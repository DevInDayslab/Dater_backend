const { pool } = require("../config/db");
const { STORE_PLATFORM } = require("../constants/storePlatforms");
const storeBillingLedger = require("./storeBillingLedger.service");
const { revertPremiumExclusiveSettings } = require("./premiumExclusiveSettings.service");
const { debugLog } = require("../utils/serverDebugLog");

const STATE_ACTIVE = "SUBSCRIPTION_STATE_ACTIVE";
const STATE_CANCELED = "SUBSCRIPTION_STATE_CANCELED";
const STATE_GRACE = "SUBSCRIPTION_STATE_IN_GRACE_PERIOD";
const STATE_ON_HOLD = "SUBSCRIPTION_STATE_ON_HOLD";
const STATE_PAUSED = "SUBSCRIPTION_STATE_PAUSED";
const STATE_EXPIRED = "SUBSCRIPTION_STATE_EXPIRED";

const RTDN_ON_HOLD = 5;
const RTDN_GRACE = 6;
const RTDN_PAUSED = 10;
const RTDN_PAUSE_SCHEDULE_CHANGED = 11;
const RTDN_REVOKED = 12;
const RTDN_EXPIRED = 13;

function hasPremiumAccess(userRow) {
  if (!userRow) return false;
  const status = String(userRow.premium_status || "INACTIVE").toUpperCase();
  if (["ON_HOLD", "PAUSED", "EXPIRED", "INACTIVE"].includes(status)) {
    return false;
  }
  if (["ACTIVE", "GRACE_PERIOD", "CANCELLED"].includes(status)) {
    const expiresAt = userRow.premium_expires_at;
    if (!expiresAt) return false;
    return new Date(expiresAt).getTime() > Date.now();
  }
  return Boolean(userRow.is_premium);
}

function subscriptionStateGrantsAccess(subscriptionState, expiryTime) {
  const state = String(subscriptionState || "");
  if ([STATE_ON_HOLD, STATE_PAUSED, STATE_EXPIRED].includes(state)) {
    return false;
  }
  if (!expiryTime) return false;
  if (new Date(expiryTime).getTime() <= Date.now()) {
    return false;
  }
  return [STATE_ACTIVE, STATE_GRACE, STATE_CANCELED].includes(state);
}

function resolvePremiumStatus(subscriptionState) {
  const state = String(subscriptionState || "");
  switch (state) {
    case STATE_GRACE:
      return "GRACE_PERIOD";
    case STATE_ON_HOLD:
      return "ON_HOLD";
    case STATE_PAUSED:
      return "PAUSED";
    case STATE_EXPIRED:
      return "EXPIRED";
    case STATE_CANCELED:
      return "CANCELLED";
    case STATE_ACTIVE:
    default:
      return "ACTIVE";
  }
}

function subscriptionAccessFlag(subscriptionState) {
  return subscriptionStateGrantsAccess(subscriptionState, new Date(Date.now() + 1000).toISOString())
    ? "GRANTED"
    : "REVOKED";
}

async function applyUserPremiumFromState(client, {
  userId,
  subscriptionState,
  expiryTime,
  autoRenewing,
  planCode,
  packCode,
  orderId,
  metadata = {},
}) {
  const status = resolvePremiumStatus(subscriptionState);
  const grantsAccess = subscriptionStateGrantsAccess(subscriptionState, expiryTime);
  const expiryIso = expiryTime ? new Date(expiryTime).toISOString() : null;

  if (grantsAccess && expiryIso) {
    await client.query(
      `UPDATE users
       SET premium_started_at = COALESCE(premium_started_at, NOW()),
           premium_expires_at = $2::timestamptz,
           premium_plan_code = COALESCE($3, premium_plan_code),
           is_premium = TRUE,
           premium_status = $4,
           updated_at = NOW()
       WHERE id = $1`,
      [userId, expiryIso, planCode || null, status === "CANCELLED" ? "CANCELLED" : status]
    );
  } else if (status === "ON_HOLD" || status === "PAUSED") {
    await client.query(
      `UPDATE users
       SET is_premium = FALSE,
           premium_status = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [userId, status]
    );
    await revertPremiumExclusiveSettings(client, userId);
  } else if (status === "EXPIRED") {
    await client.query(
      `UPDATE users
       SET is_premium = FALSE,
           premium_status = 'EXPIRED',
           updated_at = NOW()
       WHERE id = $1`,
      [userId]
    );
    await revertPremiumExclusiveSettings(client, userId);
  } else if (!grantsAccess) {
    // Past expiry or stale line item — sync DB flags only. Do not revert settings here;
    // auto-renew may be in flight via Play verify. Revert only on explicit EXPIRED/ON_HOLD/PAUSED above.
    await client.query(
      `UPDATE users
       SET is_premium = FALSE,
           premium_status = 'EXPIRED',
           updated_at = NOW()
       WHERE id = $1`,
      [userId]
    );
  }

  return { grantsAccess, status, expiryIso, autoRenewing };
}

async function applySubscriptionStateFromGoogle({
  userId,
  subscription,
  purchaseToken,
  productId,
  packCode,
  planCode,
  basePlanId,
  source = "verify",
  notificationType,
}) {
  const subscriptionState = String(subscription?.subscriptionState || "");
  const lineItem = storeBillingLedger.pickSubscriptionLineItem(subscription, {
    productId,
    basePlanId,
  });
  const expiryTime = lineItem?.expiryTime || null;
  const storeOrderId =
    subscription?.latestOrderId || lineItem?.latestSuccessfulOrderId || null;
  const autoRenewing = Boolean(lineItem?.autoRenewingPlan?.autoRenewEnabled);
  const resolvedProductId = lineItem?.productId || productId || null;
  const resolvedBasePlanId = lineItem?.offerDetails?.basePlanId || basePlanId || null;

  const metadata = storeBillingLedger.storeMetadata(STORE_PLATFORM.GOOGLE_PLAY, {
    purchaseToken,
    productId: resolvedProductId,
    orderId: storeOrderId,
    basePlanId: resolvedBasePlanId,
  });
  metadata.source = source;
  if (notificationType != null) {
    metadata.notificationType = notificationType;
  }
  metadata.subscriptionAccess = subscriptionStateGrantsAccess(subscriptionState, expiryTime)
    ? "GRANTED"
    : "REVOKED";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await applyUserPremiumFromState(client, {
      userId,
      subscriptionState,
      expiryTime,
      autoRenewing,
      planCode,
      packCode,
      orderId: storeOrderId,
      metadata: { ...metadata, purchaseToken },
    });

    if (purchaseToken) {
      await storeBillingLedger.upsertStoreSubscription(client, {
        platform: STORE_PLATFORM.GOOGLE_PLAY,
        userId,
        storeProductId: resolvedProductId,
        purchaseToken,
        storeOrderId,
        expiryTime,
        autoRenewing,
        storeState: subscriptionState,
        metadata: {
          ...metadata,
          subscriptionAccess: metadata.subscriptionAccess,
        },
      });
    }

    await client.query("COMMIT");
    debugLog("billing_subscription_state_applied", {
      userId,
      subscriptionState,
      source,
      notificationType,
      grantsAccess: result.grantsAccess,
      status: result.status,
    });
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function applyCanceledSubscription({ userId, subscription, purchaseToken, notificationType }) {
  const subscriptionState = String(subscription?.subscriptionState || STATE_CANCELED);
  const lineItem = storeBillingLedger.pickSubscriptionLineItem(subscription, {
    productId: subscription?.lineItems?.[0]?.productId,
  });
  const expiryTime = lineItem?.expiryTime || null;
  const autoRenewing = false;
  const storeOrderId =
    subscription?.latestOrderId || lineItem?.latestSuccessfulOrderId || null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (expiryTime && subscriptionStateGrantsAccess(STATE_CANCELED, expiryTime)) {
      await client.query(
        `UPDATE users
         SET premium_expires_at = $2::timestamptz,
             is_premium = TRUE,
             premium_status = 'CANCELLED',
             updated_at = NOW()
         WHERE id = $1`,
        [userId, new Date(expiryTime).toISOString()]
      );
    }
    if (purchaseToken) {
      await storeBillingLedger.upsertStoreSubscription(client, {
        platform: STORE_PLATFORM.GOOGLE_PLAY,
        userId,
        storeProductId: lineItem?.productId,
        purchaseToken,
        storeOrderId,
        expiryTime,
        autoRenewing,
        storeState: subscriptionState,
        metadata: {
          notificationType,
          canceledAt: new Date().toISOString(),
          subscriptionAccess: "GRANTED",
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

module.exports = {
  STATE_ACTIVE,
  STATE_CANCELED,
  STATE_GRACE,
  STATE_ON_HOLD,
  STATE_PAUSED,
  STATE_EXPIRED,
  RTDN_ON_HOLD,
  RTDN_GRACE,
  RTDN_PAUSED,
  RTDN_PAUSE_SCHEDULE_CHANGED,
  RTDN_REVOKED,
  RTDN_EXPIRED,
  hasPremiumAccess,
  subscriptionStateGrantsAccess,
  resolvePremiumStatus,
  subscriptionAccessFlag,
  applySubscriptionStateFromGoogle,
  applyCanceledSubscription,
};
