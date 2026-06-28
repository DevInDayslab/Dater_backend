const { pool } = require("../config/db");
const { debugLog } = require("../utils/serverDebugLog");
const productConfigService = require("./productConfig.service");

function toIsoOrNull(v) {
  return v ? new Date(v).toISOString() : null;
}

function devTransactionId(userId, packCode) {
  return `dev_${userId}_${packCode}_${Date.now()}`;
}

async function resolvePremiumProduct({ packCode, planCode }) {
  if (packCode) {
    const product = await productConfigService.getProductByPackCode(packCode);
    if (product?.category === "PREMIUM") return product;
  }
  if (planCode) {
    return productConfigService.getProductByPlanCode(planCode);
  }
  return null;
}

async function resolvePackProduct(category, { packCode, packSize }) {
  if (packCode) {
    const product = await productConfigService.getProductByPackCode(packCode);
    if (product?.category === category) return product;
  }
  if (packSize != null) {
    return productConfigService.getProductByPackSize(category, packSize);
  }
  return null;
}

async function insertPurchase(client, {
  userId,
  itemType,
  packCode,
  amountRupees,
  quantity,
  transactionId,
  metadata,
}) {
  const txId = String(transactionId || "").trim() || devTransactionId(userId, packCode);
  await client.query(
    `INSERT INTO user_purchases (user_id, item_type, amount, transaction_id, pack_code, quantity, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())`,
    [
      userId,
      itemType,
      amountRupees,
      txId,
      packCode,
      quantity,
      JSON.stringify(metadata || {}),
    ]
  );
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
  // Stacked boosts insert multiple rows; the latest row alone can have started_at in the "future"
  // (segment starts when the previous segment ends). For UI ring + countdown use the full active window.
  const activeRes = await client.query(
    `SELECT MIN(started_at) AS session_started_at,
            MAX(expires_at) AS session_expires_at
     FROM user_boost_activations
     WHERE user_id = $1
       AND expires_at > NOW()`,
    [userId]
  );
  const activeRow = activeRes.rows[0] || null;
  const sessionExpires = activeRow?.session_expires_at ? new Date(activeRow.session_expires_at) : null;
  const active = Boolean(sessionExpires && sessionExpires.getTime() > Date.now());

  let boostStartedAt = toIsoOrNull(activeRow?.session_started_at);
  let boostExpiresAt = toIsoOrNull(activeRow?.session_expires_at);

  // When nothing is active, still expose the most recent activation so clients can detect "just ended"
  // (e.g. success overlay) using a past boostExpiresAt — aggregates above return null with no active rows.
  if (!active) {
    const latestRes = await client.query(
      `SELECT started_at, expires_at
       FROM user_boost_activations
       WHERE user_id = $1
       ORDER BY expires_at DESC
       LIMIT 1`,
      [userId]
    );
    const latest = latestRes.rows[0] || null;
    boostStartedAt = toIsoOrNull(latest?.started_at);
    boostExpiresAt = toIsoOrNull(latest?.expires_at);
  }

  return {
    credits: Number(walletRes.rows[0]?.remaining_credits || 0),
    boostActive: active,
    boostStartedAt,
    boostExpiresAt,
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

async function purchasePremium({ userId, planCode, packCode, transactionId }) {
  const product = await resolvePremiumProduct({ packCode, planCode });
  if (!product) {
    const err = new Error("Invalid premium plan");
    err.code = "INVALID_PREMIUM_PLAN";
    throw err;
  }
  const normalizedPlan = String(product.planCode || planCode || "").trim().toUpperCase();
  const durationDays = Number(product.durationDays);
  const amountRupees = Number(product.pricePaise) / 100;
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
      [userId, startAt, durationDays, normalizedPlan]
    );
    await insertPurchase(client, {
      userId,
      itemType: "SUBSCRIPTION",
      packCode: product.packCode,
      amountRupees,
      quantity: 1,
      transactionId,
      metadata: { planCode: normalizedPlan, durationDays, packCode: product.packCode },
    });
    await client.query("COMMIT");
    debugLog("entitlement_premium_purchased", { userId, planCode: normalizedPlan, packCode: product.packCode });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return getEntitlementsSnapshot(userId);
}

async function purchaseBoost({ userId, packSize, packCode, transactionId }) {
  const product = await resolvePackProduct("BOOST", { packCode, packSize });
  if (!product) {
    const err = new Error("Invalid boost pack");
    err.code = "INVALID_BOOST_PACK";
    throw err;
  }
  const amountRupees = Number(product.pricePaise) / 100;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO user_boost_wallet (user_id, remaining_credits, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET remaining_credits = user_boost_wallet.remaining_credits + EXCLUDED.remaining_credits,
                     updated_at = NOW()`,
      [userId, product.quantity]
    );
    await insertPurchase(client, {
      userId,
      itemType: "BOOST",
      packCode: product.packCode,
      amountRupees,
      quantity: product.quantity,
      transactionId,
      metadata: { packCode: product.packCode, quantity: product.quantity },
    });
    await client.query("COMMIT");
    debugLog("entitlement_boost_purchased", { userId, packCode: product.packCode, quantity: product.quantity });
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

async function purchaseComments({ userId, packSize, packCode, transactionId }) {
  const product = await resolvePackProduct("COMMENTS", { packCode, packSize });
  if (!product) {
    const err = new Error("Invalid comments pack");
    err.code = "INVALID_COMMENTS_PACK";
    throw err;
  }
  const amountRupees = Number(product.pricePaise) / 100;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO user_comment_wallet (user_id, remaining_paid_comments, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET remaining_paid_comments = user_comment_wallet.remaining_paid_comments + EXCLUDED.remaining_paid_comments,
                     updated_at = NOW()`,
      [userId, product.quantity]
    );
    await insertPurchase(client, {
      userId,
      itemType: "COMMENTS",
      packCode: product.packCode,
      amountRupees,
      quantity: product.quantity,
      transactionId,
      metadata: { packCode: product.packCode, quantity: product.quantity },
    });
    await client.query("COMMIT");
    debugLog("entitlement_comments_purchased", { userId, packCode: product.packCode, quantity: product.quantity });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return getEntitlementsSnapshot(userId);
}

/**
 * Debit paid comments inside an existing transaction (caller owns BEGIN/COMMIT).
 * @param {import("pg").PoolClient} client
 */
async function consumePaidCommentsWithClient(client, userId, useCount = 1, reason = "COMMENT_REQUEST") {
  const count = Math.max(1, Number(useCount || 1));
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
  debugLog("entitlement_comments_consumed", { userId, usedCount: count, reason });
}

async function consumePaidComments({ userId, useCount = 1, reason = "COMMENT_REQUEST" }) {
  const count = Math.max(1, Number(useCount || 1));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await consumePaidCommentsWithClient(client, userId, count, reason);
    await client.query("COMMIT");
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
  consumePaidCommentsWithClient,
  syncPremiumState,
};

