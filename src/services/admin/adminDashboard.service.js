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

module.exports = {
  getDashboardStats,
  getUserGrowth,
  getDashboardBadges,
};
