require("dotenv").config();
const { pool } = require("../config/db");
const { STORE_PLATFORM } = require("../constants/storePlatforms");
const { isPlayBillingConfigured } = require("../config/googlePlay");
const googlePlayBilling = require("../services/googlePlayBilling.service");
const billingVerificationService = require("../services/billingVerification.service");
const entitlementsService = require("../services/entitlements.service");

const PLATFORM = STORE_PLATFORM.GOOGLE_PLAY;

async function reconcilePlaySubscriptions() {
  if (!isPlayBillingConfigured()) {
    console.log("Google Play billing is not configured; skipping reconcile.");
    process.exit(0);
  }

  const res = await pool.query(
    `SELECT user_id, purchase_token, store_product_id
     FROM store_subscriptions
     WHERE platform = $1
       AND (expiry_time IS NULL OR expiry_time < NOW() + INTERVAL '48 hours')
     ORDER BY updated_at ASC
     LIMIT 200`,
    [PLATFORM]
  );

  let updated = 0;
  for (const row of res.rows) {
    try {
      const subscription = await googlePlayBilling.verifySubscription({
        purchaseToken: row.purchase_token,
      });
      const lineItem = billingVerificationService.pickSubscriptionLineItem(subscription, {
        productId: row.store_product_id,
      });
      const expiryTime = lineItem?.expiryTime;
      if (!expiryTime) continue;
      await entitlementsService.extendPremiumFromStore({
        userId: row.user_id,
        orderId: subscription?.latestOrderId || null,
        expiresAt: expiryTime,
        autoRenewing: Boolean(lineItem?.autoRenewingPlan?.autoRenewEnabled),
        metadata: { source: "RECONCILE_JOB", platform: PLATFORM },
      });
      const client = await pool.connect();
      try {
        await billingVerificationService.upsertStoreSubscription(client, {
          platform: PLATFORM,
          userId: row.user_id,
          storeProductId: row.store_product_id,
          purchaseToken: row.purchase_token,
          storeOrderId: subscription?.latestOrderId,
          expiryTime,
          autoRenewing: Boolean(lineItem?.autoRenewingPlan?.autoRenewEnabled),
          storeState: subscription?.subscriptionState,
          metadata: { source: "RECONCILE_JOB" },
        });
      } finally {
        client.release();
      }
      updated += 1;
    } catch (error) {
      console.error("Reconcile failed for user", row.user_id, error.message);
    }
  }

  console.log(`Reconciled ${updated} Google Play subscription(s).`);
  await pool.end();
}

reconcilePlaySubscriptions().catch((error) => {
  console.error(error);
  process.exit(1);
});
