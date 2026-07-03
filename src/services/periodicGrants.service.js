const { hasPremiumAccess } = require("./subscriptionState.service");
const { STORE_PLATFORM } = require("../constants/storePlatforms");

const IST = "Asia/Kolkata";
const PREMIUM_DAILY_COMMENT_CAP = 10;
const FREE_DAILY_COMMENT_CAP = 5;
const WEEK_SECONDS = 604800;

function parseAnchorTimestamp(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Resolve subscription week anchor: Play startTime in store_subscriptions metadata,
 * then users.premium_started_at.
 */
async function resolveBoostGrantAnchor(client, userId, premiumRow) {
  const storeRes = await client.query(
    `SELECT metadata->>'subscriptionStartTime' AS subscription_start_time
     FROM store_subscriptions
     WHERE user_id = $1 AND platform = $2
     LIMIT 1`,
    [userId, STORE_PLATFORM.GOOGLE_PLAY]
  );
  const fromStore = parseAnchorTimestamp(storeRes.rows[0]?.subscription_start_time);
  if (fromStore) return fromStore;

  return parseAnchorTimestamp(premiumRow?.premium_started_at);
}

async function resetBoostGrantTracking(client, userId) {
  await client.query(
    `UPDATE user_boost_wallet
     SET last_boost_grant_at = NULL,
         updated_at = NOW()
     WHERE user_id = $1`,
    [userId]
  );
}

async function syncDailyCommentGrant(client, userId, isPremium) {
  const cap = isPremium ? PREMIUM_DAILY_COMMENT_CAP : FREE_DAILY_COMMENT_CAP;
  await client.query(
    `INSERT INTO user_comment_wallet (user_id, remaining_paid_comments, last_comment_grant_at, updated_at)
     VALUES ($1, $2, NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE
     SET remaining_paid_comments = GREATEST(user_comment_wallet.remaining_paid_comments, EXCLUDED.remaining_paid_comments),
         last_comment_grant_at = NOW(),
         updated_at = NOW()
     WHERE user_comment_wallet.last_comment_grant_at IS NULL
        OR (user_comment_wallet.last_comment_grant_at AT TIME ZONE $3)::date
           < (NOW() AT TIME ZONE $3)::date`,
    [userId, cap, IST]
  );
}

async function syncWeeklyBoostGrant(client, userId, subscriptionAnchorAt) {
  await client.query(
    `INSERT INTO user_boost_wallet (user_id, remaining_credits, last_boost_grant_at, updated_at)
     VALUES ($1, 1, NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE
     SET remaining_credits = user_boost_wallet.remaining_credits + GREATEST(0,
           FLOOR(EXTRACT(EPOCH FROM (NOW() - $2::timestamptz)) / ${WEEK_SECONDS})
           - COALESCE(
               FLOOR(EXTRACT(EPOCH FROM (user_boost_wallet.last_boost_grant_at - $2::timestamptz)) / ${WEEK_SECONDS}),
               -1
             )
         ),
         last_boost_grant_at = NOW(),
         updated_at = NOW()
     WHERE user_boost_wallet.user_id = $1
       AND (
         user_boost_wallet.last_boost_grant_at IS NULL
         OR FLOOR(EXTRACT(EPOCH FROM (NOW() - $2::timestamptz)) / ${WEEK_SECONDS})
            > FLOOR(EXTRACT(EPOCH FROM (user_boost_wallet.last_boost_grant_at - $2::timestamptz)) / ${WEEK_SECONDS})
       )`,
    [userId, subscriptionAnchorAt]
  );
}

/**
 * Lazily evaluates and applies pending time-based grants for a user.
 * Call when fetching entitlements or before debiting wallet credits.
 *
 * @param {import("pg").PoolClient} client
 * @param {string} userId
 * @param {object|null} premiumRow - row from syncPremiumState / users premium columns
 */
async function syncPeriodicGrants(client, userId, premiumRow) {
  const isPremium = hasPremiumAccess(premiumRow);
  await syncDailyCommentGrant(client, userId, isPremium);

  if (!isPremium) return;

  const anchor = await resolveBoostGrantAnchor(client, userId, premiumRow);
  if (!anchor) return;

  await syncWeeklyBoostGrant(client, userId, anchor);
}

module.exports = {
  IST,
  PREMIUM_DAILY_COMMENT_CAP,
  FREE_DAILY_COMMENT_CAP,
  WEEK_SECONDS,
  resolveBoostGrantAnchor,
  resetBoostGrantTracking,
  syncDailyCommentGrant,
  syncWeeklyBoostGrant,
  syncPeriodicGrants,
};
