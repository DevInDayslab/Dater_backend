const { query, pool } = require("../../config/db");
const { presignMediaUrl } = require("./adminPresign.service");
const { loadUserFiltersDetail } = require("./filtersSnapshot.service");

const FREE_TIER_DAILY_PROFILE_VIEWS = 20;

function parsePagination(queryParams) {
  const page = Math.max(Number.parseInt(queryParams.page, 10) || 1, 1);
  const limit = Math.min(Math.max(Number.parseInt(queryParams.limit, 10) || 25, 1), 100);
  return { page, limit, offset: (page - 1) * limit };
}

function toIso(value) {
  return value ? new Date(value).toISOString() : null;
}

function mapLivingInCityMode(mode) {
  const m = String(mode || "").trim();
  if (m === "MANUAL_SWITCH") return "MANUAL";
  if (m === "FOLLOW_DEVICE") return "GPS";
  return m || null;
}

function parseStringArrayParam(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

async function mapPhotoRow(row) {
  const imageUrl = await presignMediaUrl({ s3Key: row.s3_key, fallbackUrl: row.photo_url });
  return {
    id: row.id,
    userId: row.user_id,
    photoOrder: Number(row.photo_order || 0),
    isPrimary: Boolean(row.is_primary),
    s3Key: row.s3_key || null,
    imageUrl: imageUrl || row.photo_url || "",
    moderationStatus: row.moderation_status,
    uploadedAt: toIso(row.uploaded_at),
    deletedAt: toIso(row.deleted_at),
  };
}

async function getUserRow(userId, { includeDeleted = false } = {}) {
  const deletedClause = includeDeleted ? "" : "AND deleted_at IS NULL";
  const res = await query(
    `SELECT *
     FROM users
     WHERE id = $1::uuid
     ${deletedClause}
     LIMIT 1`,
    [userId]
  );
  return res.rows[0] || null;
}

async function listUsers(queryParams = {}) {
  const { page, limit, offset } = parsePagination(queryParams);
  const search = String(queryParams.search || queryParams.q || "").trim();
  const states = parseStringArrayParam(queryParams.state);
  const genders = parseStringArrayParam(queryParams.gender);
  const premium = String(queryParams.premium || "all").toLowerCase();
  const verified = String(queryParams.verified || "all").toLowerCase();
  const sort = String(queryParams.sort || "created_at_desc");

  const params = [];
  const where = ["1=1"];

  if (search) {
    params.push(`%${search}%`);
    const i = params.length;
    where.push(`(
      u.name ILIKE $${i}
      OR u.phone_e164 ILIKE $${i}
      OR u.id::text ILIKE $${i}
    )`);
  }

  if (!states.includes("DELETED")) {
    where.push("u.deleted_at IS NULL");
  }

  if (states.length > 0) {
    params.push(states);
    where.push(`u.account_state::text = ANY($${params.length}::text[])`);
  }

  if (premium === "premium") {
    where.push(`(
      u.premium_status = 'ACTIVE'
      OR (u.premium_expires_at IS NOT NULL AND u.premium_expires_at > NOW())
    )`);
  } else if (premium === "free") {
    where.push(`NOT (
      u.premium_status = 'ACTIVE'
      OR (u.premium_expires_at IS NOT NULL AND u.premium_expires_at > NOW())
    )`);
  }

  if (verified === "verified") {
    where.push("u.is_verified = TRUE");
  } else if (verified === "unverified") {
    where.push("u.is_verified = FALSE");
  }

  if (genders.length > 0) {
    params.push(genders);
    where.push(`u.gender_main = ANY($${params.length}::text[])`);
  }

  let orderBy = "u.created_at DESC";
  if (sort === "last_active_at_desc") orderBy = "u.last_active_at DESC NULLS LAST";
  else if (sort === "name_asc") orderBy = "u.name ASC NULLS LAST";

  const whereSql = where.join(" AND ");

  const countRes = await query(
    `SELECT COUNT(*)::int AS total
     FROM users u
     WHERE ${whereSql}`,
    params
  );
  const total = Number(countRes.rows[0]?.total || 0);

  params.push(limit, offset);
  const limitIdx = params.length - 1;
  const offsetIdx = params.length;

  const listRes = await query(
    `SELECT
       u.id,
       u.name,
       u.phone_e164,
       u.age_years,
       u.gender_main,
       u.account_state,
       u.premium_status,
       u.is_verified,
       u.created_at,
       u.last_active_at,
       p.photo_url AS primary_photo_url,
       p.s3_key AS primary_photo_s3_key,
       COALESCE(rc.reports_against_count, 0)::int AS reports_against_count
     FROM users u
     LEFT JOIN LATERAL (
       SELECT photo_url, s3_key
       FROM user_photos
       WHERE user_id = u.id
         AND deleted_at IS NULL
         AND moderation_status = 'APPROVED'
         AND is_primary = TRUE
       ORDER BY photo_order ASC
       LIMIT 1
     ) p ON TRUE
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS reports_against_count
       FROM reports
       WHERE reported_id = u.id
     ) rc ON TRUE
     WHERE ${whereSql}
     ORDER BY ${orderBy}
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  );

  const users = await Promise.all(
    listRes.rows.map(async (row) => {
      const primaryPhotoUrl = await presignMediaUrl({
        s3Key: row.primary_photo_s3_key,
        fallbackUrl: row.primary_photo_url,
      });
      return {
        id: row.id,
        name: row.name || null,
        phoneE164: row.phone_e164 || null,
        ageYears: row.age_years != null ? Number(row.age_years) : null,
        genderMain: row.gender_main || null,
        accountState: row.account_state,
        premiumStatus: row.premium_status,
        isVerified: Boolean(row.is_verified),
        createdAt: toIso(row.created_at),
        lastActiveAt: toIso(row.last_active_at),
        primaryPhotoUrl: primaryPhotoUrl || null,
        reportsAgainstCount: Number(row.reports_against_count || 0),
      };
    })
  );

  return {
    users,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  };
}

async function getUserProfile(userId) {
  const user = await getUserRow(userId, { includeDeleted: true });
  if (!user) return null;

  const [
    datingRes,
    lookingRes,
    interestsRes,
    pronounsRes,
    languagesRes,
    promptsRes,
    genderMoreRes,
    primaryPhotoRes,
    verificationSelfieUrl,
  ] = await Promise.all([
    query(`SELECT preferred_gender FROM user_dating_preferences WHERE user_id = $1 ORDER BY preferred_gender ASC`, [userId]),
    query(`SELECT looking_for_option FROM user_looking_for WHERE user_id = $1 ORDER BY looking_for_option ASC`, [userId]),
    query(`SELECT interest FROM user_interests WHERE user_id = $1 ORDER BY interest ASC`, [userId]),
    query(`SELECT pronoun FROM user_pronouns WHERE user_id = $1 ORDER BY pronoun ASC`, [userId]),
    query(`SELECT language FROM user_languages WHERE user_id = $1 ORDER BY language ASC`, [userId]),
    query(
      `SELECT id, prompt_order, prompt_question, prompt_answer
       FROM user_written_prompts WHERE user_id = $1 ORDER BY prompt_order ASC`,
      [userId]
    ),
    query(`SELECT gender_option FROM user_gender_more_options WHERE user_id = $1 ORDER BY gender_option ASC`, [userId]),
    query(
      `SELECT photo_url, s3_key FROM user_photos
       WHERE user_id = $1 AND deleted_at IS NULL AND moderation_status = 'APPROVED' AND is_primary = TRUE
       ORDER BY photo_order ASC LIMIT 1`,
      [userId]
    ),
    presignMediaUrl({ s3Key: user.verification_selfie_s3_key, fallbackUrl: null }),
  ]);

  const primaryRow = primaryPhotoRes.rows[0];
  const primaryPhotoUrl = primaryRow
    ? await presignMediaUrl({ s3Key: primaryRow.s3_key, fallbackUrl: primaryRow.photo_url })
    : null;

  const locationRes = await query(
    `SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
     FROM users WHERE id = $1`,
    [userId]
  );
  const loc = locationRes.rows[0] || {};

  return {
    id: user.id,
    phoneCountryCode: user.phone_country_code,
    phoneNumber: user.phone_number,
    phoneE164: user.phone_e164 || null,
    isPhoneVerified: Boolean(user.is_phone_verified),
    name: user.name || null,
    ageYears: user.age_years != null ? Number(user.age_years) : null,
    dateOfBirth: user.date_of_birth ? String(user.date_of_birth).slice(0, 10) : null,
    gender: user.gender || null,
    genderMain: user.gender_main || null,
    showGenderOnProfile: user.show_gender_on_profile !== false,
    maritalStatus: user.marital_status || null,
    heightInches: user.height_inches != null ? Number(user.height_inches) : null,
    drinking: user.drinking || null,
    smoking: user.smoking || null,
    exercise: user.exercise || null,
    religion: user.religion || null,
    education: user.education || null,
    starSign: user.star_sign || null,
    kids: user.kids || null,
    politicalLeanings: user.political_leanings || null,
    pets: user.pets || null,
    bio: user.bio || null,
    presetMessage: user.preset_message || null,
    ethnicity: user.ethnicity || null,
    occupationJobTitle: user.occupation_job_title || null,
    occupationCompany: user.occupation_company || null,
    educationInstitutionName: user.education_institution_name || null,
    educationPassingYear: user.education_passing_year != null ? Number(user.education_passing_year) : null,
    livingInCity: user.living_in_city || null,
    livingInCityMode: mapLivingInCityMode(user.living_in_city_mode),
    homeTownCity: user.home_town_city || null,
    locationLat: loc.lat != null ? Number(loc.lat) : null,
    locationLng: loc.lng != null ? Number(loc.lng) : null,
    locationGranted: Boolean(user.location_granted),
    onboardingStep: user.onboarding_step,
    onboardingCompletedAt: toIso(user.onboarding_completed_at),
    profileCompletionPercentage: Number(user.profile_completion_percentage || 0),
    accountState: user.account_state,
    premiumStatus: user.premium_status,
    premiumPlanCode: user.premium_plan_code || null,
    premiumStartedAt: toIso(user.premium_started_at),
    premiumExpiresAt: toIso(user.premium_expires_at),
    isVerified: Boolean(user.is_verified),
    verifiedAt: toIso(user.verified_at),
    verificationSelfieUrl: verificationSelfieUrl || null,
    moderationWarningCount: Number(user.moderation_warning_count || 0),
    moderationConsecutiveWarningCount: Number(user.moderation_consecutive_warning_count || 0),
    moderationWarningsAcknowledged: Number(user.moderation_warnings_acknowledged || 0),
    hideMyName: Boolean(user.hide_my_name),
    notificationsGranted: Boolean(user.notifications_granted),
    accountCreatedIpAddress: user.account_created_ip_address ? String(user.account_created_ip_address) : null,
    accountCreatedDeviceId: user.account_created_device_id || null,
    accountCreatedUserAgent: user.account_created_user_agent || null,
    consentSource: user.consent_source || null,
    ageAgreementTimestamp: toIso(user.age_agreement_timestamp),
    beKindAcceptedAt: toIso(user.be_kind_accepted_at),
    termsAcceptedAt: toIso(user.terms_accepted_at),
    privacyAcceptedAt: toIso(user.privacy_accepted_at),
    createdAt: toIso(user.created_at),
    updatedAt: toIso(user.updated_at),
    lastActiveAt: toIso(user.last_active_at),
    lastLoginAt: toIso(user.last_login_at),
    lastLogoutAt: toIso(user.last_logout_at),
    profileUpdatedAt: toIso(user.profile_updated_at),
    pausedUntil: toIso(user.paused_until),
    underageUntil: toIso(user.underage_until),
    profileHiddenAt: toIso(user.profile_hidden_at),
    deletedAt: toIso(user.deleted_at),
    datingPreferences: datingRes.rows.map((r) => r.preferred_gender),
    lookingFor: lookingRes.rows.map((r) => r.looking_for_option),
    interests: interestsRes.rows.map((r) => r.interest),
    pronouns: pronounsRes.rows.map((r) => r.pronoun),
    languages: languagesRes.rows.map((r) => r.language),
    genderMoreOptions: genderMoreRes.rows.map((r) => r.gender_option),
    writtenPrompts: promptsRes.rows.map((r) => ({
      id: r.id,
      promptOrder: Number(r.prompt_order),
      promptQuestion: r.prompt_question,
      promptAnswer: r.prompt_answer,
    })),
    primaryPhotoUrl: primaryPhotoUrl || null,
  };
}

async function getUserPhotos(userId) {
  const res = await query(
    `SELECT id, user_id, photo_url, photo_order, is_primary, s3_key, moderation_status, uploaded_at, deleted_at
     FROM user_photos
     WHERE user_id = $1
     ORDER BY photo_order ASC, uploaded_at ASC`,
    [userId]
  );
  return Promise.all(res.rows.map(mapPhotoRow));
}

async function getUserFilters(userId) {
  const exists = await getUserRow(userId, { includeDeleted: true });
  if (!exists) return null;
  const filters = await loadUserFiltersDetail(userId);
  if (filters) return filters;
  return {
    distancePrefKm: 20,
    ageMin: 20,
    ageMax: 36,
    minHeightInches: null,
    maxHeightInches: null,
    expandAgeRange: false,
    expandDistance: false,
    onlyVerifiedProfiles: false,
    preferredLocationCity: null,
    showOtherPeopleIfRunOut: true,
    preferredGenders: [],
    languages: [],
    maritalStatuses: [],
    lookingFor: [],
    drinking: [],
    smoking: [],
    exercise: [],
    religion: [],
    education: [],
    starSign: [],
    kids: [],
    political: [],
    pets: [],
    ethnicity: [],
    pronouns: [],
  };
}

async function getUserVerification(userId) {
  const user = await getUserRow(userId, { includeDeleted: true });
  if (!user) return null;

  const [selfieUrl, sessionsRes] = await Promise.all([
    presignMediaUrl({ s3Key: user.verification_selfie_s3_key, fallbackUrl: null }),
    query(
      `SELECT id, aws_session_id, status, liveness_confidence, failure_reason, created_at
       FROM user_verification_sessions
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    ),
  ]);

  return {
    verificationSelfieUrl: selfieUrl || null,
    verifiedAt: toIso(user.verified_at),
    verificationLastAttemptAt: toIso(user.verification_last_attempt_at),
    sessions: sessionsRes.rows.map((r) => ({
      id: r.id,
      awsSessionId: r.aws_session_id,
      status: r.status,
      livenessConfidence: r.liveness_confidence != null ? Number(r.liveness_confidence) : null,
      failureReason: r.failure_reason || null,
      createdAt: toIso(r.created_at),
    })),
  };
}

function mapReportRow(row) {
  return {
    id: row.id,
    reporterId: row.reporter_id,
    reporterName: row.reporter_name || "Unknown",
    reportedId: row.reported_id,
    reportedName: row.reported_name || "Unknown",
    contentType: row.content_type,
    reason: row.reason,
    status: row.status,
    createdAt: toIso(row.created_at),
    chatThreadId: row.chat_thread_id || null,
    storyId: row.story_id || null,
  };
}

async function getUserTrust(userId) {
  const user = await getUserRow(userId, { includeDeleted: true });
  if (!user) return null;

  const [againstRes, filedRes, blocksRes] = await Promise.all([
    query(
      `SELECT r.*, rep.name AS reporter_name, rd.name AS reported_name
       FROM reports r
       JOIN users rep ON rep.id = r.reporter_id
       JOIN users rd ON rd.id = r.reported_id
       WHERE r.reported_id = $1
       ORDER BY r.created_at DESC`,
      [userId]
    ),
    query(
      `SELECT r.*, rep.name AS reporter_name, rd.name AS reported_name
       FROM reports r
       JOIN users rep ON rep.id = r.reporter_id
       JOIN users rd ON rd.id = r.reported_id
       WHERE r.reporter_id = $1
       ORDER BY r.created_at DESC`,
      [userId]
    ),
    query(
      `SELECT b.blocker_id, b.blocked_id, b.created_at,
              blocker.name AS blocker_name,
              blocked.name AS blocked_name
       FROM blocks b
       JOIN users blocker ON blocker.id = b.blocker_id
       JOIN users blocked ON blocked.id = b.blocked_id
       WHERE b.blocker_id = $1 OR b.blocked_id = $1
       ORDER BY b.created_at DESC`,
      [userId]
    ),
  ]);

  return {
    accountState: user.account_state,
    moderationWarningCount: Number(user.moderation_warning_count || 0),
    moderationConsecutiveWarningCount: Number(user.moderation_consecutive_warning_count || 0),
    moderationWarningsAcknowledged: Number(user.moderation_warnings_acknowledged || 0),
    pausedUntil: toIso(user.paused_until),
    profileHiddenAt: toIso(user.profile_hidden_at),
    reportsAgainst: againstRes.rows.map(mapReportRow),
    reportsFiled: filedRes.rows.map(mapReportRow),
    blocks: blocksRes.rows.map((r) => ({
      blockerId: r.blocker_id,
      blockerName: r.blocker_name || "Unknown",
      blockedId: r.blocked_id,
      blockedName: r.blocked_name || "Unknown",
      createdAt: toIso(r.created_at),
    })),
  };
}

async function mapStoryRow(row, interactionCounts) {
  const counts = interactionCounts.get(row.id) || { views: 0, likes: 0, comments: 0 };
  const mediaUrl = await presignMediaUrl({ s3Key: null, fallbackUrl: row.media_url });
  const isActive =
    !row.deleted_at && row.expires_at && new Date(row.expires_at).getTime() > Date.now();

  return {
    id: row.id,
    mediaType: row.media_type,
    mediaUrl: mediaUrl || row.media_url || "",
    audience: row.audience || "EVERYONE",
    createdAt: toIso(row.created_at),
    expiresAt: toIso(row.expires_at),
    deletedAt: toIso(row.deleted_at),
    viewCount: counts.views,
    likeCount: counts.likes,
    commentCount: counts.comments,
    isActive,
  };
}

async function getUserContent(userId) {
  const exists = await getUserRow(userId, { includeDeleted: true });
  if (!exists) return null;

  const storiesRes = await query(
    `SELECT id, media_url, media_type, audience, created_at, expires_at, deleted_at
     FROM stories
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );

  const storyIds = storiesRes.rows.map((r) => r.id);
  const interactionCounts = new Map();
  if (storyIds.length > 0) {
    const intRes = await query(
      `SELECT story_id, interaction_type, COUNT(*)::int AS c
       FROM story_interactions
       WHERE story_id = ANY($1::uuid[])
       GROUP BY story_id, interaction_type`,
      [storyIds]
    );
    for (const row of intRes.rows) {
      const entry = interactionCounts.get(row.story_id) || { views: 0, likes: 0, comments: 0 };
      if (row.interaction_type === "VIEW") entry.views = Number(row.c);
      if (row.interaction_type === "LIKE") entry.likes = Number(row.c);
      if (row.interaction_type === "COMMENT") entry.comments = Number(row.c);
      interactionCounts.set(row.story_id, entry);
    }
  }

  const mapped = await Promise.all(storiesRes.rows.map((r) => mapStoryRow(r, interactionCounts)));
  const activeStory = mapped.find((s) => s.isActive) || null;

  return {
    activeStory,
    storyHistory: mapped,
  };
}

async function getUserChatThreads(userId) {
  const exists = await getUserRow(userId, { includeDeleted: true });
  if (!exists) return null;

  const res = await query(
    `SELECT
       t.id AS thread_id,
       t.thread_type,
       t.last_message_at,
       other.user_id AS other_participant_id,
       other_user.name AS other_participant_name,
       COALESCE(state.relationship_state, 'ACTIVE') AS relationship_state,
       COALESCE(cr.is_unlocked, FALSE) AS is_unlocked
     FROM chat_thread_participants mine
     JOIN chat_threads t ON t.id = mine.thread_id
     JOIN chat_thread_participants other
       ON other.thread_id = t.id AND other.user_id <> mine.user_id
     JOIN users other_user ON other_user.id = other.user_id
     LEFT JOIN chat_thread_user_state state
       ON state.thread_id = t.id AND state.user_id = mine.user_id
     LEFT JOIN chat_restrictions cr
       ON cr.user_id = mine.user_id AND cr.target_id = other.user_id
     WHERE mine.user_id = $1
     ORDER BY t.last_message_at DESC`,
    [userId]
  );

  return res.rows.map((r) => ({
    id: r.thread_id,
    otherParticipantId: r.other_participant_id,
    otherParticipantName: r.other_participant_name || "Unknown",
    threadType: r.thread_type,
    lastMessageAt: toIso(r.last_message_at),
    relationshipState: r.relationship_state,
    isUnlocked: Boolean(r.is_unlocked),
  }));
}

async function getUserChatMessages(userId, threadId) {
  const participantRes = await query(
    `SELECT 1 FROM chat_thread_participants WHERE thread_id = $1 AND user_id = $2 LIMIT 1`,
    [threadId, userId]
  );
  if (!participantRes.rows[0]) return null;

  const reportedRes = await query(
    `SELECT chat_thread_id FROM reports WHERE chat_thread_id = $1 LIMIT 1`,
    [threadId]
  );
  const threadIsReported = reportedRes.rows.length > 0;

  const messagesRes = await query(
    `SELECT m.id, m.sender_user_id, m.sender_type, m.message_text, m.message_type,
            m.created_at, m.deleted_at, m.reply_to_message_id,
            reply.message_text AS reply_preview_text
     FROM chat_messages m
     LEFT JOIN chat_messages reply ON reply.id = m.reply_to_message_id
     WHERE m.thread_id = $1
     ORDER BY m.created_at ASC`,
    [threadId]
  );

  return messagesRes.rows.map((m) => ({
    id: m.id,
    senderUserId: m.sender_user_id,
    senderType: m.sender_type,
    messageText: m.deleted_at ? null : m.message_text,
    messageType: m.message_type,
    createdAt: toIso(m.created_at),
    deletedAt: toIso(m.deleted_at),
    replyToMessageId: m.reply_to_message_id || null,
    replyPreview: m.reply_preview_text || null,
    isReported: threadIsReported,
  }));
}

async function getUserSocial(userId) {
  const exists = await getUserRow(userId, { includeDeleted: true });
  if (!exists) return null;

  const [friendsRes, sentRes, receivedRes, notifRes, sessionsRes, pushRes] = await Promise.all([
    query(
      `SELECT f.u1_id, f.u2_id, f.created_at,
              CASE WHEN f.u1_id = $1 THEN f.u2_id ELSE f.u1_id END AS friend_id,
              fu.name AS friend_name,
              fu.account_state AS friend_account_state
       FROM friendships f
       JOIN users fu ON fu.id = CASE WHEN f.u1_id = $1 THEN f.u2_id ELSE f.u1_id END
       WHERE f.u1_id = $1 OR f.u2_id = $1
       ORDER BY f.created_at DESC`,
      [userId]
    ),
    query(
      `SELECT ui.id, ui.target_id, ui.interaction_type, ui.request_status, ui.comment_text, ui.created_at,
              u.name AS target_user_name
       FROM user_interactions ui
       JOIN users u ON u.id = ui.target_id
       WHERE ui.user_id = $1
         AND ui.interaction_type IN ('REQUEST', 'COMMENT_REQUEST')
         AND ui.request_status = 'PENDING'
       ORDER BY ui.created_at DESC`,
      [userId]
    ),
    query(
      `SELECT ui.id, ui.user_id AS source_user_id, ui.interaction_type, ui.request_status, ui.comment_text, ui.created_at,
              u.name AS source_user_name
       FROM user_interactions ui
       JOIN users u ON u.id = ui.user_id
       WHERE ui.target_id = $1
         AND ui.interaction_type IN ('REQUEST', 'COMMENT_REQUEST')
         AND ui.request_status = 'PENDING'
       ORDER BY ui.created_at DESC`,
      [userId]
    ),
    query(
      `SELECT ne.id, ne.event_type, ne.actor_user_id, ne.is_read, ne.created_at,
              actor.name AS actor_name
       FROM notification_events ne
       LEFT JOIN users actor ON actor.id = ne.actor_user_id
       WHERE ne.recipient_user_id = $1
       ORDER BY ne.created_at DESC
       LIMIT 50`,
      [userId]
    ),
    query(
      `SELECT id, device_id, ip_address::text AS ip_address, user_agent, last_seen_at, expires_at, revoked_at
       FROM user_sessions
       WHERE user_id = $1
       ORDER BY last_seen_at DESC`,
      [userId]
    ),
    query(
      `SELECT id, platform, device_id, is_active, last_seen_at
       FROM user_push_tokens
       WHERE user_id = $1
       ORDER BY last_seen_at DESC`,
      [userId]
    ),
  ]);

  return {
    friends: friendsRes.rows.map((r) => ({
      friendId: r.friend_id,
      friendName: r.friend_name || "Unknown",
      friendAccountState: r.friend_account_state,
      createdAt: toIso(r.created_at),
    })),
    pendingSent: sentRes.rows.map((r) => ({
      id: r.id,
      targetUserId: r.target_id,
      targetUserName: r.target_user_name || "Unknown",
      interactionType: r.interaction_type,
      requestStatus: r.request_status,
      commentText: r.comment_text || null,
      createdAt: toIso(r.created_at),
    })),
    pendingReceived: receivedRes.rows.map((r) => ({
      id: r.id,
      targetUserId: r.source_user_id,
      targetUserName: r.source_user_name || "Unknown",
      interactionType: r.interaction_type,
      requestStatus: r.request_status,
      commentText: r.comment_text || null,
      createdAt: toIso(r.created_at),
    })),
    notifications: notifRes.rows.map((r) => ({
      id: r.id,
      eventType: r.event_type,
      actorName: r.actor_name || null,
      actorUserId: r.actor_user_id || null,
      isRead: Boolean(r.is_read),
      createdAt: toIso(r.created_at),
    })),
    sessions: sessionsRes.rows.map((r) => ({
      id: r.id,
      deviceId: r.device_id || null,
      ipAddress: r.ip_address || null,
      userAgent: r.user_agent || null,
      lastSeenAt: toIso(r.last_seen_at),
      expiresAt: toIso(r.expires_at),
      revokedAt: toIso(r.revoked_at),
    })),
    pushTokens: pushRes.rows.map((r) => ({
      id: r.id,
      platform: r.platform,
      deviceId: r.device_id || null,
      isActive: Boolean(r.is_active),
      lastSeenAt: toIso(r.last_seen_at),
    })),
  };
}

async function getUserRevenue(userId) {
  const user = await getUserRow(userId, { includeDeleted: true });
  if (!user) return null;

  const today = new Date().toISOString().slice(0, 10);

  const [boostWalletRes, commentWalletRes, boostActiveRes, purchasesRes, unlocksRes, usageRes] =
    await Promise.all([
      query(`SELECT remaining_credits FROM user_boost_wallet WHERE user_id = $1 LIMIT 1`, [userId]),
      query(`SELECT remaining_paid_comments FROM user_comment_wallet WHERE user_id = $1 LIMIT 1`, [userId]),
      query(
        `SELECT id, activated_count, started_at, expires_at
         FROM user_boost_activations
         WHERE user_id = $1 AND expires_at > NOW()
         ORDER BY expires_at DESC
         LIMIT 1`,
        [userId]
      ),
      query(
        `SELECT id, item_type, pack_code, amount, quantity, transaction_id, created_at
         FROM user_purchases
         WHERE user_id = $1
         ORDER BY created_at DESC`,
        [userId]
      ),
      query(
        `SELECT cue.id, cue.unlocked_at, cue.target_id, u.name AS other_name,
                (
                  SELECT t.id FROM chat_threads t
                  JOIN chat_thread_participants p1 ON p1.thread_id = t.id AND p1.user_id = cue.user_id
                  JOIN chat_thread_participants p2 ON p2.thread_id = t.id AND p2.user_id = cue.target_id
                  LIMIT 1
                ) AS thread_id
         FROM chat_unlock_events cue
         JOIN users u ON u.id = cue.target_id
         WHERE cue.user_id = $1
         ORDER BY cue.unlocked_at DESC`,
        [userId]
      ),
      query(
        `SELECT usage_date, profile_view_count
         FROM user_daily_profile_view_usage
         WHERE user_id = $1 AND usage_date = $2::date
         LIMIT 1`,
        [userId, today]
      ),
    ]);

  const purchases = purchasesRes.rows.map((p) => ({
    id: p.id,
    itemType: p.item_type,
    packCode: p.pack_code || null,
    amount: Number(p.amount || 0),
    quantity: p.quantity != null ? Number(p.quantity) : null,
    transactionId: p.transaction_id,
    createdAt: toIso(p.created_at),
  }));

  const purchaseCounts = {
    subscriptions: purchases.filter((p) => p.itemType === "SUBSCRIPTION").length,
    boosts: purchases.filter((p) => p.itemType === "BOOST").length,
    comments: purchases.filter((p) => String(p.packCode || "").startsWith("COMMENTS_")).length,
    chatUnlocks: purchases.filter((p) => p.itemType === "UNLOCK_CHAT").length,
  };

  const activeBoostRow = boostActiveRes.rows[0];

  return {
    premiumStatus: user.premium_status,
    premiumPlanCode: user.premium_plan_code || null,
    premiumStartedAt: toIso(user.premium_started_at),
    premiumExpiresAt: toIso(user.premium_expires_at),
    boostWallet: {
      remainingCredits: Number(boostWalletRes.rows[0]?.remaining_credits || 0),
    },
    commentWallet: {
      remainingPaidComments: Number(commentWalletRes.rows[0]?.remaining_paid_comments || 0),
    },
    activeBoost: activeBoostRow
      ? {
          id: activeBoostRow.id,
          activatedCount: Number(activeBoostRow.activated_count),
          startedAt: toIso(activeBoostRow.started_at),
          expiresAt: toIso(activeBoostRow.expires_at),
        }
      : null,
    purchases,
    purchaseCounts,
    chatUnlocks: unlocksRes.rows.map((r) => ({
      id: r.id,
      threadId: r.thread_id || null,
      otherParticipantName: r.other_name || "Unknown",
      unlockedAt: toIso(r.unlocked_at),
    })),
    dailyProfileViewUsage: {
      usageDate: today,
      profileViewCount: Number(usageRes.rows[0]?.profile_view_count || 0),
      freeTierLimit: FREE_TIER_DAILY_PROFILE_VIEWS,
    },
  };
}

module.exports = {
  listUsers,
  getUserProfile,
  getUserPhotos,
  getUserFilters,
  getUserVerification,
  getUserTrust,
  getUserContent,
  getUserChatThreads,
  getUserChatMessages,
  getUserSocial,
  getUserRevenue,
  getUserRow,
};
