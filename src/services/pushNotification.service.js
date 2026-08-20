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

function looksLikeApnsDeviceToken(token) {
  return /^[0-9a-fA-F]{64}$/.test(String(token || "").trim());
}

function classifyPushToken(token) {
  const trimmed = String(token || "").trim();
  if (!trimmed) return "empty";
  if (looksLikeApnsDeviceToken(trimmed)) return "apns_hex";
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/i.test(trimmed)) {
    return "uuid_like";
  }
  if (trimmed.length < 80) return "short";
  return "fcm";
}

function redactTokenPrefix(token) {
  const trimmed = String(token || "").trim();
  if (!trimmed) return "";
  if (trimmed.length <= 12) return trimmed;
  return `${trimmed.slice(0, 12)}…`;
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

function buildApnsAlertConfig(title, body) {
  return {
    headers: {
      "apns-priority": "10",
      "apns-push-type": "alert",
    },
    payload: {
      aps: {
        alert: {
          title: String(title || "").trim(),
          body: String(body || "").trim(),
        },
        sound: "default",
      },
    },
  };
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
    console.warn("[push] skip: user disabled push and in-app for event", {
      recipientUserId,
      canonicalType,
      pushEnabled: flags.pushEnabled,
      inAppEnabled: flags.inAppEnabled,
    });
    return { ok: false, reason: "preferences_disabled", canonicalType };
  }

  const tokenRes = await query(
    `SELECT token, platform
     FROM user_push_tokens
     WHERE user_id = $1
       AND is_active = TRUE
     ORDER BY last_seen_at DESC
     LIMIT 20`,
    [recipientUserId]
  );
  const rows = tokenRes.rows
    .map((r) => ({
      token: String(r.token || "").trim(),
      platform: String(r.platform || "").trim().toUpperCase(),
    }))
    .filter((r) => r.token);
  if (rows.length === 0) {
    console.warn("[push] skip: no active tokens", { recipientUserId, canonicalType });
    return { ok: false, reason: "no_active_tokens", canonicalType };
  }

  const fcmTargets = [];
  const skippedTokens = [];
  for (const row of rows) {
    const tokenKind = classifyPushToken(row.token);
    if (looksLikeApnsDeviceToken(row.token)) {
      skippedTokens.push({
        platform: row.platform,
        tokenKind,
        reason: "apns_hex",
        tokenPrefix: redactTokenPrefix(row.token),
      });
      continue;
    }
    if (tokenKind === "uuid_like") {
      skippedTokens.push({
        platform: row.platform,
        tokenKind,
        reason: "uuid_like",
        tokenPrefix: redactTokenPrefix(row.token),
      });
      continue;
    }
    fcmTargets.push({ token: row.token, platform: row.platform, tokenKind });
  }
  if (skippedTokens.length > 0) {
    console.warn("[push] skip invalid device tokens (need FCM token from Firebase SDK)", {
      recipientUserId,
      canonicalType,
      skipped: skippedTokens,
    });
  }
  if (fcmTargets.length === 0) {
    console.warn("[push] skip: no FCM-capable tokens", {
      recipientUserId,
      canonicalType,
      tokenKinds: rows.map((r) => ({ platform: r.platform, kind: classifyPushToken(r.token) })),
      skippedTokens,
    });
    return { ok: false, reason: "no_fcm_capable_tokens", canonicalType, skippedTokens };
  }

  const messaging = getMessaging();
  if (!messaging) {
    console.warn("[push] skip: Firebase Admin not initialized (set FIREBASE_SERVICE_ACCOUNT_JSON)", {
      recipientUserId,
      canonicalType,
    });
    return { ok: false, reason: "firebase_admin_not_initialized", canonicalType };
  }

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

  const fcmTokens = fcmTargets.map((t) => t.token);
  const multicast = {
    tokens: fcmTokens,
    data,
    android: {
      priority: "high",
    },
    apns: buildApnsAlertConfig(title, body),
  };

  const result = await messaging.sendEachForMulticast(multicast);
  const tokenResults = result.responses.map((r, i) => {
    const target = fcmTargets[i];
    return {
      platform: target.platform,
      tokenKind: target.tokenKind,
      tokenPrefix: redactTokenPrefix(target.token),
      ok: r.success,
      code: r.success ? "" : String(r.error?.code || ""),
      message: r.success ? "" : String(r.error?.message || ""),
    };
  });
  const failed = [];
  result.responses.forEach((r, i) => {
    if (!r.success) failed.push({ token: fcmTokens[i], error: r.error, target: fcmTargets[i] });
  });
  for (const f of failed) {
    const code = String(f.error?.code || "");
    if (code.includes("registration-token-not-registered") || code.includes("invalid-registration-token")) {
      await deactivatePushToken(f.token);
    }
  }

  const delivery = {
    ok: result.successCount > 0,
    canonicalType,
    attempted: fcmTokens.length,
    successCount: result.successCount,
    failureCount: result.failureCount,
    skippedTokens,
    tokenResults,
    failures: failed.map((f) => ({
      platform: f.target.platform,
      tokenKind: f.target.tokenKind,
      tokenPrefix: redactTokenPrefix(f.token),
      code: String(f.error?.code || ""),
      message: String(f.error?.message || ""),
    })),
  };

  if (delivery.ok) {
    console.log("[push] delivered", {
      recipientUserId,
      canonicalType,
      attempted: delivery.attempted,
      successCount: delivery.successCount,
      failureCount: delivery.failureCount,
      tokenResults: delivery.tokenResults,
    });
  } else {
    console.warn("[push] delivery failed", {
      recipientUserId,
      canonicalType,
      attempted: delivery.attempted,
      skippedTokens: delivery.skippedTokens,
      tokenResults: delivery.tokenResults,
      failures: delivery.failures,
    });
  }

  return delivery;
}

async function sendTestPushToUser(userId, { eventType = "CHAT_DM" } = {}) {
  const canonicalType = canonicalPushEventType(eventType);
  return sendEventDataNotification({
    recipientUserId: userId,
    actorUserId: "",
    eventType: canonicalType,
    title: "Dater test",
    body: "Push delivery test from admin",
    extraData: { testPush: "true" },
  });
}

/**
 * Admin broadcast to active tokens, bypasses per-event preference toggles.
 * iOS requires aps.alert (not data-only) for tray notifications when backgrounded/killed.
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
      apns: buildApnsAlertConfig(title, body),
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
  sendTestPushToUser,
  classifyPushToken,
  redactTokenPrefix,
  canonicalPushEventType,
};
