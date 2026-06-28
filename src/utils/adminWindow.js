/**
 * Parse admin dashboard time-window query params into SQL interval bounds.
 * Supported: 7d, 30d, 6m, 1y, all, 90d (growth chart)
 */
function resolveWindow(windowRaw) {
  const w = String(windowRaw || "7d").trim().toLowerCase();
  switch (w) {
    case "7d":
      return { key: "7d", days: 7, intervalSql: "INTERVAL '7 days'", allTime: false };
    case "30d":
      return { key: "30d", days: 30, intervalSql: "INTERVAL '30 days'", allTime: false };
    case "90d":
      return { key: "90d", days: 90, intervalSql: "INTERVAL '90 days'", allTime: false };
    case "6m":
      return { key: "6m", days: 183, intervalSql: "INTERVAL '6 months'", allTime: false };
    case "1y":
      return { key: "1y", days: 365, intervalSql: "INTERVAL '1 year'", allTime: false };
    case "all":
      return { key: "all", days: null, intervalSql: null, allTime: true };
    default:
      return { key: "7d", days: 7, intervalSql: "INTERVAL '7 days'", allTime: false };
  }
}

function sinceClause(column, windowRaw, paramIndex = 1) {
  const win = resolveWindow(windowRaw);
  if (win.allTime) {
    return { clause: "", params: [], win };
  }
  return {
    clause: ` AND ${column} >= NOW() - ${win.intervalSql}`,
    params: [],
    win,
  };
}

module.exports = {
  resolveWindow,
  sinceClause,
};
