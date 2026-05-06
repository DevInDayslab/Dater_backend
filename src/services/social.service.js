const { pool, query } = require("../config/db");
const moderationReports = require("./moderationReports.service");
const s3Media = require("./s3Media.service");
const profileMeExtension = require("./profileMeExtension.service");
const entitlementsService = require("./entitlements.service");
const { displayNameForPrivacy, formatNotificationPersonTitle } = require("../utils/displayName");
const { isNewHereBadgeActive } = require("../utils/newHereBadge");
const { sendEventDataNotification } = require("./pushNotification.service");

const ONLINE_ACTIVE_WINDOW_MS = 3 * 60 * 1000;

/** Free tier: full profile opens tracked in profile_view_events; sliding window. */
const FREE_TIER_PROFILE_VIEW_LIMIT = 20;
const FREE_TIER_PROFILE_VIEW_WINDOW_HOURS = 24;

/** Match users/feed: `is_premium` flag or an in-window subscription interval (column can lag behind expires). */
function viewerPremiumEffective(row) {
  if (!row) return false;
  if (row.is_premium === true) return true;
  const startMs = row.premium_started_at ? new Date(row.premium_started_at).getTime() : null;
  const endMs = row.premium_expires_at ? new Date(row.premium_expires_at).getTime() : null;
  const now = Date.now();
  return (
    Number.isFinite(startMs) &&
    Number.isFinite(endMs) &&
    startMs <= now &&
    now < endMs
  );
}

function buildBasicsPills(profileEdit) {
  const pills = [];
  const height = Number(profileEdit?.basicsHeightInches || 0);
  if (height > 0) pills.push(`${Math.floor(height / 12)}' ${height % 12}"`);
  [
    profileEdit?.basicsDrinking,
    profileEdit?.basicsSmoking,
    profileEdit?.basicsExercise,
    profileEdit?.basicsReligion,
    profileEdit?.basicsEducation,
    profileEdit?.basicsStarSign,
    profileEdit?.basicsKids,
    profileEdit?.basicsPolitical,
    profileEdit?.basicsPets,
    profileEdit?.ethnicity,
  ]
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .forEach((v) => pills.push(v));
  if (Array.isArray(profileEdit?.selectedPronouns) && profileEdit.selectedPronouns.length > 0) {
    pills.push(profileEdit.selectedPronouns.join(", "));
  }
  return pills;
}

/** Shared by feed cards and public profile so relationship UI matches before full profile fetch. */
function buildRelationshipState(row) {
  if (row.is_friend) return "friends";
  if (row.target_sent_pending) return "pending";
  if (row.viewer_ignored) return "ignored";
  if (row.viewer_sent_pending) return "added";
  return "nishtha";
}

function normalizedPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

async function loadApprovedPhotoRowsForUser(userId) {
  const photosRes = await query(
    `SELECT id, photo_url, photo_order, is_primary, moderation_status, blur_hash, s3_key
     FROM user_photos
     WHERE user_id = $1
       AND deleted_at IS NULL
       AND moderation_status = 'APPROVED'
     ORDER BY is_primary DESC, photo_order ASC`,
    [userId]
  );
  return Promise.all(
    photosRes.rows.map(async (p) => {
      let readUrl = p.photo_url;
      if (p.s3_key) {
        try {
          readUrl = await s3Media.getPresignedGetUrl({ key: p.s3_key });
        } catch (_) {}
      }
      return { ...p, photo_url: readUrl };
    })
  );
}

async function normalizePrimaryPhotoUrl(rawUrl) {
  return s3Media.presignReadIfOurS3Object(String(rawUrl || "").trim());
}

async function countRollingProfileViews24h(viewerId, client = null) {
  const runQuery = client?.query?.bind(client) || query;
  const res = await runQuery(
    `SELECT COUNT(*)::int AS c
     FROM profile_view_events
     WHERE viewer_user_id = $1
       AND created_at > NOW() - make_interval(hours => $2::int)`,
    [viewerId, FREE_TIER_PROFILE_VIEW_WINDOW_HOURS]
  );
  return Number(res.rows[0]?.c || 0);
}

async function computeProfileViewsUnlockAt(viewerId, client = null) {
  const runQuery = client?.query?.bind(client) || query;
  /** Unlock when the rolling window expires after the user's most recent tracked view (not the oldest in the set). */
  const res = await runQuery(
    `SELECT (MAX(created_at) + make_interval(hours => $2::int)) AS unlock_at
     FROM profile_view_events
     WHERE viewer_user_id = $1
       AND created_at > NOW() - make_interval(hours => $2::int)`,
    [viewerId, FREE_TIER_PROFILE_VIEW_WINDOW_HOURS]
  );
  const raw = res.rows[0]?.unlock_at;
  return raw ? new Date(raw).toISOString() : null;
}

async function getRollingProfileViewSummary(viewerId) {
  const premRes = await query(
    `SELECT is_premium, premium_started_at, premium_expires_at
     FROM users
     WHERE id = $1 AND deleted_at IS NULL
     LIMIT 1`,
    [viewerId]
  );
  const premRow = premRes.rows[0];
  if (viewerPremiumEffective(premRow)) {
    return {
      rollingCount24h: 0,
      remainingFreeViews: FREE_TIER_PROFILE_VIEW_LIMIT,
      freeDailyViewLimit: FREE_TIER_PROFILE_VIEW_LIMIT,
      profileViewLimitActive: false,
      profileViewsUnlockAt: null,
    };
  }
  const count = await countRollingProfileViews24h(viewerId);
  const remaining = Math.max(0, FREE_TIER_PROFILE_VIEW_LIMIT - count);
  const limitActive = count >= FREE_TIER_PROFILE_VIEW_LIMIT;
  let profileViewsUnlockAt = null;
  if (limitActive) {
    profileViewsUnlockAt = await computeProfileViewsUnlockAt(viewerId);
  }
  return {
    rollingCount24h: count,
    remainingFreeViews: remaining,
    freeDailyViewLimit: FREE_TIER_PROFILE_VIEW_LIMIT,
    profileViewLimitActive: limitActive,
    profileViewsUnlockAt,
  };
}

async function consumeProfileView(viewerId, targetId, source = "FEED", client = null) {
  const runQuery = client?.query?.bind(client) || query;
  const [u1, u2] = normalizedPair(viewerId, targetId);
  const friendsRes = await runQuery(
    `SELECT 1 FROM friendships WHERE u1_id = $1::uuid AND u2_id = $2::uuid LIMIT 1`,
    [u1, u2]
  );
  if (friendsRes.rowCount > 0) {
    /** Friends may open each other's full profile without consuming the free-tier rolling quota. */
    return;
  }
  const viewerRes = await runQuery(
    `SELECT is_premium, premium_started_at, premium_expires_at
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [viewerId]
  );
  const viewer = viewerRes.rows[0];
  if (!viewer) {
    const error = new Error("Viewer not found");
    error.code = "VIEWER_NOT_FOUND";
    throw error;
  }
  if (!viewerPremiumEffective(viewer)) {
    const rollingCount = await countRollingProfileViews24h(viewerId, client);
    if (rollingCount >= FREE_TIER_PROFILE_VIEW_LIMIT) {
      const unlockAt = await computeProfileViewsUnlockAt(viewerId, client);
      const error = new Error("Profile view limit reached");
      error.code = "PROFILE_VIEW_LIMIT_REACHED";
      error.profileViewsUnlockAt = unlockAt;
      throw error;
    }
  }
  await runQuery(
    `INSERT INTO profile_view_events (viewer_user_id, viewed_user_id, source)
     VALUES ($1, $2, $3)`,
    [viewerId, targetId, source]
  );
}

async function upsertFeedMemoryInteraction(viewerId, targetId, interactionType, client = null) {
  const runQuery = client?.query?.bind(client) || query;
  await runQuery(
    `DELETE FROM user_interactions
     WHERE user_id = $1
       AND target_id = $2
       AND interaction_type = $3`,
    [viewerId, targetId, interactionType]
  );
  await runQuery(
    `INSERT INTO user_interactions (user_id, target_id, interaction_type)
     VALUES ($1, $2, $3)`,
    [viewerId, targetId, interactionType]
  );
}

async function getPublicProfile(viewerId, targetUserId, { source = "FEED", consumeView = true } = {}) {
  if (!targetUserId || viewerId === targetUserId) {
    const error = new Error("Invalid target user");
    error.code = "INVALID_TARGET_USER";
    throw error;
  }
  const targetRes = await query(
    `SELECT u.id, u.account_state, u.name, u.hide_my_name, u.age_years, u.gender, u.show_gender_on_profile,
            u.marital_status, u.is_verified, u.new_here_until, u.created_at, u.bio, u.preset_message,
            u.height_inches, u.drinking, u.smoking, u.exercise, u.religion, u.education,
            u.star_sign, u.kids, u.political_leanings, u.pets, u.ethnicity,
            u.occupation_job_title, u.occupation_company, u.education_institution_name,
            u.education_passing_year, u.living_in_city, u.home_town_city, u.living_in_city_mode,
            (SELECT uf.preferred_location_city
               FROM user_filters uf
              WHERE uf.user_id = u.id
              LIMIT 1) AS preferred_location_city,
            CASE
              WHEN u.location IS NOT NULL
               AND (SELECT v.location FROM users v WHERE v.id = $1 LIMIT 1) IS NOT NULL
              THEN ST_Distance(
                u.location::geography,
                (SELECT v.location FROM users v WHERE v.id = $1 LIMIT 1)::geography
              ) / 1000.0
              ELSE NULL
            END AS distance_km,
            EXISTS (
              SELECT 1 FROM friendships f
              WHERE (f.u1_id = $1 AND f.u2_id = u.id) OR (f.u1_id = u.id AND f.u2_id = $1)
            ) AS is_friend,
            EXISTS (
              SELECT 1 FROM user_interactions ui
              WHERE ui.user_id = $1
                AND ui.target_id = u.id
                AND ui.interaction_type IN ('REQUEST', 'COMMENT_REQUEST')
                AND ui.request_status = 'PENDING'
            ) AS viewer_sent_pending,
            EXISTS (
              SELECT 1 FROM user_interactions ui
              WHERE ui.user_id = u.id
                AND ui.target_id = $1
                AND ui.interaction_type IN ('REQUEST', 'COMMENT_REQUEST')
                AND ui.request_status = 'PENDING'
            ) AS target_sent_pending,
            EXISTS (
              SELECT 1 FROM user_interactions ui
              WHERE ui.user_id = $1
                AND ui.target_id = u.id
                AND ui.interaction_type = 'IGNORE'
                AND ui.expires_at > NOW()
            ) AS viewer_ignored
     FROM users u
     WHERE u.id = $2
       AND u.deleted_at IS NULL
       AND u.account_state NOT IN ('DELETED', 'BANNED', 'UNDERAGE_BLOCKED')
     LIMIT 1`,
    [viewerId, targetUserId]
  );
  const user = targetRes.rows[0];
  if (!user) {
    const error = new Error("Profile not found");
    error.code = "PROFILE_NOT_FOUND";
    throw error;
  }

  const acct = String(user.account_state || "");
  if (acct === "PRIVACY_MODE") {
    const allowed = user.is_friend === true || user.target_sent_pending === true;
    if (!allowed) {
      const error = new Error("Profile not found");
      error.code = "PROFILE_NOT_FOUND";
      throw error;
    }
  }

  if (consumeView) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await consumeProfileView(viewerId, targetUserId, source, client);
      await upsertFeedMemoryInteraction(viewerId, targetUserId, "VIEWED", client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const approvedPhotoRows = await loadApprovedPhotoRowsForUser(targetUserId);
  const { profileEdit } = await profileMeExtension.loadProfileMeExtension(
    targetUserId,
    user,
    approvedPhotoRows
  );

  const educationLine = [profileEdit.educationInstitution, profileEdit.educationPassingYear]
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .join(" ");
  const occupationLine = [profileEdit.occupationJobTitle, profileEdit.occupationCompany]
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .join(" at ");
  const prefCity = String(user.preferred_location_city || "").trim();
  const mapCityLine =
    user.living_in_city_mode === "MANUAL_SWITCH"
      ? prefCity || String(user.living_in_city || "").trim()
      : String(user.living_in_city || "").trim();
  const livesInLabel = user.living_in_city ? `Lives in ${user.living_in_city}` : "";

  return {
    userId: user.id,
    name: displayNameForPrivacy(user.name, user.hide_my_name === true),
    age: user.age_years != null ? Number(user.age_years) : 0,
    gender: user.show_gender_on_profile === false ? "" : user.gender || "",
    status: user.marital_status || "",
    verified: user.is_verified === true,
    isNewHere: isNewHereBadgeActive(user),
    relationshipState: buildRelationshipState(user),
    photoUrls: approvedPhotoRows.map((p) => p.photo_url).filter(Boolean),
    bio: profileEdit.bio || "",
    lookingForTags: Array.isArray(profileEdit.lookingForSelected) ? profileEdit.lookingForSelected : [],
    basicsPills: buildBasicsPills(profileEdit),
    interests: Array.isArray(profileEdit.selectedInterests) ? profileEdit.selectedInterests : [],
    languages: Array.isArray(profileEdit.selectedLanguages) ? profileEdit.selectedLanguages : [],
    educationLine,
    occupationLine,
    mapCity: mapCityLine,
    distanceKm: user.distance_km == null ? null : Number(Number(user.distance_km).toFixed(1)),
    livesInLabel,
    fromLabel: user.home_town_city ? `From ${user.home_town_city}` : "",
    livingInCityMode: user.living_in_city_mode || "FOLLOW_DEVICE",
  };
}

const MAX_COMMENT_REQUEST_CHARS = 150;

async function assertEligibleFriendRequestPair(client, viewerId, targetUserId) {
  if (!targetUserId || viewerId === targetUserId) {
    const error = new Error("Invalid target user");
    error.code = "INVALID_TARGET_USER";
    throw error;
  }
  const targetRes = await client.query(
    `SELECT id, account_state FROM users
     WHERE id = $1
       AND deleted_at IS NULL
       AND account_state NOT IN ('DELETED', 'BANNED', 'UNDERAGE_BLOCKED')
     LIMIT 1`,
    [targetUserId]
  );
  const tgt = targetRes.rows[0];
  if (!tgt) {
    const error = new Error("Profile not found");
    error.code = "PROFILE_NOT_FOUND";
    throw error;
  }
  if (String(tgt.account_state) === "PRIVACY_MODE") {
    const error = new Error("This profile is not accepting new requests right now");
    error.code = "PRIVACY_MODE_BLOCKS_REQUEST";
    throw error;
  }
  const [u1, u2] = [viewerId, targetUserId].sort();
  const friendRes = await client.query(
    `SELECT 1 FROM friendships WHERE u1_id = $1 AND u2_id = $2 LIMIT 1`,
    [u1, u2]
  );
  if (friendRes.rowCount > 0) {
    const error = new Error("Already friends");
    error.code = "ALREADY_FRIENDS";
    throw error;
  }
}

/**
 * Ensures a DIRECT thread exists for the pair so friends can chat after accept.
 * Links optional user_interactions row via created_from_interaction_id.
 */
async function ensureDirectChatThreadForPair(client, userA, userB, createdFromInteractionId) {
  const existing = await client.query(
    `SELECT ct.id
     FROM chat_threads ct
     JOIN chat_thread_participants p1
       ON p1.thread_id = ct.id AND p1.user_id = $1 AND p1.left_at IS NULL
     JOIN chat_thread_participants p2
       ON p2.thread_id = ct.id AND p2.user_id = $2 AND p2.left_at IS NULL
     WHERE ct.thread_type = 'DIRECT'
     LIMIT 1`,
    [userA, userB]
  );
  if (existing.rows[0]?.id) {
    return existing.rows[0].id;
  }
  const ins = await client.query(
    `INSERT INTO chat_threads (thread_type, created_from_interaction_id)
     VALUES ('DIRECT', $1)
     RETURNING id`,
    [createdFromInteractionId]
  );
  const threadId = ins.rows[0].id;
  await client.query(
    `INSERT INTO chat_thread_participants (thread_id, user_id)
     VALUES ($1, $2), ($1, $3)`,
    [threadId, userA, userB]
  );
  await client.query(
    `INSERT INTO chat_thread_user_state (thread_id, user_id)
     VALUES ($1, $2), ($1, $3)`,
    [threadId, userA, userB]
  );
  await client.query(
    `INSERT INTO chat_restrictions (user_id, target_id, message_count, is_unlocked)
     VALUES ($1, $2, 0, FALSE)
     ON CONFLICT (user_id, target_id)
     DO NOTHING`,
    [userA, userB]
  );
  await client.query(
    `INSERT INTO chat_restrictions (user_id, target_id, message_count, is_unlocked)
     VALUES ($1, $2, 0, FALSE)
     ON CONFLICT (user_id, target_id)
     DO NOTHING`,
    [userB, userA]
  );
  return threadId;
}

async function sendFriendRequest(viewerId, targetUserId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assertEligibleFriendRequestPair(client, viewerId, targetUserId);
    await client.query(
      `DELETE FROM user_interactions
       WHERE user_id = $1
         AND target_id = $2
         AND interaction_type = 'IGNORE'`,
      [viewerId, targetUserId]
    );
    await client.query(
      `DELETE FROM user_interactions
       WHERE user_id = $1
         AND target_id = $2
         AND interaction_type IN ('REQUEST', 'COMMENT_REQUEST')
         AND request_status = 'PENDING'`,
      [viewerId, targetUserId]
    );
    await client.query(
      `INSERT INTO user_interactions (user_id, target_id, interaction_type, request_status)
       VALUES ($1, $2, 'REQUEST', 'PENDING')`,
      [viewerId, targetUserId]
    );
    await client.query(
      `INSERT INTO notification_events (recipient_user_id, actor_user_id, event_type, is_silent)
       VALUES ($1, $2, 'REQUEST_SENT', FALSE)`,
      [targetUserId, viewerId]
    );
    const senderRes = await client.query(
      `SELECT name, hide_my_name, age_years
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [viewerId]
    );
    const sRow = senderRes.rows[0];
    const pushTitle = formatNotificationPersonTitle(sRow?.name, sRow?.hide_my_name === true, sRow?.age_years);
    await client.query("COMMIT");
    sendEventDataNotification({
      recipientUserId: targetUserId,
      actorUserId: viewerId,
      eventType: "FRIEND_REQUEST_RECEIVED",
      title: pushTitle,
      body: "Sent you a friend request!",
      extraData: { senderId: viewerId },
    }).catch(() => {});
    return getPublicProfile(viewerId, targetUserId, { consumeView: false });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Friend request with custom message (COMMENT_REQUEST). Message 1–150 chars after trim. */
async function sendCommentRequest(viewerId, targetUserId, rawMessage) {
  const message = String(rawMessage || "").trim();
  if (message.length === 0 || message.length > MAX_COMMENT_REQUEST_CHARS) {
    const error = new Error(
      `Comment must be between 1 and ${MAX_COMMENT_REQUEST_CHARS} characters`
    );
    error.code = "INVALID_COMMENT_TEXT";
    throw error;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assertEligibleFriendRequestPair(client, viewerId, targetUserId);
    await entitlementsService.consumePaidCommentsWithClient(client, viewerId, 1, "COMMENT_REQUEST");
    await client.query(
      `DELETE FROM user_interactions
       WHERE user_id = $1
         AND target_id = $2
         AND interaction_type = 'IGNORE'`,
      [viewerId, targetUserId]
    );
    await client.query(
      `DELETE FROM user_interactions
       WHERE user_id = $1
         AND target_id = $2
         AND interaction_type IN ('REQUEST', 'COMMENT_REQUEST')
         AND request_status = 'PENDING'`,
      [viewerId, targetUserId]
    );
    await client.query(
      `INSERT INTO user_interactions (user_id, target_id, interaction_type, comment_text, request_status)
       VALUES ($1, $2, 'COMMENT_REQUEST', $3, 'PENDING')`,
      [viewerId, targetUserId, message]
    );
    await client.query(
      `INSERT INTO notification_events (recipient_user_id, actor_user_id, event_type, is_silent)
       VALUES ($1, $2, 'REQUEST_COMMENT_SENT', FALSE)`,
      [targetUserId, viewerId]
    );
    const senderRes = await client.query(
      `SELECT name, hide_my_name, age_years
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [viewerId]
    );
    const sRow = senderRes.rows[0];
    const pushTitle = formatNotificationPersonTitle(sRow?.name, sRow?.hide_my_name === true, sRow?.age_years);
    await client.query("COMMIT");
    sendEventDataNotification({
      recipientUserId: targetUserId,
      actorUserId: viewerId,
      eventType: "COMMENT",
      title: pushTitle,
      body: "Sent you a comment!",
      extraData: { senderId: viewerId },
    }).catch(() => {});
    return getPublicProfile(viewerId, targetUserId, { consumeView: false });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Pending incoming REQUEST / COMMENT_REQUEST rows visible in the notification centre (same filters as list). */
async function countPendingIncomingFriendRequests(viewerId) {
  const res = await query(
    `SELECT COUNT(*)::int AS c
     FROM user_interactions ui
     JOIN users u ON u.id = ui.user_id
     WHERE ui.target_id = $1
       AND ui.interaction_type IN ('REQUEST', 'COMMENT_REQUEST')
       AND ui.request_status = 'PENDING'
       AND u.deleted_at IS NULL
       AND u.account_state NOT IN ('DELETED', 'BANNED', 'UNDERAGE_BLOCKED')
       AND (
         EXISTS (
           SELECT 1
           FROM user_filter_preferred_genders ufg
           WHERE ufg.user_id = $1
             AND ufg.gender = u.gender_main
         )
         OR (
           NOT EXISTS (SELECT 1 FROM user_filter_preferred_genders WHERE user_id = $1)
           AND (
             EXISTS (
               SELECT 1
               FROM user_dating_preferences udpv
               WHERE udpv.user_id = $1
                 AND udpv.preferred_gender = u.gender_main
             )
             OR NOT EXISTS (SELECT 1 FROM user_dating_preferences WHERE user_id = $1)
           )
         )
       )`,
    [viewerId]
  );
  return Number(res.rows[0]?.c || 0);
}

async function ignoreProfile(viewerId, targetUserId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const incomingPendingRes = await client.query(
      `SELECT id
       FROM user_interactions
       WHERE user_id = $1
         AND target_id = $2
         AND interaction_type IN ('REQUEST', 'COMMENT_REQUEST')
         AND request_status = 'PENDING'
       LIMIT 1`,
      [targetUserId, viewerId]
    );
    if (incomingPendingRes.rows[0]?.id) {
      await client.query(
        `UPDATE user_interactions
         SET request_status = 'IGNORED',
             request_acted_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [incomingPendingRes.rows[0].id]
      );
    } else {
      await upsertFeedMemoryInteraction(viewerId, targetUserId, "IGNORE", client);
    }
    await client.query("COMMIT");
    return { success: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Incoming friend / comment requests for the notification centre.
 * Only PENDING rows where the viewer is the recipient (target_id).
 * Gender filter matches feed semantics (preferred genders or dating preferences fallback).
 */
async function listIncomingFriendRequests(viewerId, { page = 1, pageSize = 30 } = {}) {
  const clamp = (n, min, max, fallback) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return fallback;
    return Math.max(min, Math.min(max, Math.round(v)));
  };
  const normalizedPage = clamp(page, 1, 1000, 1);
  const normalizedPageSize = clamp(pageSize, 1, 50, 30);
  const offset = (normalizedPage - 1) * normalizedPageSize;
  const fetchLimit = normalizedPageSize + 1;
  const res = await query(
    `SELECT ui.id AS interaction_id,
            ui.user_id AS from_user_id,
            ui.interaction_type::text AS interaction_type,
            ui.comment_text,
            ui.created_at,
            u.name,
            u.hide_my_name,
            u.age_years AS age,
            u.is_verified AS verified,
            (
              SELECT up.photo_url
              FROM user_photos up
              WHERE up.user_id = u.id
                AND up.deleted_at IS NULL
                AND up.moderation_status = 'APPROVED'
              ORDER BY up.is_primary DESC, up.photo_order ASC
              LIMIT 1
            ) AS primary_photo_url,
            EXISTS (
              SELECT 1 FROM stories st
              WHERE st.user_id = u.id AND st.deleted_at IS NULL AND st.expires_at > NOW()
            ) AS has_story_active,
            EXISTS (
              SELECT 1 FROM stories st
              WHERE st.user_id = u.id AND st.deleted_at IS NULL AND st.expires_at > NOW()
                AND NOT EXISTS (
                  SELECT 1 FROM story_interactions si
                  WHERE si.story_id = st.id
                    AND si.actor_user_id = $1::uuid
                    AND si.interaction_type = 'VIEW'
                )
            ) AS story_ring_has_unseen
     FROM user_interactions ui
     JOIN users u ON u.id = ui.user_id
     WHERE ui.target_id = $1
       AND ui.interaction_type IN ('REQUEST', 'COMMENT_REQUEST')
       AND ui.request_status = 'PENDING'
       AND u.deleted_at IS NULL
       AND u.account_state NOT IN ('DELETED', 'BANNED', 'UNDERAGE_BLOCKED')
       AND (
         EXISTS (
           SELECT 1
           FROM user_filter_preferred_genders ufg
           WHERE ufg.user_id = $1
             AND ufg.gender = u.gender_main
         )
         OR (
           NOT EXISTS (SELECT 1 FROM user_filter_preferred_genders WHERE user_id = $1)
           AND (
             EXISTS (
               SELECT 1
               FROM user_dating_preferences udpv
               WHERE udpv.user_id = $1
                 AND udpv.preferred_gender = u.gender_main
             )
             OR NOT EXISTS (SELECT 1 FROM user_dating_preferences WHERE user_id = $1)
           )
         )
       )
     ORDER BY ui.created_at DESC, ui.id DESC
     LIMIT $2
     OFFSET $3`,
    [viewerId, fetchLimit, offset]
  );
  const hasMore = res.rows.length > normalizedPageSize;
  const windowRows = hasMore ? res.rows.slice(0, normalizedPageSize) : res.rows;
  const items = await Promise.all(
    windowRows.map(async (row) => ({
      interactionId: row.interaction_id,
      fromUserId: row.from_user_id,
      interactionType: row.interaction_type,
      commentText: row.comment_text || "",
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      name: displayNameForPrivacy(row.name, row.hide_my_name === true),
      age: row.age != null ? Number(row.age) : 0,
      verified: row.verified === true,
      primaryPhotoUrl: await normalizePrimaryPhotoUrl(row.primary_photo_url),
      hasStoryActive: row.has_story_active === true,
      viewerHasUnseenStory: row.story_ring_has_unseen === true,
    }))
  );
  return {
    page: normalizedPage,
    pageSize: normalizedPageSize,
    hasMore,
    items,
  };
}

/** Restores PENDING on an incoming request the viewer had marked IGNORED (notification-centre undo). */
async function undoIncomingFriendRequestIgnore(viewerId, fromUserId) {
  const res = await query(
    `UPDATE user_interactions
     SET request_status = 'PENDING',
         request_acted_at = NULL,
         updated_at = NOW()
     WHERE user_id = $1
       AND target_id = $2
       AND interaction_type IN ('REQUEST', 'COMMENT_REQUEST')
       AND request_status = 'IGNORED'
     RETURNING id`,
    [fromUserId, viewerId]
  );
  if (!res.rows[0]) {
    const err = new Error("No ignored request to undo");
    err.code = "REQUEST_UNDO_NOT_FOUND";
    throw err;
  }
  return { success: true };
}

async function listFriends(viewerId, { sort = "NEARBY" } = {}) {
  const normalizedSort = String(sort || "NEARBY").trim().toUpperCase();
  const orderClause =
    normalizedSort === "RECENT"
      ? "f.created_at DESC, u.name ASC"
      : "distance_km ASC NULLS LAST, f.created_at DESC";
  const res = await query(
    `SELECT u.id AS user_id,
            u.name,
            u.hide_my_name,
            u.age_years AS age,
            u.is_verified AS verified,
            u.living_in_city,
            u.last_active_at,
            f.created_at AS friends_since,
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
            END AS distance_km,
            (
              SELECT up.photo_url
              FROM user_photos up
              WHERE up.user_id = u.id
                AND up.deleted_at IS NULL
                AND up.moderation_status = 'APPROVED'
              ORDER BY up.is_primary DESC, up.photo_order ASC
              LIMIT 1
            ) AS primary_photo_url
     FROM friendships f
     JOIN users u
       ON u.id = CASE WHEN f.u1_id = $1 THEN f.u2_id ELSE f.u1_id END
     WHERE (f.u1_id = $1 OR f.u2_id = $1)
       AND u.deleted_at IS NULL
       AND u.account_state NOT IN ('DELETED', 'BANNED', 'UNDERAGE_BLOCKED')
     ORDER BY ${orderClause}`,
    [viewerId]
  );
  return Promise.all(
    res.rows.map(async (row) => ({
      userId: row.user_id,
      name: displayNameForPrivacy(row.name, row.hide_my_name === true),
      age: row.age != null ? Number(row.age) : 0,
      verified: row.verified === true,
      location: row.living_in_city || "",
      distanceKm: row.distance_km != null ? Number(row.distance_km) : null,
      friendsSince: row.friends_since ? new Date(row.friends_since).toISOString() : null,
      primaryPhotoUrl: await normalizePrimaryPhotoUrl(row.primary_photo_url),
      isOnline: row.last_active_at
        ? new Date(row.last_active_at).getTime() >= Date.now() - ONLINE_ACTIVE_WINDOW_MS
        : false,
      hasStoryActive: row.has_story_active === true,
      viewerHasUnseenStory: row.story_ring_has_unseen === true,
    }))
  );
}

async function resolveDirectThreadId(userA, userB) {
  const res = await query(
    `SELECT t.id
     FROM chat_threads t
     JOIN chat_thread_participants p1 ON p1.thread_id = t.id AND p1.user_id = $1
     JOIN chat_thread_participants p2 ON p2.thread_id = t.id AND p2.user_id = $2
     WHERE t.thread_type = 'DIRECT'
     LIMIT 1`,
    [userA, userB]
  );
  return res.rows[0]?.id || "";
}

async function unfriendUser(viewerId, targetUserId) {
  const targetId = String(targetUserId || "").trim();
  if (!targetId || targetId === viewerId) {
    const error = new Error("Invalid target user");
    error.code = "INVALID_TARGET_USER";
    throw error;
  }
  const [u1, u2] = normalizedPair(viewerId, targetId);
  await query(
    `DELETE FROM friendships
     WHERE u1_id = $1
       AND u2_id = $2`,
    [u1, u2]
  );
  const threadId = await resolveDirectThreadId(viewerId, targetId);
  if (threadId) {
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
           can_report = false,
           can_view_profile = false,
           pinned_to_bottom = true,
           is_deleted_from_inbox = false,
           updated_at = NOW()
       WHERE thread_id = $1
         AND user_id = $2`,
      [threadId, targetId]
    );
  }
  return { success: true };
}

async function blockUser(viewerId, targetUserId, reason = "") {
  const targetId = String(targetUserId || "").trim();
  if (!targetId || targetId === viewerId) {
    const error = new Error("Invalid target user");
    error.code = "INVALID_TARGET_USER";
    throw error;
  }
  await query(
    `INSERT INTO blocks (blocker_id, blocked_id, reason)
     VALUES ($1, $2, $3)
     ON CONFLICT (blocker_id, blocked_id)
     DO UPDATE SET reason = EXCLUDED.reason, created_at = NOW()`,
    [viewerId, targetId, String(reason || "").trim() || null]
  );
  const [u1, u2] = normalizedPair(viewerId, targetId);
  await query(
    `DELETE FROM friendships
     WHERE u1_id = $1
       AND u2_id = $2`,
    [u1, u2]
  );
  const threadId = await resolveDirectThreadId(viewerId, targetId);
  if (threadId) {
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
      [threadId, viewerId, targetId]
    );
  }
  return { success: true };
}

async function reportUser(viewerId, targetUserId, { reason = "", contentType = "PROFILE", threadId = "" } = {}) {
  const targetId = String(targetUserId || "").trim();
  if (!targetId || targetId === viewerId) {
    const error = new Error("INVALID_TARGET_USER");
    error.code = "INVALID_TARGET_USER";
    throw error;
  }
  const normalizedReason = String(reason || "").trim();
  if (!normalizedReason) {
    const error = new Error("Report reason is required");
    error.code = "REPORT_REASON_REQUIRED";
    throw error;
  }
  const type = String(contentType || "PROFILE").trim().toUpperCase();
  const safeType = type === "CHAT" || type === "STORY" ? type : "PROFILE";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO reports (reporter_id, reported_id, content_type, reason, chat_thread_id, story_id)
       VALUES ($1, $2, $3::report_content_type_enum, $4, NULLIF($5, '')::uuid, NULL)`,
      [viewerId, targetId, safeType, normalizedReason, String(threadId || "").trim()]
    );
    const agg = await moderationReports.applyReportMilestonesForReportedUser(client, targetId);
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

async function respondToRequest(viewerId, fromUserId, decision) {
  const normalizedDecision = String(decision || "").trim().toUpperCase();
  if (!["ACCEPTED", "IGNORED"].includes(normalizedDecision)) {
    const error = new Error("Invalid request decision");
    error.code = "INVALID_REQUEST_DECISION";
    throw error;
  }
  const client = await pool.connect();
  let accepterName = "Someone";
  let pushAcceptTitle = "";
  try {
    await client.query("BEGIN");
    const requestRes = await client.query(
      `SELECT id
       FROM user_interactions
       WHERE user_id = $1
         AND target_id = $2
         AND interaction_type IN ('REQUEST', 'COMMENT_REQUEST')
         AND request_status = 'PENDING'
       LIMIT 1`,
      [fromUserId, viewerId]
    );
    const pendingRequest = requestRes.rows[0];
    if (!pendingRequest) {
      const error = new Error("Pending request not found");
      error.code = "REQUEST_NOT_FOUND";
      throw error;
    }
    const pendingInteractionId = pendingRequest.id;
    await client.query(
      `UPDATE user_interactions
       SET request_status = $2,
           request_acted_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [pendingInteractionId, normalizedDecision]
    );
    if (normalizedDecision === "ACCEPTED") {
      const [u1, u2] = [viewerId, fromUserId].sort();
      await client.query(
        `INSERT INTO friendships (u1_id, u2_id)
         VALUES ($1, $2)
         ON CONFLICT (u1_id, u2_id) DO NOTHING`,
        [u1, u2]
      );
      const threadId = await ensureDirectChatThreadForPair(client, viewerId, fromUserId, pendingInteractionId);
      const accepterProfileRes = await client.query(
        `SELECT COALESCE(preset_message, '') AS preset_message
         FROM users
         WHERE id = $1
         LIMIT 1`,
        [viewerId]
      );
      const accepterPreset = String(accepterProfileRes.rows[0]?.preset_message || "").trim();
      if (accepterPreset) {
        await client.query(
          `INSERT INTO chat_messages
             (thread_id, sender_type, sender_user_id, message_type, message_text, reply_to_message_id)
           VALUES ($1, 'USER', $2, 'TEXT', $3, NULL)`,
          [threadId, viewerId, accepterPreset]
        );
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
             AND user_id = $2`,
          [threadId, fromUserId]
        );
      }
      await client.query(
        `INSERT INTO notification_events (recipient_user_id, actor_user_id, event_type, is_silent)
         VALUES ($1, $2, 'REQUEST_ACCEPTED', FALSE)`,
        [fromUserId, viewerId]
      );
      const accepterRes = await client.query(
        `SELECT name, hide_my_name, age_years
         FROM users
         WHERE id = $1
         LIMIT 1`,
        [viewerId]
      );
      const aRow = accepterRes.rows[0];
      pushAcceptTitle = formatNotificationPersonTitle(aRow?.name, aRow?.hide_my_name === true, aRow?.age_years);
      accepterName = pushAcceptTitle;
    }
    await client.query("COMMIT");
    if (normalizedDecision === "ACCEPTED") {
      sendEventDataNotification({
        recipientUserId: fromUserId,
        actorUserId: viewerId,
        eventType: "FRIEND_REQUEST_ACCEPTED",
        title: pushAcceptTitle || accepterName,
        body: "Accepted your friend request!",
        extraData: { friendId: viewerId },
      }).catch(() => {});
    }
    return getPublicProfile(viewerId, fromUserId, { consumeView: false });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  getPublicProfile,
  consumeProfileView,
  sendFriendRequest,
  sendCommentRequest,
  ignoreProfile,
  respondToRequest,
  countPendingIncomingFriendRequests,
  listIncomingFriendRequests,
  listFriends,
  unfriendUser,
  blockUser,
  reportUser,
  undoIncomingFriendRequestIgnore,
  getRollingProfileViewSummary,
  buildRelationshipState,
};
