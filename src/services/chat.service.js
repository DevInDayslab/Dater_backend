const { pool, query } = require("../config/db");
const moderationReports = require("./moderationReports.service");
const s3Media = require("./s3Media.service");
const { displayNameForPrivacy, formatNotificationPersonTitle } = require("../utils/displayName");
const { sendEventDataNotification } = require("./pushNotification.service");

const ONLINE_ACTIVE_WINDOW_MS = 3 * 60 * 1000;

function normalizeGender(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (raw === "male" || raw === "man" || raw === "m") return "male";
  if (raw === "female" || raw === "woman" || raw === "f") return "female";
  if (raw === "nonbinary" || raw === "non-binary" || raw === "non binary" || raw === "nb") {
    return "non-binary";
  }
  return raw;
}

function isPremiumEffective(row) {
  if (!row) return false;
  if (row.is_premium === true) return true;
  const startMs = row.premium_started_at ? new Date(row.premium_started_at).getTime() : null;
  const endMs = row.premium_expires_at ? new Date(row.premium_expires_at).getTime() : null;
  const now = Date.now();
  return Number.isFinite(startMs) && Number.isFinite(endMs) && startMs <= now && now < endMs;
}

function isSenderRestricted(senderGender, receiverGender) {
  const s = normalizeGender(senderGender);
  const r = normalizeGender(receiverGender);
  if (s === "male" && (r === "female" || r === "male" || r === "non-binary")) return true;
  if (s === "non-binary" && r === "female") return true;
  return false;
}

function normalizedPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

function isUuidLike(value) {
  const v = String(value || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

async function normalizePrimaryPhotoUrl(rawUrl) {
  return s3Media.presignReadIfOurS3Object(String(rawUrl || "").trim());
}

async function ensureParticipant(threadId, userId) {
  const res = await query(
    `SELECT 1
     FROM chat_thread_participants
     WHERE thread_id = $1 AND user_id = $2
     LIMIT 1`,
    [threadId, userId]
  );
  return res.rowCount > 0;
}

async function getThreadPeer(threadId, viewerId) {
  const res = await query(
    `SELECT u.id,
            u.name,
            u.hide_my_name,
            u.gender_main,
            u.gender,
            u.is_premium,
            u.premium_started_at,
            u.premium_expires_at
     FROM chat_thread_participants p
     JOIN users u ON u.id = p.user_id
     WHERE p.thread_id = $1
       AND p.user_id <> $2
     LIMIT 1`,
    [threadId, viewerId]
  );
  return res.rows[0] || null;
}

async function acquireChatSendLock(client, threadId, senderId) {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [`chat-send:${String(threadId || "").trim()}:${String(senderId || "").trim()}`]
  );
}

async function evaluateChatLockWithRunner(runQuery, { threadId, senderId }, { lockRestrictionRow = false } = {}) {
  const senderRes = await runQuery(
    `SELECT id, gender_main, gender, is_premium, premium_started_at, premium_expires_at
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [senderId]
  );
  const sender = senderRes.rows[0];
  if (!sender) {
    const error = new Error("Sender not found");
    error.code = "SENDER_NOT_FOUND";
    throw error;
  }
  if (isPremiumEffective(sender)) {
    return { isLocked: false, reason: "PREMIUM", unlocksAt: null };
  }

  const peerRes = await runQuery(
    `SELECT u.id,
            u.name,
            u.gender_main,
            u.gender,
            u.is_premium,
            u.premium_started_at,
            u.premium_expires_at
     FROM chat_thread_participants p
     JOIN users u ON u.id = p.user_id
     WHERE p.thread_id = $1
       AND p.user_id <> $2
     LIMIT 1`,
    [threadId, senderId]
  );
  const peer = peerRes.rows[0] || null;
  if (!peer) {
    const error = new Error("Thread peer not found");
    error.code = "THREAD_PEER_NOT_FOUND";
    throw error;
  }
  const senderGender = sender.gender_main || sender.gender;
  const peerGender = peer.gender_main || peer.gender;
  if (!isSenderRestricted(senderGender, peerGender)) {
    return { isLocked: false, reason: "UNRESTRICTED_MATRIX", unlocksAt: null };
  }

  if (lockRestrictionRow) {
    await runQuery(
      `INSERT INTO chat_restrictions (user_id, target_id, message_count, is_unlocked)
       VALUES ($1, $2, 0, FALSE)
       ON CONFLICT (user_id, target_id) DO NOTHING`,
      [senderId, peer.id]
    );
  }
  const restrictionsRes = await runQuery(
    `SELECT is_unlocked, is_locally_unlocked
     FROM chat_restrictions
     WHERE user_id = $1 AND target_id = $2
     ${lockRestrictionRow ? "FOR UPDATE" : ""}
     LIMIT 1`,
    [senderId, peer.id]
  );
  const restriction = restrictionsRes.rows[0];
  if (restriction?.is_unlocked === true || restriction?.is_locally_unlocked === true) {
    return { isLocked: false, reason: "CHAT_UNLOCKED", unlocksAt: null };
  }

  const countRes = await runQuery(
    `SELECT COUNT(*)::int AS c,
            MAX(created_at) AS latest_at
     FROM chat_messages
     WHERE thread_id = $1
       AND sender_type = 'USER'
       AND sender_user_id = $2
       AND deleted_at IS NULL
       AND created_at > NOW() - INTERVAL '1 hour'`,
    [threadId, senderId]
  );
  const count = Number(countRes.rows[0]?.c || 0);
  if (count < 3) {
    return { isLocked: false, reason: "ALLOW_WINDOW", unlocksAt: null };
  }
  const latest = countRes.rows[0]?.latest_at;
  const unlocksAt = latest ? new Date(new Date(latest).getTime() + 60 * 60 * 1000).toISOString() : null;
  return { isLocked: true, reason: "RATE_LIMIT", unlocksAt };
}

async function evaluateChatLock({ threadId, senderId }, { client = null, lockRestrictionRow = false } = {}) {
  const runQuery = client?.query?.bind(client) || query;
  return evaluateChatLockWithRunner(runQuery, { threadId, senderId }, { lockRestrictionRow });
}

async function listThreads(viewerId, { sort = "RECENT", search = "" } = {}) {
  const normalizedSort = String(sort || "RECENT").trim().toUpperCase();
  const q = String(search || "").trim();
  let orderClause = "COALESCE(t.last_message_at, t.created_at) DESC";
  if (normalizedSort === "NEARBY") orderClause = "distance_km ASC NULLS LAST, COALESCE(t.last_message_at, t.created_at) DESC";
  if (normalizedSort === "UNREAD") orderClause = "CASE WHEN COALESCE(s.unread_count_cache, 0) > 0 THEN 0 ELSE 1 END, COALESCE(t.last_message_at, t.created_at) DESC";
  if (normalizedSort === "UNANSWERED") orderClause = "CASE WHEN s.last_inbound_message_at IS NOT NULL AND (s.last_outbound_message_at IS NULL OR s.last_outbound_message_at < s.last_inbound_message_at) THEN 0 ELSE 1 END, COALESCE(t.last_message_at, t.created_at) DESC";
  const params = [viewerId];
  let searchClause = "";
  if (q) {
    params.push(`%${q}%`);
    searchClause =
      "AND (COALESCE(u.name, CASE WHEN COALESCE(s.relationship_state::text, 'ACTIVE') = 'DELETED_ACCOUNT' THEN 'Deleted Account' ELSE '' END) ILIKE $2 OR COALESCE(last_message.message_text, '') ILIKE $2)";
  }
  const res = await query(
    `SELECT t.id AS thread_id,
            COALESCE(u.id::text, other.user_id::text, state_other.user_id::text, '_deleted_account_') AS peer_user_id,
            COALESCE(u.name, CASE WHEN COALESCE(s.relationship_state::text, 'ACTIVE') = 'DELETED_ACCOUNT' THEN 'Deleted Account' ELSE '' END) AS peer_name,
            u.hide_my_name AS peer_hide_my_name,
            u.last_active_at AS peer_last_active_at,
            COALESCE(s.unread_count_cache, 0)::int AS unread_count,
            (
              s.last_inbound_message_at IS NOT NULL
              AND (s.last_outbound_message_at IS NULL OR s.last_outbound_message_at < s.last_inbound_message_at)
            ) AS has_reply_badge,
            COALESCE(pref.is_muted, false) AS is_muted,
            COALESCE(s.relationship_state::text, 'ACTIVE') AS relationship_state,
            s.relationship_state_set_at AS relationship_state_set_at,
            s.relationship_state_expires_at AS relationship_state_expires_at,
            COALESCE(s.pinned_to_bottom, false) AS pinned_to_bottom,
            s.can_view_profile,
            (
              SELECT up.photo_url
              FROM user_photos up
              WHERE up.user_id = u.id
                AND up.deleted_at IS NULL
                AND up.moderation_status = 'APPROVED'
              ORDER BY up.is_primary DESC, up.photo_order ASC
              LIMIT 1
            ) AS primary_photo_url,
            COALESCE(last_message.message_text, '') AS last_message_text,
            last_message.created_at AS last_message_at,
            COALESCE((last_message.sender_user_id = $1), false) AS last_message_from_me,
            EXISTS (
              SELECT 1
              FROM stories st
              WHERE st.user_id = u.id
                AND st.deleted_at IS NULL
                AND st.expires_at > NOW()
            ) AS has_story_active,
            EXISTS (
              SELECT 1
              FROM stories st
              WHERE st.user_id = u.id
                AND st.deleted_at IS NULL
                AND st.expires_at > NOW()
                AND NOT EXISTS (
                  SELECT 1 FROM story_interactions si
                  WHERE si.story_id = st.id
                    AND si.actor_user_id = $1::uuid
                    AND si.interaction_type = 'VIEW'
                )
            ) AS story_ring_has_unseen,
            CASE
              WHEN u.location IS NOT NULL
               AND (SELECT v.location FROM users v WHERE v.id = $1 LIMIT 1) IS NOT NULL
              THEN ST_Distance(
                u.location::geography,
                (SELECT v.location FROM users v WHERE v.id = $1 LIMIT 1)::geography
              ) / 1000.0
              ELSE NULL
            END AS distance_km
     FROM chat_threads t
     JOIN chat_thread_participants mine ON mine.thread_id = t.id AND mine.user_id = $1
     LEFT JOIN LATERAL (
       SELECT p.user_id
       FROM chat_thread_participants p
       WHERE p.thread_id = t.id
         AND p.user_id <> $1
       LIMIT 1
     ) other ON true
     LEFT JOIN LATERAL (
       SELECT s2.user_id
       FROM chat_thread_user_state s2
       WHERE s2.thread_id = t.id
         AND s2.user_id <> $1
       LIMIT 1
     ) state_other ON true
     LEFT JOIN users u ON u.id = other.user_id
     LEFT JOIN chat_thread_user_state s ON s.thread_id = t.id AND s.user_id = $1
     LEFT JOIN chat_user_pair_preferences pref ON pref.user_id = $1 AND pref.target_id = u.id
     LEFT JOIN LATERAL (
      SELECT m.message_text, m.created_at, m.sender_user_id
       FROM chat_messages m
       WHERE m.thread_id = t.id
         AND m.deleted_at IS NULL
       ORDER BY m.created_at DESC
       LIMIT 1
     ) AS last_message ON true
     WHERE (
         COALESCE(s.relationship_state::text, 'ACTIVE') = 'DELETED_ACCOUNT'
         OR (
           u.id IS NOT NULL
           AND u.deleted_at IS NULL
           AND u.account_state NOT IN ('DELETED', 'BANNED', 'UNDERAGE_BLOCKED')
         )
       )
       AND EXISTS (
         SELECT 1
         FROM chat_messages em
         WHERE em.thread_id = t.id
           AND em.deleted_at IS NULL
       )
       AND COALESCE(s.is_deleted_from_inbox, false) = false
       AND (
         COALESCE(s.relationship_state::text, 'ACTIVE') <> 'CHAT_ENDED'
         OR COALESCE(s.relationship_state_set_at, NOW()) >= NOW() - INTERVAL '3 days'
       )
       ${searchClause}
     ORDER BY CASE WHEN COALESCE(s.pinned_to_bottom, false) THEN 1 ELSE 0 END, ${orderClause}`,
    params
  );
  const items = await Promise.all(
    res.rows.map(async (row) => ({
      threadId: row.thread_id,
      peerUserId: row.peer_user_id,
      name: displayNameForPrivacy(row.peer_name, row.peer_hide_my_name === true),
      primaryPhotoUrl: await normalizePrimaryPhotoUrl(row.primary_photo_url || ""),
      lastMessage: row.last_message_text || "",
      lastMessageAt: row.last_message_at ? new Date(row.last_message_at).toISOString() : null,
      lastMessageFromMe: row.last_message_from_me === true,
      peerLastActiveAt: row.peer_last_active_at ? new Date(row.peer_last_active_at).toISOString() : null,
      unreadCount: Number(row.unread_count || 0),
      hasReplyBadge: row.has_reply_badge === true,
      isMuted: row.is_muted === true,
      relationshipState: row.relationship_state || "ACTIVE",
      relationshipStateSetAt: row.relationship_state_set_at
        ? new Date(row.relationship_state_set_at).toISOString()
        : null,
      relationshipStateExpiresAt: row.relationship_state_expires_at
        ? new Date(row.relationship_state_expires_at).toISOString()
        : null,
      canViewProfile: row.can_view_profile !== false,
      hasStoryActive: row.has_story_active === true,
      viewerHasUnseenStory: row.story_ring_has_unseen === true,
      isOnline: row.peer_last_active_at
        ? new Date(row.peer_last_active_at).getTime() >= Date.now() - ONLINE_ACTIVE_WINDOW_MS
        : false,
      distanceKm: row.distance_km != null ? Number(row.distance_km) : null,
    }))
  );
  return items;
}

async function unfriendByThread(viewerId, threadId) {
  const ok = await ensureParticipant(threadId, viewerId);
  if (!ok) {
    const error = new Error("Thread not found");
    error.code = "THREAD_NOT_FOUND";
    throw error;
  }
  const peer = await getThreadPeer(threadId, viewerId);
  if (!peer) {
    const error = new Error("Thread peer not found");
    error.code = "THREAD_PEER_NOT_FOUND";
    throw error;
  }
  const [u1, u2] = normalizedPair(viewerId, peer.id);
  await query(`DELETE FROM friendships WHERE u1_id = $1 AND u2_id = $2`, [u1, u2]);
  await query(
    `UPDATE chat_thread_user_state
     SET is_deleted_from_inbox = true,
         deleted_from_inbox_at = NOW(),
         updated_at = NOW()
     WHERE thread_id = $1
       AND user_id = $2`,
    [threadId, viewerId]
  );
  await query(
    `UPDATE chat_thread_user_state
     SET relationship_state = 'CHAT_ENDED',
         relationship_state_set_at = NOW(),
         relationship_state_expires_at = NOW() + INTERVAL '3 days',
         can_report = true,
         can_view_profile = false,
         pinned_to_bottom = true,
         is_deleted_from_inbox = false,
         updated_at = NOW()
     WHERE thread_id = $1
       AND user_id = $2`,
    [threadId, peer.id]
  );
  return { success: true };
}

async function blockByThread(viewerId, threadId, reason = "") {
  const ok = await ensureParticipant(threadId, viewerId);
  if (!ok) {
    const error = new Error("Thread not found");
    error.code = "THREAD_NOT_FOUND";
    throw error;
  }
  const peer = await getThreadPeer(threadId, viewerId);
  if (!peer) {
    const error = new Error("Thread peer not found");
    error.code = "THREAD_PEER_NOT_FOUND";
    throw error;
  }
  await query(
    `INSERT INTO blocks (blocker_id, blocked_id, reason)
     VALUES ($1, $2, $3)
     ON CONFLICT (blocker_id, blocked_id)
     DO UPDATE SET reason = EXCLUDED.reason, created_at = NOW()`,
    [viewerId, peer.id, String(reason || "").trim() || null]
  );
  const [u1, u2] = normalizedPair(viewerId, peer.id);
  await query(`DELETE FROM friendships WHERE u1_id = $1 AND u2_id = $2`, [u1, u2]);
  await query(
    `UPDATE chat_thread_user_state
     SET relationship_state = 'BLOCKED',
         relationship_state_set_at = NOW(),
         relationship_state_expires_at = NULL,
         can_report = false,
         can_view_profile = false,
         pinned_to_bottom = true,
         is_deleted_from_inbox = true,
         deleted_from_inbox_at = NOW(),
         updated_at = NOW()
     WHERE thread_id = $1
       AND user_id IN ($2, $3)`,
    [threadId, viewerId, peer.id]
  );
  return { success: true };
}

async function reportByThread(viewerId, threadId, reason) {
  const ok = await ensureParticipant(threadId, viewerId);
  if (!ok) {
    const error = new Error("Thread not found");
    error.code = "THREAD_NOT_FOUND";
    throw error;
  }
  const normalizedReason = String(reason || "").trim();
  if (!normalizedReason) {
    const error = new Error("Report reason is required");
    error.code = "REPORT_REASON_REQUIRED";
    throw error;
  }
  const peer = await getThreadPeer(threadId, viewerId);
  if (!peer) {
    const error = new Error("Thread peer not found");
    error.code = "THREAD_PEER_NOT_FOUND";
    throw error;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO reports (reporter_id, reported_id, content_type, reason, chat_thread_id)
       VALUES ($1, $2, 'CHAT'::report_content_type_enum, $3, $4::uuid)`,
      [viewerId, peer.id, normalizedReason, threadId]
    );
    const agg = await moderationReports.applyReportMilestonesForReportedUser(client, peer.id);
    await client.query("COMMIT");
    return { success: true, ...agg };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

async function listThreadMessages(viewerId, threadId, { limit = 50, before = null } = {}) {
  const ok = await ensureParticipant(threadId, viewerId);
  if (!ok) {
    const error = new Error("Thread not found");
    error.code = "THREAD_NOT_FOUND";
    throw error;
  }
  const normalizedLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const params = [threadId, normalizedLimit];
  let beforeClause = "";
  if (before) {
    params.push(before);
    beforeClause = "AND m.created_at < $3::timestamptz";
  }
  const res = await query(
    `SELECT m.id,
            m.sender_user_id,
            m.message_text,
            m.message_type::text AS message_type,
            m.referenced_story_id,
            m.referenced_story_reply_id,
            m.created_at,
            m.reply_to_message_id,
            rm.sender_user_id AS reply_sender_user_id,
            rm.message_text AS reply_message_text,
            st.user_id AS referenced_story_owner_id,
            st.media_url AS referenced_story_media_url
     FROM chat_messages m
     LEFT JOIN chat_messages rm ON rm.id = m.reply_to_message_id
     LEFT JOIN stories st ON st.id = m.referenced_story_id
     WHERE m.thread_id = $1
       AND m.deleted_at IS NULL
       ${beforeClause}
     ORDER BY m.created_at DESC
     LIMIT $2`,
    params
  );
  const rows = [...res.rows].reverse();
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      senderUserId: row.sender_user_id || "",
      text: row.message_text || "",
      messageType: row.message_type || "TEXT",
      storyId: row.referenced_story_id || "",
      storyOwnerUserId: row.referenced_story_owner_id || "",
      storyPreviewUrl: await s3Media.presignReadIfOurS3Object(row.referenced_story_media_url || ""),
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      isFromMe: (row.sender_user_id || "") === viewerId,
      replyToMessageId: row.reply_to_message_id || "",
      replySenderUserId: row.reply_sender_user_id || "",
      replyMessageText: row.reply_message_text || "",
    }))
  );
}

/** True if recipient has muted this sender (WhatsApp-style: no push / FCM for that thread peer). */
async function recipientHasMutedSender(recipientUserId, senderUserId) {
  const recipient = String(recipientUserId || "").trim();
  const sender = String(senderUserId || "").trim();
  if (!recipient || !sender || recipient === sender) return false;
  const res = await query(
    `SELECT COALESCE(pref.is_muted, false) AS is_muted
     FROM chat_user_pair_preferences pref
     WHERE pref.user_id = $1::uuid AND pref.target_id = $2::uuid
     LIMIT 1`,
    [recipient, sender]
  );
  return res.rows[0]?.is_muted === true;
}

async function sendMessage(viewerId, threadId, text, replyToMessageId = "") {
  const body = String(text || "").trim();
  if (!body) {
    const error = new Error("Message text is required");
    error.code = "MESSAGE_TEXT_REQUIRED";
    throw error;
  }
  const client = await pool.connect();
  let peerUserId = "";
  try {
    await client.query("BEGIN");
    const okRes = await client.query(
      `SELECT 1
       FROM chat_thread_participants
       WHERE thread_id = $1 AND user_id = $2
       LIMIT 1`,
      [threadId, viewerId]
    );
    if (okRes.rowCount === 0) {
      const error = new Error("Thread not found");
      error.code = "THREAD_NOT_FOUND";
      throw error;
    }
    const viewerStateRes = await client.query(
      `SELECT COALESCE(is_deleted_from_inbox, false) AS is_deleted_from_inbox,
              COALESCE(relationship_state::text, 'ACTIVE') AS relationship_state
       FROM chat_thread_user_state
       WHERE thread_id = $1
         AND user_id = $2
       LIMIT 1`,
      [threadId, viewerId]
    );
    const viewerState = viewerStateRes.rows[0];
    if (
      viewerState &&
      (viewerState.is_deleted_from_inbox === true ||
        ["CHAT_ENDED", "BLOCKED", "DELETED_ACCOUNT"].includes(
          String(viewerState.relationship_state || "").trim().toUpperCase()
        ))
    ) {
      const error = new Error("Chat unavailable");
      error.code = "CHAT_UNAVAILABLE";
      throw error;
    }
    await acquireChatSendLock(client, threadId, viewerId);
    const lock = await evaluateChatLock(
      { threadId, senderId: viewerId },
      { client, lockRestrictionRow: true }
    );
    if (lock.isLocked) {
      const error = new Error("Chat is temporarily locked");
      error.code = "CHAT_LOCKED_PAYWALL";
      error.unlocksAt = lock.unlocksAt;
      throw error;
    }
    const rawReplyId = String(replyToMessageId || "").trim();
    const normalizedReplyId = isUuidLike(rawReplyId) ? rawReplyId : "";
    let safeReplyId = null;
    if (normalizedReplyId && isUuidLike(normalizedReplyId)) {
      const replyRes = await client.query(
        `SELECT id
         FROM chat_messages
         WHERE id = $1
           AND thread_id = $2
           AND deleted_at IS NULL
         LIMIT 1`,
        [normalizedReplyId, threadId]
      );
      if (replyRes.rowCount > 0) safeReplyId = normalizedReplyId;
    }
    const insertRes = await client.query(
      `INSERT INTO chat_messages (thread_id, sender_type, sender_user_id, message_type, message_text, reply_to_message_id)
       VALUES ($1, 'USER', $2, 'TEXT', $3, $4)
       RETURNING id, created_at`,
      [threadId, viewerId, body, safeReplyId]
    );
    const message = insertRes.rows[0];
    const peerRes = await client.query(
      `SELECT p.user_id AS peer_user_id
       FROM chat_thread_participants p
       WHERE p.thread_id = $1
         AND p.user_id <> $2
       LIMIT 1`,
      [threadId, viewerId]
    );
    peerUserId = String(peerRes.rows[0]?.peer_user_id || "").trim();
    const senderRes = await client.query(
      `SELECT name, hide_my_name, age_years
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [viewerId]
    );
    const sRow = senderRes.rows[0];
    const pushTitle = formatNotificationPersonTitle(sRow?.name, sRow?.hide_my_name === true, sRow?.age_years);
    await client.query(`UPDATE chat_threads SET last_message_at = NOW() WHERE id = $1`, [threadId]);
    await client.query(
    `UPDATE chat_thread_user_state
     SET unread_count_cache = 0,
         has_reply_badge = false,
         last_outbound_message_at = NOW(),
         updated_at = NOW()
     WHERE thread_id = $1
       AND user_id = $2`,
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
     WHERE thread_id = $1
       AND user_id <> $2`,
      [threadId, viewerId]
    );
    await client.query("COMMIT");
    if (peerUserId) {
      (async () => {
        let muted = false;
        try {
          muted = await recipientHasMutedSender(peerUserId, viewerId);
        } catch (_) {
          muted = false;
        }
        if (muted) return;
        sendEventDataNotification({
          recipientUserId: peerUserId,
          actorUserId: viewerId,
          eventType: "CHAT_DM",
          title: pushTitle,
          body: body,
          chatId: threadId,
          extraData: { senderId: viewerId },
        }).catch((error) => {
          console.warn("[push] chat DM delivery failed", {
            recipientUserId: peerUserId,
            threadId,
            error: error?.message || error,
          });
        });
      })();
    }
    return {
      id: message.id,
      createdAt: message.created_at ? new Date(message.created_at).toISOString() : null,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function unlockThreadLocally(viewerId, threadId) {
  const ok = await ensureParticipant(threadId, viewerId);
  if (!ok) {
    const error = new Error("Thread not found");
    error.code = "THREAD_NOT_FOUND";
    throw error;
  }
  const peer = await getThreadPeer(threadId, viewerId);
  if (!peer) {
    const error = new Error("Thread peer not found");
    error.code = "THREAD_PEER_NOT_FOUND";
    throw error;
  }
  await query(
    `INSERT INTO chat_restrictions (user_id, target_id, is_locally_unlocked, updated_at)
     VALUES ($1, $2, true, NOW())
     ON CONFLICT (user_id, target_id)
     DO UPDATE SET is_locally_unlocked = true, updated_at = NOW()`,
    [viewerId, peer.id]
  );
  await query(
    `INSERT INTO chat_unlock_events (user_id, target_id)
     VALUES ($1, $2)`,
    [viewerId, peer.id]
  );
  return { success: true };
}

/** Inbox visibility + thread state filter (matches [listThreads] / unread logic). */
const CHAT_INBOX_VISIBILITY_WHERE = `
     FROM chat_threads t
     JOIN chat_thread_participants mine ON mine.thread_id = t.id AND mine.user_id = $1::uuid
     LEFT JOIN LATERAL (
       SELECT p.user_id
       FROM chat_thread_participants p
       WHERE p.thread_id = t.id AND p.user_id <> $1::uuid
       LIMIT 1
     ) other ON true
     LEFT JOIN users u ON u.id = other.user_id
     LEFT JOIN chat_thread_user_state s ON s.thread_id = t.id AND s.user_id = $1::uuid
     WHERE (
         COALESCE(s.relationship_state::text, 'ACTIVE') = 'DELETED_ACCOUNT'
         OR (
           u.id IS NOT NULL
           AND u.deleted_at IS NULL
           AND u.account_state NOT IN ('DELETED', 'BANNED', 'UNDERAGE_BLOCKED')
         )
       )
       AND EXISTS (
         SELECT 1
         FROM chat_messages em
         WHERE em.thread_id = t.id
           AND em.deleted_at IS NULL
       )
       AND COALESCE(s.is_deleted_from_inbox, false) = false
       AND (
         COALESCE(s.relationship_state::text, 'ACTIVE') <> 'CHAT_ENDED'
         OR COALESCE(s.relationship_state_set_at, NOW()) >= NOW() - INTERVAL '3 days'
       )`;

/**
 * Inbox threads that count toward the bottom-nav chat badge (stricter than [listThreads] visibility).
 * Excludes deleted-account / chat-ended rows and muted peers — those may still appear in the inbox list.
 */
const CHAT_NAV_BADGE_VISIBILITY_WHERE = `
     FROM chat_threads t
     JOIN chat_thread_participants mine ON mine.thread_id = t.id AND mine.user_id = $1::uuid
     LEFT JOIN LATERAL (
       SELECT p.user_id
       FROM chat_thread_participants p
       WHERE p.thread_id = t.id AND p.user_id <> $1::uuid
       LIMIT 1
     ) other ON true
     LEFT JOIN users u ON u.id = other.user_id
     LEFT JOIN chat_thread_user_state s ON s.thread_id = t.id AND s.user_id = $1::uuid
     LEFT JOIN chat_user_pair_preferences pref ON pref.user_id = $1::uuid AND pref.target_id = other.user_id
     WHERE u.id IS NOT NULL
       AND u.deleted_at IS NULL
       AND u.account_state NOT IN ('DELETED', 'BANNED', 'UNDERAGE_BLOCKED')
       AND COALESCE(s.relationship_state::text, 'ACTIVE') NOT IN ('DELETED_ACCOUNT', 'CHAT_ENDED')
       AND EXISTS (
         SELECT 1
         FROM chat_messages em
         WHERE em.thread_id = t.id
           AND em.deleted_at IS NULL
       )
       AND COALESCE(s.is_deleted_from_inbox, false) = false
       AND COALESCE(pref.is_muted, false) = false`;

/**
 * Sum of per-thread unread counters for inbox-visible threads (matches listThreads visibility rules).
 */
async function sumUnreadMessages(viewerId) {
  const res = await query(
    `SELECT COALESCE(SUM(COALESCE(s.unread_count_cache, 0)), 0)::bigint AS total
     ${CHAT_INBOX_VISIBILITY_WHERE}`,
    [viewerId]
  );
  return Number(res.rows[0]?.total || 0);
}

/**
 * Distinct inbox threads where the peer messaged last and the viewer has not sent a reply after that
 * (same predicate as UNANSWERED sort). Used for bottom-nav chat badge — one count per person, not per message.
 * Visibility uses [CHAT_NAV_BADGE_VISIBILITY_WHERE] (excludes ended / deleted-account / muted).
 */
async function countThreadsAwaitingViewerReply(viewerId) {
  const res = await query(
    `SELECT COUNT(*)::bigint AS c
     ${CHAT_NAV_BADGE_VISIBILITY_WHERE}
       AND s.last_inbound_message_at IS NOT NULL
       AND (
         s.last_outbound_message_at IS NULL
         OR s.last_outbound_message_at < s.last_inbound_message_at
       )`,
    [viewerId]
  );
  return Number(res.rows[0]?.c || 0);
}

async function markThreadRead(viewerId, threadId) {
  const ok = await ensureParticipant(threadId, viewerId);
  if (!ok) {
    const error = new Error("Thread not found");
    error.code = "THREAD_NOT_FOUND";
    throw error;
  }
  await query(
    `UPDATE chat_thread_user_state
     SET unread_count_cache = 0,
         has_reply_badge = false,
         updated_at = NOW()
     WHERE thread_id = $1
       AND user_id = $2`,
    [threadId, viewerId]
  );
  return { success: true };
}

async function setThreadMuted(viewerId, threadId, muted) {
  const ok = await ensureParticipant(threadId, viewerId);
  if (!ok) {
    const error = new Error("Thread not found");
    error.code = "THREAD_NOT_FOUND";
    throw error;
  }
  const peer = await getThreadPeer(threadId, viewerId);
  if (!peer) {
    const error = new Error("Thread peer not found");
    error.code = "THREAD_PEER_NOT_FOUND";
    throw error;
  }
  await query(
    `INSERT INTO chat_user_pair_preferences (user_id, target_id, is_muted, muted_at, updated_at)
     VALUES ($1, $2, $3, CASE WHEN $3 THEN NOW() ELSE NULL END, NOW())
     ON CONFLICT (user_id, target_id)
     DO UPDATE SET
       is_muted = EXCLUDED.is_muted,
       muted_at = CASE WHEN EXCLUDED.is_muted THEN NOW() ELSE NULL END,
       updated_at = NOW()`,
    [viewerId, peer.id, Boolean(muted)]
  );
  return { success: true };
}

async function deleteThreadFromInbox(viewerId, threadId) {
  const ok = await ensureParticipant(threadId, viewerId);
  if (!ok) {
    const error = new Error("Thread not found");
    error.code = "THREAD_NOT_FOUND";
    throw error;
  }
  await query(
    `UPDATE chat_thread_user_state
     SET is_deleted_from_inbox = true,
         deleted_from_inbox_at = NOW(),
         updated_at = NOW()
     WHERE thread_id = $1
       AND user_id = $2`,
    [threadId, viewerId]
  );
  return { success: true };
}

async function getOrCreateDirectThread(viewerId, targetUserId) {
  const targetId = String(targetUserId || "").trim();
  if (!targetId || targetId === viewerId) {
    const error = new Error("Invalid target user");
    error.code = "INVALID_TARGET_USER";
    throw error;
  }
  const targetRes = await query(
    `SELECT id, name, hide_my_name, last_active_at
     FROM users
     WHERE id = $1
       AND deleted_at IS NULL
       AND account_state NOT IN ('DELETED', 'BANNED', 'UNDERAGE_BLOCKED')
     LIMIT 1`,
    [targetId]
  );
  const target = targetRes.rows[0];
  if (!target) {
    const error = new Error("Target user not found");
    error.code = "TARGET_USER_NOT_FOUND";
    throw error;
  }
  const [u1, u2] = normalizedPair(viewerId, targetId);
  let threadId = "";
  const existing = await query(
    `SELECT t.id
     FROM chat_threads t
     JOIN chat_thread_participants p1 ON p1.thread_id = t.id AND p1.user_id = $1
     JOIN chat_thread_participants p2 ON p2.thread_id = t.id AND p2.user_id = $2
     WHERE t.thread_type = 'DIRECT'
     LIMIT 1`,
    [viewerId, targetId]
  );
  threadId = existing.rows[0]?.id || "";
  if (!threadId) {
    const friendshipRes = await query(
      `SELECT 1
       FROM friendships
       WHERE u1_id = $1
         AND u2_id = $2
       LIMIT 1`,
      [u1, u2]
    );
    if (friendshipRes.rowCount === 0) {
      const error = new Error("Users are not friends");
      error.code = "NOT_FRIENDS";
      throw error;
    }
    const created = await query(
      `INSERT INTO chat_threads (thread_type)
       VALUES ('DIRECT')
       RETURNING id`,
      []
    );
    threadId = created.rows[0].id;
    await query(
      `INSERT INTO chat_thread_participants (thread_id, user_id)
       VALUES ($1, $2), ($1, $3)`,
      [threadId, viewerId, targetId]
    );
  }
  await query(
    `INSERT INTO chat_thread_user_state (thread_id, user_id)
     VALUES ($1, $2), ($1, $3)
     ON CONFLICT (thread_id, user_id) DO NOTHING`,
    [threadId, viewerId, targetId]
  );
  const friendshipRes = await query(
    `SELECT 1
     FROM friendships
     WHERE u1_id = $1
       AND u2_id = $2
     LIMIT 1`,
    [u1, u2]
  );
  if (friendshipRes.rowCount > 0) {
    await query(
      `UPDATE chat_thread_user_state
       SET is_deleted_from_inbox = false,
           deleted_from_inbox_at = NULL,
           relationship_state = 'ACTIVE',
           relationship_state_set_at = NOW(),
           relationship_state_expires_at = NULL,
           can_view_profile = true,
           can_report = true,
           pinned_to_bottom = false,
           updated_at = NOW()
       WHERE thread_id = $1
         AND user_id IN ($2, $3)
         AND relationship_state::text NOT IN ('BLOCKED', 'DELETED_ACCOUNT')`,
      [threadId, viewerId, targetId]
    );
  }
  const viewerStateRes = await query(
    `SELECT COALESCE(is_deleted_from_inbox, false) AS is_deleted_from_inbox,
            COALESCE(relationship_state::text, 'ACTIVE') AS relationship_state
     FROM chat_thread_user_state
     WHERE thread_id = $1
       AND user_id = $2
     LIMIT 1`,
    [threadId, viewerId]
  );
  const viewerState = viewerStateRes.rows[0];
  if (
    viewerState &&
    (viewerState.is_deleted_from_inbox === true ||
      ["CHAT_ENDED", "BLOCKED", "DELETED_ACCOUNT"].includes(
        String(viewerState.relationship_state || "").trim().toUpperCase()
      ))
  ) {
    const error = new Error("Chat unavailable");
    error.code = "CHAT_UNAVAILABLE";
    throw error;
  }
  const photoRes = await query(
    `SELECT photo_url
     FROM user_photos
     WHERE user_id = $1
       AND deleted_at IS NULL
       AND moderation_status = 'APPROVED'
     ORDER BY is_primary DESC, photo_order ASC
     LIMIT 1`,
    [targetId]
  );
  const storyRingRes = await query(
    `SELECT EXISTS (
       SELECT 1 FROM stories st
       WHERE st.user_id = $1::uuid AND st.deleted_at IS NULL AND st.expires_at > NOW()
     ) AS has_active,
     EXISTS (
       SELECT 1 FROM stories st
       WHERE st.user_id = $1::uuid AND st.deleted_at IS NULL AND st.expires_at > NOW()
         AND NOT EXISTS (
           SELECT 1 FROM story_interactions si
           WHERE si.story_id = st.id AND si.actor_user_id = $2::uuid AND si.interaction_type = 'VIEW'
         )
     ) AS has_unseen`,
    [targetId, viewerId]
  );
  const sr = storyRingRes.rows[0] || {};
  return {
    threadId,
    peerUserId: targetId,
    name: displayNameForPrivacy(target.name, target.hide_my_name === true),
    primaryPhotoUrl: await normalizePrimaryPhotoUrl(photoRes.rows[0]?.photo_url || ""),
    hasStoryActive: sr.has_active === true,
    viewerHasUnseenStory: sr.has_unseen === true,
    isOnline: target.last_active_at
      ? new Date(target.last_active_at).getTime() >= Date.now() - ONLINE_ACTIVE_WINDOW_MS
      : false,
    lastActiveAt: target.last_active_at ? new Date(target.last_active_at).toISOString() : null,
  };
}

module.exports = {
  listThreads,
  sumUnreadMessages,
  countThreadsAwaitingViewerReply,
  listThreadMessages,
  sendMessage,
  evaluateChatLock,
  unfriendByThread,
  blockByThread,
  reportByThread,
  unlockThreadLocally,
  markThreadRead,
  setThreadMuted,
  deleteThreadFromInbox,
  getOrCreateDirectThread,
  acquireChatSendLock,
  ensureParticipant,
  getThreadPeer,
};
