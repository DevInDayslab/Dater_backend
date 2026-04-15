/**
 * Dev/local: permanently delete one user row by phone. Child rows CASCADE (sessions,
 * photos metadata, interests, filters, social rows where applicable, etc.).
 *
 * S3 objects for old photos are not deleted here; only DB metadata is removed.
 *
 * From backend/: npm run dev:reset-user -- +9198XXXXXXXX
 * Or 10-digit India number: npm run dev:reset-user -- 98XXXXXXXX
 *
 * Requires DATABASE_URL in .env (same as the API).
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
  const raw = process.argv[2];
  if (!raw) {
    console.error("Usage: node src/scripts/resetUserByPhone.js <+E164 or 10-digit IN number>");
    process.exit(1);
  }
  const phoneE164 = toE164(raw);

  const sel = await query(
    `SELECT id, phone_e164, onboarding_step, onboarding_completed_at, name
     FROM users WHERE phone_e164 = $1 LIMIT 1`,
    [phoneE164]
  );
  if (sel.rows.length === 0) {
    console.error(`No user with phone_e164=${phoneE164}`);
    process.exit(2);
  }
  const u = sel.rows[0];
  console.log("Deleting user (CASCADE removes linked rows):", u);

  const del = await query(`DELETE FROM users WHERE id = $1 RETURNING id, phone_e164`, [u.id]);
  console.log("Deleted:", del.rows[0]);
  console.log(
    "Sign in again with the same number: auth will INSERT a new user (fresh onboarding)."
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => pool.end());
