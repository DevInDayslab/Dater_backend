const msg91Service = require("../services/msg91.service");
const authService = require("../services/auth.service");
const { debugLog, maskPhoneDigits } = require("../utils/serverDebugLog");

function normalizeDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

/** Strict frontend parity: India mobile must be exactly 10 digits. */
function assertValidTenDigitIndianPhone(rawPhone) {
  const digits = normalizeDigits(rawPhone);
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  const err = new Error("Phone number must be exactly 10 digits");
  err.code = "INVALID_PHONE_NUMBER";
  throw err;
}

function requestMeta(req) {
  return {
    ipAddress: req.ip,
    deviceId: req.headers["x-device-id"] || req.body?.deviceId || null,
    userAgent: req.headers["user-agent"] || null,
  };
}

async function requestOTP(req, res) {
  try {
    const { phone } = req.body;
    assertValidTenDigitIndianPhone(phone);
    debugLog("auth_request_otp_start", { phone: maskPhoneDigits(phone) });
    const result = await msg91Service.sendOTP(phone);
    debugLog("auth_request_otp_ok", { phone: maskPhoneDigits(phone) });

    return res.status(200).json({
      success: true,
      message: "OTP sent successfully",
      data: result,
    });
  } catch (error) {
    debugLog("auth_request_otp_fail", {
      phone: maskPhoneDigits(req.body?.phone),
      error: error.response?.data || error.message,
    });
    return res.status(400).json({
      success: false,
      message: "Failed to send OTP",
      error: error.response?.data || error.message,
    });
  }
}

async function verifyOTP(req, res) {
  try {
    const { phone, otp } = req.body;
    assertValidTenDigitIndianPhone(phone);
    debugLog("auth_verify_otp_start", { phone: maskPhoneDigits(phone) });
    const result = await msg91Service.verifyOTP(phone, otp);

    const status = String(result?.type || "").toLowerCase();
    if (status === "success") {
      debugLog("auth_verify_otp_ok", { phone: maskPhoneDigits(phone) });
    } else {
      debugLog("auth_verify_otp_msg91_response", {
        phone: maskPhoneDigits(phone),
        type: result?.type,
      });
    }

    return res.status(200).json({
      success: status === "success",
      message: status === "success" ? "OTP validated" : "OTP verification response received",
      data: result,
    });
  } catch (error) {
    debugLog("auth_verify_otp_fail", {
      phone: maskPhoneDigits(req.body?.phone),
      error: error.response?.data || error.message,
    });
    return res.status(400).json({
      success: false,
      message: "Failed to verify OTP",
      error: error.response?.data || error.message,
    });
  }
}

async function resendOTP(req, res) {
  try {
    const { phone } = req.body;
    assertValidTenDigitIndianPhone(phone);
    debugLog("auth_resend_otp_start", { phone: maskPhoneDigits(phone) });
    const result = await msg91Service.resendOTP(phone);
    debugLog("auth_resend_otp_ok", { phone: maskPhoneDigits(phone) });

    return res.status(200).json({
      success: true,
      message: "OTP resent successfully",
      data: result,
    });
  } catch (error) {
    debugLog("auth_resend_otp_fail", {
      phone: maskPhoneDigits(req.body?.phone),
      error: error.response?.data || error.message,
    });
    return res.status(400).json({
      success: false,
      message: "Failed to resend OTP",
      error: error.response?.data || error.message,
    });
  }
}

async function completeCaptcha(req, res) {
  try {
    const { captchaChallengeId, captchaAnswer } = req.body;
    debugLog("auth_complete_captcha_start", { userId: req.auth.userId });
    const result = await authService.completeCaptchaLogin({
      userId: req.auth.userId,
      captchaChallengeId,
      captchaAnswer,
      ...requestMeta(req),
    });
    debugLog("auth_complete_captcha_ok", { userId: req.auth.userId, nextRoute: result.nextRoute });
    return res.status(200).json({
      success: true,
      message: "Captcha completed",
      data: result,
    });
  } catch (error) {
    const code = error.code || "COMPLETE_CAPTCHA_FAILED";
    const statusCode =
      code === "BANNED" || code === "DELETED" ? 403 : 400;
    debugLog("auth_complete_captcha_fail", {
      userId: req.auth?.userId,
      code,
      errorMessage: error.message,
    });
    return res.status(statusCode).json({
      success: false,
      message: error.message || "Captcha completion failed",
      code,
      error: error.message,
    });
  }
}

async function verifyOtpAndLogin(req, res) {
  try {
    const { phone, otp, consentAcceptedAt, consentSource, captchaChallengeId, captchaAnswer } = req.body;
    assertValidTenDigitIndianPhone(phone);
    debugLog("auth_verify_otp_login_start", { phone: maskPhoneDigits(phone) });
    const result = await authService.verifyOtpAndLogin({
      phone,
      otp,
      consentAcceptedAt: consentAcceptedAt || null,
      consentSource: consentSource || null,
      captchaChallengeId: captchaChallengeId || null,
      captchaAnswer: captchaAnswer || null,
      ...requestMeta(req),
    });
    debugLog("auth_verify_otp_login_ok", {
      phone: maskPhoneDigits(phone),
      userId: result.userId,
      nextRoute: result.nextRoute,
    });
    return res.status(200).json({
      success: true,
      message: "Login successful",
      data: result,
    });
  } catch (error) {
    const code = error.code || "VERIFY_OTP_LOGIN_FAILED";
    const statusCode =
      code === "BANNED" || code === "DELETED" ? 403 : 400;
    debugLog("auth_verify_otp_login_fail", {
      phone: maskPhoneDigits(req.body?.phone),
      code,
      errorMessage: error.message,
    });
    return res.status(statusCode).json({
      success: false,
      message: error.message || "OTP login failed",
      code,
      error: error.response?.data || error.message,
    });
  }
}

async function verifyAccessToken(req, res) {
  try {
    const { accessToken, phone, consentAcceptedAt, consentSource, captchaChallengeId, captchaAnswer } =
      req.body;
    const tokenLen = accessToken ? String(accessToken).length : 0;
    debugLog("auth_verify_access_token_start", {
      phone: maskPhoneDigits(phone),
      accessTokenChars: tokenLen,
      consentSource: consentSource || null,
    });
    const result = await authService.verifyAccessTokenAndLogin({
      accessToken,
      fallbackPhone: phone || null,
      consentAcceptedAt: consentAcceptedAt || null,
      consentSource: consentSource || null,
      captchaChallengeId: captchaChallengeId || null,
      captchaAnswer: captchaAnswer || null,
      ...requestMeta(req),
    });

    debugLog("auth_login_session_ok", {
      userId: result.userId,
      isNewUser: result.isNewUser,
      nextRoute: result.nextRoute,
      onboardingStep: result.onboardingStep,
      accountState: result.accountState,
      phone: maskPhoneDigits(phone),
    });

    return res.status(200).json({
      success: true,
      message: "Login successful",
      data: result,
    });
  } catch (error) {
    const code = error.code || "VERIFY_ACCESS_TOKEN_FAILED";
    const statusCode =
      code === "BANNED" || code === "DELETED" ? 403 : 400;
    debugLog("auth_verify_access_token_fail", {
      code,
      phone: maskPhoneDigits(req.body?.phone),
      errorMessage: error.message,
      statusCode,
    });
    return res.status(statusCode).json({
      success: false,
      message: "Failed to verify widget access token",
      code,
      error: error.response?.data || error.message,
    });
  }
}

async function createCaptchaChallenge(req, res) {
  try {
    const { phone } = req.body;
    assertValidTenDigitIndianPhone(phone);
    debugLog("auth_captcha_challenge_start", { phone: maskPhoneDigits(phone), ...requestMeta(req) });
    const result = await authService.createCaptchaChallenge({
      phone,
      ...requestMeta(req),
    });
    debugLog("auth_captcha_challenge_ok", { phone: maskPhoneDigits(phone) });
    return res.status(200).json({
      success: true,
      message: "Captcha challenge issued",
      data: result,
    });
  } catch (error) {
    const code = error.code || "CAPTCHA_CHALLENGE_FAILED";
    debugLog("auth_captcha_challenge_fail", {
      phone: maskPhoneDigits(req.body?.phone),
      code,
      error: error.message,
    });
    return res.status(400).json({
      success: false,
      message: error.message || "Could not issue captcha challenge",
      code,
      error: error.message,
    });
  }
}

async function previewLoginRoute(req, res) {
  try {
    const { phone } = req.body;
    assertValidTenDigitIndianPhone(phone);
    debugLog("auth_preview_login_route_start", { phone: maskPhoneDigits(phone) });
    const result = await authService.previewLoginRouteByPhone({ phone });
    debugLog("auth_preview_login_route_ok", {
      phone: maskPhoneDigits(phone),
      userExists: result.userExists,
      nextRoute: result.nextRoute,
    });
    return res.status(200).json({
      success: true,
      message: "Login route preview",
      data: result,
    });
  } catch (error) {
    const code = error.code || "PREVIEW_LOGIN_ROUTE_FAILED";
    debugLog("auth_preview_login_route_fail", {
      phone: maskPhoneDigits(req.body?.phone),
      code,
      error: error.message,
    });
    return res.status(400).json({
      success: false,
      message: error.message || "Could not preview login route",
      code,
      error: error.message,
    });
  }
}

async function precheckLogin(req, res) {
  try {
    const { phone } = req.body;
    assertValidTenDigitIndianPhone(phone);
    debugLog("auth_precheck_start", { phone: maskPhoneDigits(phone), ...requestMeta(req) });
    const result = await authService.precheckLogin({
      phone,
      ...requestMeta(req),
    });
    debugLog("auth_precheck_ok", {
      phone: maskPhoneDigits(phone),
      requiresCaptcha: result.requiresCaptcha,
      reason: result.reason,
      failedCountWindow: result.failedCountWindow,
    });

    return res.status(200).json({
      success: true,
      message: "Login precheck evaluated",
      data: result,
    });
  } catch (error) {
    debugLog("auth_precheck_fail", {
      phone: maskPhoneDigits(req.body?.phone),
      error: error.message,
    });
    return res.status(400).json({
      success: false,
      message: "Failed to evaluate login precheck",
      error: error.response?.data || error.message,
    });
  }
}

async function logout(req, res) {
  try {
    const { userId, sessionId } = req.auth;
    const result = await authService.logout({ userId, sessionId });
    debugLog("auth_logout_ok", { userId, sessionId, revoked: result.revoked });
    return res.status(200).json({
      success: true,
      message: result.revoked ? "Logged out successfully" : "Session already logged out",
      data: result,
    });
  } catch (error) {
    debugLog("auth_logout_fail", { userId: req.auth?.userId, error: error.message });
    return res.status(400).json({
      success: false,
      message: "Failed to log out",
      error: error.response?.data || error.message,
    });
  }
}

module.exports = {
  requestOTP,
  resendOTP,
  verifyOTP,
  verifyOtpAndLogin,
  createCaptchaChallenge,
  completeCaptcha,
  previewLoginRoute,
  precheckLogin,
  verifyAccessToken,
  logout,
};
