/**
 * Dev/local: add boost credits to a user's wallet (does not activate a boost session).
 *
 * From backend/:
 *   node src/scripts/grantBoostDev.js 9354120990
 *   node src/scripts/grantBoostDev.js +919876543210 5
 *
 * Args: [phone] [amount default 1]
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
  const raw = process.argv[2] || process.env.GRANT_BOOST_PHONE || "";
  const amount = Math.max(1, parseInt(process.argv[3] || process.env.GRANT_BOOST_AMOUNT || "1", 10) || 1);
  if (!raw) {
    console.error("Usage: node src/scripts/grantBoostDev.js <phone> [amount]");
    process.exit(2);
  }
  const phoneE164 = toE164(raw);

  const sel = await query(
    `SELECT id, phone_e164, name FROM users WHERE phone_e164 = $1 AND deleted_at IS NULL LIMIT 1`,
    [phoneE164]
  );
  if (sel.rows.length === 0) {
    console.error(`No user with phone_e164=${phoneE164}`);
    process.exit(2);
  }
  const u = sel.rows[0];

  const upd = await query(
    `INSERT INTO user_boost_wallet (user_id, remaining_credits, updated_at)
     VALUES ($1::uuid, $2, NOW())
     ON CONFLICT (user_id)
     DO UPDATE SET
       remaining_credits = user_boost_wallet.remaining_credits + EXCLUDED.remaining_credits,
       updated_at = NOW()
     RETURNING user_id, remaining_credits`,
    [u.id, amount]
  );

  const row = upd.rows[0];
  console.log(`Added ${amount} boost credit(s) for ${phoneE164} (${u.name || "no name"}):`);
  console.log(JSON.stringify({ userId: row.user_id, remainingCredits: row.remaining_credits }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
