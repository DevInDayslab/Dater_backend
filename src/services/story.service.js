const { pool, query } = require("../config/db");
const entitlementsService = require("./entitlements.service");
const chatService = require("./chat.service");
const s3Media = require("./s3Media.service");
const moderationReports = require("./moderationReports.service");
const { displayNameForPrivacy } = require("../utils/displayName");
const {
  advMatchMaritalAnd,
  advMatchDrinkingAnd,
  advMatchSmokingAnd,
  advMatchEthnicityAnd,
} = require("../utils/advancedFilterMatchSql");
const { resolveIndiaBrowseAnchor, getIndiaBrowseAnchorUnnestArrays } = require("./geocoder.service");

function normalizedPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** Mirrors feed.service.js: default window ±5 from viewer age, hard bounds 18–80, slider min span 4; expand applies ±5. */
function resolveFeedAgeBounds(viewer) {
  const selfAge = Number(viewer.age_years);
  let ageMin = Number(viewer.age_min);
  let ageMax = Number(viewer.age_max);
  if (!Number.isFinite(ageMin)) {
    ageMin = Number.isFinite(selfAge) ? Math.max(18, selfAge - 5) : 20;
  }
  if (!Number.isFinite(ageMax)) {
    ageMax = Number.isFinite(selfAge) ? Math.min(80, selfAge + 5) : 36;
  }
  ageMin = clamp(ageMin, 18, 100, 20);
  ageMax = clamp(ageMax, 18, 100, 36);
  if (viewer.expand_age_range === true) {
    ageMin = Math.max(18, Math.round(ageMin - 5));
    ageMax = Math.min(80, Math.round(ageMax + 5));
  }
  if (ageMax - ageMin < 4) {
    const mid = Math.round((ageMin + ageMax) / 2);
    ageMin = Math.max(18, mid - 2);
    ageMax = Math.min(80, mid + 2);
    if (ageMax - ageMin < 4) ageMax = Math.min(80, ageMin + 4);
  }
  if (ageMax < ageMin) {
    const t = ageMin;
    ageMin = ageMax;
    ageMax = t;
  }
  return { ageMin, ageMax };
}

/** Mirrors feed.service.js: default 20km, 2–150; expand_distance widens radius. */
function resolveFeedDistanceKm(viewer) {
  let distanceKm = Number(viewer.distance_pref_km) || 20;
  if (distanceKm < 2) distanceKm = 2;
  if (distanceKm > 150) distanceKm = 150;
  if (viewer.expand_distance === true) {
    distanceKm = Math.min(150, Math.round(distanceKm * 1.75));
  }
  return distanceKm;
}

async function getViewerContextForStoryReel(userId) {
  const res = await query(
    `SELECT u.id,
            u.age_years,
            u.gender_main,
            u.location,
            u.living_in_city,
            u.is_premium,
            u.premium_expires_at,
            uf.distance_pref_km,
            uf.age_min,
            uf.age_max,
            uf.expand_age_range,
            uf.expand_distance,
            uf.only_verified_profiles,
            uf.preferred_location_city
     FROM users u
     JOIN user_filters uf ON uf.user_id = u.id
     WHERE u.id = $1::uuid
     LIMIT 1`,
    [userId]
  );
  return res.rows[0] || null;
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

    await chatService.acquireChatSendLock(client, threadId, viewerId);
    const lock = await chatService.evaluateChatLock(
      { threadId, senderId: viewerId },
      { client, lockRestrictionRow: true }
    );
    if (lock.isLocked) {
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
  const total = await query(
    `SELECT COUNT(*)::int AS c
     FROM story_interactions si
     INNER JOIN stories s ON s.id = si.story_id
     WHERE s.user_id = $1::uuid
       AND s.deleted_at IS NULL
       AND s.expires_at > NOW()
       AND si.actor_user_id <> $1::uuid
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
    totalInteractionCount: Number(total.rows[0]?.c || 0),
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
  const viewer = await getViewerContextForStoryReel(viewerId);
  if (!viewer) return { users: [] };
  const distanceKm = resolveFeedDistanceKm(viewer);
  const { ageMin, ageMax } = resolveFeedAgeBounds(viewer);
  const onlyVerified = viewer.only_verified_profiles === true;
  const maxUsers = 60;
  const prefCityRaw = String(viewer.preferred_location_city || "").trim();
  const browseAnchorCoords = prefCityRaw ? resolveIndiaBrowseAnchor(prefCityRaw) : null;
  const browseAnchorLat = browseAnchorCoords != null ? browseAnchorCoords.lat : null;
  const browseAnchorLng = browseAnchorCoords != null ? browseAnchorCoords.lng : null;
  const anchorArrays = getIndiaBrowseAnchorUnnestArrays();

  const res = await query(
    `WITH viewer AS (
       SELECT u.id AS user_id,
              $2::integer AS distance_km,
              $3::smallint AS age_min,
              $4::smallint AS age_max,
              $5::boolean AS only_verified,
              COALESCE((
                SELECT array_agg(ufg.gender ORDER BY ufg.gender)
                FROM user_filter_preferred_genders ufg
                WHERE ufg.user_id = u.id
              ), ARRAY[]::varchar[]) AS preferred_genders,
              -- Browse locale for reel eligibility = filter preferred city only (not profile living_in_city).
              uf.preferred_location_city AS preferred_location_city,
              (uf.preferred_location_city IS NOT NULL AND NULLIF(TRIM(uf.preferred_location_city), '') IS NOT NULL) AS using_switch_city,
              (COALESCE(u.is_premium, FALSE)
                OR (u.premium_expires_at IS NOT NULL AND u.premium_expires_at > NOW())) AS premium_effective,
              uf.min_height_inches AS filter_min_height_inches,
              uf.max_height_inches AS filter_max_height_inches,
              COALESCE(uf.show_other_people_if_run_out, TRUE) AS show_other_people_if_run_out,
              COALESCE((
                SELECT array_agg(language ORDER BY language)
                FROM user_filter_languages WHERE user_id = u.id
              ), ARRAY[]::varchar[]) AS filter_languages,
              COALESCE((
                SELECT array_agg(marital_status ORDER BY marital_status)
                FROM user_filter_marital_statuses WHERE user_id = u.id
              ), ARRAY[]::varchar[]) AS filter_marital_statuses,
              COALESCE((
                SELECT array_agg(looking_for_option ORDER BY looking_for_option)
                FROM user_filter_looking_for WHERE user_id = u.id
              ), ARRAY[]::varchar[]) AS filter_looking_for,
              COALESCE((
                SELECT array_agg(drinking_option ORDER BY drinking_option)
                FROM user_filter_drinking_preferences WHERE user_id = u.id
              ), ARRAY[]::varchar[]) AS filter_drinking,
              COALESCE((
                SELECT array_agg(smoking_option ORDER BY smoking_option)
                FROM user_filter_smoking_preferences WHERE user_id = u.id
              ), ARRAY[]::varchar[]) AS filter_smoking,
              COALESCE((
                SELECT array_agg(exercise_option ORDER BY exercise_option)
                FROM user_filter_exercise_preferences WHERE user_id = u.id
              ), ARRAY[]::varchar[]) AS filter_exercise,
              COALESCE((
                SELECT array_agg(religion_option ORDER BY religion_option)
                FROM user_filter_religion_preferences WHERE user_id = u.id
              ), ARRAY[]::varchar[]) AS filter_religion,
              COALESCE((
                SELECT array_agg(education_option ORDER BY education_option)
                FROM user_filter_education_preferences WHERE user_id = u.id
              ), ARRAY[]::varchar[]) AS filter_education,
              COALESCE((
                SELECT array_agg(star_sign_option ORDER BY star_sign_option)
                FROM user_filter_star_sign_preferences WHERE user_id = u.id
              ), ARRAY[]::varchar[]) AS filter_star_sign,
              COALESCE((
                SELECT array_agg(kids_option ORDER BY kids_option)
                FROM user_filter_kids_preferences WHERE user_id = u.id
              ), ARRAY[]::varchar[]) AS filter_kids,
              COALESCE((
                SELECT array_agg(political_option ORDER BY political_option)
                FROM user_filter_political_preferences WHERE user_id = u.id
              ), ARRAY[]::varchar[]) AS filter_political,
              COALESCE((
                SELECT array_agg(pet_option ORDER BY pet_option)
                FROM user_filter_pet_preferences WHERE user_id = u.id
              ), ARRAY[]::varchar[]) AS filter_pets,
              COALESCE((
                SELECT array_agg(ethnicity_option ORDER BY ethnicity_option)
                FROM user_filter_ethnicity_preferences WHERE user_id = u.id
              ), ARRAY[]::varchar[]) AS filter_ethnicity,
              COALESCE((
                SELECT array_agg(pronoun_option ORDER BY pronoun_option)
                FROM user_filter_pronoun_preferences WHERE user_id = u.id
              ), ARRAY[]::varchar[]) AS filter_pronouns,
              (
                uf.min_height_inches IS NOT NULL
                OR uf.max_height_inches IS NOT NULL
                OR EXISTS (SELECT 1 FROM user_filter_marital_statuses WHERE user_id = u.id LIMIT 1)
                OR EXISTS (SELECT 1 FROM user_filter_looking_for WHERE user_id = u.id LIMIT 1)
                OR EXISTS (SELECT 1 FROM user_filter_drinking_preferences WHERE user_id = u.id LIMIT 1)
                OR EXISTS (SELECT 1 FROM user_filter_smoking_preferences WHERE user_id = u.id LIMIT 1)
                OR EXISTS (SELECT 1 FROM user_filter_exercise_preferences WHERE user_id = u.id LIMIT 1)
                OR EXISTS (SELECT 1 FROM user_filter_religion_preferences WHERE user_id = u.id LIMIT 1)
                OR EXISTS (SELECT 1 FROM user_filter_education_preferences WHERE user_id = u.id LIMIT 1)
                OR EXISTS (SELECT 1 FROM user_filter_star_sign_preferences WHERE user_id = u.id LIMIT 1)
                OR EXISTS (SELECT 1 FROM user_filter_kids_preferences WHERE user_id = u.id LIMIT 1)
                OR EXISTS (SELECT 1 FROM user_filter_political_preferences WHERE user_id = u.id LIMIT 1)
                OR EXISTS (SELECT 1 FROM user_filter_pet_preferences WHERE user_id = u.id LIMIT 1)
                OR EXISTS (SELECT 1 FROM user_filter_ethnicity_preferences WHERE user_id = u.id LIMIT 1)
                OR EXISTS (SELECT 1 FROM user_filter_pronoun_preferences WHERE user_id = u.id LIMIT 1)
              ) AS filter_advanced_active,
              $6::double precision AS browse_anchor_lat,
              $7::double precision AS browse_anchor_lng,
              CASE
                WHEN $6::double precision IS NOT NULL AND $7::double precision IS NOT NULL THEN
                  ST_SetSRID(ST_MakePoint($7::double precision, $6::double precision), 4326)::geography
                ELSE NULL::geography
              END AS browse_anchor_geog
       FROM users u
       JOIN user_filters uf ON uf.user_id = u.id
       WHERE u.id = $1::uuid
     ),
     city_anchor AS (
       SELECT *
       FROM unnest($8::text[], $9::double precision[], $10::double precision[]) AS ca(label_norm, lat, lng)
     ),
     eligible_candidate_staging AS (
       SELECT c.id,
              (
                NOT v.premium_effective
                OR (
                  (v.filter_min_height_inches IS NULL OR c.height_inches IS NULL OR c.height_inches >= v.filter_min_height_inches)
                  AND (v.filter_max_height_inches IS NULL OR c.height_inches IS NULL OR c.height_inches <= v.filter_max_height_inches)
${advMatchMaritalAnd}
                  AND (
                    CARDINALITY(v.filter_looking_for) = 0
                    OR EXISTS (
                      SELECT 1
                      FROM user_looking_for clf
                      WHERE clf.user_id = c.id
                        AND clf.looking_for_option = ANY(v.filter_looking_for)
                    )
                  )
${advMatchDrinkingAnd}
${advMatchSmokingAnd}
                  AND (CARDINALITY(v.filter_exercise) = 0 OR (c.exercise IS NOT NULL AND c.exercise = ANY(v.filter_exercise)))
                  AND (CARDINALITY(v.filter_religion) = 0 OR (c.religion IS NOT NULL AND c.religion = ANY(v.filter_religion)))
                  AND (CARDINALITY(v.filter_education) = 0 OR (c.education IS NOT NULL AND c.education = ANY(v.filter_education)))
                  AND (CARDINALITY(v.filter_star_sign) = 0 OR (c.star_sign IS NOT NULL AND c.star_sign = ANY(v.filter_star_sign)))
                  AND (CARDINALITY(v.filter_kids) = 0 OR (c.kids IS NOT NULL AND c.kids = ANY(v.filter_kids)))
                  AND (CARDINALITY(v.filter_political) = 0 OR (c.political_leanings IS NOT NULL AND c.political_leanings = ANY(v.filter_political)))
                  AND (CARDINALITY(v.filter_pets) = 0 OR (c.pets IS NOT NULL AND c.pets = ANY(v.filter_pets)))
${advMatchEthnicityAnd}
                  AND (
                    CARDINALITY(v.filter_pronouns) = 0
                    OR EXISTS (
                      SELECT 1
                      FROM user_pronouns cp
                      WHERE cp.user_id = c.id
                        AND cp.pronoun = ANY(v.filter_pronouns)
                    )
                  )
                )
              ) AS adv_match
       FROM users c
       JOIN users vu ON vu.id = $1::uuid
       CROSS JOIN viewer v
       WHERE c.id <> v.user_id
         AND c.deleted_at IS NULL
         AND c.account_state = 'ACTIVE'
         AND (v.only_verified = FALSE OR c.is_verified = TRUE)
         AND (
           (
             vu.location IS NOT NULL
             AND c.location IS NOT NULL
             AND (
              (
                v.using_switch_city = TRUE
                AND v.browse_anchor_geog IS NOT NULL
                AND ST_DWithin(
                  c.location::geography,
                  v.browse_anchor_geog,
                  (v.distance_km * 1000)::double precision
                )
              )
               OR (
                 v.using_switch_city = TRUE
                 AND v.browse_anchor_geog IS NULL
                 AND NULLIF(TRIM(c.living_in_city), '') IS NOT NULL
                 AND NULLIF(TRIM(v.preferred_location_city), '') IS NOT NULL
                 AND (
                   LOWER(TRIM(c.living_in_city)) = LOWER(TRIM(v.preferred_location_city))
                   OR LOWER(TRIM(SPLIT_PART(c.living_in_city, ',', 1))) =
                      LOWER(TRIM(SPLIT_PART(v.preferred_location_city, ',', 1)))
                 )
               )
               OR (
                 v.using_switch_city = FALSE
                 AND ST_DWithin(
                   c.location::geography,
                   vu.location::geography,
                   (v.distance_km * 1000)::double precision
                 )
               )
               OR (
                 v.using_switch_city = FALSE
                 AND vu.location IS NOT NULL
                 AND (
                   COALESCE(c.is_premium, FALSE)
                   OR (c.premium_expires_at IS NOT NULL AND c.premium_expires_at > NOW())
                 )
                 AND EXISTS (
                   SELECT 1
                   FROM user_filters cuf
                   INNER JOIN city_anchor ca ON ca.label_norm = lower(trim(cuf.preferred_location_city))
                   WHERE cuf.user_id = c.id
                     AND NULLIF(TRIM(cuf.preferred_location_city), '') IS NOT NULL
                     AND ST_DWithin(
                       ST_SetSRID(ST_MakePoint(ca.lng, ca.lat), 4326)::geography,
                       vu.location::geography,
                       (v.distance_km * 1000)::double precision
                     )
                 )
               )
             )
           )
           OR (
             vu.location IS NULL
             AND v.using_switch_city = TRUE
             AND v.browse_anchor_geog IS NOT NULL
             AND c.location IS NOT NULL
             AND ST_DWithin(
               c.location::geography,
               v.browse_anchor_geog,
               (v.distance_km * 1000)::double precision
             )
           )
         )
         AND EXISTS (
           SELECT 1
           FROM user_filters cdf
           WHERE cdf.user_id = c.id
             AND (
               (
                 vu.location IS NOT NULL
                 AND c.location IS NOT NULL
                 AND (
                   (
                     v.using_switch_city = TRUE
                     AND v.browse_anchor_geog IS NOT NULL
                     AND ST_DWithin(
                       c.location::geography,
                       v.browse_anchor_geog,
                       (
                         LEAST(
                           150,
                           CASE
                             WHEN COALESCE(cdf.expand_distance, FALSE)
                               THEN ROUND(LEAST(150, GREATEST(2, COALESCE(cdf.distance_pref_km, 20))) * 1.75)
                             ELSE LEAST(150, GREATEST(2, COALESCE(cdf.distance_pref_km, 20)))
                           END
                         ) * 1000
                       )::double precision
                     )
                   )
                   OR (
                     v.using_switch_city = FALSE
                     AND (
                       ST_DWithin(
                         c.location::geography,
                         vu.location::geography,
                         (
                           LEAST(
                             150,
                             CASE
                               WHEN COALESCE(cdf.expand_distance, FALSE)
                                 THEN ROUND(LEAST(150, GREATEST(2, COALESCE(cdf.distance_pref_km, 20))) * 1.75)
                               ELSE LEAST(150, GREATEST(2, COALESCE(cdf.distance_pref_km, 20)))
                             END
                           ) * 1000
                         )::double precision
                       )
                       OR (
                         (COALESCE(c.is_premium, FALSE) OR (c.premium_expires_at IS NOT NULL AND c.premium_expires_at > NOW()))
                         AND NULLIF(TRIM(cdf.preferred_location_city), '') IS NOT NULL
                         AND EXISTS (
                           SELECT 1
                           FROM city_anchor ca
                           WHERE ca.label_norm = lower(trim(cdf.preferred_location_city))
                             AND ST_DWithin(
                               ST_SetSRID(ST_MakePoint(ca.lng, ca.lat), 4326)::geography,
                               vu.location::geography,
                               (
                                 LEAST(
                                   150,
                                   CASE
                                     WHEN COALESCE(cdf.expand_distance, FALSE)
                                       THEN ROUND(LEAST(150, GREATEST(2, COALESCE(cdf.distance_pref_km, 20))) * 1.75)
                                     ELSE LEAST(150, GREATEST(2, COALESCE(cdf.distance_pref_km, 20)))
                                   END
                                 ) * 1000
                               )::double precision
                             )
                         )
                       )
                     )
                   )
                   OR (
                     v.using_switch_city = TRUE
                     AND v.browse_anchor_geog IS NULL
                     AND NULLIF(TRIM(v.preferred_location_city), '') IS NOT NULL
                     AND NULLIF(TRIM(cdf.preferred_location_city), '') IS NOT NULL
                     AND (
                       LOWER(TRIM(v.preferred_location_city)) = LOWER(TRIM(cdf.preferred_location_city))
                       OR LOWER(TRIM(SPLIT_PART(v.preferred_location_city, ',', 1))) =
                          LOWER(TRIM(SPLIT_PART(cdf.preferred_location_city, ',', 1)))
                     )
                   )
                 )
               )
               OR (
                 vu.location IS NULL
                 AND NULLIF(TRIM(v.preferred_location_city), '') IS NOT NULL
                 AND NULLIF(TRIM(cdf.preferred_location_city), '') IS NOT NULL
                 AND (
                   LOWER(TRIM(v.preferred_location_city)) = LOWER(TRIM(cdf.preferred_location_city))
                   OR LOWER(TRIM(SPLIT_PART(v.preferred_location_city, ',', 1))) =
                      LOWER(TRIM(SPLIT_PART(cdf.preferred_location_city, ',', 1)))
                 )
               )
             )
         )
         AND c.age_years BETWEEN v.age_min AND v.age_max
         AND (
           EXISTS (
             SELECT 1
             FROM user_filter_preferred_genders ufg
             WHERE ufg.user_id = v.user_id
               AND ufg.gender = c.gender_main
           )
           OR NOT EXISTS (
             SELECT 1 FROM user_filter_preferred_genders WHERE user_id = v.user_id
           )
         )
         AND (
           EXISTS (
             SELECT 1
             FROM user_filter_preferred_genders cufg
             WHERE cufg.user_id = c.id
               AND cufg.gender = vu.gender_main
           )
           OR NOT EXISTS (
             SELECT 1 FROM user_filter_preferred_genders WHERE user_id = c.id
           )
         )
         AND EXISTS (
           SELECT 1
           FROM user_filters cf
           WHERE cf.user_id = c.id
             AND vu.age_years BETWEEN cf.age_min AND cf.age_max
         )
         AND NOT EXISTS (
           SELECT 1
           FROM friendships f
           WHERE (f.u1_id = v.user_id AND f.u2_id = c.id)
              OR (f.u1_id = c.id AND f.u2_id = v.user_id)
         )
         AND NOT EXISTS (
           SELECT 1
           FROM blocks b
           WHERE (b.blocker_id = v.user_id AND b.blocked_id = c.id)
              OR (b.blocker_id = c.id AND b.blocked_id = v.user_id)
         )
         AND NOT EXISTS (
           SELECT 1
           FROM user_interactions ui
           WHERE ui.user_id = v.user_id
             AND ui.target_id = c.id
             AND (
               (ui.interaction_type IN ('IGNORE', 'VIEWED') AND ui.expires_at > NOW())
               OR (ui.interaction_type IN ('REQUEST', 'COMMENT_REQUEST') AND ui.request_status = 'IGNORED')
               OR (ui.interaction_type IN ('REQUEST', 'COMMENT_REQUEST') AND ui.request_status = 'PENDING')
             )
         )
         AND NOT EXISTS (
           SELECT 1
           FROM user_interactions ui
           WHERE ui.user_id = c.id
             AND ui.target_id = v.user_id
             AND ui.interaction_type IN ('REQUEST', 'COMMENT_REQUEST')
             AND ui.request_status IN ('IGNORED', 'PENDING')
         )
         AND (
           CARDINALITY(v.filter_languages) = 0
           OR EXISTS (
             SELECT 1
             FROM user_languages cl
             WHERE cl.user_id = c.id
               AND cl.language = ANY(v.filter_languages)
           )
         )
     ),
     eligible_candidates AS (
       SELECT id FROM eligible_candidate_staging WHERE adv_match
       UNION ALL
       SELECT ecs.id
       FROM eligible_candidate_staging ecs
       CROSS JOIN viewer v
       WHERE NOT ecs.adv_match
         AND v.premium_effective
         AND v.show_other_people_if_run_out
         AND v.filter_advanced_active
     ),
     story_rows AS (
       SELECT s.id AS story_id,
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
           OR (
             COALESCE(s.audience, 'EVERYONE') = 'EVERYONE'
             AND EXISTS (SELECT 1 FROM eligible_candidates ec WHERE ec.id = s.user_id)
           )
         )
     ),
     eligible_owner_ids AS (
       SELECT user_id,
              BOOL_OR(NOT viewed_by_viewer) AS viewer_has_unseen_story,
              BOOL_OR(is_friend) AS is_friend,
              (user_id = $1::uuid) AS is_self
       FROM story_rows
       GROUP BY user_id
       ORDER BY is_self DESC, viewer_has_unseen_story DESC, user_id
       LIMIT $11::int
     )
     SELECT sr.*
     FROM story_rows sr
     JOIN eligible_owner_ids eo ON eo.user_id = sr.user_id
     ORDER BY sr.user_id, sr.created_at ASC`,
    [viewerId, distanceKm, ageMin, ageMax, onlyVerified, browseAnchorLat, browseAnchorLng, anchorArrays.anchorLabelNorms, anchorArrays.anchorLats, anchorArrays.anchorLngs, maxUsers]
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

/**
 * Single-peer reel for notification deep-links when the sender is omitted from the feed-filtered home reel.
 * Visibility matches story viewing rules (blocked hidden; FRIENDS_ONLY requires friendship; EVERYONE allowed).
 */
async function listStoryReelForNotificationPeer(viewerId, peerUserId) {
  const peer = String(peerUserId || "").trim();
  const uuidRe =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidRe.test(peer)) {
    const e = new Error("Invalid peer user id");
    e.code = "PEER_INVALID";
    throw e;
  }
  if (peer === viewerId) {
    return { users: [] };
  }

  const res = await query(
    `SELECT s.id AS story_id,
            s.user_id,
            s.media_url,
            s.media_type::text AS media_type,
            s.created_at,
            s.expires_at,
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
     WHERE s.user_id = $2::uuid
       AND s.deleted_at IS NULL
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
     ORDER BY s.created_at ASC`,
    [viewerId, peer]
  );

  if (res.rows.length === 0) {
    return { users: [] };
  }

  const row0 = res.rows[0];
  const uid = row0.user_id;
  const entry = {
    userId: uid,
    name: displayNameForPrivacy(row0.name, row0.hide_my_name === true),
    ageYears: row0.age_years != null ? Number(row0.age_years) : 0,
    verified: row0.is_verified === true,
    isFriend: row0.is_friend === true,
    isSelf: uid === viewerId,
    primaryPhotoUrl: await s3Media.presignReadIfOurS3Object(String(row0.primary_photo_url || "").trim()),
    viewerHasUnseenStory: false,
    stories: [],
  };

  for (const row of res.rows) {
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
  entry.stories.sort((a, b) => {
    if (a._viewedByViewer !== b._viewedByViewer) {
      return a._viewedByViewer ? 1 : -1;
    }
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return ta - tb;
  });
  entry.stories = entry.stories.map(({ _viewedByViewer, ...rest }) => rest);

  return { users: [entry] };
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
  listStoryReelForNotificationPeer,
  getViewerStoryState,
  areFriends,
  countStoryViews,
};
