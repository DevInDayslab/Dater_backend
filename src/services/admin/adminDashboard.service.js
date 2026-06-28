const { query } = require("../../config/db");
const { resolveWindow } = require("../../utils/adminWindow");

async function countUsers(sqlExtra = "") {
  const res = await query(
    `SELECT COUNT(*)::int AS c
     FROM users
     WHERE deleted_at IS NULL
     ${sqlExtra}`
  );
  return Number(res.rows[0]?.c || 0);
}

async function countPurchasesInWindow(itemFilterSql, windowRaw) {
  const win = resolveWindow(windowRaw);
  const params = [];
  let timeClause = "";
  if (!win.allTime) {
    timeClause = ` AND created_at >= NOW() - ${win.intervalSql}`;
  }
  const res = await query(
    `SELECT COUNT(*)::int AS c
     FROM user_purchases
     WHERE ${itemFilterSql}
     ${timeClause}`,
    params
  );
  return Number(res.rows[0]?.c || 0);
}

async function getDashboardStats(windowRaw = "7d") {
  const win = resolveWindow(windowRaw);

  const [
    totalUsers,
    dau,
    mau,
    activePremiumUsers,
    boostsSold,
    commentsSold,
    chatUnlocksSold,
    totalReports,
    bannedUsers,
    pendingPhotoReview,
  ] = await Promise.all([
    countUsers(),
    countUsers(`AND last_active_at >= NOW() - INTERVAL '1 day'`),
    countUsers(`AND last_active_at >= NOW() - INTERVAL '30 days'`),
    query(
      `SELECT COUNT(*)::int AS c
       FROM users
       WHERE deleted_at IS NULL
         AND (
           premium_status = 'ACTIVE'
           OR (premium_expires_at IS NOT NULL AND premium_expires_at > NOW())
         )`
    ).then((r) => Number(r.rows[0]?.c || 0)),
    countPurchasesInWindow(`item_type = 'BOOST'`, windowRaw),
    countPurchasesInWindow(`pack_code LIKE 'COMMENTS_%'`, windowRaw),
    countPurchasesInWindow(`item_type = 'UNLOCK_CHAT'`, windowRaw),
    query(`SELECT COUNT(*)::int AS c FROM reports`).then((r) => Number(r.rows[0]?.c || 0)),
    countUsers(`AND account_state = 'BANNED'`),
    query(
      `SELECT COUNT(*)::int AS c
       FROM user_photos
       WHERE moderation_status = 'PENDING_MODERATION'`
    ).then((r) => Number(r.rows[0]?.c || 0)),
  ]);

  return {
    totalUsers,
    dau,
    mau,
    activePremiumUsers,
    boostsSold,
    commentsSold,
    chatUnlocksSold,
    totalReports,
    bannedUsers,
    pendingPhotoReview,
    window: win.key,
  };
}

async function getUserGrowth(windowRaw = "30d") {
  const win = resolveWindow(windowRaw);
  const days = win.days || 30;

  const res = await query(
    `SELECT DATE(created_at) AS day, COUNT(*)::int AS new_users
     FROM users
     WHERE created_at >= NOW() - ${win.intervalSql || "INTERVAL '30 days'"}
     GROUP BY DATE(created_at)
     ORDER BY day ASC`
  );

  const byDay = new Map(res.rows.map((r) => [String(r.day), Number(r.new_users || 0)]));
  const points = [];
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    points.push({
      date: key,
      newUsers: byDay.get(key) || 0,
    });
  }

  return {
    window: win.key,
    data: points,
  };
}

async function getDashboardBadges() {
  const [totalReports, bannedUsers] = await Promise.all([
    query(`SELECT COUNT(*)::int AS c FROM reports`).then((r) => Number(r.rows[0]?.c || 0)),
    countUsers(`AND account_state = 'BANNED'`),
  ]);

  return {
    totalReports,
    bannedUsers,
  };
}

async function getGenderBreakdown() {
  const res = await query(
    `SELECT COALESCE(NULLIF(TRIM(gender_main), ''), 'Unknown') AS gender_main,
            COUNT(*)::int AS c
     FROM users
     WHERE deleted_at IS NULL
     GROUP BY 1
     ORDER BY c DESC`
  );
  const total = res.rows.reduce((sum, row) => sum + Number(row.c || 0), 0);
  return res.rows.map((row) => {
    const count = Number(row.c || 0);
    return {
      genderMain: row.gender_main,
      count,
      percentage: total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
    };
  });
}

async function getAccountStateBreakdown() {
  const res = await query(
    `SELECT account_state, COUNT(*)::int AS c
     FROM users
     WHERE deleted_at IS NULL
     GROUP BY account_state
     ORDER BY c DESC`
  );
  return res.rows.map((row) => ({
    accountState: row.account_state,
    count: Number(row.c || 0),
  }));
}

async function getOnboardingFunnel() {
  const res = await query(
    `SELECT onboarding_step, COUNT(*)::int AS c
     FROM users
     WHERE deleted_at IS NULL
     GROUP BY onboarding_step
     ORDER BY c DESC`
  );
  return res.rows.map((row) => ({
    onboardingStep: row.onboarding_step,
    count: Number(row.c || 0),
  }));
}

async function getVerificationStats() {
  const [userRes, sessionRes] = await Promise.all([
    query(
      `SELECT
         COUNT(*) FILTER (WHERE is_verified = TRUE)::int AS verified_count,
         COUNT(*) FILTER (WHERE is_verified = FALSE)::int AS unverified_count
       FROM users
       WHERE deleted_at IS NULL`
    ),
    query(
      `SELECT
         COUNT(*)::int AS total_attempts,
         COUNT(*) FILTER (WHERE status = 'SUCCESS')::int AS success_count
       FROM user_verification_sessions`
    ),
  ]);

  const verifiedCount = Number(userRes.rows[0]?.verified_count || 0);
  const unverifiedCount = Number(userRes.rows[0]?.unverified_count || 0);
  const totalAttempts = Number(sessionRes.rows[0]?.total_attempts || 0);
  const successCount = Number(sessionRes.rows[0]?.success_count || 0);

  return {
    verifiedCount,
    unverifiedCount,
    totalAttempts,
    successRate: totalAttempts > 0 ? Math.round((successCount / totalAttempts) * 1000) / 10 : 0,
  };
}

async function getDashboardBreakdowns() {
  const [genderBreakdown, accountStateBreakdown, onboardingFunnel, verificationStats] =
    await Promise.all([
      getGenderBreakdown(),
      getAccountStateBreakdown(),
      getOnboardingFunnel(),
      getVerificationStats(),
    ]);

  return {
    genderBreakdown,
    accountStateBreakdown,
    onboardingFunnel,
    verificationStats,
  };
}

async function getRevenueDaily(windowRaw = "30d") {
  const win = resolveWindow(windowRaw);

  const res = await query(
    `SELECT DATE(created_at) AS day,
            COUNT(*) FILTER (WHERE item_type = 'SUBSCRIPTION')::int AS subscriptions,
            COUNT(*) FILTER (WHERE item_type = 'BOOST')::int AS boosts,
            COUNT(*) FILTER (WHERE pack_code LIKE 'COMMENTS_%')::int AS comments,
            COUNT(*) FILTER (WHERE item_type = 'UNLOCK_CHAT')::int AS chat_unlocks
     FROM user_purchases
     WHERE ${win.allTime ? "TRUE" : `created_at >= NOW() - ${win.intervalSql}`}
     GROUP BY DATE(created_at)
     ORDER BY day ASC`
  );

  const mapRow = (row) => ({
    date: String(row.day),
    subscriptions: Number(row.subscriptions || 0),
    boosts: Number(row.boosts || 0),
    comments: Number(row.comments || 0),
    chatUnlocks: Number(row.chat_unlocks || 0),
  });

  if (win.allTime) {
    return res.rows.map(mapRow);
  }

  const byDay = new Map(res.rows.map((row) => [String(row.day), mapRow(row)]));
  const days = win.days || 30;
  const points = [];
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    points.push(
      byDay.get(key) || {
        date: key,
        subscriptions: 0,
        boosts: 0,
        comments: 0,
        chatUnlocks: 0,
      }
    );
  }

  return points;
}

async function getDashboardRevenue(windowRaw = "30d") {
  const win = resolveWindow(windowRaw);
  const [boostsSold, commentPacksSold, subscriptionsSold, data] = await Promise.all([
    countPurchasesInWindow(`item_type = 'BOOST'`, windowRaw),
    countPurchasesInWindow(`pack_code LIKE 'COMMENTS_%'`, windowRaw),
    countPurchasesInWindow(`item_type = 'SUBSCRIPTION'`, windowRaw),
    getRevenueDaily(windowRaw),
  ]);

  return {
    window: win.key,
    summary: {
      boostsSold,
      commentPacksSold,
      subscriptionsSold,
      chatUnlocksSold: await countPurchasesInWindow(`item_type = 'UNLOCK_CHAT'`, windowRaw),
    },
    daily: data,
  };
}

module.exports = {
  getDashboardStats,
  getUserGrowth,
  getDashboardBadges,
  getDashboardBreakdowns,
  getDashboardRevenue,
};
