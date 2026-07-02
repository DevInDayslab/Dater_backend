const { pool } = require("../config/db");
const { STORE_PLATFORM } = require("../constants/storePlatforms");
const googlePlayBilling = require("./googlePlayBilling.service");
const billingVerificationService = require("./billingVerification.service");
const subscriptionStateService = require("./subscriptionState.service");
const entitlementsService = require("./entitlements.service");
const { debugLog } = require("../utils/serverDebugLog");

const PLATFORM = STORE_PLATFORM.GOOGLE_PLAY;

const SUBSCRIPTION_RENEWED = 2;
const SUBSCRIPTION_CANCELED = 3;
const SUBSCRIPTION_PURCHASED = 4;
const SUBSCRIPTION_ON_HOLD = 5;
const SUBSCRIPTION_IN_GRACE_PERIOD = 6;
const SUBSCRIPTION_RESTARTED = 1;
const SUBSCRIPTION_PAUSED = 10;
const SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED = 11;
const SUBSCRIPTION_EXPIRED = 13;
const SUBSCRIPTION_REVOKED = 12;

async function recordWebhookEvent(platform, messageId, eventType, payload) {
  if (!messageId) return false;
  const res = await pool.query(
    `INSERT INTO store_webhook_events (platform, message_id, event_type, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (platform, message_id) DO NOTHING
     RETURNING message_id`,
    [platform, messageId, eventType, JSON.stringify(payload || {})]
  );
  return Boolean(res.rows[0]);
}

async function findUserIdByPurchaseToken(platform, purchaseToken) {
  const subRes = await pool.query(
    `SELECT user_id FROM store_subscriptions
     WHERE platform = $1 AND purchase_token = $2
     LIMIT 1`,
    [platform, purchaseToken]
  );
  if (subRes.rows[0]?.user_id) return subRes.rows[0].user_id;
  const purchaseRes = await pool.query(
    `SELECT user_id FROM store_purchase_verifications
     WHERE platform = $1 AND purchase_token = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [platform, purchaseToken]
  );
  return purchaseRes.rows[0]?.user_id || null;
}

async function handleSubscriptionNotification(notification) {
  const purchaseToken = notification?.purchaseToken;
  const notificationType = Number(notification?.notificationType);
  if (!purchaseToken) return;

  const userId = await findUserIdByPurchaseToken(PLATFORM, purchaseToken);
  if (!userId) {
    debugLog("billing_rtdn_unknown_token", {
      purchaseToken: purchaseToken.slice(0, 12),
      notificationType,
    });
    return;
  }

  const subscription = await googlePlayBilling.verifySubscription({ purchaseToken });
  const subscriptionId = notification?.subscriptionId;
  const { product, lineItem, resolvedProductId, effectiveBasePlanId } =
    await billingVerificationService.resolvePremiumProductFromSubscription(subscription, {
      productId: subscriptionId,
    });
  const storeOrderId = subscription?.latestOrderId || lineItem?.latestSuccessfulOrderId;

  if (notificationType === SUBSCRIPTION_CANCELED) {
    await subscriptionStateService.applyCanceledSubscription({
      userId,
      subscription,
      purchaseToken,
      notificationType,
    });
    return;
  }

  if (
    notificationType === SUBSCRIPTION_RENEWED ||
    notificationType === SUBSCRIPTION_PURCHASED ||
    notificationType === SUBSCRIPTION_RESTARTED
  ) {
    await billingVerificationService.syncSubscriptionStateFromGoogle({
      userId,
      subscription,
      purchaseToken,
      productId: resolvedProductId || subscriptionId,
      packCode: product?.packCode || null,
      basePlanId: effectiveBasePlanId,
      source: "rtdn",
      notificationType,
    });

    await billingVerificationService.ensureSubscriptionAcknowledged({
      userId,
      productId: resolvedProductId || subscriptionId,
      purchaseToken,
      storeOrderId,
    });

    if (storeOrderId && notificationType === SUBSCRIPTION_RENEWED && product?.packCode) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await entitlementsService.insertPurchase(client, {
          userId,
          itemType: "SUBSCRIPTION",
          packCode: product.packCode,
          amountRupees: Number(product.pricePaise || 0) / 100,
          quantity: 1,
          transactionId: storeOrderId,
          metadata: {
            source: "GOOGLE_PLAY_RENEWAL",
            notificationType,
            platform: PLATFORM,
            planCode: product.planCode,
          },
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        debugLog("billing_rtdn_renewal_ledger_failed", { userId, message: error.message });
      } finally {
        client.release();
      }
    }
    return;
  }

  if (
    notificationType === SUBSCRIPTION_ON_HOLD ||
    notificationType === SUBSCRIPTION_IN_GRACE_PERIOD ||
    notificationType === SUBSCRIPTION_PAUSED ||
    notificationType === SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED ||
    notificationType === SUBSCRIPTION_EXPIRED ||
    notificationType === SUBSCRIPTION_REVOKED
  ) {
    await billingVerificationService.syncSubscriptionStateFromGoogle({
      userId,
      subscription,
      purchaseToken,
      productId: resolvedProductId || subscriptionId,
      packCode: product?.packCode || null,
      basePlanId: effectiveBasePlanId,
      source: "rtdn",
      notificationType,
    });
    return;
  }

  await billingVerificationService.syncSubscriptionStateFromGoogle({
    userId,
    subscription,
    purchaseToken,
    productId: resolvedProductId || subscriptionId,
    packCode: product?.packCode || null,
    basePlanId: effectiveBasePlanId,
    source: "rtdn",
    notificationType,
  });
}

async function handleVoidedPurchase(notification) {
  const purchaseToken = notification?.purchaseToken;
  if (!purchaseToken) return;
  const userId = await findUserIdByPurchaseToken(PLATFORM, purchaseToken);
  if (!userId) return;
  await pool.query(
    `UPDATE users
     SET is_premium = FALSE,
         premium_status = 'INACTIVE',
         premium_expires_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [userId]
  );
}

async function handleWebhook(req, res) {
  try {
    const message = req.body?.message;
    const messageId = message?.messageId;
    const dataRaw = message?.data;
    if (!dataRaw) {
      return res.status(400).json({ success: false, message: "Missing Pub/Sub message data" });
    }

    const decoded = JSON.parse(Buffer.from(dataRaw, "base64").toString("utf8"));
    const eventKind = decoded?.subscriptionNotification
      ? "subscription"
      : decoded?.voidedPurchaseNotification
        ? "voided"
        : decoded?.testNotification
          ? "test"
          : "other";
    const isNew = await recordWebhookEvent(PLATFORM, messageId, eventKind, decoded);
    if (!isNew) {
      return res.status(200).json({ success: true, message: "Duplicate RTDN ignored" });
    }

    if (decoded?.testNotification) {
      return res.status(200).json({ success: true, message: "Test notification received" });
    }

    if (decoded?.subscriptionNotification) {
      await handleSubscriptionNotification(decoded.subscriptionNotification);
    }

    if (decoded?.voidedPurchaseNotification) {
      await handleVoidedPurchase(decoded.voidedPurchaseNotification);
    }

    return res.status(200).json({ success: true, message: "RTDN processed" });
  } catch (error) {
    debugLog("billing_rtdn_error", { message: error.message });
    return res.status(500).json({
      success: false,
      message: "Failed to process RTDN",
      error: error.message,
    });
  }
}

module.exports = {
  handleWebhook,
  handleSubscriptionNotification,
};
