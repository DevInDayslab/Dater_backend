const DEFAULT_APPLE_DEMO_OTP = "765290";
/** App Review account — used when APPLE_DEMO_PHONE is not set on the server (e.g. EC2/PM2). */
const BUILTIN_APPLE_DEMO_PHONE_E164 = "+919764762744";

function normalizePhoneDigits(phone) {
  return String(phone || "").replace(/\D/g, "");
}

function toDemoPhoneE164(raw) {
  const digits = normalizePhoneDigits(raw);
  if (!digits) return null;
  if (digits.length === 10) return `+91${digits}`;
  if (digits.startsWith("91") && digits.length === 12) return `+${digits}`;
  return `+${digits}`;
}

function getAppleDemoPhoneE164() {
  const raw = String(process.env.APPLE_DEMO_PHONE || "").trim();
  if (raw) return toDemoPhoneE164(raw);
  return BUILTIN_APPLE_DEMO_PHONE_E164;
}

function getAppleDemoOtp() {
  const configured = String(process.env.APPLE_DEMO_OTP || "").trim();
  return configured || DEFAULT_APPLE_DEMO_OTP;
}

function indianMobile10(phone) {
  const digits = normalizePhoneDigits(phone);
  if (digits.length >= 10) return digits.slice(-10);
  return digits;
}

function isAppleDemoPhone(phone) {
  const demoE164 = getAppleDemoPhoneE164();
  if (!demoE164) return false;
  const candidate = toDemoPhoneE164(phone);
  if (!candidate) return false;
  if (candidate === demoE164) return true;
  return indianMobile10(phone) === indianMobile10(demoE164);
}

function matchesAppleDemoOtp(otp) {
  const normalized = String(otp || "").trim();
  return normalized.length === 6 && normalized === getAppleDemoOtp();
}

function isAppleDemoOtpLogin(phone, otp) {
  return isAppleDemoPhone(phone) && matchesAppleDemoOtp(otp);
}

module.exports = {
  DEFAULT_APPLE_DEMO_OTP,
  getAppleDemoPhoneE164,
  getAppleDemoOtp,
  isAppleDemoPhone,
  matchesAppleDemoOtp,
  isAppleDemoOtpLogin,
};
