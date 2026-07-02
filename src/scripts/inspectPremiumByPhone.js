/**
 * Inspect premium + Play subscription state for a user by phone (QA helper).
 * Usage: node src/scripts/inspectPremiumByPhone.js 9876543210
 */
require("dotenv").config();
const { pool } = require("../config/db");
const { STORE_PLATFORM } = require("../constants/storePlatforms");

async function main() {
  const phone = String(process.argv[2] || "").replace(/\D/g, "");
  if (phone.length < 10) {
    console.error("Usage: node src/scripts/inspectPremiumByPhone.js <phone_digits>");
    process.exit(1);
  }

  const userRes = await pool.query(
    `SELECT id, phone_e164, is_premium, premium_status, premium_plan_code,
            premium_expires_at, premium_started_at, updated_at
     FROM users
     WHERE regexp_replace(phone_e164, '\\D', '', 'g') LIKE $1
     ORDER BY updated_at DESC
     LIMIT 1`,
    [`%${phone.slice(-10)}`]
  );
  const user = userRes.rows[0];
  if (!user) {
    console.error("No user found for phone ending", phone.slice(-10));
    process.exit(1);
  }

  console.log("\n--- User premium ---");
  console.log(JSON.stringify(user, null, 2));

  const subRes = await pool.query(
    `SELECT store_product_id, purchase_token, latest_order_id, expiry_time,
            auto_renewing, store_state, metadata, updated_at
     FROM store_subscriptions
     WHERE user_id = $1 AND platform = $2`,
    [user.id, STORE_PLATFORM.GOOGLE_PLAY]
  );
  console.log("\n--- store_subscriptions ---");
  console.log(JSON.stringify(subRes.rows[0] || null, null, 2));

  const verifyRes = await pool.query(
    `SELECT store_order_id, pack_code, store_state, purchase_type, acknowledged_at, created_at
     FROM store_purchase_verifications
     WHERE user_id = $1 AND platform = $2
     ORDER BY created_at DESC
     LIMIT 5`,
    [user.id, STORE_PLATFORM.GOOGLE_PLAY]
  );
  console.log("\n--- recent verifications ---");
  console.log(JSON.stringify(verifyRes.rows, null, 2));

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
