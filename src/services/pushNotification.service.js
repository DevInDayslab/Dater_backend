const { query } = require("../config/db");
const { getMessaging } = require("./firebaseAdmin.service");

// Backend must not guess app foreground/background using timestamps.
// Send data payload if user wants either channel; client decides final route.
function shouldAttemptPush({ pushEnabled, inAppEnabled }) {
  return Boolean(pushEnabled || inAppEnabled);
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
  const flags = mapping[String(eventType || "").trim()] || { pushEnabled: true, inAppEnabled: true };
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
  if (tokens.length === 0) return;

  const messaging = getMessaging();
  if (!messaging) return;

  // Data-only payload by design. Never send "notification" block.
  const data = buildDataPayload({
    type: eventType,
    title,
    body,
    actorUserId,
    chatId,
    extra: extraData,
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

module.exports = {
  sendEventDataNotification,
};

