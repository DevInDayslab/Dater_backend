/**
 * Automated checks for lazy periodic grants (daily comments + weekly boosts).
 * Run: npm run verify:periodic-grants
 *
 * Mock-client tests run without DB. Set VERIFY_PERIODIC_GRANTS_USER_ID for live DB checks
 * (transaction rolled back).
 */
require("dotenv").config();

const { pool } = require("../config/db");
const { hasPremiumAccess } = require("../services/subscriptionState.service");
const {
  syncPeriodicGrants,
  syncDailyCommentGrant,
  syncWeeklyBoostGrant,
  PREMIUM_DAILY_COMMENT_CAP,
  FREE_DAILY_COMMENT_CAP,
  WEEK_SECONDS,
} = require("../services/periodicGrants.service");

function assert(name, condition) {
  if (!condition) {
    console.error(`FAIL: ${name}`);
    process.exit(1);
  }
  console.log(`PASS: ${name}`);
}

function futureIso(ms = 86_400_000) {
  return new Date(Date.now() + ms).toISOString();
}

function pastIso(ms = 86_400_000) {
  return new Date(Date.now() - ms).toISOString();
}

async function testDailyCommentGrantSql() {
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql: String(sql), params });
      return { rowCount: 1, rows: [] };
    },
  };

  await syncDailyCommentGrant(client, "user-1", true);
  const q = queries[0];
  assert("daily grant uses GREATEST top-up", q.sql.includes("GREATEST"));
  assert("daily grant uses IST timezone gate", q.sql.includes("AT TIME ZONE $3") && q.params.includes("Asia/Kolkata"));
  assert("premium cap is 10", paramsInclude(q.params, PREMIUM_DAILY_COMMENT_CAP));

  await syncDailyCommentGrant(client, "user-2", false);
  assert("free cap is 5", paramsInclude(queries[1].params, FREE_DAILY_COMMENT_CAP));
}

function paramsInclude(params, value) {
  return Array.isArray(params) && params.includes(value);
}

async function testWeeklyBoostGrantSql() {
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql: String(sql), params });
      return { rowCount: 1, rows: [] };
    },
  };

  const anchor = pastIso(21 * 86_400_000);
  await syncWeeklyBoostGrant(client, "user-1", anchor);
  const q = queries[0];
  assert("weekly boost uses subscription anchor param", q.params[1] === anchor);
  assert("weekly boost uses week-index FLOOR math", q.sql.includes("FLOOR(EXTRACT(EPOCH"));
  assert("weekly boost treats NULL granted week as -1", q.sql.includes("-1"));
  assert("weekly boost uses 604800 second week", q.sql.includes(String(WEEK_SECONDS)));
}

async function testSyncPeriodicGrantsSkipsBoostWhenNotPremium() {
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes("store_subscriptions")) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    },
  };

  const freeRow = {
    is_premium: false,
    premium_status: "INACTIVE",
    premium_expires_at: null,
    premium_started_at: null,
  };
  await syncPeriodicGrants(client, "user-free", freeRow);
  assert(
    "free user only runs comment grant (no boost wallet upsert)",
    queries.length === 1 && queries[0].sql.includes("user_comment_wallet")
  );
}

async function testSyncPeriodicGrantsRunsBoostForPremium() {
  const queries = [];
  const anchor = pastIso(3 * 86_400_000);
  const client = {
    query: async (sql) => {
      queries.push({ sql: String(sql) });
      if (String(sql).includes("store_subscriptions")) {
        return {
          rowCount: 1,
          rows: [{ subscription_start_time: anchor }],
        };
      }
      return { rowCount: 1, rows: [] };
    },
  };

  const premiumRow = {
    is_premium: true,
    premium_status: "ACTIVE",
    premium_expires_at: futureIso(),
    premium_started_at: anchor,
  };
  await syncPeriodicGrants(client, "user-premium", premiumRow);
  assert("premium user runs comment grant", queries.some((q) => q.sql.includes("user_comment_wallet")));
  assert("premium user runs boost grant", queries.some((q) => q.sql.includes("user_boost_wallet")));
}

function testHasPremiumAccessForGrants() {
  assert(
    "cancelled-but-valid grants premium access",
    hasPremiumAccess({
      is_premium: true,
      premium_status: "CANCELLED",
      premium_expires_at: futureIso(),
    })
  );
  assert(
    "expired does not grant premium access",
    !hasPremiumAccess({
      is_premium: true,
      premium_status: "EXPIRED",
      premium_expires_at: pastIso(),
    })
  );
}

async function testDbIntegrationIfConfigured() {
  const userId = process.env.VERIFY_PERIODIC_GRANTS_USER_ID;
  if (!userId) {
    console.log("SKIP: DB integration (set VERIFY_PERIODIC_GRANTS_USER_ID to enable)");
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const anchor = pastIso(21 * 86_400_000);
    await client.query(
      `UPDATE users
       SET is_premium = TRUE,
           premium_status = 'ACTIVE',
           premium_expires_at = $2::timestamptz,
           premium_started_at = $3::timestamptz,
           updated_at = NOW()
       WHERE id = $1`,
      [userId, futureIso(30 * 86_400_000), anchor]
    );

    await client.query(
      `INSERT INTO user_boost_wallet (user_id, remaining_credits, last_boost_grant_at, updated_at)
       VALUES ($1, 1, $2::timestamptz, NOW())
       ON CONFLICT (user_id) DO UPDATE
       SET remaining_credits = 1,
           last_boost_grant_at = $2::timestamptz,
           updated_at = NOW()`,
      [userId, anchor]
    );

    const premiumRes = await client.query(
      `SELECT is_premium, premium_started_at, premium_expires_at, premium_plan_code, premium_status
       FROM users WHERE id = $1`,
      [userId]
    );
    await syncPeriodicGrants(client, userId, premiumRes.rows[0]);

    const walletRes = await client.query(
      `SELECT remaining_credits FROM user_boost_wallet WHERE user_id = $1`,
      [userId]
    );
    const credits = Number(walletRes.rows[0]?.remaining_credits || 0);
    assert("DB: 3-week idle premium accumulates boosts (expect >= 4)", credits >= 4);

    await client.query("ROLLBACK");
    console.log("PASS: DB integration (rolled back)");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  await testDailyCommentGrantSql();
  await testWeeklyBoostGrantSql();
  await testSyncPeriodicGrantsSkipsBoostWhenNotPremium();
  await testSyncPeriodicGrantsRunsBoostForPremium();
  testHasPremiumAccessForGrants();
  await testDbIntegrationIfConfigured();
  console.log("\nOK: periodic grants verification");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
