const { query } = require("../config/db");
const { getMessaging } = require("./firebaseAdmin.service");
const s3Media = require("./s3Media.service");
const { displayNameForPrivacy } = require("../utils/displayName");

// Backend must not guess app foreground/background using timestamps.
// Send data payload if user wants either channel; client decides final route.
function shouldAttemptPush({ pushEnabled, inAppEnabled }) {
  return Boolean(pushEnabled || inAppEnabled);
}

/** Align server event names with Android [normalizeFcmNotificationType] / preference buckets. */
function canonicalPushEventType(raw) {
  const u = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/-/g, "_");
  switch (u) {
    case "FRIEND_REQUEST_RECEIVED":
    case "NEW_FRIEND_REQUEST":
    case "FRIEND_REQUEST":
      return "FRIEND_REQUEST_RECEIVED";
    case "FRIEND_REQUEST_ACCEPTED":
    case "REQUEST_ACCEPTED":
    case "FRIEND_ACCEPTED":
    case "ACCEPTED_FRIEND_REQUEST":
      return "FRIEND_REQUEST_ACCEPTED";
    case "COMMENT":
    case "NEW_COMMENT":
    case "COMMENTS":
    case "COMMENT_REQUEST":
    case "REQUEST_COMMENT_SENT":
      return "COMMENT";
    case "CHAT_DM":
    case "DM":
    case "MESSAGE":
    case "NEW_MESSAGE":
      return "CHAT_DM";
    default:
      return u || String(raw || "").trim();
  }
}

function buildDataPayload({
  type,
  title,
  body,
  actorUserId = "",
  chatId = "",
  extra = {},
}) {
  const out = {
    type: String(type || "").trim(),
    title: String(title || "").trim(),
    body: String(body || "").trim(),
  };
  if (actorUserId) out.actorUserId = String(actorUserId);
  if (chatId) out.chatId = String(chatId);
  for (const [k, v] of Object.entries(extra || {})) {
    if (v == null) continue;
    out[String(k)] = String(v);
  }
  return out;
}

async function resolveActorPrimaryPhotoReadUrl(row) {
  const s3Key = String(row.primary_photo_s3_key || "").trim();
  if (s3Key && !s3Key.includes("..")) {
    try {
      return await s3Media.getPresignedGetUrl({ key: s3Key, expiresInSeconds: 3600 });
    } catch {
      /* fall through */
    }
  }
  const rawUrl = String(row.primary_photo_url || "").trim();
  const signedOrPassthrough = await s3Media.presignReadIfOurS3Object(rawUrl);
  return String(signedOrPassthrough || "").trim();
}

async function loadActorPayload(actorUserId) {
  const actorId = String(actorUserId || "").trim();
  if (!actorId) return {};
  const actorRes = await query(
    `SELECT u.id,
            u.name,
            u.hide_my_name,
            u.age_years,
            u.is_verified,
            ph.photo_url AS primary_photo_url,
            ph.s3_key AS primary_photo_s3_key
     FROM users u
     LEFT JOIN LATERAL (
       SELECT up.photo_url, up.s3_key
       FROM user_photos up
       WHERE up.user_id = u.id
         AND up.deleted_at IS NULL
         AND up.moderation_status = 'APPROVED'
       ORDER BY up.is_primary DESC, up.photo_order ASC, up.created_at ASC
       LIMIT 1
     ) ph ON TRUE
     WHERE u.id = $1
     LIMIT 1`,
    [actorId]
  );
  const row = actorRes.rows[0];
  if (!row) return {};
  const actorPhotoUrl = await resolveActorPrimaryPhotoReadUrl(row);
  const rawName = String(row.name || "").trim();
  const actorAgeYears =
    row.age_years != null && Number.isFinite(Number(row.age_years)) ? Number(row.age_years) : null;
  return {
    actorUserId: String(row.id || "").trim(),
    actorName: displayNameForPrivacy(rawName, row.hide_my_name === true),
    actorAge: actorAgeYears != null && actorAgeYears > 0 ? String(Math.round(actorAgeYears)) : "",
    actorPhotoUrl: actorPhotoUrl || "",
    verified: row.is_verified === true,
  };
}

async function deactivatePushToken(token) {
  await query(
    `UPDATE user_push_tokens
     SET is_active = FALSE
     WHERE token = $1`,
    [token]
  );
}

async function sendEventDataNotification({
  recipientUserId,
  actorUserId = "",
  eventType,
  title,
  body,
  chatId = "",
  extraData = {},
}) {
  const actorPayload = await loadActorPayload(actorUserId).catch(() => ({}));
  const prefRes = await query(
    `SELECT COALESCE(p.push_friend_request_received, TRUE) AS push_friend_request_received,
            COALESCE(p.push_friend_request_accepted, TRUE) AS push_friend_request_accepted,
            COALESCE(p.push_chat_dm, TRUE) AS push_chat_dm,
            COALESCE(p.push_comment, TRUE) AS push_comment,
            COALESCE(p.inapp_friend_request_received, TRUE) AS inapp_friend_request_received,
            COALESCE(p.inapp_friend_request_accepted, TRUE) AS inapp_friend_request_accepted,
            COALESCE(p.inapp_chat_dm, TRUE) AS inapp_chat_dm,
            COALESCE(p.inapp_comment, TRUE) AS inapp_comment
     FROM user_notification_preferences p
     WHERE p.user_id = $1
     LIMIT 1`,
    [recipientUserId]
  );
  const pref = prefRes.rows[0] || {
    push_friend_request_received: true,
    push_friend_request_accepted: true,
    push_chat_dm: true,
    push_comment: true,
    inapp_friend_request_received: true,
    inapp_friend_request_accepted: true,
    inapp_chat_dm: true,
    inapp_comment: true,
  };

  const canonicalType = canonicalPushEventType(eventType);

  const mapping = {
    FRIEND_REQUEST_RECEIVED: {
      pushEnabled: pref.push_friend_request_received === true,
      inAppEnabled: pref.inapp_friend_request_received === true,
    },
    FRIEND_REQUEST_ACCEPTED: {
      pushEnabled: pref.push_friend_request_accepted === true,
      inAppEnabled: pref.inapp_friend_request_accepted === true,
    },
    CHAT_DM: {
      pushEnabled: pref.push_chat_dm === true,
      inAppEnabled: pref.inapp_chat_dm === true,
    },
    COMMENT: {
      pushEnabled: pref.push_comment === true,
      inAppEnabled: pref.inapp_comment === true,
    },
  };
  const flags = mapping[canonicalType] || { pushEnabled: true, inAppEnabled: true };
  if (!shouldAttemptPush(flags)) {
    return;
  }

  const tokenRes = await query(
    `SELECT token
     FROM user_push_tokens
     WHERE user_id = $1
       AND is_active = TRUE
     ORDER BY last_seen_at DESC
     LIMIT 20`,
    [recipientUserId]
  );
  const tokens = tokenRes.rows.map((r) => String(r.token || "").trim()).filter(Boolean);
  if (tokens.length === 0) {
    console.warn("[push] skip: no active tokens", { recipientUserId, canonicalType });
    return;
  }

  const messaging = getMessaging();
  if (!messaging) {
    console.warn("[push] skip: Firebase Admin not initialized (set FIREBASE_SERVICE_ACCOUNT_JSON)", {
      recipientUserId,
      canonicalType,
    });
    return;
  }

  // Data-only payload by design. Never send "notification" block.
  const data = buildDataPayload({
    type: canonicalType,
    title,
    body,
    actorUserId,
    chatId,
    extra: {
      ...actorPayload,
      ...(extraData || {}),
    },
  });

  const multicast = {
    tokens,
    data,
    android: {
      priority: "high",
    },
  };

  const result = await messaging.sendEachForMulticast(multicast);
  const failed = [];
  result.responses.forEach((r, i) => {
    if (!r.success) failed.push({ token: tokens[i], error: r.error });
  });
  for (const f of failed) {
    const code = String(f.error?.code || "");
    if (code.includes("registration-token-not-registered") || code.includes("invalid-registration-token")) {
      await deactivatePushToken(f.token);
    }
  }
}

/**
 * Admin broadcast: data-only FCM to active tokens, bypasses per-event preference toggles.
 */
async function sendAdminBroadcast({ title, body, deepLink = "", tokens }) {
  const cleanTokens = [...new Set(tokens.map((t) => String(t || "").trim()).filter(Boolean))];
  if (cleanTokens.length === 0) {
    return { attempted: 0, successCount: 0, failureCount: 0 };
  }

  const messaging = getMessaging();
  if (!messaging) {
    console.warn("[push] admin broadcast skipped: Firebase Admin not initialized");
    return { attempted: cleanTokens.length, successCount: 0, failureCount: cleanTokens.length };
  }

  const data = buildDataPayload({
    type: "ADMIN_BROADCAST",
    title: String(title || "").trim(),
    body: String(body || "").trim(),
    extra: deepLink ? { deepLink: String(deepLink).trim() } : {},
  });

  let successCount = 0;
  let failureCount = 0;
  const batchSize = 500;

  for (let i = 0; i < cleanTokens.length; i += batchSize) {
    const batch = cleanTokens.slice(i, i + batchSize);
    const result = await messaging.sendEachForMulticast({
      tokens: batch,
      data,
      android: { priority: "high" },
    });
    successCount += result.successCount;
    failureCount += result.failureCount;
    result.responses.forEach((r, idx) => {
      if (!r.success) {
        const code = String(r.error?.code || "");
        if (
          code.includes("registration-token-not-registered") ||
          code.includes("invalid-registration-token")
        ) {
          deactivatePushToken(batch[idx]).catch(() => {});
        }
      }
    });
  }

  return { attempted: cleanTokens.length, successCount, failureCount };
}

module.exports = {
  sendEventDataNotification,
  sendAdminBroadcast,
};

