function parseAdminFiledReport(reason) {
  const text = String(reason || "");
  const match = text.match(/^\[Admin(?:: ([^\]]+))?\]\s*(.*)$/);
  if (!match) return null;
  const adminName = (match[1] || "Admin").trim() || "Admin";
  const userReason = (match[2] || "").trim();
  return {
    adminName,
    reason: userReason || text,
    reporterLabel: adminName === "Admin" ? "Admin" : `Admin · ${adminName}`,
  };
}

function withAdminReportDisplay(row) {
  const adminMeta = parseAdminFiledReport(row.reason);
  if (!adminMeta) return null;
  return {
    reporterId: null,
    reporterName: adminMeta.reporterLabel,
    reason: adminMeta.reason,
    filedByAdmin: true,
  };
}

module.exports = {
  parseAdminFiledReport,
  withAdminReportDisplay,
}
