const { pool } = require("../config/db");
const { STORE_PLATFORM } = require("../constants/storePlatforms");
const { isAppleBillingConfigured, getSignedDataVerifier } = require("../config/appleStore");
const productConfigService = require("./productConfig.service");
const entitlementsService = require("./entitlements.service");
const storeBillingLedger = require("./storeBillingLedger.service");
const { revertPremiumExclusiveSettings, clearPrivacyModeOnPremiumLoss } = require("./premiumExclusiveSettings.service");
const { debugLog } = require("../utils/serverDebugLog");
const { VerificationException, NotificationTypeV2 } = require("@apple/app-store-server-library");

const PLATFORM = STORE_PLATFORM.APP_STORE;

async function findExistingStorePurchase(storeOrderId) {
  if (!storeOrderId) return null;
  const res = await pool.query(
    `SELECT spv.*, up.user_id
     FROM store_purchase_verifications spv
     LEFT JOIN user_purchases up ON up.id = spv.user_purchase_id
     WHERE spv.platform = $1 AND spv.store_order_id = $2
     LIMIT 1`,
    [PLATFORM, storeOrderId]
  );
  return res.rows[0] || null;
}

async function findUserIdByOriginalTransactionId(originalTransactionId) {
  const token = String(originalTransactionId || "").trim();
  if (!token) return null;

  const subRes = await pool.query(
    `SELECT user_id FROM store_subscriptions
     WHERE platform = $1 AND purchase_token = $2
     LIMIT 1`,
    [PLATFORM, token]
  );
  if (subRes.rows[0]?.user_id) return subRes.rows[0].user_id;

  const purchaseRes = await pool.query(
    `SELECT user_id FROM store_purchase_verifications
     WHERE platform = $1
       AND (
         purchase_token = $2
         OR metadata->>'originalTransactionId' = $2
       )
     ORDER BY created_at DESC
     LIMIT 1`,
    [PLATFORM, token]
  );
  return purchaseRes.rows[0]?.user_id || null;
}

async function recordStorePurchaseVerification({
  userId,
  storeOrderId,
  purchaseToken,
  storeProductId,
  packCode,
  purchaseType,
  storeState,
  userPurchaseId,
  metadata,
}) {
  await pool.query(
    `INSERT INTO store_purchase_verifications (
       user_id, platform, store_order_id, purchase_token, store_product_id, pack_code,
       purchase_type, store_state, user_purchase_id, metadata, acknowledged_at, consumed_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb,
       NOW(),
       CASE WHEN $7 = 'INAPP' THEN NOW() ELSE NULL END,
       NOW()
     )
     ON CONFLICT (platform, store_order_id) DO UPDATE SET
       store_state = EXCLUDED.store_state,
       metadata = store_purchase_verifications.metadata || EXCLUDED.metadata,
       updated_at = NOW()`,
    [
      userId,
      PLATFORM,
      storeOrderId,
      purchaseToken,
      storeProductId,
      packCode,
      purchaseType,
      storeState,
      userPurchaseId || null,
      JSON.stringify(metadata || {}),
    ]
  );
}

async function recordWebhookEvent(messageId, eventType, payload) {
  if (!messageId) return false;
  const res = await pool.query(
    `INSERT INTO store_webhook_events (platform, message_id, event_type, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (platform, message_id) DO NOTHING
     RETURNING message_id`,
    [PLATFORM, messageId, eventType, JSON.stringify(payload || {})]
  );
  return Boolean(res.rows[0]);
}

function mapAppleVerificationError(error) {
  if (error?.code) return error;
  if (error instanceof VerificationException || error?.status != null) {
    const err = new Error(error.message || "Apple JWS verification failed");
    err.code = "APPLE_JWS_INVALID";
    err.cause = error;
    return err;
  }
  return error;
}

async function decodeAndVerifyAppleJws(jwsToken) {
  if (!isAppleBillingConfigured()) {
    const err = new Error("App Store billing is not configured on the server");
    err.code = "APPLE_NOT_CONFIGURED";
    throw err;
  }
  const token = String(jwsToken || "").trim();
  if (!token || token.split(".").length !== 3) {
    const err = new Error("jwsToken must be a StoreKit 2 JWS compact serialization string");
    err.code = "INVALID_JWS";
    throw err;
  }
  try {
    const verifier = getSignedDataVerifier();
    return await verifier.verifyAndDecodeTransaction(token);
  } catch (error) {
    throw mapAppleVerificationError(error);
  }
}

function resolveExpiryDate(decoded, product) {
  if (decoded?.expiresDate) {
    const fromApple = new Date(Number(decoded.expiresDate));
    if (!Number.isNaN(fromApple.getTime())) return fromApple;
  }
  const days = Number(product?.durationDays);
  if (Number.isFinite(days) && days > 0) {
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }
  const err = new Error("Subscription expiry missing from Apple transaction");
  err.code = "INVALID_SUBSCRIPTION";
  throw err;
}

function autoRenewingFromDecoded(decoded) {
  // StoreKit transaction payload may omit this; renewal info is separate.
  if (decoded?.autoRenewStatus == null) return true;
  return Number(decoded.autoRenewStatus) === 1 || decoded.autoRenewStatus === true;
}

/**
 * Upsert APP_STORE row so ASSN webhooks can resolve user by originalTransactionId.
 */
async function upsertAppleStoreSubscription({
  userId,
  productId,
  originalTransactionId,
  transactionId,
  expiresAt,
  autoRenewing,
  storeState,
  metadata = {},
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await storeBillingLedger.upsertStoreSubscription(client, {
      platform: PLATFORM,
      userId,
      storeProductId: productId,
      purchaseToken: originalTransactionId,
      storeOrderId: transactionId,
      expiryTime: expiresAt ? new Date(expiresAt).toISOString() : null,
      autoRenewing: Boolean(autoRenewing),
      storeState: String(storeState || "ACTIVE"),
      metadata: {
        source: "APP_STORE",
        originalTransactionId,
        transactionId,
        ...metadata,
      },
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function markApplePremiumExpired({ userId, status = "EXPIRED", originalTransactionId, productId, transactionId }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE users
       SET is_premium = FALSE,
           premium_status = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [userId, status]
    );
    if (status === "EXPIRED") {
      await revertPremiumExclusiveSettings(client, userId);
    } else {
      await clearPrivacyModeOnPremiumLoss(client, userId);
    }
    if (originalTransactionId) {
      const prior = await client.query(
        `SELECT store_product_id FROM store_subscriptions
         WHERE user_id = $1 AND platform = $2
         LIMIT 1`,
        [userId, PLATFORM]
      );
      const resolvedProductId =
        productId || prior.rows[0]?.store_product_id || "com.dater.premium.unknown";
      await storeBillingLedger.upsertStoreSubscription(client, {
        platform: PLATFORM,
        userId,
        storeProductId: resolvedProductId,
        purchaseToken: originalTransactionId,
        storeOrderId: transactionId || null,
        expiryTime: null,
        autoRenewing: false,
        storeState: status,
        metadata: {
          source: "APP_STORE_WEBHOOK",
          originalTransactionId,
          subscriptionAccess: "REVOKED",
        },
      });
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function markApplePremiumCancelled({ userId, expiresAt, originalTransactionId, productId, transactionId }) {
  const expiryIso = expiresAt ? new Date(expiresAt).toISOString() : null;
  const stillActive = expiryIso && new Date(expiryIso).getTime() > Date.now();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (stillActive) {
      await client.query(
        `UPDATE users
         SET premium_expires_at = $2::timestamptz,
             is_premium = TRUE,
             premium_status = 'CANCELLED',
             updated_at = NOW()
         WHERE id = $1`,
        [userId, expiryIso]
      );
    }
    if (originalTransactionId) {
      const prior = await client.query(
        `SELECT store_product_id FROM store_subscriptions
         WHERE user_id = $1 AND platform = $2
         LIMIT 1`,
        [userId, PLATFORM]
      );
      const resolvedProductId =
        productId || prior.rows[0]?.store_product_id || "com.dater.premium.unknown";
      await storeBillingLedger.upsertStoreSubscription(client, {
        platform: PLATFORM,
        userId,
        storeProductId: resolvedProductId,
        purchaseToken: originalTransactionId,
        storeOrderId: transactionId || null,
        expiryTime: expiryIso,
        autoRenewing: false,
        storeState: "CANCELLED",
        metadata: {
          source: "APP_STORE_WEBHOOK",
          originalTransactionId,
          canceledAt: new Date().toISOString(),
          subscriptionAccess: stillActive ? "GRANTED" : "REVOKED",
        },
      });
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Apply premium from a verified Apple transaction (purchase, renew, or launch sync).
 */
async function applyApplePremiumGrant({
  userId,
  product,
  decoded,
  notificationType = null,
  isRenewal = false,
}) {
  const productId = String(decoded.productId || product.appleProductId || "").trim();
  const transactionId = String(decoded.transactionId || "").trim();
  const originalTransactionId = String(decoded.originalTransactionId || transactionId).trim();
  const expiresAt = resolveExpiryDate(decoded, product);
  const autoRenewing = autoRenewingFromDecoded(decoded);

  const metadata = {
    source: isRenewal ? "APP_STORE_RENEWAL" : "APP_STORE",
    appleProductId: productId,
    transactionId,
    originalTransactionId,
    type: decoded.type || null,
    environment: decoded.environment || null,
    notificationType,
  };

  if (isRenewal) {
    await entitlementsService.extendPremiumFromStore({
      userId,
      orderId: transactionId,
      expiresAt: expiresAt.toISOString(),
      autoRenewing,
      packCode: product.packCode,
      amountRupees: Number(product.pricePaise) / 100,
      metadata,
    });
  } else {
    await entitlementsService.grantPremiumFromStore({
      userId,
      packCode: product.packCode,
      planCode: product.planCode,
      orderId: transactionId,
      expiresAt: expiresAt.toISOString(),
      autoRenewing,
      metadata,
    });
  }

  await upsertAppleStoreSubscription({
    userId,
    productId,
    originalTransactionId,
    transactionId,
    expiresAt: expiresAt.toISOString(),
    autoRenewing,
    storeState: isRenewal ? "DID_RENEW" : "SUBSCRIBED",
    metadata,
  });

  return entitlementsService.getEntitlementsSnapshot(userId);
}

/**
 * Verify Apple StoreKit 2 purchase and grant entitlements using shared DB writers.
 */
async function verifyApplePurchase({ userId, jwsToken, threadId }) {
  const decoded = await decodeAndVerifyAppleJws(jwsToken);
  const productId = String(decoded.productId || "").trim();
  const transactionId = String(decoded.transactionId || "").trim();
  const originalTransactionId = String(decoded.originalTransactionId || transactionId).trim();

  if (!productId || !transactionId) {
    const err = new Error("Apple transaction missing productId or transactionId");
    err.code = "INVALID_JWS";
    throw err;
  }

  const product = await productConfigService.getProductByAppleProductId(productId);
  if (!product) {
    const err = new Error("Unknown Apple product");
    err.code = "INVALID_PRODUCT";
    throw err;
  }

  const existing = await findExistingStorePurchase(transactionId);
  if (existing?.user_id && String(existing.user_id) === String(userId)) {
    // Launch sync of an already-fulfilled tx — refresh subscription mirror + expiry only.
    if (product.category === "PREMIUM") {
      try {
        const expiresAt = resolveExpiryDate(decoded, product);
        await upsertAppleStoreSubscription({
          userId,
          productId,
          originalTransactionId,
          transactionId,
          expiresAt: expiresAt.toISOString(),
          autoRenewing: autoRenewingFromDecoded(decoded),
          storeState: String(decoded.type || "ACTIVE"),
          metadata: { source: "APP_STORE_SYNC" },
        });
        if (expiresAt.getTime() > Date.now()) {
          await pool.query(
            `UPDATE users
             SET premium_expires_at = $2::timestamptz,
                 is_premium = TRUE,
                 premium_status = CASE
                   WHEN premium_status = 'CANCELLED' THEN 'CANCELLED'
                   ELSE 'ACTIVE'
                 END,
                 updated_at = NOW()
             WHERE id = $1`,
            [userId, expiresAt.toISOString()]
          );
        }
      } catch (syncErr) {
        debugLog("apple_sync_refresh_failed", { userId, transactionId, message: syncErr.message });
      }
    }
    return entitlementsService.getEntitlementsSnapshot(userId);
  }
  if (existing?.user_id && String(existing.user_id) !== String(userId)) {
    const err = new Error("Purchase already fulfilled for another account");
    err.code = "PURCHASE_ALREADY_OWNED";
    throw err;
  }

  const metadata = {
    source: "APP_STORE",
    appleProductId: productId,
    transactionId,
    originalTransactionId,
    type: decoded.type || null,
    environment: decoded.environment || null,
  };

  let snapshot;
  const purchaseType = product.category === "PREMIUM" ? "SUBSCRIPTION" : "INAPP";

  if (product.category === "PREMIUM") {
    // Renewals arrive as new transactionIds — treat existing Apple sub for this user as renewal.
    const priorSub = await pool.query(
      `SELECT 1 FROM store_subscriptions
       WHERE user_id = $1 AND platform = $2 AND purchase_token = $3
       LIMIT 1`,
      [userId, PLATFORM, originalTransactionId]
    );
    const isRenewal = priorSub.rows.length > 0;
    snapshot = await applyApplePremiumGrant({
      userId,
      product,
      decoded,
      isRenewal,
    });
  } else if (product.category === "BOOST") {
    snapshot = await entitlementsService.purchaseBoost({
      userId,
      packCode: product.packCode,
      packSize: product.quantity,
      transactionId,
      metadata,
    });
  } else if (product.category === "COMMENTS") {
    snapshot = await entitlementsService.purchaseComments({
      userId,
      packCode: product.packCode,
      packSize: product.quantity,
      transactionId,
      metadata,
    });
  } else if (product.category === "CHAT") {
    const normalizedThreadId = String(threadId || "").trim();
    if (normalizedThreadId) {
      await entitlementsService.purchaseChatUnlock({
        userId,
        threadId: normalizedThreadId,
        packCode: product.packCode,
        transactionId,
        metadata,
      });
      snapshot = await entitlementsService.getEntitlementsSnapshot(userId);
    } else {
      snapshot = await entitlementsService.creditPendingChatUnlock({
        userId,
        packCode: product.packCode,
        transactionId,
        metadata,
      });
    }
  } else {
    const err = new Error("Unsupported product category");
    err.code = "INVALID_PRODUCT_TYPE";
    throw err;
  }

  await recordStorePurchaseVerification({
    userId,
    storeOrderId: transactionId,
    // Unique per transaction for renewals; originalTransactionId lives in metadata + store_subscriptions.
    purchaseToken: transactionId,
    storeProductId: productId,
    packCode: product.packCode,
    purchaseType,
    storeState: String(decoded.type || "PURCHASED"),
    metadata: {
      ...metadata,
      threadId: String(threadId || "").trim() || null,
    },
  });

  debugLog("apple_purchase_verified", {
    userId,
    productId,
    transactionId,
    packCode: product.packCode,
    category: product.category,
  });

  return snapshot;
}

async function decodeNotificationPayload(signedPayload) {
  if (!isAppleBillingConfigured()) {
    const err = new Error("App Store billing is not configured on the server");
    err.code = "APPLE_NOT_CONFIGURED";
    throw err;
  }
  const payload = String(signedPayload || "").trim();
  if (!payload || payload.split(".").length !== 3) {
    const err = new Error("signedPayload must be a JWS compact serialization string");
    err.code = "INVALID_JWS";
    throw err;
  }
  try {
    const verifier = getSignedDataVerifier();
    return await verifier.verifyAndDecodeNotification(payload);
  } catch (error) {
    throw mapAppleVerificationError(error);
  }
}

async function decodeSignedTransactionInfo(signedTransactionInfo) {
  if (!signedTransactionInfo) return null;
  try {
    const verifier = getSignedDataVerifier();
    return await verifier.verifyAndDecodeTransaction(signedTransactionInfo);
  } catch (error) {
    debugLog("apple_webhook_tx_decode_failed", { message: error.message });
    return null;
  }
}

/**
 * App Store Server Notifications V2 handler.
 * Always safe to acknowledge; unknown users are no-ops.
 */
async function handleAppleWebhook({ signedPayload }) {
  const notification = await decodeNotificationPayload(signedPayload);
  const notificationType = String(notification.notificationType || "");
  const subtype = String(notification.subtype || "");
  const notificationUUID = String(notification.notificationUUID || "").trim();
  const data = notification.data || {};

  const inserted = await recordWebhookEvent(notificationUUID || `${notificationType}_${Date.now()}`, notificationType, {
    notificationType,
    subtype,
    environment: data.environment || notification.data?.environment || null,
  });
  if (!inserted && notificationUUID) {
    debugLog("apple_webhook_duplicate", { notificationUUID, notificationType });
    return { ok: true, duplicate: true };
  }

  const decodedTx = await decodeSignedTransactionInfo(data.signedTransactionInfo);
  if (!decodedTx) {
    debugLog("apple_webhook_no_transaction", { notificationType, subtype });
    return { ok: true, skipped: true };
  }

  const productId = String(decodedTx.productId || "").trim();
  const transactionId = String(decodedTx.transactionId || "").trim();
  const originalTransactionId = String(decodedTx.originalTransactionId || transactionId).trim();

  const userId = await findUserIdByOriginalTransactionId(originalTransactionId);
  if (!userId) {
    debugLog("apple_webhook_unknown_token", {
      originalTransactionId: originalTransactionId.slice(0, 12),
      notificationType,
    });
    return { ok: true, unknownUser: true };
  }

  const product = productId
    ? await productConfigService.getProductByAppleProductId(productId)
    : null;

  const renewTypes = new Set([
    NotificationTypeV2.DID_RENEW,
    NotificationTypeV2.SUBSCRIBED,
    NotificationTypeV2.OFFER_REDEEMED,
    "DID_RENEW",
    "SUBSCRIBED",
    "OFFER_REDEEMED",
  ]);
  const expireTypes = new Set([
    NotificationTypeV2.EXPIRED,
    NotificationTypeV2.GRACE_PERIOD_EXPIRED,
    NotificationTypeV2.REVOKE,
    NotificationTypeV2.REFUND,
    "EXPIRED",
    "GRACE_PERIOD_EXPIRED",
    "REVOKE",
    "REFUND",
  ]);

  if (renewTypes.has(notificationType) && product?.category === "PREMIUM") {
    const isRenewal = notificationType === NotificationTypeV2.DID_RENEW || notificationType === "DID_RENEW";
    await applyApplePremiumGrant({
      userId,
      product,
      decoded: decodedTx,
      notificationType,
      isRenewal,
    });
    // Idempotent verification ledger for renewals
    await recordStorePurchaseVerification({
      userId,
      storeOrderId: transactionId,
      purchaseToken: transactionId,
      storeProductId: productId,
      packCode: product.packCode,
      purchaseType: "SUBSCRIPTION",
      storeState: notificationType,
      metadata: {
        source: "APP_STORE_WEBHOOK",
        originalTransactionId,
        notificationType,
        subtype,
      },
    });
    debugLog("apple_webhook_renewed", { userId, transactionId, notificationType });
    return { ok: true, applied: "renew" };
  }

  if (
    notificationType === NotificationTypeV2.DID_CHANGE_RENEWAL_STATUS ||
    notificationType === "DID_CHANGE_RENEWAL_STATUS"
  ) {
    if (subtype === "AUTO_RENEW_DISABLED") {
      let expiresAt = null;
      try {
        expiresAt = resolveExpiryDate(decodedTx, product);
      } catch {
        expiresAt = decodedTx.expiresDate ? new Date(Number(decodedTx.expiresDate)) : null;
      }
      await markApplePremiumCancelled({
        userId,
        expiresAt,
        originalTransactionId,
        productId,
        transactionId,
      });
      debugLog("apple_webhook_cancelled", { userId, notificationType, subtype });
      return { ok: true, applied: "cancelled" };
    }
    // AUTO_RENEW_ENABLED — refresh grant if we have product + expiry
    if (product?.category === "PREMIUM") {
      await applyApplePremiumGrant({
        userId,
        product,
        decoded: decodedTx,
        notificationType,
        isRenewal: true,
      });
    }
    return { ok: true, applied: "renewal_status" };
  }

  if (expireTypes.has(notificationType)) {
    const status =
      notificationType === NotificationTypeV2.REFUND ||
      notificationType === "REFUND" ||
      notificationType === NotificationTypeV2.REVOKE ||
      notificationType === "REVOKE"
        ? "INACTIVE"
        : "EXPIRED";
    await markApplePremiumExpired({
      userId,
      status,
      originalTransactionId,
      productId,
      transactionId,
    });
    debugLog("apple_webhook_expired", { userId, notificationType, status });
    return { ok: true, applied: "expire" };
  }

  // DID_FAIL_TO_RENEW / DID_CHANGE_RENEWAL_PREF — sync expiry mirror only if still active
  if (product?.category === "PREMIUM" && decodedTx.expiresDate) {
    try {
      const expiresAt = resolveExpiryDate(decodedTx, product);
      if (expiresAt.getTime() > Date.now()) {
        await upsertAppleStoreSubscription({
          userId,
          productId,
          originalTransactionId,
          transactionId,
          expiresAt: expiresAt.toISOString(),
          autoRenewing: autoRenewingFromDecoded(decodedTx),
          storeState: notificationType || "ACTIVE",
          metadata: { notificationType, subtype, source: "APP_STORE_WEBHOOK" },
        });
      }
    } catch (e) {
      debugLog("apple_webhook_soft_sync_failed", { message: e.message, notificationType });
    }
  }

  return { ok: true, applied: "noop" };
}

async function getAppleCatalog() {
  return productConfigService.getAppleCatalogPayload();
}

async function redeemChatUnlockCredit({ userId, threadId }) {
  return entitlementsService.redeemPendingChatUnlock({ userId, threadId });
}

module.exports = {
  verifyApplePurchase,
  getAppleCatalog,
  redeemChatUnlockCredit,
  decodeAndVerifyAppleJws,
  handleAppleWebhook,
};
