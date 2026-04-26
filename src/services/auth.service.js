const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { query, pool } = require("../config/db");
const msg91Service = require("./msg91.service");
const { debugLog, maskPhoneDigits } = require("../utils/serverDebugLog");
const { resolveUserAppRoute } = require("../utils/resolveUserAppRoute");

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 365; // 365 days
const PRECHECK_WINDOW_MINUTES = 15;
const PRECHECK_FAIL_THRESHOLD = 3;
const PRECHECK_RANDOM_CAPTCHA_PERCENT = 12;

const CAPTCHA_CODE_LENGTH = 5;
const CAPTCHA_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CAPTCHA_TTL_MINUTES = 10;

function captchaSecret() {
  return process.env.CAPTCHA_PEPPER || process.env.JWT_SECRET || "dater-dev-captcha";
}

function normalizeCaptchaAnswer(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .toUpperCase();
}

function hashCaptchaAnswer(normalizedAnswer) {
  return crypto.createHmac("sha256", captchaSecret()).update(normalizedAnswer).digest("hex");
}

function generateCaptchaDisplayCode() {
  let out = "";
  for (let i = 0; i < CAPTCHA_CODE_LENGTH; i += 1) {
    out += CAPTCHA_CODE_CHARS[Math.floor(Math.random() * CAPTCHA_CODE_CHARS.length)];
  }
  return out;
}

function normalizePhone(phone) {
  return String(phone || "").replace(/[^\d]/g, "");
}

function parseE164(phone) {
  const digits = normalizePhone(phone);
  if (!digits) return null;
  if (digits.length === 10) return `+91${digits}`;
  if (digits.startsWith("91") && digits.length === 12) return `+${digits}`;
  if (digits.startsWith("0") && digits.length === 11) return `+91${digits.slice(1)}`;
  return `+${digits}`;
}

function safeJson(value) {
  return typeof value === "object" && value !== null ? value : {};
}

function decodeJwtPayload(token) {
  try {
    const parts = String(token).split(".");
    if (parts.length < 2) return {};
    const payload = Buffer.from(parts[1], "base64url").toString("utf8");
    return safeJson(JSON.parse(payload));
  } catch {
    return {};
  }
}

function extractPhoneFromMsg91(accessToken, verifyResponse) {
  const payload = decodeJwtPayload(accessToken);
  const candidates = [
    verifyResponse?.phone,
    verifyResponse?.mobile,
    verifyResponse?.identifier,
    verifyResponse?.data?.phone,
    verifyResponse?.data?.mobile,
    verifyResponse?.data?.identifier,
    payload.phone,
    payload.mobile,
    payload.identifier,
    payload.user,
    payload.sub,
  ]
    .map((x) => (x == null ? "" : String(x)))
    .filter(Boolean);

  for (const candidate of candidates) {
    const e164 = parseE164(candidate);
    if (e164) return e164;
  }
  return null;
}

async function logAttempt({
  phoneE164,
  ipAddress,
  deviceId,
  userAgent,
  action,
  status,
  reason = null,
  requiresCaptcha = false,
}) {
  await query(
    `INSERT INTO auth_login_attempts
      (phone_e164, ip_address, device_id, user_agent, action, status, reason, requires_captcha)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [phoneE164, ipAddress, deviceId, userAgent, action, status, reason, requiresCaptcha]
  );
}

function shouldRandomCaptcha() {
  return Math.random() * 100 < PRECHECK_RANDOM_CAPTCHA_PERCENT;
}

async function precheckLogin({ phone, ipAddress, deviceId, userAgent }) {
  const phoneE164 = parseE164(phone);
  if (!phoneE164) {
    throw new Error("A valid phone number is required");
  }

  const recentRes = await query(
    `SELECT COUNT(*)::int AS failed_count
     FROM auth_login_attempts
     WHERE phone_e164 = $1
       AND created_at >= NOW() - ($2 || ' minutes')::interval
       AND status = 'FAIL'`,
    [phoneE164, PRECHECK_WINDOW_MINUTES]
  );

  const failedCount = recentRes.rows[0]?.failed_count || 0;
  const thresholdHit = failedCount >= PRECHECK_FAIL_THRESHOLD;
  const randomCaptcha = shouldRandomCaptcha();
  const requiresCaptcha = thresholdHit || randomCaptcha;

  await logAttempt({
    phoneE164,
    ipAddress,
    deviceId,
    userAgent,
    action: "PRECHECK",
    status: "SUCCESS",
    reason: `failed_count=${failedCount}`,
    requiresCaptcha,
  });

  return {
    phoneE164,
    requiresCaptcha,
    reason: thresholdHit ? "RISK_THRESHOLD" : randomCaptcha ? "RANDOM_CHECK" : "CLEAR",
    failedCountWindow: failedCount,
  };
}

async function latestPrecheckRequiresCaptcha(phoneE164) {
  const res = await query(
    `SELECT requires_captcha
     FROM auth_login_attempts
     WHERE phone_e164 = $1
       AND action = 'PRECHECK'
       AND status = 'SUCCESS'
       AND created_at >= NOW() - ($2 || ' minutes')::interval
     ORDER BY created_at DESC
     LIMIT 1`,
    [phoneE164, PRECHECK_WINDOW_MINUTES]
  );
  return Boolean(res.rows[0]?.requires_captcha);
}

async function userHasPendingCaptchaByPhone(phoneE164) {
  const r = await query(
    `SELECT 1 FROM users
     WHERE phone_e164 = $1 AND account_state = 'PENDING_CAPTCHA'::account_state_enum
     LIMIT 1`,
    [phoneE164]
  );
  return r.rows.length > 0;
}

async function createCaptchaChallenge({ phone, ipAddress, deviceId, userAgent }) {
  const phoneE164 = parseE164(phone);
  if (!phoneE164) {
    throw new Error("A valid phone number is required");
  }

  const [precheckCaptcha, pendingCaptcha] = await Promise.all([
    latestPrecheckRequiresCaptcha(phoneE164),
    userHasPendingCaptchaByPhone(phoneE164),
  ]);
  const needs = precheckCaptcha || pendingCaptcha;
  if (!needs) {
    const err = new Error("Captcha is not required for this login attempt");
    err.code = "CAPTCHA_NOT_REQUIRED";
    throw err;
  }

  const displayCode = generateCaptchaDisplayCode();
  const answerHmac = hashCaptchaAnswer(normalizeCaptchaAnswer(displayCode));

  await query(
    `UPDATE auth_captcha_challenges
     SET invalidated_at = NOW()
     WHERE phone_e164 = $1
       AND invalidated_at IS NULL
       AND consumed_at IS NULL`,
    [phoneE164]
  );

  const ins = await query(
    `INSERT INTO auth_captcha_challenges (phone_e164, answer_hmac, expires_at)
     VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval)
     RETURNING id`,
    [phoneE164, answerHmac, CAPTCHA_TTL_MINUTES]
  );

  const id = ins.rows[0]?.id;
  if (!id) {
    throw new Error("Could not create captcha challenge");
  }

  await logAttempt({
    phoneE164,
    ipAddress,
    deviceId,
    userAgent,
    action: "CAPTCHA_ISSUED",
    status: "SUCCESS",
    reason: null,
    requiresCaptcha: false,
  });

  return { captchaChallengeId: String(id), displayCode };
}

async function assertCaptchaForLogin({ phoneE164, captchaChallengeId, captchaAnswer }) {
  const rowRes = await query(
    `SELECT id, answer_hmac
     FROM auth_captcha_challenges
     WHERE id = $1::uuid
       AND phone_e164 = $2
       AND invalidated_at IS NULL
       AND consumed_at IS NULL
       AND expires_at > NOW()`,
    [captchaChallengeId, phoneE164]
  );
  if (rowRes.rows.length === 0) {
    const err = new Error("Captcha challenge is invalid or expired");
    err.code = "CAPTCHA_EXPIRED";
    throw err;
  }
  const row = rowRes.rows[0];
  const expected = String(row.answer_hmac);
  const got = hashCaptchaAnswer(normalizeCaptchaAnswer(captchaAnswer));
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(got, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    const err = new Error("Captcha does not match");
    err.code = "CAPTCHA_INVALID";
    throw err;
  }
  await query(`UPDATE auth_captcha_challenges SET consumed_at = NOW() WHERE id = $1::uuid`, [
    captchaChallengeId,
  ]);
}

async function getOrCreateUserByPhone(phoneE164, { ipAddress, deviceId, userAgent, consentAcceptedAt, consentSource }) {
  const phoneNumber = phoneE164.replace(/^\+91/, "");
  const consentTimestamp = consentAcceptedAt ? new Date(consentAcceptedAt) : null;
  const hasValidConsentTs = consentTimestamp && !Number.isNaN(consentTimestamp.getTime());

  const updatedExisting = await query(
    `UPDATE users
       SET is_phone_verified = TRUE,
           last_active_at = NOW(),
           terms_accepted_at = COALESCE(terms_accepted_at, $2),
           privacy_accepted_at = COALESCE(privacy_accepted_at, $2),
           consent_source = COALESCE(consent_source, $3),
           updated_at = NOW()
       WHERE phone_e164 = $1
       RETURNING id, phone_e164, onboarding_completed_at, onboarding_step, onboarding_updated_at, account_state, underage_until`,
    [phoneE164, hasValidConsentTs ? consentTimestamp.toISOString() : null, consentSource || null]
  );

  if (updatedExisting.rows.length > 0) {
    return { user: updatedExisting.rows[0], isNewUser: false };
  }

  const created = await query(
    `INSERT INTO users
      (phone_country_code, phone_number, phone_e164, is_phone_verified, onboarding_step, onboarding_updated_at,
       terms_accepted_at, privacy_accepted_at, consent_source,
       account_created_ip_address, account_created_device_id, account_created_user_agent)
     VALUES ('+91', $1, $2, TRUE, 'onboarding_name', NOW(), $3, $3, $4, $5, $6, $7)
     RETURNING id, phone_e164, onboarding_completed_at, onboarding_step, onboarding_updated_at, account_state, underage_until`,
    [
      phoneNumber,
      phoneE164,
      hasValidConsentTs ? consentTimestamp.toISOString() : null,
      consentSource || null,
      ipAddress || null,
      deviceId || null,
      userAgent || null,
    ]
  );

  return { user: created.rows[0], isNewUser: true };
}

/**
 * Hard-stops login when we must not issue a session. UNDERAGE (and other /blocked/* routes) still
 * receive a JWT so the client can persist and cold-start to the blocked UI via GET /me + nextRoute.
 */
function assertAllowedUserState(user) {
  const state = String(user.account_state || "ACTIVE");
  if (state === "BANNED") {
    const error = new Error("User is banned");
    error.code = "BANNED";
    throw error;
  }
}

/**
 * Soft-deleted accounts may log in again within the retention window and are treated as brand-new onboarding
 * (same user row; deletion is audited separately on delete-account).
 */
async function normalizeDeletedUserReturning(user) {
  if (!user || String(user.account_state) !== "DELETED") return user;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const userId = user.id;

    // Fresh-account semantics on same-number relogin: clear all profile/onboarding residue.
    const resetTables = [
      "user_photos",
      "user_gender_more_options",
      "user_dating_preferences",
      "user_looking_for",
      "user_interests",
      "user_languages",
      "user_pronouns",
      "user_written_prompts",
      "user_filter_preferred_genders",
      "user_filter_languages",
      "user_filter_marital_statuses",
      "user_filter_looking_for",
      "user_filter_drinking_preferences",
      "user_filter_smoking_preferences",
      "user_filter_exercise_preferences",
      "user_filter_religion_preferences",
      "user_filter_education_preferences",
      "user_filter_star_sign_preferences",
      "user_filter_kids_preferences",
      "user_filter_political_preferences",
      "user_filter_pet_preferences",
      "user_filter_ethnicity_preferences",
      "user_filter_pronoun_preferences",
      "premium_boosts",
      "user_daily_profile_view_usage",
      "profile_view_events",
    ];
    for (const table of resetTables) {
      await client.query(`DELETE FROM ${table} WHERE user_id = $1::uuid`, [userId]);
    }
    await client.query(`DELETE FROM profile_view_events WHERE viewed_user_id = $1::uuid`, [userId]);
    await client.query(`DELETE FROM user_filters WHERE user_id = $1::uuid`, [userId]);

    const res = await client.query(
      `UPDATE users
       SET account_state = 'ACTIVE'::account_state_enum,
           deleted_at = NULL,
           paused_until = NULL,
           hide_my_name = FALSE,
           onboarding_step = 'onboarding_name',
           onboarding_completed_at = NULL,
           onboarding_updated_at = NOW(),
           profile_completion_percentage = 0,
           -- wipe profile core
           name = NULL,
           age_years = NULL,
           date_of_birth = NULL,
           gender = NULL,
           gender_main = NULL,
           show_gender_on_profile = FALSE,
           marital_status = NULL,
           bio = NULL,
           preset_message = NULL,
           height_inches = NULL,
           drinking = NULL,
           smoking = NULL,
           exercise = NULL,
           religion = NULL,
           education = NULL,
           star_sign = NULL,
           kids = NULL,
           political_leanings = NULL,
           pets = NULL,
           ethnicity = NULL,
           occupation_job_title = NULL,
           occupation_company = NULL,
           education_institution_name = NULL,
           education_passing_year = NULL,
           living_in_city = NULL,
           home_town_city = NULL,
           living_in_city_mode = 'FOLLOW_DEVICE',
           location = NULL,
           location_granted = FALSE,
           notifications_granted = FALSE,
           updated_at = NOW()
       WHERE id = $1::uuid
         AND account_state = 'DELETED'::account_state_enum
       RETURNING id, phone_e164, onboarding_completed_at, onboarding_step, onboarding_updated_at, account_state, underage_until`,
      [userId]
    );
    await client.query("COMMIT");
    const row = res.rows[0];
    debugLog("auth_reactivated_deleted_user", { userId: user.id, fullyReset: true });
    return row || user;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      /* ignore */
    }
    throw error;
  } finally {
    client.release();
  }
}

async function normalizeUnderageState(user) {
  if (String(user.account_state) !== "UNDERAGE_BLOCKED") return user;
  if (!user.underage_until) return user;
  const eligibleNow = new Date(user.underage_until).getTime() <= Date.now();
  if (!eligibleNow) return user;

  const res = await query(
    `UPDATE users
     SET account_state = 'ACTIVE'::account_state_enum,
         underage_until = NULL,
         onboarding_step = 'onboarding_name',
         onboarding_completed_at = NULL,
         onboarding_updated_at = NOW(),
         updated_at = NOW()
     WHERE id = $1
     RETURNING id, phone_e164, onboarding_completed_at, onboarding_step, account_state, underage_until`,
    [user.id]
  );
  return res.rows[0] || user;
}

async function normalizeOnboardingWindow(user) {
  if (user.onboarding_completed_at) return user;
  if (!user.onboarding_updated_at) return user;

  const stale =
    Date.now() - new Date(user.onboarding_updated_at).getTime() >
    7 * 24 * 60 * 60 * 1000;
  if (!stale) return user;

  const res = await query(
    `UPDATE users
     SET onboarding_step = 'onboarding_name',
         onboarding_completed_at = NULL,
         onboarding_updated_at = NOW(),
         updated_at = NOW()
     WHERE id = $1
     RETURNING id, phone_e164, onboarding_completed_at, onboarding_step, onboarding_updated_at, account_state, underage_until`,
    [user.id]
  );
  return res.rows[0] || user;
}

async function createSessionAndToken({ userId, ipAddress, deviceId, userAgent }) {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error("JWT_SECRET is required in environment variables");
  }

  const jwtId = crypto.randomUUID();
  const sessionRes = await query(
    `INSERT INTO user_sessions (user_id, jwt_id, device_id, ip_address, user_agent, expires_at)
     VALUES ($1, $2::uuid, $3, $4, $5, NOW() + ($6 || ' seconds')::interval)
     RETURNING id, jwt_id, expires_at`,
    [userId, jwtId, deviceId || null, ipAddress || null, userAgent || null, ACCESS_TOKEN_TTL_SECONDS]
  );
  const session = sessionRes.rows[0];

  await query(`UPDATE users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1::uuid`, [userId]);

  const accessToken = jwt.sign(
    {
      sub: userId,
      sid: session.id,
      jti: session.jwt_id,
      type: "access",
    },
    jwtSecret,
    { expiresIn: ACCESS_TOKEN_TTL_SECONDS }
  );

  return { session, accessToken };
}

/**
 * Shared session issuance after MSG91 has already proven the phone (widget JWT or SendOTP verify).
 * @param {object} audit — `successAction` / `underageCaptchaSkipAction` for auth_login_attempts.action
 */
async function completeLoginWithVerifiedPhoneE164({
  phoneE164,
  consentAcceptedAt = null,
  consentSource = null,
  captchaChallengeId = null,
  captchaAnswer = null,
  ipAddress,
  deviceId,
  userAgent,
  msg91,
  audit = {},
}) {
  const successAction = audit.successAction || "VERIFY_ACCESS_TOKEN";
  const underageCaptchaSkipAction = audit.underageCaptchaSkipAction || successAction;

  const captchaRequired = await latestPrecheckRequiresCaptcha(phoneE164);
  const cid = captchaChallengeId ? String(captchaChallengeId).trim() : "";
  const cans = captchaAnswer != null ? String(captchaAnswer).trim() : "";
  const hasCaptchaPayload = Boolean(cid && cans);

  if (captchaRequired && !hasCaptchaPayload) {
    const result = await getOrCreateUserByPhone(phoneE164, {
      ipAddress,
      deviceId,
      userAgent,
      consentAcceptedAt,
      consentSource,
    });
    let user = await normalizeUnderageState(result.user);
    user = await normalizeOnboardingWindow(user);
    user = await normalizeDeletedUserReturning(user);
    assertAllowedUserState(user);

    // Underage users must not be forced into PENDING_CAPTCHA (would overwrite account_state and wrong nextRoute).
    if (String(user.account_state) === "UNDERAGE_BLOCKED") {
      const { session, accessToken: daterAccessToken } = await createSessionAndToken({
        userId: user.id,
        ipAddress,
        deviceId,
        userAgent,
      });
      await logAttempt({
        phoneE164,
        ipAddress,
        deviceId,
        userAgent,
        action: underageCaptchaSkipAction,
        status: "SUCCESS",
        reason: "underage_skips_captcha_pending",
        requiresCaptcha: true,
      });
      return {
        phoneE164,
        userId: user.id,
        isNewUser: result.isNewUser,
        nextRoute: resolveUserAppRoute(user),
        accountState: user.account_state,
        onboardingStep: user.onboarding_step,
        token: {
          accessToken: daterAccessToken,
          expiresAt: session.expires_at,
          sessionId: session.id,
        },
        msg91,
      };
    }

    await query(
      `UPDATE users
       SET account_state = 'PENDING_CAPTCHA'::account_state_enum, updated_at = NOW()
       WHERE id = $1`,
      [user.id]
    );

    const { session, accessToken: daterAccessToken } = await createSessionAndToken({
      userId: user.id,
      ipAddress,
      deviceId,
      userAgent,
    });

    await logAttempt({
      phoneE164,
      ipAddress,
      deviceId,
      userAgent,
      action: "LOGIN_CAPTCHA_PENDING",
      status: "SUCCESS",
      reason: null,
      requiresCaptcha: true,
    });

    return {
      phoneE164,
      userId: user.id,
      isNewUser: result.isNewUser,
      nextRoute: "/captcha-pending",
      accountState: "PENDING_CAPTCHA",
      onboardingStep: user.onboarding_step,
      token: {
        accessToken: daterAccessToken,
        expiresAt: session.expires_at,
        sessionId: session.id,
      },
      msg91,
    };
  }

  if (captchaRequired && hasCaptchaPayload) {
    await assertCaptchaForLogin({
      phoneE164,
      captchaChallengeId: cid,
      captchaAnswer: cans,
    });
  }

  const result = await getOrCreateUserByPhone(phoneE164, {
    ipAddress,
    deviceId,
    userAgent,
    consentAcceptedAt,
    consentSource,
  });
  let user = await normalizeUnderageState(result.user);
  user = await normalizeOnboardingWindow(user);
  user = await normalizeDeletedUserReturning(user);
  const isNewUser = result.isNewUser;
  assertAllowedUserState(user);

  const refreshed = await query(
    `UPDATE users
     SET account_state = CASE
           WHEN account_state = 'PENDING_CAPTCHA'::account_state_enum THEN 'ACTIVE'::account_state_enum
           ELSE account_state
         END,
         updated_at = NOW()
     WHERE id = $1
     RETURNING id, phone_e164, onboarding_completed_at, onboarding_step, onboarding_updated_at, account_state, underage_until`,
    [user.id]
  );
  user = refreshed.rows[0] || user;

  const { session, accessToken: daterAccessToken } = await createSessionAndToken({
    userId: user.id,
    ipAddress,
    deviceId,
    userAgent,
  });

  await logAttempt({
    phoneE164,
    ipAddress,
    deviceId,
    userAgent,
    action: successAction,
    status: "SUCCESS",
    reason: null,
    requiresCaptcha: false,
  });

  return {
    phoneE164,
    userId: user.id,
    isNewUser,
    nextRoute: resolveUserAppRoute(user),
    accountState: user.account_state,
    onboardingStep: user.onboarding_step,
    token: {
      accessToken: daterAccessToken,
      expiresAt: session.expires_at,
      sessionId: session.id,
    },
    msg91,
  };
}

async function verifyAccessTokenAndLogin({
  accessToken,
  fallbackPhone = null,
  consentAcceptedAt = null,
  consentSource = null,
  captchaChallengeId = null,
  captchaAnswer = null,
  ipAddress,
  deviceId,
  userAgent,
}) {
  const verifyResponse = await msg91Service.verifyAccessToken(accessToken);
  const status = String(verifyResponse?.type || "").toLowerCase();
  if (status !== "success") {
    debugLog("auth_msg91_widget_verify_not_success", {
      status,
      message: verifyResponse?.message,
      keys: verifyResponse && typeof verifyResponse === "object" ? Object.keys(verifyResponse) : [],
    });
    const error = new Error(verifyResponse?.message || "MSG91 access-token verification failed");
    error.code = "MSG91_VERIFY_FAILED";
    throw error;
  }

  const phoneE164 = extractPhoneFromMsg91(accessToken, verifyResponse) || parseE164(fallbackPhone);
  if (!phoneE164) {
    debugLog("auth_phone_extract_failed", {
      fallbackPhone: maskPhoneDigits(fallbackPhone),
      tokenPayloadKeys: Object.keys(decodeJwtPayload(accessToken)),
    });
    const error = new Error("Could not extract verified phone from MSG91 response");
    error.code = "PHONE_EXTRACTION_FAILED";
    throw error;
  }

  return completeLoginWithVerifiedPhoneE164({
    phoneE164,
    consentAcceptedAt,
    consentSource,
    captchaChallengeId,
    captchaAnswer,
    ipAddress,
    deviceId,
    userAgent,
    msg91: verifyResponse,
    audit: {
      successAction: "VERIFY_ACCESS_TOKEN",
      underageCaptchaSkipAction: "VERIFY_ACCESS_TOKEN",
    },
  });
}

/** MSG91 SendOTP API verify + same Dater session path as the widget flow. */
async function verifyOtpAndLogin({
  phone,
  otp,
  consentAcceptedAt = null,
  consentSource = null,
  captchaChallengeId = null,
  captchaAnswer = null,
  ipAddress,
  deviceId,
  userAgent,
}) {
  const verifyResponse = await msg91Service.verifyOTP(phone, otp);
  const status = String(verifyResponse?.type || "").toLowerCase();
  if (status !== "success") {
    debugLog("auth_msg91_send_otp_verify_not_success", {
      status,
      message: verifyResponse?.message,
    });
    const error = new Error(verifyResponse?.message || "OTP verification failed");
    error.code = "OTP_VERIFY_FAILED";
    throw error;
  }

  const phoneE164 = parseE164(phone);
  if (!phoneE164) {
    const error = new Error("Could not parse phone number");
    error.code = "INVALID_PHONE_NUMBER";
    throw error;
  }

  return completeLoginWithVerifiedPhoneE164({
    phoneE164,
    consentAcceptedAt,
    consentSource,
    captchaChallengeId,
    captchaAnswer,
    ipAddress,
    deviceId,
    userAgent,
    msg91: verifyResponse,
    audit: {
      successAction: "VERIFY_OTP_LOGIN",
      underageCaptchaSkipAction: "VERIFY_OTP_LOGIN",
    },
  });
}

async function completeCaptchaLogin({ userId, captchaChallengeId, captchaAnswer, ipAddress, deviceId, userAgent }) {
  const uid = String(userId || "").trim();
  const cid = captchaChallengeId ? String(captchaChallengeId).trim() : "";
  const cans = captchaAnswer != null ? String(captchaAnswer).trim() : "";
  if (!cid || !cans) {
    const err = new Error("Captcha challenge and answer are required");
    err.code = "CAPTCHA_REQUIRED";
    throw err;
  }

  const userRes = await query(
    `SELECT id, phone_e164, account_state, onboarding_completed_at, onboarding_step, onboarding_updated_at, underage_until
     FROM users
     WHERE id = $1::uuid
     LIMIT 1`,
    [uid]
  );
  const row = userRes.rows[0];
  if (!row) {
    throw new Error("User not found");
  }
  if (String(row.account_state) !== "PENDING_CAPTCHA") {
    const err = new Error("Captcha is not pending for this account");
    err.code = "CAPTCHA_NOT_PENDING";
    throw err;
  }

  await assertCaptchaForLogin({
    phoneE164: row.phone_e164,
    captchaChallengeId: cid,
    captchaAnswer: cans,
  });

  await query(
    `UPDATE users SET account_state = 'ACTIVE'::account_state_enum, updated_at = NOW() WHERE id = $1::uuid`,
    [uid]
  );

  const refreshed = await query(
    `SELECT id, phone_e164, onboarding_completed_at, onboarding_step, onboarding_updated_at, account_state, underage_until
     FROM users
     WHERE id = $1::uuid
     LIMIT 1`,
    [uid]
  );
  let user = refreshed.rows[0];
  user = await normalizeUnderageState(user);
  user = await normalizeOnboardingWindow(user);
  user = await normalizeDeletedUserReturning(user);
  assertAllowedUserState(user);

  await logAttempt({
    phoneE164: row.phone_e164,
    ipAddress,
    deviceId,
    userAgent,
    action: "COMPLETE_CAPTCHA",
    status: "SUCCESS",
    reason: null,
    requiresCaptcha: false,
  });

  return {
    nextRoute: resolveUserAppRoute(user),
    accountState: user.account_state,
    onboardingStep: user.onboarding_step,
  };
}

/**
 * Read-only routing hint for the OTP screen: mirrors [resolveUserAppRoute] from the DB without
 * running login side-effects (no user row mutations).
 */
async function previewLoginRouteByPhone({ phone }) {
  const phoneE164 = parseE164(phone);
  if (!phoneE164) {
    const err = new Error("A valid phone number is required");
    err.code = "INVALID_PHONE_NUMBER";
    throw err;
  }
  const userRes = await query(
    `SELECT id, onboarding_completed_at, onboarding_step, onboarding_updated_at, account_state, underage_until
     FROM users
     WHERE phone_e164 = $1
     LIMIT 1`,
    [phoneE164]
  );
  if (userRes.rows.length === 0) {
    return {
      phoneE164,
      userExists: false,
      nextRoute: "/onboarding/resume",
      onboardingStep: "onboarding_name",
      accountState: "ACTIVE",
    };
  }
  const user = userRes.rows[0];
  return {
    phoneE164,
    userExists: true,
    nextRoute: resolveUserAppRoute(user),
    onboardingStep: String(user.onboarding_step || ""),
    accountState: String(user.account_state || "ACTIVE"),
  };
}

async function logout({ userId, sessionId }) {
  const res = await query(
    `UPDATE user_sessions
     SET revoked_at = NOW(),
         last_seen_at = NOW()
     WHERE id = $1
       AND user_id = $2
       AND revoked_at IS NULL
     RETURNING id`,
    [sessionId, userId]
  );
  if (res.rowCount > 0) {
    await query(`UPDATE users SET last_logout_at = NOW(), updated_at = NOW() WHERE id = $1::uuid`, [userId]);
  }
  return { revoked: res.rowCount > 0 };
}

module.exports = {
  precheckLogin,
  previewLoginRouteByPhone,
  verifyAccessTokenAndLogin,
  verifyOtpAndLogin,
  completeCaptchaLogin,
  createCaptchaChallenge,
  logout,
  logAttempt,
  parseE164,
};
