/**
 * Automated checks for premium expiry revert (subscription-exclusive settings).
 * Run on EC2 after deploy: npm run verify:premium-expiry-revert
 *
 * Uses mock-client assertions (no DB required). Optional DB integration when
 * VERIFY_PREMIUM_EXPIRY_USER_ID is set — runs inside a transaction and rolls back.
 */
require("dotenv").config();

const { pool } = require("../config/db");
const {
  ADVANCED_FILTER_JUNCTION_TABLES,
  revertPremiumExclusiveSettings,
} = require("../services/premiumExclusiveSettings.service");
const { hasPremiumAccess } = require("../services/subscriptionState.service");

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

async function testRevertWithMockClient() {
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes("RETURNING id")) {
        return { rowCount: 1, rows: [{ id: params[0] }] };
      }
      return { rowCount: 1, rows: [] };
    },
  };

  await revertPremiumExclusiveSettings(client, "00000000-0000-4000-8000-000000000001");

  assert(
    "revert clears preferred_location_city",
    queries.some((q) => q.sql.includes("preferred_location_city = NULL"))
  );
  assert(
    "revert clears privacy mode when set",
    queries.some((q) => q.sql.includes("account_state = 'ACTIVE'") && q.sql.includes("PRIVACY_MODE"))
  );
  assert(
    "revert clears all advanced filter junction tables",
    ADVANCED_FILTER_JUNCTION_TABLES.every((table) =>
      queries.some((q) => q.sql.includes(`DELETE FROM ${table}`))
    )
  );
  assert(
    "revert clears height scalars",
    queries.some((q) => q.sql.includes("min_height_inches = NULL"))
  );
}

function testHasPremiumAccessUnifiesExpiredFlag() {
  const expiredRow = {
    is_premium: true,
    premium_status: "EXPIRED",
    premium_expires_at: pastIso(),
    premium_started_at: pastIso(30 * 86_400_000),
  };
  assert(
    "hasPremiumAccess denies expired status even when is_premium=true",
    !hasPremiumAccess(expiredRow)
  );

  const activeRow = {
    is_premium: true,
    premium_status: "ACTIVE",
    premium_expires_at: futureIso(),
    premium_started_at: pastIso(),
  };
  assert("hasPremiumAccess grants active in-window subscription", hasPremiumAccess(activeRow));

  const cancelledFutureRow = {
    is_premium: true,
    premium_status: "CANCELLED",
    premium_expires_at: futureIso(),
    premium_started_at: pastIso(),
  };
  assert(
    "hasPremiumAccess grants cancelled sub until period end",
    hasPremiumAccess(cancelledFutureRow)
  );
}

async function testRevertWithDatabase() {
  const userId = String(process.env.VERIFY_PREMIUM_EXPIRY_USER_ID || "").trim();
  if (!userId) {
    console.log("SKIP: DB integration (set VERIFY_PREMIUM_EXPIRY_USER_ID to run)");
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO user_filters (user_id, age_min, age_max, preferred_location_city, min_height_inches, max_height_inches)
       VALUES ($1, 20, 36, 'TestCity', 60, 72)
       ON CONFLICT (user_id) DO UPDATE
       SET preferred_location_city = EXCLUDED.preferred_location_city,
           min_height_inches = EXCLUDED.min_height_inches,
           max_height_inches = EXCLUDED.max_height_inches,
           updated_at = NOW()`,
      [userId]
    );
    await client.query(
      `UPDATE users SET account_state = 'PRIVACY_MODE', updated_at = NOW() WHERE id = $1`,
      [userId]
    );
    await client.query(
      `INSERT INTO user_filter_drinking_preferences (user_id, drinking_option)
       VALUES ($1, 'Socially')
       ON CONFLICT DO NOTHING`,
      [userId]
    );

    await revertPremiumExclusiveSettings(client, userId);

    const filtersRes = await client.query(
      `SELECT preferred_location_city, min_height_inches, max_height_inches
       FROM user_filters WHERE user_id = $1`,
      [userId]
    );
    const userRes = await client.query(
      `SELECT account_state FROM users WHERE id = $1`,
      [userId]
    );
    const junctionRes = await client.query(
      `SELECT COUNT(*)::int AS n FROM user_filter_drinking_preferences WHERE user_id = $1`,
      [userId]
    );

    assert("DB: preferred_location_city cleared", !filtersRes.rows[0]?.preferred_location_city);
    assert("DB: min_height_inches cleared", filtersRes.rows[0]?.min_height_inches == null);
    assert("DB: advanced junction rows cleared", Number(junctionRes.rows[0]?.n || 0) === 0);
    assert(
      "DB: privacy mode reverted to ACTIVE",
      String(userRes.rows[0]?.account_state || "") === "ACTIVE"
    );

    await client.query("ROLLBACK");
    console.log("PASS: DB integration rolled back (no persistent changes)");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  console.log("=== Premium expiry revert checks ===\n");
  await testRevertWithMockClient();
  testHasPremiumAccessUnifiesExpiredFlag();
  await testRevertWithDatabase();
  console.log("\nOK: All premium expiry revert checks passed.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => pool.end());
