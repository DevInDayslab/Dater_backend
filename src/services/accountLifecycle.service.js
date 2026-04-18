const { query } = require("../config/db");

/** Auto-resume when a timed pause has elapsed. */
async function normalizeExpiredPauseForUser(userId) {
  await query(
    `UPDATE users
     SET account_state = 'ACTIVE'::account_state_enum,
         paused_until = NULL,
         updated_at = NOW()
     WHERE id = $1::uuid
       AND account_state = 'PAUSED'::account_state_enum
       AND paused_until IS NOT NULL
       AND paused_until <= NOW()`,
    [userId]
  );
}

function pauseDurationToUntilIso(durationKey) {
  const k = String(durationKey || "").trim().toLowerCase();
  if (k === "until_resume" || k === "" || k === "manual") {
    return { pausedUntilIso: null };
  }
  const now = Date.now();
  let ms = 0;
  if (k === "24h" || k === "24_hours") ms = 24 * 60 * 60 * 1000;
  else if (k === "72h" || k === "72_hours") ms = 72 * 60 * 60 * 1000;
  else if (k === "1w" || k === "1_week" || k === "7d") ms = 7 * 24 * 60 * 60 * 1000;
  else return { error: "INVALID_PAUSE_DURATION" };
  return { pausedUntilIso: new Date(now + ms).toISOString() };
}

module.exports = {
  normalizeExpiredPauseForUser,
  pauseDurationToUntilIso,
};
