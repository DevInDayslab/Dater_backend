const { pool } = require("../config/db");
const { STORE_PLATFORM } = require("../constants/storePlatforms");
const googlePlayBilling = require("./googlePlayBilling.service");
const billingVerificationService = require("./billingVerification.service");
const entitlementsService = require("./entitlements.service");
const { debugLog } = require("../utils/serverDebugLog");

const PLATFORM = STORE_PLATFORM.GOOGLE_PLAY;

const SUBSCRIPTION_RENEWED = 2;
const SUBSCRIPTION_CANCELED = 3;
const SUBSCRIPTION_PURCHASED = 4;
const SUBSCRIPTION_ON_HOLD = 5;
const SUBSCRIPTION_IN_GRACE_PERIOD = 6;
const SUBSCRIPTION_RESTARTED = 1;
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
  const lineItem = billingVerificationService.pickSubscriptionLineItem(subscription, {
    productId: notification?.subscriptionId,
  });
  const expiryTime = lineItem?.expiryTime;
  const storeOrderId = subscription?.latestOrderId || lineItem?.latestSuccessfulOrderId;
  const autoRenewing = Boolean(lineItem?.autoRenewingPlan?.autoRenewEnabled);
  const subscriptionState = String(subscription?.subscriptionState || "");

  if (
    notificationType === SUBSCRIPTION_RENEWED ||
    notificationType === SUBSCRIPTION_PURCHASED ||
    notificationType === SUBSCRIPTION_RESTARTED
  ) {
    if (expiryTime) {
      await entitlementsService.extendPremiumFromStore({
        userId,
        orderId: storeOrderId,
        expiresAt: expiryTime,
        autoRenewing,
        metadata: billingVerificationService.storeMetadata(PLATFORM, {
          purchaseToken,
          productId: lineItem?.productId || notification?.subscriptionId,
          orderId: storeOrderId,
          basePlanId: lineItem?.offerDetails?.basePlanId,
        }),
      });
      const client = await pool.connect();
      try {
        await billingVerificationService.upsertStoreSubscription(client, {
          platform: PLATFORM,
          userId,
          storeProductId: lineItem?.productId || notification?.subscriptionId,
          purchaseToken,
          storeOrderId,
          expiryTime,
          autoRenewing,
          storeState: subscriptionState,
          metadata: { notificationType },
        });
      } finally {
        client.release();
      }
    }
    return;
  }

  if (notificationType === SUBSCRIPTION_CANCELED) {
    await pool.query(
      `UPDATE store_subscriptions
       SET auto_renewing = FALSE,
           store_state = $3,
           metadata = metadata || $4::jsonb,
           updated_at = NOW()
       WHERE user_id = $1 AND platform = $2`,
      [
        userId,
        PLATFORM,
        subscriptionState,
        JSON.stringify({ canceledAt: new Date().toISOString() }),
      ]
    );
    return;
  }

  if (
    notificationType === SUBSCRIPTION_IN_GRACE_PERIOD ||
    notificationType === SUBSCRIPTION_ON_HOLD
  ) {
    if (expiryTime) {
      await entitlementsService.extendPremiumFromStore({
        userId,
        orderId: null,
        expiresAt: expiryTime,
        autoRenewing,
        metadata: { graceOrHold: true, notificationType },
      });
    }
    await pool.query(
      `UPDATE store_subscriptions
       SET store_state = $3,
           metadata = metadata || $4::jsonb,
           updated_at = NOW()
       WHERE user_id = $1 AND platform = $2`,
      [userId, PLATFORM, subscriptionState, JSON.stringify({ notificationType })]
    );
    return;
  }

  if (notificationType === SUBSCRIPTION_EXPIRED) {
    await pool.query(
      `UPDATE users
       SET is_premium = FALSE,
           premium_status = 'EXPIRED',
           updated_at = NOW()
       WHERE id = $1`,
      [userId]
    );
    await pool.query(
      `UPDATE store_subscriptions
       SET store_state = $3, auto_renewing = FALSE, updated_at = NOW()
       WHERE user_id = $1 AND platform = $2`,
      [userId, PLATFORM, subscriptionState]
    );
    return;
  }

  if (notificationType === SUBSCRIPTION_REVOKED) {
    await pool.query(
      `UPDATE users
       SET is_premium = FALSE,
           premium_status = 'INACTIVE',
           premium_expires_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [userId]
    );
    await pool.query(
      `UPDATE store_subscriptions
       SET store_state = $3, auto_renewing = FALSE, updated_at = NOW()
       WHERE user_id = $1 AND platform = $2`,
      [userId, PLATFORM, subscriptionState]
    );
  }
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
