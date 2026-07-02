require("dotenv").config();
const { pool } = require("../config/db");
const { STORE_PLATFORM } = require("../constants/storePlatforms");
const { isPlayBillingConfigured } = require("../config/googlePlay");
const googlePlayBilling = require("../services/googlePlayBilling.service");
const billingVerificationService = require("../services/billingVerification.service");

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
      await billingVerificationService.syncSubscriptionStateFromGoogle({
        userId: row.user_id,
        subscription,
        purchaseToken: row.purchase_token,
        productId: row.store_product_id,
        source: "reconcile",
      });
      await billingVerificationService.ensureSubscriptionAcknowledged({
        userId: row.user_id,
        productId: row.store_product_id,
        purchaseToken: row.purchase_token,
        storeOrderId: subscription?.latestOrderId,
      });
      updated += 1;
      console.log("Reconciled user", row.user_id, "state", subscription?.subscriptionState);
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
