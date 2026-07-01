require("dotenv").config();
const { pool } = require("../config/db");
const { STORE_PLATFORM } = require("../constants/storePlatforms");
const { isPlayBillingConfigured } = require("../config/googlePlay");
const googlePlayBilling = require("../services/googlePlayBilling.service");

const PLATFORM = STORE_PLATFORM.GOOGLE_PLAY;

async function retryBillingFulfillment() {
  if (!isPlayBillingConfigured()) {
    console.log("Google Play billing is not configured; skipping retry.");
    process.exit(0);
  }

  const unacked = await pool.query(
    `SELECT store_order_id, store_product_id, purchase_token
     FROM store_purchase_verifications
     WHERE platform = $1
       AND purchase_type = 'SUBSCRIPTION'
       AND acknowledged_at IS NULL
       AND created_at < NOW() - INTERVAL '5 minutes'
     ORDER BY created_at ASC
     LIMIT 100`,
    [PLATFORM]
  );

  for (const row of unacked.rows) {
    try {
      await googlePlayBilling.acknowledgeSubscription({
        productId: row.store_product_id,
        purchaseToken: row.purchase_token,
      });
      await pool.query(
        `UPDATE store_purchase_verifications
         SET acknowledged_at = NOW(), updated_at = NOW()
         WHERE platform = $1 AND store_order_id = $2`,
        [PLATFORM, row.store_order_id]
      );
      console.log("Acknowledged subscription", row.store_order_id);
    } catch (error) {
      console.error("Ack retry failed", row.store_order_id, error.message);
    }
  }

  const unconsumed = await pool.query(
    `SELECT store_order_id, store_product_id, purchase_token
     FROM store_purchase_verifications
     WHERE platform = $1
       AND purchase_type = 'INAPP'
       AND consumed_at IS NULL
       AND created_at < NOW() - INTERVAL '5 minutes'
     ORDER BY created_at ASC
     LIMIT 100`,
    [PLATFORM]
  );

  for (const row of unconsumed.rows) {
    try {
      await googlePlayBilling.consumeInApp({
        productId: row.store_product_id,
        purchaseToken: row.purchase_token,
      });
      await pool.query(
        `UPDATE store_purchase_verifications
         SET consumed_at = NOW(), updated_at = NOW()
         WHERE platform = $1 AND store_order_id = $2`,
        [PLATFORM, row.store_order_id]
      );
      console.log("Consumed in-app purchase", row.store_order_id);
    } catch (error) {
      console.error("Consume retry failed", row.store_order_id, error.message);
    }
  }

  await pool.end();
}

retryBillingFulfillment().catch((error) => {
  console.error(error);
  process.exit(1);
});
