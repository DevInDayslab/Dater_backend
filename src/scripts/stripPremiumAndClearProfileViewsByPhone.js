/**
 * Dev/local: make a user non-premium and clear profile-view history so you can test
 * the free rolling 20 full-profile limit again.
 *
 * - Sets is_premium false and clears premium window fields.
 * - Deletes profile_view_events where this user is the viewer.
 * - Clears user_daily_profile_view_usage for this user (legacy counter, harmless).
 * - Deletes active premium_boosts rows for this user (optional clean slate).
 *
 * From backend/:
 *   npm run dev:strip-premium-clear-views -- 9354120990
 *   npm run dev:strip-premium-clear-views -- +919876543210
 *
 * Requires DATABASE_URL in .env
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { pool, query } = require("../config/db");

function toE164(raw) {
  const s = String(raw).trim().replace(/\s/g, "");
  if (s.startsWith("+")) return s;
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length > 0) return `+${digits}`;
  return s;
}

async function main() {
  const raw = process.argv[2] || process.env.TEST_USER_PHONE || "9354120990";
  const phoneE164 = toE164(raw);

  const sel = await query(
    `SELECT id, phone_e164, name, is_premium
     FROM users WHERE phone_e164 = $1 AND deleted_at IS NULL LIMIT 1`,
    [phoneE164]
  );
  if (sel.rows.length === 0) {
    console.error(`No user with phone_e164=${phoneE164}`);
    process.exit(2);
  }
  const u = sel.rows[0];

  const views = await query(`DELETE FROM profile_view_events WHERE viewer_user_id = $1 RETURNING id`, [u.id]);
  const daily = await query(`DELETE FROM user_daily_profile_view_usage WHERE user_id = $1 RETURNING user_id`, [u.id]);
  const boosts = await query(`DELETE FROM premium_boosts WHERE user_id = $1 RETURNING user_id`, [u.id]);

  const upd = await query(
    `UPDATE users
     SET is_premium = FALSE,
         premium_started_at = NULL,
         premium_expires_at = NULL,
         premium_plan_code = NULL,
         premium_status = 'INACTIVE',
         updated_at = NOW()
     WHERE id = $1
     RETURNING id, phone_e164, name, is_premium, premium_status`,
    [u.id]
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        user: upd.rows[0],
        deletedProfileViewEvents: views.rowCount,
        deletedDailyUsageRows: daily.rowCount,
        deletedPremiumBoostRows: boosts.rowCount,
      },
      null,
      2
    )
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => pool.end());
