const { query } = require("../../config/db");
const pushNotification = require("../pushNotification.service");

const VALID_AUDIENCES = new Set([
  "ALL_USERS",
  "PREMIUM_ONLY",
  "FREE_ONLY",
  "ACTIVE_7D",
  "CITY",
]);

function parsePagination(queryParams) {
  const page = Math.max(Number.parseInt(queryParams.page, 10) || 1, 1);
  const limit = Math.min(Math.max(Number.parseInt(queryParams.limit, 10) || 25, 1), 100);
  return { page, limit, offset: (page - 1) * limit };
}

function toIso(value) {
  return value ? new Date(value).toISOString() : null;
}

function buildAudienceUserFilter(audience, city) {
  const clauses = [
    "u.deleted_at IS NULL",
    "u.account_state NOT IN ('DELETED'::account_state_enum, 'BANNED'::account_state_enum)",
  ];
  const params = [];

  const a = String(audience || "ALL_USERS").trim().toUpperCase();
  if (!VALID_AUDIENCES.has(a)) {
    const err = new Error("Invalid target audience");
    err.code = "INVALID_AUDIENCE";
    throw err;
  }

  if (a === "PREMIUM_ONLY") {
    clauses.push(`(
      u.premium_status = 'ACTIVE'
      OR (u.premium_expires_at IS NOT NULL AND u.premium_expires_at > NOW())
    )`);
  } else if (a === "FREE_ONLY") {
    clauses.push(`NOT (
      u.premium_status = 'ACTIVE'
      OR (u.premium_expires_at IS NOT NULL AND u.premium_expires_at > NOW())
    )`);
  } else if (a === "ACTIVE_7D") {
    clauses.push("u.last_active_at >= NOW() - INTERVAL '7 days'");
  } else if (a === "CITY") {
    const cityLabel = String(city || "").trim();
    if (!cityLabel) {
      const err = new Error("city is required for CITY audience");
      err.code = "CITY_REQUIRED";
      throw err;
    }
    params.push(`%${cityLabel}%`);
    clauses.push(`u.living_in_city ILIKE $${params.length}`);
  }

  return { audience: a, whereSql: clauses.join(" AND "), params };
}

async function resolveAudienceUserIds(audience, city) {
  const { whereSql, params } = buildAudienceUserFilter(audience, city);
  const res = await query(
    `SELECT DISTINCT u.id
     FROM users u
     INNER JOIN user_push_tokens t
       ON t.user_id = u.id
      AND t.is_active = TRUE
     WHERE ${whereSql}`,
    params
  );
  return res.rows.map((r) => r.id);
}

async function getAudienceSize({ audience, city }) {
  const userIds = await resolveAudienceUserIds(audience, city);
  return {
    audience: String(audience || "ALL_USERS").trim().toUpperCase(),
    city: city || null,
    estimatedRecipients: userIds.length,
  };
}

async function fetchActiveTokensForUsers(userIds) {
  if (!userIds.length) return [];
  const res = await query(
    `SELECT DISTINCT ON (user_id) token
     FROM user_push_tokens
     WHERE user_id = ANY($1::uuid[])
       AND is_active = TRUE
     ORDER BY user_id, last_seen_at DESC`,
    [userIds]
  );
  return res.rows.map((r) => r.token).filter(Boolean);
}

async function sendBroadcast({ title, body, audience, city, deepLink, sentByAdminId }) {
  const trimmedTitle = String(title || "").trim().slice(0, 50);
  const trimmedBody = String(body || "").trim().slice(0, 150);
  if (!trimmedTitle || !trimmedBody) {
    const err = new Error("title and body are required");
    err.code = "INVALID_BROADCAST";
    throw err;
  }

  const audienceKey = String(audience || "ALL_USERS").trim().toUpperCase();
  const userIds = await resolveAudienceUserIds(audienceKey, city);
  const tokens = await fetchActiveTokensForUsers(userIds);

  const pushResult = await pushNotification.sendAdminBroadcast({
    title: trimmedTitle,
    body: trimmedBody,
    deepLink: deepLink || "",
    tokens,
  });

  const insertRes = await query(
    `INSERT INTO admin_broadcasts (
       title, body, target_audience, deep_link, sent_at, recipients_count, sent_by_admin_id, metadata
     ) VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7::jsonb)
     RETURNING id, sent_at`,
    [
      trimmedTitle,
      trimmedBody,
      audienceKey,
      deepLink ? String(deepLink).trim() : null,
      userIds.length,
      sentByAdminId || null,
      JSON.stringify({
        uniqueUsersTargeted: userIds.length,
        tokensAttempted: pushResult.attempted,
        pushSuccessCount: pushResult.successCount,
        pushFailureCount: pushResult.failureCount,
        city: city || null,
      }),
    ]
  );

  const row = insertRes.rows[0];
  return {
    broadcastId: row.id,
    sentAt: toIso(row.sent_at),
    title: trimmedTitle,
    body: trimmedBody,
    targetAudience: audienceKey,
    recipientsCount: userIds.length,
    deepLink: deepLink || null,
    push: pushResult,
  };
}

async function listBroadcasts(queryParams = {}) {
  const { page, limit, offset } = parsePagination(queryParams);

  const countRes = await query(`SELECT COUNT(*)::int AS total FROM admin_broadcasts`);
  const total = Number(countRes.rows[0]?.total || 0);

  const res = await query(
    `SELECT b.id, b.title, b.body, b.target_audience, b.deep_link, b.sent_at,
            b.recipients_count, au.name AS sent_by_admin_name
     FROM admin_broadcasts b
     LEFT JOIN admin_users au ON au.id = b.sent_by_admin_id
     ORDER BY b.sent_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  return {
    items: res.rows.map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      targetAudience: r.target_audience,
      recipientsCount: Number(r.recipients_count || 0),
      sentByAdminName: r.sent_by_admin_name || "Unknown",
      sentAt: toIso(r.sent_at),
      deepLink: r.deep_link || null,
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  };
}

module.exports = {
  getAudienceSize,
  sendBroadcast,
  listBroadcasts,
};
