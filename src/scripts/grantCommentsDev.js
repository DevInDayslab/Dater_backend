/**
 * Dev helper: grant paid comment credits.
 *
 * Usage:
 *   npm run dev:grant-comments -- 9354120990 4
 *   npm run dev:grant-comments -- +919354120990 4
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { query } = require("../config/db");

function toE164(raw) {
  const s = String(raw || "").trim().replace(/\s/g, "");
  if (s.startsWith("+")) return s;
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length > 0) return `+${digits}`;
  return s;
}

async function main() {
  const rawPhone = process.argv[2] || "9354120990";
  const creditsRaw = process.argv[3];
  const credits = Math.min(100, Math.max(1, Number.parseInt(String(creditsRaw || "1"), 10) || 1));

  const phoneE164 = toE164(rawPhone);
  const sel = await query(
    `SELECT id, phone_e164, name
     FROM users
     WHERE phone_e164 = $1 AND deleted_at IS NULL
     LIMIT 1`,
    [phoneE164]
  );
  if (sel.rows.length === 0) {
    console.error(`No user with phone_e164=${phoneE164}`);
    process.exit(2);
  }
  const u = sel.rows[0];

  const up = await query(
    `INSERT INTO user_comment_wallet (user_id, remaining_paid_comments, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id)
     DO UPDATE SET
       remaining_paid_comments = user_comment_wallet.remaining_paid_comments + EXCLUDED.remaining_paid_comments,
       updated_at = NOW()
     RETURNING remaining_paid_comments`,
    [u.id, credits]
  );

  console.log(
    JSON.stringify(
      {
        success: true,
        phone: phoneE164,
        name: u.name,
        creditsAdded: credits,
        remainingPaidComments: Number(up.rows[0]?.remaining_paid_comments || 0),
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

