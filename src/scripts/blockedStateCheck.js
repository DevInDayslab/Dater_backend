require("dotenv").config();

const { pool } = require("../config/db");

async function run() {
  try {
    const calc = await pool.query(
      "SELECT (TIMESTAMP '2025-04-04' + ((18-17)::text || ' years')::interval)::date AS age17_turn18, (TIMESTAMP '2025-04-04' + ((18-16)::text || ' years')::interval)::date AS age16_turn18"
    );
    const asIstDate = (value) =>
      new Date(value).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const age17 = asIstDate(calc.rows[0].age17_turn18);
    const age16 = asIstDate(calc.rows[0].age16_turn18);
    if (age17 !== "2026-04-04" || age16 !== "2027-04-04") {
      throw new Error("Underage year math mismatch");
    }

    const phone = "+919000000001";
    await pool.query("DELETE FROM users WHERE phone_e164 = $1", [phone]);
    const created = await pool.query(
      "INSERT INTO users (phone_country_code, phone_number, phone_e164, is_phone_verified, account_state, underage_until, onboarding_step, onboarding_updated_at, onboarding_completed_at) VALUES ('+91','9000000001',$1,TRUE,'UNDERAGE_BLOCKED', NOW() - INTERVAL '1 day','onboarding_lifestyle', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days') RETURNING id",
      [phone]
    );
    const userId = created.rows[0].id;

    await pool.query(
      "UPDATE users SET account_state='ACTIVE'::account_state_enum, underage_until=NULL, onboarding_step='onboarding_name', onboarding_completed_at=NULL, onboarding_updated_at=NOW(), updated_at=NOW() WHERE id=$1 AND account_state='UNDERAGE_BLOCKED'::account_state_enum AND underage_until IS NOT NULL AND underage_until <= NOW()",
      [userId]
    );

    const chk = await pool.query(
      "SELECT account_state, onboarding_step, onboarding_completed_at FROM users WHERE id=$1",
      [userId]
    );
    const row = chk.rows[0];
    if (
      row.account_state !== "ACTIVE" ||
      row.onboarding_step !== "onboarding_name" ||
      row.onboarding_completed_at !== null
    ) {
      throw new Error("Eligibility unlock/reset failed");
    }

    await pool.query("DELETE FROM users WHERE id=$1", [userId]);

    console.log("blocked-state checks passed", {
      age17_turn18: age17,
      age16_turn18: age16,
    });
  } finally {
    await pool.end();
  }
}

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
