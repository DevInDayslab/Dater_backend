/**
 * When hideMyName is enabled, only the first alphabetic character is shown (product parity with Android).
 */
function displayNameForPrivacy(fullName, hideMyName) {
  const raw = String(fullName || "").trim();
  if (!hideMyName) return raw;
  if (!raw) return "";
  return raw.charAt(0).toUpperCase();
}

module.exports = { displayNameForPrivacy };
