const { query } = require("../../config/db");
const { resolveWindow } = require("../../utils/adminWindow");

function purchaseTimeFilter(win) {
  return win.allTime ? "" : ` AND created_at >= NOW() - ${win.intervalSql}`;
}

function parsePagination(queryParams) {
  const page = Math.max(Number.parseInt(queryParams.page, 10) || 1, 1);
  const limit = Math.min(Math.max(Number.parseInt(queryParams.limit, 10) || 25, 1), 100);
  return { page, limit, offset: (page - 1) * limit };
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

async function getPurchaseSummary(windowRaw = "30d") {
  const win = resolveWindow(windowRaw);
  const res = await query(
    `SELECT
       COALESCE(SUM(amount), 0)::numeric AS total_revenue,
       COUNT(*) FILTER (WHERE item_type = 'SUBSCRIPTION')::int AS subscriptions_sold,
       COUNT(*) FILTER (WHERE item_type = 'BOOST')::int AS boosts_sold,
       COUNT(*) FILTER (WHERE pack_code LIKE 'COMMENTS_%')::int AS comment_packs_sold,
       COUNT(*) FILTER (WHERE item_type = 'UNLOCK_CHAT')::int AS chat_unlocks_sold
     FROM user_purchases
     WHERE TRUE${purchaseTimeFilter(win)}`
  );
  const row = res.rows[0] || {};
  return {
    totalRevenue: Number(row.total_revenue || 0),
    subscriptionsSold: Number(row.subscriptions_sold || 0),
    boostsSold: Number(row.boosts_sold || 0),
    commentPacksSold: Number(row.comment_packs_sold || 0),
    chatUnlocksSold: Number(row.chat_unlocks_sold || 0),
  };
}

async function getPremiumPlanMix() {
  const res = await query(
    `SELECT COALESCE(premium_plan_code, 'UNKNOWN') AS plan_code,
            COUNT(*)::int AS c
     FROM users
     WHERE deleted_at IS NULL
       AND premium_plan_code IS NOT NULL
       AND (
         premium_status = 'ACTIVE'
         OR (premium_expires_at IS NOT NULL AND premium_expires_at > NOW())
       )
     GROUP BY 1
     ORDER BY c DESC`
  );

  const total = res.rows.reduce((sum, row) => sum + Number(row.c || 0), 0);
  return res.rows.map((row) => {
    const count = Number(row.c || 0);
    return {
      planCode: row.plan_code,
      count,
      percentage: total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
    };
  });
}

async function getRevenueSummary(windowRaw = "30d") {
  const win = resolveWindow(windowRaw);
  const [summary, daily, premiumPlanMix] = await Promise.all([
    getPurchaseSummary(windowRaw),
    getRevenueDaily(windowRaw),
    getPremiumPlanMix(),
  ]);

  return {
    window: win.key,
    summary,
    daily,
    premiumPlanMix,
  };
}

async function getTopBuyers(windowRaw = "30d", queryParams = {}) {
  const win = resolveWindow(windowRaw);
  const { page, limit, offset } = parsePagination(queryParams);

  const timeFilter = win.allTime ? "" : ` AND p.created_at >= NOW() - ${win.intervalSql}`;

  const countRes = await query(
    `SELECT COUNT(*)::int AS total
     FROM (
       SELECT p.user_id
       FROM user_purchases p
       JOIN users u ON u.id = p.user_id
       WHERE u.deleted_at IS NULL${timeFilter}
       GROUP BY p.user_id
     ) buyers`
  );
  const total = Number(countRes.rows[0]?.total || 0);

  const listRes = await query(
    `SELECT u.id AS user_id,
            u.name AS user_name,
            u.premium_status,
            u.account_state,
            COUNT(p.id)::int AS total_purchases,
            COALESCE(SUM(p.amount), 0)::numeric AS total_spend
     FROM user_purchases p
     JOIN users u ON u.id = p.user_id
     WHERE u.deleted_at IS NULL${timeFilter}
     GROUP BY u.id, u.name, u.premium_status, u.account_state
     ORDER BY total_spend DESC, total_purchases DESC, u.name ASC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  return {
    window: win.key,
    items: listRes.rows.map((row) => ({
      userId: row.user_id,
      userName: row.user_name || "Unknown",
      totalPurchases: Number(row.total_purchases || 0),
      totalSpend: Number(row.total_spend || 0),
      premiumStatus: row.premium_status,
      accountState: row.account_state,
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  };
}

async function getPackBreakdown(windowRaw = "30d") {
  const win = resolveWindow(windowRaw);
  const res = await query(
    `SELECT COALESCE(pack_code, 'UNKNOWN') AS pack_code,
            COUNT(*)::int AS c
     FROM user_purchases
     WHERE pack_code IS NOT NULL
       AND TRIM(pack_code) <> ''${purchaseTimeFilter(win)}
     GROUP BY 1
     ORDER BY c DESC, pack_code ASC`
  );

  return {
    window: win.key,
    items: res.rows.map((row) => ({
      packCode: row.pack_code,
      count: Number(row.c || 0),
    })),
  };
}

module.exports = {
  getRevenueSummary,
  getTopBuyers,
  getPackBreakdown,
};
