const { pool } = require("../config/db");
const { debugLog } = require("../utils/serverDebugLog");
const productConfigService = require("./productConfig.service");
const chatService = require("./chat.service");
const { hasPremiumAccess } = require("./subscriptionState.service");

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
  try {
    const res = await client.query(
      `INSERT INTO user_purchases (user_id, item_type, amount, transaction_id, pack_code, quantity, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
       RETURNING id`,
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
    return res.rows[0]?.id || null;
  } catch (e) {
    if (e.code === "23505") {
      const existing = await client.query(
        `SELECT id FROM user_purchases WHERE transaction_id = $1 LIMIT 1`,
        [txId]
      );
      return existing.rows[0]?.id || null;
    }
    throw e;
  }
}

function computeBoostMinutes(activateCount) {
  const pairs = Math.floor(activateCount / 2);
  const remainder = activateCount % 2;
  return pairs * 100 + remainder * 30;
}

async function syncPremiumState(client, userId) {
  const res = await client.query(
    `UPDATE users
     SET is_premium = CASE
           WHEN premium_status IN ('ON_HOLD', 'PAUSED', 'EXPIRED', 'INACTIVE') THEN FALSE
           WHEN premium_status = 'GRACE_PERIOD' THEN
             CASE WHEN premium_expires_at IS NOT NULL AND premium_expires_at > NOW() THEN TRUE ELSE FALSE END
           WHEN premium_status IN ('ACTIVE', 'CANCELLED') THEN
             CASE WHEN premium_expires_at IS NOT NULL AND premium_expires_at > NOW() THEN TRUE ELSE FALSE END
           WHEN premium_expires_at IS NOT NULL AND premium_expires_at > NOW() THEN TRUE
           ELSE FALSE
         END,
         premium_status = CASE
           WHEN premium_status IN ('ON_HOLD', 'PAUSED', 'GRACE_PERIOD') THEN premium_status
           WHEN premium_status = 'CANCELLED' AND premium_expires_at IS NOT NULL AND premium_expires_at > NOW() THEN 'CANCELLED'
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
        isActive: hasPremiumAccess(premium),
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

async function grantPremiumFromStore({
  userId,
  packCode,
  planCode,
  orderId,
  expiresAt,
  autoRenewing = true,
  metadata = {},
}) {
  const product = await resolvePremiumProduct({ packCode, planCode });
  if (!product) {
    const err = new Error("Invalid premium plan");
    err.code = "INVALID_PREMIUM_PLAN";
    throw err;
  }
  const normalizedPlan = String(product.planCode || planCode || "").trim().toUpperCase();
  const amountRupees = Number(product.pricePaise) / 100;
  const expiryDate = new Date(expiresAt);
  if (Number.isNaN(expiryDate.getTime())) {
    const err = new Error("Invalid subscription expiry from Google");
    err.code = "INVALID_SUBSCRIPTION";
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE users
       SET premium_started_at = COALESCE(premium_started_at, NOW()),
           premium_expires_at = $2::timestamptz,
           premium_plan_code = $3,
           is_premium = TRUE,
           premium_status = 'ACTIVE',
           updated_at = NOW()
       WHERE id = $1`,
      [userId, expiryDate.toISOString(), normalizedPlan]
    );
    await insertPurchase(client, {
      userId,
      itemType: "SUBSCRIPTION",
      packCode: product.packCode,
      amountRupees,
      quantity: 1,
      transactionId: orderId,
      metadata: {
        planCode: normalizedPlan,
        packCode: product.packCode,
        autoRenewing,
        source: "GOOGLE_PLAY",
        ...(metadata || {}),
      },
    });
    await client.query("COMMIT");
    debugLog("entitlement_premium_granted_google", {
      userId,
      planCode: normalizedPlan,
      packCode: product.packCode,
      expiresAt: expiryDate.toISOString(),
    });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return getEntitlementsSnapshot(userId);
}

async function extendPremiumFromStore({
  userId,
  orderId,
  expiresAt,
  autoRenewing,
  metadata = {},
  amountRupees = 0,
  packCode = null,
}) {
  const expiryDate = new Date(expiresAt);
  if (Number.isNaN(expiryDate.getTime())) {
    const err = new Error("Invalid subscription expiry from Google");
    err.code = "INVALID_SUBSCRIPTION";
    throw err;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE users
       SET premium_expires_at = $2::timestamptz,
           is_premium = CASE WHEN $2::timestamptz > NOW() THEN TRUE ELSE is_premium END,
           premium_status = CASE WHEN $2::timestamptz > NOW() THEN 'ACTIVE' ELSE premium_status END,
           updated_at = NOW()
       WHERE id = $1`,
      [userId, expiryDate.toISOString()]
    );
    if (orderId) {
      await insertPurchase(client, {
        userId,
        itemType: "SUBSCRIPTION",
        packCode: packCode || "PREMIUM_RENEWAL",
        amountRupees,
        quantity: 1,
        transactionId: orderId,
        metadata: { source: "GOOGLE_PLAY_RENEWAL", autoRenewing, ...(metadata || {}) },
      });
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return getEntitlementsSnapshot(userId);
}

async function purchasePremium({ userId, planCode, packCode, transactionId, metadata }) {
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
      metadata: { planCode: normalizedPlan, durationDays, packCode: product.packCode, ...(metadata || {}) },
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

async function purchaseBoost({ userId, packSize, packCode, transactionId, metadata }) {
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
      metadata: { packCode: product.packCode, quantity: product.quantity, ...(metadata || {}) },
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
    await client.query(
      `INSERT INTO premium_boosts (user_id, started_at, expires_at)
       VALUES ($1, $3::timestamptz, $4::timestamptz)`,
      [userId, startAt.toISOString(), expiresAt.toISOString()]
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

async function purchaseComments({ userId, packSize, packCode, transactionId, metadata }) {
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
      metadata: { packCode: product.packCode, quantity: product.quantity, ...(metadata || {}) },
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

async function purchaseChatUnlock({ userId, threadId, packCode, transactionId, metadata }) {
  const product = await resolvePackProduct("CHAT", { packCode });
  if (!product) {
    const err = new Error("Invalid chat unlock pack");
    err.code = "INVALID_CHAT_UNLOCK_PACK";
    throw err;
  }

  const normalizedThreadId = String(threadId || "").trim();
  if (!normalizedThreadId) {
    const err = new Error("threadId is required");
    err.code = "INVALID_INPUT";
    throw err;
  }

  const isParticipant = await chatService.ensureParticipant(normalizedThreadId, userId);
  if (!isParticipant) {
    const err = new Error("Thread not found");
    err.code = "THREAD_NOT_FOUND";
    throw err;
  }

  const peer = await chatService.getThreadPeer(normalizedThreadId, userId);
  if (!peer) {
    const err = new Error("Thread peer not found");
    err.code = "THREAD_PEER_NOT_FOUND";
    throw err;
  }

  const amountRupees = Number(product.pricePaise) / 100;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const restrictionRes = await client.query(
      `SELECT is_unlocked, is_locally_unlocked
       FROM chat_restrictions
       WHERE user_id = $1 AND target_id = $2
       FOR UPDATE`,
      [userId, peer.id]
    );
    const restriction = restrictionRes.rows[0];
    if (restriction?.is_unlocked === true || restriction?.is_locally_unlocked === true) {
      const err = new Error("Chat is already unlocked");
      err.code = "CHAT_ALREADY_UNLOCKED";
      throw err;
    }

    const purchaseId = await insertPurchase(client, {
      userId,
      itemType: "UNLOCK_CHAT",
      packCode: product.packCode,
      amountRupees,
      quantity: 1,
      transactionId,
      metadata: {
        threadId: normalizedThreadId,
        targetUserId: peer.id,
        packCode: product.packCode,
        ...(metadata || {}),
      },
    });

    await client.query(
      `INSERT INTO chat_restrictions (user_id, target_id, is_unlocked, updated_at)
       VALUES ($1, $2, TRUE, NOW())
       ON CONFLICT (user_id, target_id)
       DO UPDATE SET is_unlocked = TRUE, updated_at = NOW()`,
      [userId, peer.id]
    );

    await client.query(
      `INSERT INTO chat_unlock_events (user_id, target_id, purchase_id)
       VALUES ($1, $2, $3)`,
      [userId, peer.id, purchaseId]
    );

    await client.query("COMMIT");
    debugLog("entitlement_chat_unlock_purchased", {
      userId,
      threadId: normalizedThreadId,
      targetUserId: peer.id,
      packCode: product.packCode,
    });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  return {
    success: true,
    threadId: normalizedThreadId,
    packCode: product.packCode,
  };
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
  grantPremiumFromStore,
  grantPremiumFromGoogle: grantPremiumFromStore,
  extendPremiumFromStore,
  extendPremiumFromGoogle: extendPremiumFromStore,
  purchaseBoost,
  activateBoost,
  purchaseComments,
  purchaseChatUnlock,
  consumePaidComments,
  consumePaidCommentsWithClient,
  syncPremiumState,
  insertPurchase,
  hasPremiumAccess,
};

