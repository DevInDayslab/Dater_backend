/**
 * When hideMyName is enabled, only the first character is shown (parity with Android [DisplayNameMask]).
 */
function displayNameForPrivacy(fullName, hideMyName) {
  const raw = String(fullName || "").trim();
  if (!hideMyName) return raw;
  if (!raw) return "";
  return raw.charAt(0).toUpperCase();
}

/**
 * Push / in-app banner title line: masked initial when name hidden ("R, 18"), full name + age otherwise.
 */
function formatNotificationPersonTitle(fullName, hideMyName, ageYears) {
  const raw = String(fullName || "").trim();
  const namePart = displayNameForPrivacy(raw, hideMyName === true);
  const fallbackName = namePart || (!raw ? "Someone" : "");
  const age = Number(ageYears);
  const hasAge = Number.isFinite(age) && age > 0;
  const safeAge = hasAge ? Math.round(age) : null;
  if (fallbackName && safeAge != null) return `${fallbackName}, ${safeAge}`;
  if (fallbackName) return fallbackName;
  if (safeAge != null) return `Someone, ${safeAge}`;
  return "Someone";
}

module.exports = { displayNameForPrivacy, formatNotificationPersonTitle };
