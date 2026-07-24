const { pool } = require("../config/db");
const { STORE_PLATFORM } = require("../constants/storePlatforms");
const { isAppleBillingConfigured, getSignedDataVerifier } = require("../config/appleStore");
const productConfigService = require("./productConfig.service");
const entitlementsService = require("./entitlements.service");
const { debugLog } = require("../utils/serverDebugLog");
const { VerificationException } = require("@apple/app-store-server-library");

async function findExistingStorePurchase(storeOrderId) {
  if (!storeOrderId) return null;
  const res = await pool.query(
    `SELECT spv.*, up.user_id
     FROM store_purchase_verifications spv
     LEFT JOIN user_purchases up ON up.id = spv.user_purchase_id
     WHERE spv.platform = $1 AND spv.store_order_id = $2
     LIMIT 1`,
    [STORE_PLATFORM.APP_STORE, storeOrderId]
  );
  return res.rows[0] || null;
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
      STORE_PLATFORM.APP_STORE,
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

/**
 * Decode + cryptographically verify StoreKit 2 transaction JWS.
 */
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
    const expiresAt = resolveExpiryDate(decoded, product);
    snapshot = await entitlementsService.grantPremiumFromStore({
      userId,
      packCode: product.packCode,
      planCode: product.planCode,
      orderId: transactionId,
      expiresAt: expiresAt.toISOString(),
      autoRenewing: true,
      metadata,
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
      // Orphaned Transaction.updates retry without UI threadId — credit wallet.
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
    // Use transactionId (not originalTransactionId) so subscription renewals
    // do not collide on idx_spv_platform_token_product.
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
};
