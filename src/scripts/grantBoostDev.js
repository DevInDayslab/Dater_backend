/**
 * Dev helpers for profile boost:
 *
 * Active window (feed ranking uses premium_boosts):
 *   npm run dev:grant-boost -- 9354120990
 *   npm run dev:grant-boost -- 9354120990 45   # duration in minutes (default 30)
 *
 * Remove active boosts + add wallet credits (in-app “available” boost to activate):
 *   npm run dev:grant-boost -- 9354120990 available
 *   npm run dev:grant-boost -- 9354120990 available 3   # add 3 credits
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

async function grantAvailableBoost(phoneE164, creditsToAdd) {
  const sel = await query(
    `SELECT id, phone_e164, name FROM users WHERE phone_e164 = $1 AND deleted_at IS NULL LIMIT 1`,
    [phoneE164]
  );
  if (sel.rows.length === 0) {
    console.error(`No user with phone_e164=${phoneE164}`);
    process.exit(2);
  }
  const u = sel.rows[0];

  const delPb = await query(`DELETE FROM premium_boosts WHERE user_id = $1`, [u.id]);
  const delAct = await query(
    `DELETE FROM user_boost_activations WHERE user_id = $1 AND expires_at > NOW()`,
    [u.id]
  );

  const wallet = await query(
    `INSERT INTO user_boost_wallet (user_id, remaining_credits, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id)
     DO UPDATE SET
       remaining_credits = user_boost_wallet.remaining_credits + EXCLUDED.remaining_credits,
       updated_at = NOW()
     RETURNING remaining_credits`,
    [u.id, creditsToAdd]
  );

  console.log(
    JSON.stringify(
      {
        success: true,
        mode: "available",
        phone: phoneE164,
        name: u.name,
        creditsAdded: creditsToAdd,
        remainingBoostCredits: wallet.rows[0]?.remaining_credits,
        cleared: {
          premium_boosts_rows: delPb.rowCount ?? 0,
          active_user_boost_activations: delAct.rowCount ?? 0,
        },
      },
      null,
      2
    )
  );
}

async function grantActiveBoostWindow(phoneE164, minutes) {
  const sel = await query(
    `SELECT id, phone_e164, name FROM users WHERE phone_e164 = $1 AND deleted_at IS NULL LIMIT 1`,
    [phoneE164]
  );
  if (sel.rows.length === 0) {
    console.error(`No user with phone_e164=${phoneE164}`);
    process.exit(2);
  }
  const u = sel.rows[0];

  await query(`DELETE FROM premium_boosts WHERE user_id = $1`, [u.id]);

  const ins = await query(
    `INSERT INTO premium_boosts (user_id, started_at, expires_at)
     VALUES ($1, NOW() - INTERVAL '30 seconds', NOW() + ($2::int * INTERVAL '1 minute'))
     RETURNING id, user_id, started_at, expires_at`,
    [u.id, minutes]
  );

  const row = ins.rows[0];
  console.log(
    JSON.stringify(
      {
        success: true,
        mode: "active",
        phone: phoneE164,
        name: u.name,
        durationMinutes: minutes,
        boost: row,
      },
      null,
      2
    )
  );
}

async function main() {
  const raw = process.argv[2] || "9354120990";
  const arg3 = String(process.argv[3] ?? "").trim().toLowerCase();

  if (arg3 === "available") {
    const creditsRaw = process.argv[4];
    const credits = Math.min(100, Math.max(1, Number.parseInt(String(creditsRaw || "1"), 10) || 1));
    await grantAvailableBoost(toE164(raw), credits);
    return;
  }

  const minutesRaw = process.argv[3];
  const minutes = Math.min(24 * 60, Math.max(5, Number.parseInt(String(minutesRaw || "30"), 10) || 30));
  await grantActiveBoostWindow(toE164(raw), minutes);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
