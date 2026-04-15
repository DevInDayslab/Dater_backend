const { pool } = require("../config/db");
const { debugLog } = require("../utils/serverDebugLog");

const PREMIUM_PLANS = {
  WEEK: { days: 7, packCode: "PREMIUM_WEEK" },
  MONTH: { days: 30, packCode: "PREMIUM_MONTH" },
  THREE_MONTHS: { days: 90, packCode: "PREMIUM_THREE_MONTHS" },
};

const BOOST_PACKS = {
  1: { packCode: "BOOST_1", quantity: 1 },
  5: { packCode: "BOOST_5", quantity: 5 },
  15: { packCode: "BOOST_15", quantity: 15 },
};

const COMMENT_PACKS = {
  2: { packCode: "COMMENTS_2", quantity: 2 },
  5: { packCode: "COMMENTS_5", quantity: 5 },
  15: { packCode: "COMMENTS_15", quantity: 15 },
};

function toIsoOrNull(v) {
  return v ? new Date(v).toISOString() : null;
}

function computeBoostMinutes(activateCount) {
  const pairs = Math.floor(activateCount / 2);
  const remainder = activateCount % 2;
  return pairs * 100 + remainder * 30;
}

async function syncPremiumState(client, userId) {
  const res = await client.query(
    `UPDATE users
     SET is_premium = CASE WHEN premium_expires_at IS NOT NULL AND premium_expires_at > NOW() THEN TRUE ELSE FALSE END,
         premium_status = CASE
           WHEN premium_expires_at IS NOT NULL AND premium_expires_at > NOW() THEN 'ACTIVE'
           WHEN premium_expires_at IS NOT NULL THEN 'EXPIRED'
           ELSE 'INACTIVE'
         END,
         updated_at = NOW()
     WHERE id = $1
     RETURNING is_premium, premium_started_at, premium_expires_at, premium_plan_code, premium_status`,
    [userId]
  );
  return res.rows[0] || null;
}

async function getBoostSnapshot(client, userId) {
  const walletRes = await client.query(
    `SELECT remaining_credits FROM user_boost_wallet WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  const activationRes = await client.query(
    `SELECT started_at, expires_at, activated_count
     FROM user_boost_activations
     WHERE user_id = $1
     ORDER BY expires_at DESC
     LIMIT 1`,
    [userId]
  );
  const latest = activationRes.rows[0] || null;
  const active = latest ? new Date(latest.expires_at).getTime() > Date.now() : false;
  return {
    credits: Number(walletRes.rows[0]?.remaining_credits || 0),
    boostActive: active,
    boostStartedAt: toIsoOrNull(latest?.started_at),
    boostExpiresAt: toIsoOrNull(latest?.expires_at),
  };
}

async function getCommentsSnapshot(client, userId) {
  const res = await client.query(
    `SELECT remaining_paid_comments FROM user_comment_wallet WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  return {
    credits: Number(res.rows[0]?.remaining_paid_comments || 0),
  };
}

async function getEntitlementsSnapshot(userId) {
  const client = await pool.connect();
  try {
    const premium = await syncPremiumState(client, userId);
    const boost = await getBoostSnapshot(client, userId);
    const comments = await getCommentsSnapshot(client, userId);
    return {
      premium: {
        isActive: Boolean(premium?.is_premium),
        startedAt: toIsoOrNull(premium?.premium_started_at),
        expiresAt: toIsoOrNull(premium?.premium_expires_at),
        planCode: premium?.premium_plan_code || null,
        status: premium?.premium_status || "INACTIVE",
      },
      boost,
      comments,
    };
  } finally {
    client.release();
  }
}

async function purchasePremium({ userId, planCode, transactionId }) {
  const normalizedPlan = String(planCode || "").trim().toUpperCase();
  const plan = PREMIUM_PLANS[normalizedPlan];
  if (!plan) {
    const err = new Error("Invalid premium plan");
    err.code = "INVALID_PREMIUM_PLAN";
    throw err;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const startRes = await client.query(
      `SELECT CASE WHEN premium_expires_at IS NOT NULL AND premium_expires_at > NOW() THEN premium_expires_at ELSE NOW() END AS start_at
       FROM users WHERE id = $1 LIMIT 1`,
      [userId]
    );
    const startAt = startRes.rows[0]?.start_at;
    await client.query(
      `UPDATE users
       SET premium_started_at = COALESCE(premium_started_at, NOW()),
           premium_expires_at = ($2::timestamptz + ($3::int || ' days')::interval),
           premium_plan_code = $4,
           is_premium = TRUE,
           premium_status = 'ACTIVE',
           updated_at = NOW()
       WHERE id = $1`,
      [userId, startAt, plan.days, normalizedPlan]
    );
    await client.query(
      `INSERT INTO user_purchases (user_id, product_type, transaction_id, status, purchased_at, pack_code, quantity, metadata)
       VALUES ($1, 'PREMIUM', NULLIF($2, ''), 'SUCCESS', NOW(), $3, 1, jsonb_build_object('planCode', $3, 'durationDays', $4))`,
      [userId, transactionId || null, plan.packCode, plan.days]
    );
    await client.query("COMMIT");
    debugLog("entitlement_premium_purchased", { userId, planCode: normalizedPlan });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return getEntitlementsSnapshot(userId);
}

async function purchaseBoost({ userId, packSize, transactionId }) {
  const size = Number(packSize);
  const pack = BOOST_PACKS[size];
  if (!pack) {
    const err = new Error("Invalid boost pack");
    err.code = "INVALID_BOOST_PACK";
    throw err;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO user_boost_wallet (user_id, remaining_credits, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET remaining_credits = user_boost_wallet.remaining_credits + EXCLUDED.remaining_credits,
                     updated_at = NOW()`,
      [userId, pack.quantity]
    );
    await client.query(
      `INSERT INTO user_purchases (user_id, product_type, transaction_id, status, purchased_at, pack_code, quantity, metadata)
       VALUES ($1, 'BOOST', NULLIF($2, ''), 'SUCCESS', NOW(), $3, $4, jsonb_build_object('packSize', $4))`,
      [userId, transactionId || null, pack.packCode, pack.quantity]
    );
    await client.query("COMMIT");
    debugLog("entitlement_boost_purchased", { userId, packSize: pack.quantity });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return getEntitlementsSnapshot(userId);
}

async function activateBoost({ userId, activateCount }) {
  const count = Math.max(1, Number(activateCount || 0));
  if (!Number.isFinite(count)) {
    const err = new Error("Invalid boost count");
    err.code = "INVALID_BOOST_COUNT";
    throw err;
  }
  const minutesToAdd = computeBoostMinutes(count);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const walletRes = await client.query(
      `SELECT remaining_credits FROM user_boost_wallet WHERE user_id = $1 FOR UPDATE`,
      [userId]
    );
    const credits = Number(walletRes.rows[0]?.remaining_credits || 0);
    if (credits < count) {
      const err = new Error("Not enough boost credits");
      err.code = "INSUFFICIENT_BOOST_CREDITS";
      throw err;
    }
    const existingRes = await client.query(
      `SELECT expires_at
       FROM user_boost_activations
       WHERE user_id = $1
       ORDER BY expires_at DESC
       LIMIT 1`,
      [userId]
    );
    const existingExpiry = existingRes.rows[0]?.expires_at
      ? new Date(existingRes.rows[0].expires_at)
      : null;
    const now = new Date();
    const startAt = existingExpiry && existingExpiry.getTime() > now.getTime() ? existingExpiry : now;
    const expiresAt = new Date(startAt.getTime() + minutesToAdd * 60 * 1000);
    await client.query(
      `INSERT INTO user_boost_activations (user_id, activated_count, started_at, expires_at)
       VALUES ($1, $2, $3::timestamptz, $4::timestamptz)`,
      [userId, count, startAt.toISOString(), expiresAt.toISOString()]
    );
    await client.query(
      `UPDATE user_boost_wallet
       SET remaining_credits = remaining_credits - $2,
           updated_at = NOW()
       WHERE user_id = $1`,
      [userId, count]
    );
    await client.query("COMMIT");
    debugLog("entitlement_boost_activated", { userId, activatedCount: count, minutesToAdd });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return getEntitlementsSnapshot(userId);
}

async function purchaseComments({ userId, packSize, transactionId }) {
  const size = Number(packSize);
  const pack = COMMENT_PACKS[size];
  if (!pack) {
    const err = new Error("Invalid comments pack");
    err.code = "INVALID_COMMENTS_PACK";
    throw err;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO user_comment_wallet (user_id, remaining_paid_comments, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET remaining_paid_comments = user_comment_wallet.remaining_paid_comments + EXCLUDED.remaining_paid_comments,
                     updated_at = NOW()`,
      [userId, pack.quantity]
    );
    await client.query(
      `INSERT INTO user_purchases (user_id, product_type, transaction_id, status, purchased_at, pack_code, quantity, metadata)
       VALUES ($1, 'COMMENTS', NULLIF($2, ''), 'SUCCESS', NOW(), $3, $4, jsonb_build_object('packSize', $4))`,
      [userId, transactionId || null, pack.packCode, pack.quantity]
    );
    await client.query("COMMIT");
    debugLog("entitlement_comments_purchased", { userId, packSize: pack.quantity });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return getEntitlementsSnapshot(userId);
}

async function consumePaidComments({ userId, useCount = 1, reason = "COMMENT_REQUEST" }) {
  const count = Math.max(1, Number(useCount || 1));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const walletRes = await client.query(
      `SELECT remaining_paid_comments FROM user_comment_wallet WHERE user_id = $1 FOR UPDATE`,
      [userId]
    );
    const credits = Number(walletRes.rows[0]?.remaining_paid_comments || 0);
    if (credits < count) {
      const err = new Error("Insufficient paid comments");
      err.code = "INSUFFICIENT_COMMENT_CREDITS";
      throw err;
    }
    await client.query(
      `UPDATE user_comment_wallet
       SET remaining_paid_comments = remaining_paid_comments - $2,
           updated_at = NOW()
       WHERE user_id = $1`,
      [userId, count]
    );
    await client.query(
      `INSERT INTO user_comment_usage (user_id, used_count, reason)
       VALUES ($1, $2, $3)`,
      [userId, count, String(reason || "COMMENT_REQUEST").trim().toUpperCase()]
    );
    await client.query("COMMIT");
    debugLog("entitlement_comments_consumed", { userId, usedCount: count, reason });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return getEntitlementsSnapshot(userId);
}

module.exports = {
  getEntitlementsSnapshot,
  purchasePremium,
  purchaseBoost,
  activateBoost,
  purchaseComments,
  consumePaidComments,
  syncPremiumState,
};

