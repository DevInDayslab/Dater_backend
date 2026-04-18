/**
 * Dev/local: set premium active for exactly 30 days from now (does not stack on old expiry).
 *
 * From backend/:
 *   node src/scripts/grantPremiumDev.js 9354120990
 *   node src/scripts/grantPremiumDev.js +919876543210
 *
 * Requires DATABASE_URL in .env
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { query } = require("../config/db");

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
  const raw = process.argv[2] || process.env.GRANT_PREMIUM_PHONE || "9354120990";
  const phoneE164 = toE164(raw);

  const sel = await query(
    `SELECT id, phone_e164, name, is_premium, premium_expires_at
     FROM users WHERE phone_e164 = $1 AND deleted_at IS NULL LIMIT 1`,
    [phoneE164]
  );
  if (sel.rows.length === 0) {
    console.error(`No user with phone_e164=${phoneE164}`);
    process.exit(2);
  }
  const u = sel.rows[0];

  const upd = await query(
    `UPDATE users
     SET premium_started_at = NOW(),
         premium_expires_at = NOW() + INTERVAL '30 days',
         premium_plan_code = 'PREMIUM_MONTH',
         is_premium = TRUE,
         premium_status = 'ACTIVE',
         updated_at = NOW()
     WHERE id = $1
     RETURNING id, phone_e164, name, is_premium, premium_started_at, premium_expires_at, premium_plan_code`,
    [u.id]
  );

  const row = upd.rows[0];
  console.log("Premium granted (30 days from now):");
  console.log(JSON.stringify(row, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
