const { pool } = require("../config/db");
const { STORE_PLATFORM } = require("../constants/storePlatforms");
const { isPlayBillingConfigured } = require("../config/googlePlay");
const googlePlayBilling = require("./googlePlayBilling.service");
const productConfigService = require("./productConfig.service");
const entitlementsService = require("./entitlements.service");
const subscriptionStateService = require("./subscriptionState.service");
const { debugLog } = require("../utils/serverDebugLog");

const PENDING_SUBSCRIPTION_STATES = new Set(["SUBSCRIPTION_STATE_PENDING"]);

function storeMetadata(platform, { purchaseToken, productId, orderId, basePlanId }) {
  return {
    platform,
    purchaseToken,
    productId,
    orderId,
    basePlanId: basePlanId || null,
  };
}

async function findExistingStorePurchase(platform, storeOrderId) {
  if (!storeOrderId) return null;
  const res = await pool.query(
    `SELECT spv.*, up.user_id
     FROM store_purchase_verifications spv
     LEFT JOIN user_purchases up ON up.id = spv.user_purchase_id
     WHERE spv.platform = $1 AND spv.store_order_id = $2
     LIMIT 1`,
    [platform, storeOrderId]
  );
  return res.rows[0] || null;
}

async function recordStorePurchaseVerification(client, {
  platform,
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
  await client.query(
    `INSERT INTO store_purchase_verifications (
       user_id, platform, store_order_id, purchase_token, store_product_id, pack_code,
       purchase_type, store_state, user_purchase_id, metadata, acknowledged_at, consumed_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb,
       NULL,
       NULL,
       NOW()
     )
     ON CONFLICT (platform, store_order_id) DO UPDATE SET
       store_state = EXCLUDED.store_state,
       metadata = store_purchase_verifications.metadata || EXCLUDED.metadata,
       updated_at = NOW()`,
    [
      userId,
      platform,
      storeOrderId,
      purchaseToken,
      storeProductId,
      packCode,
      purchaseType,
      storeState,
      userPurchaseId,
      JSON.stringify(metadata || {}),
    ]
  );
}

async function upsertStoreSubscription(client, {
  platform,
  userId,
  storeProductId,
  purchaseToken,
  storeOrderId,
  expiryTime,
  autoRenewing,
  storeState,
  metadata,
}) {
  await client.query(
    `INSERT INTO store_subscriptions (
       user_id, platform, store_product_id, purchase_token, latest_order_id,
       expiry_time, auto_renewing, store_state, metadata, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9::jsonb, NOW())
     ON CONFLICT (user_id, platform) DO UPDATE SET
       store_product_id = EXCLUDED.store_product_id,
       purchase_token = EXCLUDED.purchase_token,
       latest_order_id = EXCLUDED.latest_order_id,
       expiry_time = EXCLUDED.expiry_time,
       auto_renewing = EXCLUDED.auto_renewing,
       store_state = EXCLUDED.store_state,
       metadata = store_subscriptions.metadata || EXCLUDED.metadata,
       updated_at = NOW()`,
    [
      userId,
      platform,
      storeProductId,
      purchaseToken,
      storeOrderId,
      expiryTime,
      autoRenewing,
      storeState,
      JSON.stringify(metadata || {}),
    ]
  );
}

function pickSubscriptionLineItem(subscription, { productId, basePlanId }) {
  const lineItems = subscription?.lineItems || [];
  if (!lineItems.length) return null;
  if (basePlanId) {
    const match = lineItems.find(
      (item) =>
        String(item?.offerDetails?.basePlanId || "").toLowerCase() ===
        String(basePlanId).toLowerCase()
    );
    if (match) return match;
  }
  if (productId) {
    const match = lineItems.find((item) => item?.productId === productId);
    if (match) return match;
  }
  return lineItems[0];
}

async function verifyGooglePlaySubscription({
  userId,
  purchaseToken,
  productId,
  packCode,
  basePlanId,
}) {
  const platform = STORE_PLATFORM.GOOGLE_PLAY;

  const subscription = await googlePlayBilling.verifySubscription({ purchaseToken });
  const subscriptionState = String(subscription?.subscriptionState || "");
  if (PENDING_SUBSCRIPTION_STATES.has(subscriptionState)) {
    const err = new Error("Subscription payment is pending");
    err.code = "PURCHASE_PENDING";
    throw err;
  }

  const lineItem = pickSubscriptionLineItem(subscription, {
    productId,
    basePlanId,
  });
  const resolvedBasePlanId = lineItem?.offerDetails?.basePlanId || basePlanId || null;
  const resolvedProductId = lineItem?.productId || productId;

  let product = await productConfigService.getProductByGooglePlayProductId(resolvedProductId, {
    basePlanId: resolvedBasePlanId,
  });
  if ((!product || product.category !== "PREMIUM") && packCode) {
    product = await productConfigService.getProductByPackCode(packCode);
  }
  if (!product || product.category !== "PREMIUM") {
    const err = new Error("Invalid premium pack");
    err.code = "INVALID_PREMIUM_PLAN";
    throw err;
  }
  if (product.googlePlayProductId && product.googlePlayProductId !== resolvedProductId) {
    const err = new Error("Product ID does not match catalog");
    err.code = "PRODUCT_MISMATCH";
    throw err;
  }

  const effectiveBasePlanId = resolvedBasePlanId || product.googlePlayBasePlanId;
  const expiryTime = lineItem?.expiryTime;
  if (!expiryTime) {
    const err = new Error("Subscription expiry missing from Google");
    err.code = "INVALID_SUBSCRIPTION";
    throw err;
  }
  if (!subscriptionStateService.subscriptionStateGrantsAccess(subscriptionState, expiryTime)) {
    const err = new Error("Subscription is not active");
    err.code = "SUBSCRIPTION_INACTIVE";
    throw err;
  }

  const storeOrderId =
    subscription?.latestOrderId ||
    lineItem?.latestSuccessfulOrderId ||
    `play_sub_${purchaseToken.slice(0, 24)}`;

  const existing = await findExistingStorePurchase(platform, storeOrderId);
  if (existing?.user_id && String(existing.user_id) === String(userId)) {
    return entitlementsService.getEntitlementsSnapshot(userId);
  }

  const autoRenewing = Boolean(lineItem?.autoRenewingPlan?.autoRenewEnabled);
  const metadata = storeMetadata(platform, {
    purchaseToken,
    productId: resolvedProductId,
    orderId: storeOrderId,
    basePlanId: effectiveBasePlanId,
  });

  await subscriptionStateService.applySubscriptionStateFromGoogle({
    userId,
    subscription,
    purchaseToken,
    productId: resolvedProductId,
    packCode: product.packCode,
    planCode: product.planCode,
    basePlanId: effectiveBasePlanId,
    source: "verify",
  });

  const normalizedPlan = String(product.planCode || "").trim().toUpperCase();
  const amountRupees = Number(product.pricePaise) / 100;

  const client = await pool.connect();
  let userPurchaseId = null;
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE users
       SET premium_plan_code = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [userId, normalizedPlan]
    );
    userPurchaseId = await entitlementsService.insertPurchase(client, {
      userId,
      itemType: "SUBSCRIPTION",
      packCode: product.packCode,
      amountRupees,
      quantity: 1,
      transactionId: storeOrderId,
      metadata: {
        planCode: normalizedPlan,
        packCode: product.packCode,
        autoRenewing,
        source: "GOOGLE_PLAY",
        ...(metadata || {}),
      },
    });
    await recordStorePurchaseVerification(client, {
      platform,
      userId,
      storeOrderId,
      purchaseToken,
      storeProductId: resolvedProductId,
      packCode: product.packCode,
      purchaseType: "SUBSCRIPTION",
      storeState: subscriptionState,
      userPurchaseId,
      metadata,
    });
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  try {
    await googlePlayBilling.acknowledgeSubscription({ productId: resolvedProductId, purchaseToken });
    await pool.query(
      `UPDATE store_purchase_verifications
       SET acknowledged_at = NOW(), updated_at = NOW()
       WHERE platform = $1 AND store_order_id = $2`,
      [platform, storeOrderId]
    );
  } catch (ackErr) {
    debugLog("billing_ack_failed", { userId, storeOrderId, message: ackErr.message });
  }

  return entitlementsService.getEntitlementsSnapshot(userId);
}

async function verifyGooglePlayInApp({
  userId,
  purchaseToken,
  productId,
  packCode,
  threadId,
}) {
  const platform = STORE_PLATFORM.GOOGLE_PLAY;
  const product = await productConfigService.getProductByPackCode(packCode);
  if (!product) {
    const err = new Error("Invalid product pack");
    err.code = "INVALID_PRODUCT_PACK";
    throw err;
  }
  if (!["BOOST", "COMMENTS", "CHAT"].includes(product.category)) {
    const err = new Error("Pack is not a one-time purchase");
    err.code = "INVALID_PRODUCT_TYPE";
    throw err;
  }
  if (product.googlePlayProductId && product.googlePlayProductId !== productId) {
    const err = new Error("Product ID does not match catalog");
    err.code = "PRODUCT_MISMATCH";
    throw err;
  }

  const purchase = await googlePlayBilling.verifyInAppPurchase({ productId, purchaseToken });
  const purchaseState = Number(purchase?.purchaseState);
  if (purchaseState === 2) {
    const err = new Error("Purchase payment is pending");
    err.code = "PURCHASE_PENDING";
    throw err;
  }
  if (purchaseState !== 0) {
    const err = new Error("Purchase is not completed");
    err.code = "PURCHASE_NOT_COMPLETED";
    throw err;
  }

  const storeOrderId =
    String(purchase?.orderId || "").trim() || `play_inapp_${purchaseToken.slice(0, 24)}`;
  const existing = await findExistingStorePurchase(platform, storeOrderId);
  if (existing?.user_id && String(existing.user_id) === String(userId)) {
    try {
      await googlePlayBilling.consumeInApp({ productId, purchaseToken });
    } catch (consumeErr) {
      debugLog("billing_consume_retry_existing", { storeOrderId, message: consumeErr.message });
    }
    return entitlementsService.getEntitlementsSnapshot(userId);
  }

  const metadata = storeMetadata(platform, {
    purchaseToken,
    productId,
    orderId: storeOrderId,
  });

  let result;
  if (product.category === "BOOST") {
    result = await entitlementsService.purchaseBoost({
      userId,
      packCode: product.packCode,
      transactionId: storeOrderId,
      metadata,
    });
  } else if (product.category === "COMMENTS") {
    result = await entitlementsService.purchaseComments({
      userId,
      packCode: product.packCode,
      transactionId: storeOrderId,
      metadata,
    });
  } else {
    if (!threadId) {
      const err = new Error("threadId is required for chat unlock");
      err.code = "INVALID_INPUT";
      throw err;
    }
    await entitlementsService.purchaseChatUnlock({
      userId,
      threadId,
      packCode: product.packCode,
      transactionId: storeOrderId,
      metadata,
    });
    result = await entitlementsService.getEntitlementsSnapshot(userId);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const purchaseRow = await client.query(
      `SELECT id FROM user_purchases WHERE transaction_id = $1 LIMIT 1`,
      [storeOrderId]
    );
    await recordStorePurchaseVerification(client, {
      platform,
      userId,
      storeOrderId,
      purchaseToken,
      storeProductId: productId,
      packCode: product.packCode,
      purchaseType: "INAPP",
      storeState: "PURCHASED",
      userPurchaseId: purchaseRow.rows[0]?.id || null,
      metadata,
    });
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  try {
    await googlePlayBilling.consumeInApp({ productId, purchaseToken });
    await pool.query(
      `UPDATE store_purchase_verifications
       SET consumed_at = NOW(), updated_at = NOW()
       WHERE platform = $1 AND store_order_id = $2`,
      [platform, storeOrderId]
    );
  } catch (consumeErr) {
    debugLog("billing_consume_failed", { userId, storeOrderId, message: consumeErr.message });
  }

  return result;
}

/**
 * Entry point for mobile clients. Dispatches by store platform.
 * iOS will call with platform=APP_STORE once App Store verification is implemented.
 */
async function verifyPurchase({
  userId,
  platform = STORE_PLATFORM.GOOGLE_PLAY,
  purchaseToken,
  productId,
  packCode,
  basePlanId,
  threadId,
}) {
  const normalizedPlatform = String(platform || STORE_PLATFORM.GOOGLE_PLAY).trim().toUpperCase();

  if (normalizedPlatform === STORE_PLATFORM.APP_STORE) {
    const err = new Error("App Store verification is not implemented yet");
    err.code = "APP_STORE_NOT_IMPLEMENTED";
    throw err;
  }

  if (normalizedPlatform !== STORE_PLATFORM.GOOGLE_PLAY) {
    const err = new Error("Unsupported store platform");
    err.code = "UNSUPPORTED_PLATFORM";
    throw err;
  }

  if (!isPlayBillingConfigured()) {
    const err = new Error("Google Play billing is not configured on the server");
    err.code = "PLAY_NOT_CONFIGURED";
    throw err;
  }

  const normalizedToken = String(purchaseToken || "").trim();
  const normalizedProductId = String(productId || "").trim();
  const normalizedPackCode = String(packCode || "").trim();
  if (!normalizedToken || !normalizedProductId) {
    const err = new Error("purchaseToken and productId are required");
    err.code = "INVALID_INPUT";
    throw err;
  }

  if (!normalizedPackCode) {
    const premiumProduct = await productConfigService.getProductByGooglePlayProductId(
      normalizedProductId,
      { basePlanId }
    );
    if (premiumProduct?.category === "PREMIUM") {
      return verifyGooglePlaySubscription({
        userId,
        purchaseToken: normalizedToken,
        productId: normalizedProductId,
        packCode: null,
        basePlanId,
      });
    }
    const err = new Error("packCode is required for one-time purchases");
    err.code = "INVALID_INPUT";
    throw err;
  }

  const product = await productConfigService.getProductByPackCode(normalizedPackCode);
  if (!product) {
    const err = new Error("Unknown product pack");
    err.code = "INVALID_PRODUCT_PACK";
    throw err;
  }

  if (product.category === "PREMIUM") {
    return verifyGooglePlaySubscription({
      userId,
      purchaseToken: normalizedToken,
      productId: normalizedProductId,
      packCode: normalizedPackCode,
      basePlanId,
    });
  }

  return verifyGooglePlayInApp({
    userId,
    purchaseToken: normalizedToken,
    productId: normalizedProductId,
    packCode: normalizedPackCode,
    threadId,
  });
}

module.exports = {
  STORE_PLATFORM,
  verifyPurchase,
  verifyGooglePlaySubscription,
  verifyGooglePlayInApp,
  findExistingStorePurchase,
  upsertStoreSubscription,
  recordStorePurchaseVerification,
  pickSubscriptionLineItem,
  storeMetadata,
  // Back-compat aliases for RTDN service
  upsertPlaySubscription: upsertStoreSubscription,
  playMetadata: (fields) => storeMetadata(STORE_PLATFORM.GOOGLE_PLAY, fields),
};
