/**
 * Dev-oriented logs (onboarding saves, uploads, moderation). Skipped in production
 * unless DEBUG_SERVER_LOG=1.
 */
function shouldLog() {
  if (process.env.DEBUG_SERVER_LOG === "1") return true;
  if (process.env.NODE_ENV === "production") return false;
  return true;
}

function debugLog(tag, payload = {}) {
  if (!shouldLog()) return;
  console.log("[Dater]", tag, payload);
}

/** Last 4 digits only for logs (E.164 digits without +). */
function maskPhoneDigits(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  if (d.length <= 4) return "***";
  return `****${d.slice(-4)}`;
}

module.exports = { debugLog, shouldLog, maskPhoneDigits };
