const { pool, query } = require("../config/db");
const entitlementsService = require("./entitlements.service");
const chatService = require("./chat.service");
const s3Media = require("./s3Media.service");
const moderationReports = require("./moderationReports.service");
const { displayNameForPrivacy } = require("../utils/displayName");

function normalizedPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

async function areFriends(userIdA, userIdB) {
  const [u1, u2] = normalizedPair(userIdA, userIdB);
  const r = await query(
    `SELECT 1 FROM friendships WHERE u1_id = $1::uuid AND u2_id = $2::uuid LIMIT 1`,
    [u1, u2]
  );
  return r.rowCount > 0;
}

async function isBlockedEitherWay(a, b) {
  const r = await query(
    `SELECT 1 FROM blocks
     WHERE (blocker_id = $1::uuid AND blocked_id = $2::uuid)
        OR (blocker_id = $2::uuid AND blocked_id = $1::uuid)
     LIMIT 1`,
    [a, b]
  );
  return r.rowCount > 0;
}

async function loadStoryRow(storyId) {
  const r = await query(
    `SELECT s.id,
            s.user_id,
            s.media_url,
            s.media_type::text AS media_type,
            s.created_at,
            s.expires_at,
            s.deleted_at,
            COALESCE(s.audience, 'EVERYONE') AS audience,
            u.account_state::text AS owner_account_state
     FROM stories s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = $1::uuid
     LIMIT 1`,
    [storyId]
  );
  return r.rows[0] || null;
}

/**
 * Viewer may see story in viewer/reel if not expired, not deleted, owner ok, not blocked,
 * and (own | friend | audience EVERYONE).
 */
async function assertStoryViewableForViewer(viewerId, story) {
  if (!story || story.deleted_at) {
    const e = new Error("Story not found");
    e.code = "STORY_NOT_FOUND";
    throw e;
  }
  if (new Date(story.expires_at).getTime() <= Date.now()) {
    const e = new Error("Story has expired");
    e.code = "STORY_EXPIRED";
    throw e;
  }
  const ownerId = story.user_id;
  if (ownerId === viewerId) return;

  const st = String(story.owner_account_state || "");
  if (["DELETED", "BANNED", "UNDERAGE_BLOCKED"].includes(st)) {
    const e = new Error("Story not found");
    e.code = "STORY_NOT_FOUND";
    throw e;
  }
  if (await isBlockedEitherWay(viewerId, ownerId)) {
    const e = new Error("Story not found");
    e.code = "STORY_NOT_FOUND";
    throw e;
  }
  const aud = String(story.audience || "EVERYONE").toUpperCase();
  if (aud === "FRIENDS_ONLY") {
    const ok = await areFriends(viewerId, ownerId);
    if (!ok) {
      const e = new Error("Story not visible");
      e.code = "STORY_NOT_VISIBLE";
      throw e;
    }
  }
}

async function viewerWantsGhostStoryViews(viewerId) {
  const r = await query(`SELECT account_state::text AS st FROM users WHERE id = $1::uuid LIMIT 1`, [viewerId]);
  return String(r.rows[0]?.st || "").toUpperCase() === "PRIVACY_MODE";
}

async function recordStoryView(viewerId, storyId) {
  const story = await loadStoryRow(storyId);
  await assertStoryViewableForViewer(viewerId, story);
  if (story.user_id === viewerId) {
    await query(
      `INSERT INTO story_self_views (story_id, owner_user_id)
       VALUES ($1::uuid, $2::uuid)
       ON CONFLICT (story_id) DO NOTHING`,
      [storyId, viewerId]
    );
    return { recorded: true, viewCount: await countStoryViews(storyId) };
  }
  const showInActivity = !(await viewerWantsGhostStoryViews(viewerId));
  /** Story watches do not consume the free-tier profile quota; opening full profile does (non-friend / non-premium). */
  await query(
    `INSERT INTO story_interactions (story_id, actor_user_id, story_owner_id, interaction_type, show_in_activity_list)
     SELECT $1::uuid, $2::uuid, $3::uuid, 'VIEW', $4::boolean
     WHERE NOT EXISTS (
       SELECT 1 FROM story_interactions
       WHERE story_id = $1::uuid AND actor_user_id = $2::uuid AND interaction_type = 'VIEW'
     )`,
    [storyId, viewerId, story.user_id, showInActivity]
  );
  const vc = await countStoryViews(storyId);
  return { recorded: true, viewCount: vc };
}

async function countStoryViews(storyId) {
  const r = await query(
    `SELECT COUNT(*)::int AS c
     FROM story_interactions
     WHERE story_id = $1::uuid AND interaction_type = 'VIEW'`,
    [storyId]
  );
  return Number(r.rows[0]?.c || 0);
}

async function toggleStoryLike(viewerId, storyId, wantLike) {
  const story = await loadStoryRow(storyId);
  await assertStoryViewableForViewer(viewerId, story);
  if (story.user_id === viewerId) {
    const e = new Error("Cannot like own story");
    e.code = "STORY_SELF_ACTION";
    throw e;
  }
  if (wantLike) {
    await query(
      `INSERT INTO story_interactions (story_id, actor_user_id, story_owner_id, interaction_type)
       SELECT $1::uuid, $2::uuid, $3::uuid, 'LIKE'
       WHERE NOT EXISTS (
         SELECT 1 FROM story_interactions
         WHERE story_id = $1::uuid AND actor_user_id = $2::uuid AND interaction_type = 'LIKE'
       )`,
      [storyId, viewerId, story.user_id]
    );
  } else {
    await query(
      `DELETE FROM story_interactions
       WHERE story_id = $1::uuid AND actor_user_id = $2::uuid AND interaction_type = 'LIKE'`,
      [storyId, viewerId]
    );
  }
  const likedRes = await query(
    `SELECT 1 FROM story_interactions
     WHERE story_id = $1::uuid AND actor_user_id = $2::uuid AND interaction_type = 'LIKE'
     LIMIT 1`,
    [storyId, viewerId]
  );
  return { liked: likedRes.rowCount > 0 };
}

/** Non-friend: consumes 1 paid comment credit; no notification_events row. */
async function addStoryComment(viewerId, storyId, rawText) {
  const text = String(rawText || "").trim();
  if (text.length === 0 || text.length > 500) {
    const e = new Error("Comment must be 1–500 characters");
    e.code = "INVALID_STORY_COMMENT";
    throw e;
  }
  const story = await loadStoryRow(storyId);
  await assertStoryViewableForViewer(viewerId, story);
  const ownerId = story.user_id;
  if (ownerId === viewerId) {
    const e = new Error("Cannot comment on own story here");
    e.code = "STORY_SELF_ACTION";
    throw e;
  }
  const friends = await areFriends(viewerId, ownerId);
  if (friends) {
    const e = new Error("Use story reply for friends");
    e.code = "USE_STORY_REPLY_FOR_FRIEND";
    throw e;
  }
  await entitlementsService.consumePaidComments({ userId: viewerId, useCount: 1, reason: "STORY_COMMENT" });
  await query(
    `INSERT INTO story_interactions (story_id, actor_user_id, story_owner_id, interaction_type, comment_text)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'COMMENT', $4)`,
    [storyId, viewerId, ownerId, text]
  );
  return { success: true };
}

/** Friend: DM-style reply in chat + story_replies row. No separate comment credit. */
async function addStoryReplyToChat(viewerId, storyId, rawText) {
  const text = String(rawText || "").trim();
  if (text.length === 0 || text.length > 2000) {
    const e = new Error("Reply must be 1–2000 characters");
    e.code = "INVALID_STORY_REPLY";
    throw e;
  }
  const story = await loadStoryRow(storyId);
  await assertStoryViewableForViewer(viewerId, story);
  const ownerId = story.user_id;
  if (ownerId === viewerId) {
    const e = new Error("Cannot reply to own story");
    e.code = "STORY_SELF_ACTION";
    throw e;
  }
  const friends = await areFriends(viewerId, ownerId);
  if (!friends) {
    const e = new Error("Story reply is for friends only");
    e.code = "STORY_REPLY_NOT_FRIEND";
    throw e;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const srRes = await client.query(
      `INSERT INTO story_replies (story_id, replier_user_id, story_owner_id, reply_text)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4)
       RETURNING id`,
      [storyId, viewerId, ownerId, text]
    );
    const storyReplyId = srRes.rows[0].id;

    const threadInfo = await chatService.getOrCreateDirectThread(viewerId, ownerId);
    const threadId = threadInfo.threadId;

    const lock = await chatService.evaluateChatLock({ threadId, senderId: viewerId });
    if (lock.isLocked) {
      await client.query("ROLLBACK");
      const e = new Error("Chat is temporarily locked");
      e.code = "CHAT_LOCKED_PAYWALL";
      e.unlocksAt = lock.unlocksAt;
      throw e;
    }

    const msgRes = await client.query(
      `INSERT INTO chat_messages (
         thread_id, sender_type, sender_user_id, message_type, message_text,
         referenced_story_id, referenced_story_reply_id
       )
       VALUES ($1::uuid, 'USER', $2::uuid, 'STORY_REPLY_REFERENCE', $3, $4::uuid, $5::uuid)
       RETURNING id, created_at`,
      [threadId, viewerId, text, storyId, storyReplyId]
    );
    const msg = msgRes.rows[0];
    await client.query(`UPDATE story_replies SET chat_message_id = $2::uuid WHERE id = $1::uuid`, [
      storyReplyId,
      msg.id,
    ]);

    await client.query(`UPDATE chat_threads SET last_message_at = NOW() WHERE id = $1::uuid`, [threadId]);
    await client.query(
      `UPDATE chat_thread_user_state
       SET unread_count_cache = 0,
           has_reply_badge = false,
           last_outbound_message_at = NOW(),
           updated_at = NOW()
       WHERE thread_id = $1::uuid AND user_id = $2::uuid`,
      [threadId, viewerId]
    );
    await client.query(
      `UPDATE chat_thread_user_state
       SET unread_count_cache = unread_count_cache + 1,
           has_reply_badge = true,
           last_inbound_message_at = NOW(),
           is_deleted_from_inbox = false,
           deleted_from_inbox_at = NULL,
           updated_at = NOW()
       WHERE thread_id = $1::uuid AND user_id <> $2::uuid`,
      [threadId, viewerId]
    );

    await client.query("COMMIT");
    return {
      storyReplyId,
      threadId,
      messageId: msg.id,
      createdAt: msg.created_at ? new Date(msg.created_at).toISOString() : null,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function listStoryActivity(ownerId, storyId) {
  const story = await loadStoryRow(storyId);
  if (!story || story.user_id !== ownerId) {
    const e = new Error("Story not found");
    e.code = "STORY_NOT_FOUND";
    throw e;
  }

  const friendSql = `EXISTS (
      SELECT 1 FROM friendships f
      WHERE f.u1_id = LEAST($2::uuid, si.actor_user_id)
        AND f.u2_id = GREATEST($2::uuid, si.actor_user_id)
    )`;
  const openedSql = `EXISTS (
      SELECT 1 FROM story_activity_profile_seen sap
      WHERE sap.owner_user_id = $2::uuid
        AND sap.story_id = $1::uuid
        AND sap.actor_user_id = si.actor_user_id
    )`;
  const actorPhotoSql = `(
      SELECT up.photo_url FROM user_photos up
      WHERE up.user_id = u.id AND up.deleted_at IS NULL
      ORDER BY up.photo_order ASC
      LIMIT 1
    ) AS primary_photo_url`;
  const actorHasActiveStorySql = `EXISTS (
      SELECT 1 FROM stories s
      WHERE s.user_id = si.actor_user_id
        AND s.deleted_at IS NULL
        AND s.expires_at > NOW()
    ) AS has_active_story`;
  const ownerUnseenActorStorySql = `EXISTS (
      SELECT 1 FROM stories s
      WHERE s.user_id = si.actor_user_id
        AND s.deleted_at IS NULL
        AND s.expires_at > NOW()
        AND NOT EXISTS (
          SELECT 1 FROM story_interactions x
          WHERE x.story_id = s.id
            AND x.actor_user_id = $2::uuid
            AND x.interaction_type = 'VIEW'
        )
    ) AS viewer_has_unseen_story`;

  const views = await query(
    `SELECT si.actor_user_id AS uid,
            u.name,
            u.age_years,
            u.is_verified,
            u.hide_my_name,
            si.created_at,
            ${friendSql} AS is_friend,
            ${openedSql} AS profile_opened,
            ${actorPhotoSql},
            ${actorHasActiveStorySql},
            ${ownerUnseenActorStorySql}
     FROM story_interactions si
     JOIN users u ON u.id = si.actor_user_id
     WHERE si.story_id = $1::uuid
       AND si.interaction_type = 'VIEW'
       AND COALESCE(si.show_in_activity_list, true) = true
       AND NOT EXISTS (
         SELECT 1 FROM story_interactions x
         WHERE x.story_id = si.story_id
           AND x.actor_user_id = si.actor_user_id
           AND x.interaction_type = 'COMMENT'
       )
       AND NOT EXISTS (
         SELECT 1 FROM story_interactions x
         WHERE x.story_id = si.story_id
           AND x.actor_user_id = si.actor_user_id
           AND x.interaction_type = 'LIKE'
       )
     ORDER BY si.created_at DESC
     LIMIT 200`,
    [storyId, ownerId]
  );

  const likes = await query(
    `SELECT si.actor_user_id AS uid,
            u.name,
            u.age_years,
            u.is_verified,
            u.hide_my_name,
            si.created_at,
            ${friendSql} AS is_friend,
            ${openedSql} AS profile_opened,
            ${actorPhotoSql},
            ${actorHasActiveStorySql},
            ${ownerUnseenActorStorySql}
     FROM story_interactions si
     JOIN users u ON u.id = si.actor_user_id
     WHERE si.story_id = $1::uuid
       AND si.interaction_type = 'LIKE'
       AND NOT EXISTS (
         SELECT 1 FROM story_interactions x
         WHERE x.story_id = si.story_id
           AND x.actor_user_id = si.actor_user_id
           AND x.interaction_type = 'COMMENT'
       )
     ORDER BY si.created_at DESC
     LIMIT 200`,
    [storyId, ownerId]
  );

  const comments = await query(
    `SELECT si.actor_user_id AS uid,
            u.name,
            u.age_years,
            u.is_verified,
            u.hide_my_name,
            si.comment_text,
            si.created_at,
            ${friendSql} AS is_friend,
            ${openedSql} AS profile_opened,
            ${actorPhotoSql},
            ${actorHasActiveStorySql},
            ${ownerUnseenActorStorySql}
     FROM story_interactions si
     JOIN users u ON u.id = si.actor_user_id
     WHERE si.story_id = $1::uuid AND si.interaction_type = 'COMMENT'
     ORDER BY si.created_at DESC
     LIMIT 200`,
    [storyId, ownerId]
  );

  async function mapActivityActorRow(row) {
    const rawPhoto = String(row.primary_photo_url || "").trim();
    const primaryPhotoUrl = rawPhoto ? await s3Media.presignReadIfOurS3Object(rawPhoto) : "";
    return {
      userId: row.uid,
      name: displayNameForPrivacy(row.name, row.hide_my_name === true),
      age: row.age_years != null ? Number(row.age_years) : 0,
      verified: row.is_verified === true,
      at: row.created_at ? new Date(row.created_at).toISOString() : null,
      isFriend: row.is_friend === true,
      profileOpened: row.profile_opened === true,
      primaryPhotoUrl,
      hasActiveStory: row.has_active_story === true,
      viewerHasUnseenStory: row.viewer_has_unseen_story === true,
    };
  }

  const [viewsOut, likesOut, commentsOut] = await Promise.all([
    Promise.all(views.rows.map(async (row) => ({ ...(await mapActivityActorRow(row)), kind: "VIEWED" }))),
    Promise.all(likes.rows.map(async (row) => ({ ...(await mapActivityActorRow(row)), kind: "LIKED" }))),
    Promise.all(
      comments.rows.map(async (row) => ({
        ...(await mapActivityActorRow(row)),
        kind: "COMMENTED",
        comment: row.comment_text || "",
      }))
    ),
  ]);

  return {
    storyId,
    viewCount: await countStoryViews(storyId),
    views: viewsOut,
    likes: likesOut,
    comments: commentsOut,
  };
}

/** Non-friend "View" on story activity → persists "Seen" on reload. */
async function markStoryActivityProfileOpened(ownerId, storyId, actorUserId) {
  const aid = String(actorUserId || "").trim();
  if (!aid) {
    const e = new Error("actorUserId is required");
    e.code = "ACTOR_REQUIRED";
    throw e;
  }
  const story = await loadStoryRow(storyId);
  if (!story || story.user_id !== ownerId) {
    const e = new Error("Story not found");
    e.code = "STORY_NOT_FOUND";
    throw e;
  }
  await query(
    `INSERT INTO story_activity_profile_seen (owner_user_id, story_id, actor_user_id)
     VALUES ($1::uuid, $2::uuid, $3::uuid)
     ON CONFLICT (owner_user_id, story_id, actor_user_id) DO UPDATE SET seen_at = EXCLUDED.seen_at`,
    [ownerId, storyId, aid]
  );
  return { success: true };
}

async function softDeleteStory(ownerId, storyId) {
  const story = await loadStoryRow(storyId);
  if (!story || story.user_id !== ownerId) {
    const e = new Error("Story not found");
    e.code = "STORY_NOT_FOUND";
    throw e;
  }
  await query(
    `UPDATE stories
     SET deleted_at = NOW(),
         media_purge_after = COALESCE(media_purge_after, NOW() + INTERVAL '6 months')
     WHERE id = $1::uuid`,
    [storyId]
  );
  return { success: true };
}

async function reportStory(viewerId, storyId, rawReason) {
  const reason = String(rawReason || "").trim();
  if (!reason) {
    const e = new Error("Report reason is required");
    e.code = "REPORT_REASON_REQUIRED";
    throw e;
  }
  const story = await loadStoryRow(storyId);
  await assertStoryViewableForViewer(viewerId, story);
  const ownerId = story.user_id;
  if (ownerId === viewerId) {
    const e = new Error("Cannot report your own story");
    e.code = "STORY_SELF_REPORT";
    throw e;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const dup = await client.query(
      `SELECT 1 FROM reports WHERE story_id = $1::uuid AND reporter_id = $2::uuid LIMIT 1`,
      [storyId, viewerId]
    );
    if (dup.rowCount > 0) {
      await client.query("COMMIT");
      return { success: true, alreadyReported: true, warningIssued: false, storyRemoved: false, userBanned: false };
    }
    try {
      await client.query(
        `INSERT INTO reports (reporter_id, reported_id, content_type, reason, story_id)
         VALUES ($1::uuid, $2::uuid, 'STORY'::report_content_type_enum, $3, $4::uuid)`,
        [viewerId, ownerId, reason, storyId]
      );
    } catch (insErr) {
      if (insErr && insErr.code === "23505") {
        await client.query("ROLLBACK");
        return { success: true, alreadyReported: true, warningIssued: false, storyRemoved: false, userBanned: false };
      }
      throw insErr;
    }

    const cntRes = await client.query(
      `SELECT COUNT(DISTINCT reporter_id)::int AS c
       FROM reports
       WHERE story_id = $1::uuid AND content_type = 'STORY'::report_content_type_enum`,
      [storyId]
    );
    const n = Number(cntRes.rows[0]?.c || 0);
    let storyRemoved = false;

    // Three distinct reporters on this story ⇒ soft-remove the story (content policy).
    if (n === 3) {
      await client.query(`SELECT id FROM stories WHERE id = $1::uuid AND deleted_at IS NULL FOR UPDATE`, [storyId]);
      const del = await client.query(
        `UPDATE stories
         SET deleted_at = NOW(),
             media_purge_after = COALESCE(media_purge_after, NOW() + INTERVAL '6 months')
         WHERE id = $1::uuid AND deleted_at IS NULL
         RETURNING id`,
        [storyId]
      );
      storyRemoved = del.rowCount > 0;
    }

    // Warnings/bans: all reports against the story owner (profile + chat + story) share one counter.
    const agg = await moderationReports.applyReportMilestonesForReportedUser(client, ownerId);

    await client.query("COMMIT");
    return {
      success: true,
      alreadyReported: false,
      warningIssued: agg.warningIssued,
      storyRemoved,
      userBanned: agg.userBanned,
      totalReportsAgainstUser: agg.totalReports,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function listMyStories(userId) {
  const res = await query(
    `SELECT s.id,
            s.media_url,
            s.media_type::text AS media_type,
            s.created_at,
            s.expires_at,
            (SELECT COUNT(*)::int FROM story_interactions si
             WHERE si.story_id = s.id AND si.interaction_type = 'VIEW') AS view_count
     FROM stories s
     WHERE s.user_id = $1::uuid
       AND s.deleted_at IS NULL
       AND s.expires_at > NOW()
     ORDER BY s.created_at DESC
     LIMIT 5`,
    [userId]
  );
  const stories = [];
  for (const row of res.rows) {
    stories.push({
      storyId: row.id,
      mediaUrl: await s3Media.presignReadIfOurS3Object(row.media_url || ""),
      mediaType: row.media_type || "IMAGE",
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
      viewCount: Number(row.view_count || 0),
    });
  }
  return { stories };
}

async function getMeStorySummary(userId) {
  const active = await query(
    `SELECT COUNT(*)::int AS c
     FROM stories
     WHERE user_id = $1::uuid AND deleted_at IS NULL AND expires_at > NOW()`,
    [userId]
  );
  const unread = await query(
    `SELECT COUNT(*)::int AS c
     FROM story_interactions si
     INNER JOIN stories s ON s.id = si.story_id
     WHERE s.user_id = $1::uuid
       AND s.deleted_at IS NULL
       AND s.expires_at > NOW()
       AND si.actor_user_id <> $1::uuid
       AND si.created_at > (SELECT u.story_activity_seen_at FROM users u WHERE u.id = $1::uuid LIMIT 1)
       AND (
         si.interaction_type IN ('LIKE', 'COMMENT')
         OR (si.interaction_type = 'VIEW' AND COALESCE(si.show_in_activity_list, true) = true)
       )`,
    [userId]
  );
  return {
    hasActiveStory: Number(active.rows[0]?.c || 0) > 0,
    activeStoryCount: Number(active.rows[0]?.c || 0),
    unreadInteractionCount: Number(unread.rows[0]?.c || 0),
  };
}

async function markStoryActivitySeen(userId) {
  await query(`UPDATE users SET story_activity_seen_at = NOW() WHERE id = $1::uuid`, [userId]);
  return { success: true };
}

async function createStoryFromUpload(userId, { mediaUrl, mediaType = "IMAGE", audience = "EVERYONE" }) {
  const aud = String(audience || "EVERYONE").toUpperCase() === "FRIENDS_ONLY" ? "FRIENDS_ONLY" : "EVERYONE";
  const mt = String(mediaType || "IMAGE").toUpperCase() === "VIDEO" ? "VIDEO" : "IMAGE";
  const url = String(mediaUrl || "").trim();
  if (!url) {
    const e = new Error("mediaUrl is required");
    e.code = "STORY_MEDIA_REQUIRED";
    throw e;
  }
  const activeCount = await query(
    `SELECT COUNT(*)::int AS c FROM stories
     WHERE user_id = $1::uuid AND deleted_at IS NULL AND expires_at > NOW()`,
    [userId]
  );
  if (Number(activeCount.rows[0]?.c || 0) >= 5) {
    const e = new Error("You can have at most 5 active stories at a time");
    e.code = "STORY_LIMIT_REACHED";
    throw e;
  }
  const ins = await query(
    `INSERT INTO stories (user_id, media_url, media_type, audience, expires_at)
     VALUES ($1::uuid, $2, $3::story_media_type_enum, $4, NOW() + INTERVAL '24 hours')
     RETURNING id, created_at, expires_at, audience`,
    [userId, url, mt, aud]
  );
  const row = ins.rows[0];
  return {
    storyId: row.id,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    audience: row.audience,
  };
}

async function presignStoryUpload(userId) {
  const storyId = s3Media.newPhotoId();
  const key = s3Media.buildStoryObjectKey(userId, storyId);
  const { uploadUrl, publicUrl } = await s3Media.getPresignedPutUrl({
    key,
    contentType: "image/jpeg",
  });
  return { storyId, uploadUrl, publicUrl, mediaUrl: publicUrl, s3Key: key };
}

/** Home reel: users the viewer can see with at least one active story slide. */
async function listStoryReelForViewer(viewerId) {
  const res = await query(
    `SELECT s.id AS story_id,
            s.user_id,
            s.media_url,
            s.media_type::text AS media_type,
            s.created_at,
            s.expires_at,
            COALESCE(s.audience, 'EVERYONE') AS audience,
            u.name,
            u.age_years,
            u.is_verified,
            u.hide_my_name,
            (
              SELECT up.photo_url FROM user_photos up
              WHERE up.user_id = u.id AND up.deleted_at IS NULL
              ORDER BY up.photo_order ASC
              LIMIT 1
            ) AS primary_photo_url,
            EXISTS (
              SELECT 1 FROM friendships f
              WHERE (f.u1_id = $1::uuid AND f.u2_id = s.user_id)
                 OR (f.u2_id = $1::uuid AND f.u1_id = s.user_id)
            ) AS is_friend,
            (
              CASE
                WHEN s.user_id = $1::uuid THEN EXISTS (
                  SELECT 1 FROM story_self_views sv
                  WHERE sv.story_id = s.id AND sv.owner_user_id = $1::uuid
                )
                ELSE EXISTS (
                  SELECT 1 FROM story_interactions si
                  WHERE si.story_id = s.id
                    AND si.actor_user_id = $1::uuid
                    AND si.interaction_type = 'VIEW'
                )
              END
            ) AS viewed_by_viewer
     FROM stories s
     JOIN users u ON u.id = s.user_id
     WHERE s.deleted_at IS NULL
       AND s.expires_at > NOW()
       AND u.deleted_at IS NULL
       AND u.account_state NOT IN ('DELETED', 'BANNED', 'UNDERAGE_BLOCKED')
       AND NOT EXISTS (
         SELECT 1 FROM blocks b
         WHERE (b.blocker_id = $1::uuid AND b.blocked_id = s.user_id)
            OR (b.blocker_id = s.user_id AND b.blocked_id = $1::uuid)
       )
       AND (
         s.user_id = $1::uuid
         OR EXISTS (
           SELECT 1 FROM friendships f
           WHERE (f.u1_id = $1::uuid AND f.u2_id = s.user_id)
              OR (f.u2_id = $1::uuid AND f.u1_id = s.user_id)
         )
         OR COALESCE(s.audience, 'EVERYONE') = 'EVERYONE'
       )
     ORDER BY s.user_id, s.created_at ASC`,
    [viewerId]
  );

  const byUser = new Map();
  for (const row of res.rows) {
    const uid = row.user_id;
    if (!byUser.has(uid)) {
      byUser.set(uid, {
        userId: uid,
        name: displayNameForPrivacy(row.name, row.hide_my_name === true),
        ageYears: row.age_years != null ? Number(row.age_years) : 0,
        verified: row.is_verified === true,
        isFriend: row.is_friend === true,
        isSelf: uid === viewerId,
        primaryPhotoUrl: await s3Media.presignReadIfOurS3Object(String(row.primary_photo_url || "").trim()),
        viewerHasUnseenStory: false,
        stories: [],
      });
    }
    const entry = byUser.get(uid);
    const viewed = row.viewed_by_viewer === true;
    entry.viewerHasUnseenStory = entry.viewerHasUnseenStory || !viewed;
    entry.stories.push({
      storyId: row.story_id,
      mediaUrl: await s3Media.presignReadIfOurS3Object(row.media_url || ""),
      mediaType: row.media_type,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
      _viewedByViewer: viewed,
    });
  }
  for (const entry of byUser.values()) {
    entry.stories.sort((a, b) => {
      if (a._viewedByViewer !== b._viewedByViewer) {
        return a._viewedByViewer ? 1 : -1;
      }
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return ta - tb;
    });
    entry.stories = entry.stories.map(({ _viewedByViewer, ...rest }) => rest);
  }
  const users = [...byUser.values()].sort((a, b) => {
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
    if (a.viewerHasUnseenStory !== b.viewerHasUnseenStory) {
      return a.viewerHasUnseenStory ? -1 : 1;
    }
    return String(a.userId).localeCompare(String(b.userId));
  });
  return { users };
}

async function getViewerStoryState(viewerId, storyId) {
  const story = await loadStoryRow(storyId);
  await assertStoryViewableForViewer(viewerId, story);
  const mediaUrl = await s3Media.presignReadIfOurS3Object(story.media_url || "");
  const mediaType = story.media_type || "IMAGE";
  if (story.user_id === viewerId) {
    return {
      liked: false,
      likeCount: await countLikes(storyId),
      viewCount: await countStoryViews(storyId),
      mediaUrl,
      mediaType,
    };
  }
  const likedRes = await query(
    `SELECT 1 FROM story_interactions
     WHERE story_id = $1::uuid AND actor_user_id = $2::uuid AND interaction_type = 'LIKE' LIMIT 1`,
    [storyId, viewerId]
  );
  return {
    liked: likedRes.rowCount > 0,
    likeCount: await countLikes(storyId),
    viewCount: await countStoryViews(storyId),
    isFriend: await areFriends(viewerId, story.user_id),
    mediaUrl,
    mediaType,
  };
}

async function countLikes(storyId) {
  const r = await query(
    `SELECT COUNT(*)::int AS c FROM story_interactions
     WHERE story_id = $1::uuid AND interaction_type = 'LIKE'`,
    [storyId]
  );
  return Number(r.rows[0]?.c || 0);
}

module.exports = {
  loadStoryRow,
  assertStoryViewableForViewer,
  recordStoryView,
  toggleStoryLike,
  addStoryComment,
  addStoryReplyToChat,
  listStoryActivity,
  markStoryActivityProfileOpened,
  softDeleteStory,
  reportStory,
  listMyStories,
  getMeStorySummary,
  markStoryActivitySeen,
  createStoryFromUpload,
  presignStoryUpload,
  listStoryReelForViewer,
  getViewerStoryState,
  areFriends,
  countStoryViews,
};
