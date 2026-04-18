/**
 * Integration checks for verification endpoints + response timing.
 *
 * Notes:
 * - Full liveness completion requires an actual mobile FaceLiveness challenge.
 * - This script validates the API contract, timings, and expected failure modes
 *   for preview/complete when session is not yet completed by AWS UI.
 *
 * Run:
 *   node src/scripts/testVerificationFlow.js
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
const jwt = require("jsonwebtoken");
const { query } = require("../config/db");

const API_BASE = process.env.API_BASE_URL || "http://127.0.0.1:3000";

function section(title) {
  console.log(`\n--- ${title} ---`);
}

async function ensureUser() {
  const users = await query(`SELECT id, phone_e164 FROM users ORDER BY created_at DESC NULLS LAST LIMIT 1`);
  if (users.rows.length) return users.rows[0];

  const suffix = String(Math.floor(Math.random() * 1e9)).padStart(9, "0");
  const phoneNumber = `9${suffix}`.slice(0, 10);
  const phoneE164 = `+91${phoneNumber}`;
  const ins = await query(
    `INSERT INTO users (
       phone_country_code,
       phone_number,
       phone_e164,
       is_phone_verified,
       age_years,
       name,
       onboarding_step
     ) VALUES ('+91', $1, $2, true, 25, 'Verification flow script', 'onboarding_upload_photos')
     RETURNING id, phone_e164`,
    [phoneNumber, phoneE164]
  );
  return ins.rows[0];
}

async function mintBearerForUser(userId) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET missing");
  const ins = await query(
    `INSERT INTO user_sessions (user_id, jwt_id, expires_at)
     VALUES ($1, gen_random_uuid(), NOW() + interval '7 days')
     RETURNING id, jwt_id`,
    [userId]
  );
  const row = ins.rows[0];
  return jwt.sign(
    { sub: userId, sid: row.id, jti: row.jwt_id, type: "access" },
    secret,
    { expiresIn: "7d" }
  );
}

async function fetchJsonWithTiming(apiPath, { method = "GET", token, body } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const start = process.hrtime.bigint();
  const res = await fetch(`${API_BASE}${apiPath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { _raw: text };
  }
  return { status: res.status, json, elapsedMs };
}

function printResult(label, result) {
  console.log(
    `${label}: HTTP ${result.status} | ${result.elapsedMs.toFixed(1)} ms | success=${Boolean(
      result.json?.success
    )}`
  );
  if (result.json?.code) console.log(`code=${result.json.code}`);
}

async function main() {
  section("Setup user + token");
  const user = await ensureUser();
  const token = await mintBearerForUser(user.id);
  console.log("userId:", user.id, "phone:", user.phone_e164 || "n/a");

  section("GET /me baseline");
  const me = await fetchJsonWithTiming("/api/v1/users/me", { token });
  printResult("me", me);
  if (!me.json?.success) {
    console.error("GET /me failed:", JSON.stringify(me.json, null, 2));
    process.exit(1);
  }
  console.log(
    "verification snapshot:",
    JSON.stringify(me.json?.data?.verification || {}, null, 2)
  );

  section("POST /verify-liveness/session");
  const sessionRes = await fetchJsonWithTiming("/api/v1/users/me/verify-liveness/session", {
    method: "POST",
    token,
    body: {},
  });
  printResult("session", sessionRes);
  console.log(JSON.stringify(sessionRes.json, null, 2));
  if (!sessionRes.json?.success || !sessionRes.json?.data?.sessionId) {
    console.error("Session creation failed.");
    process.exit(1);
  }
  const sessionId = sessionRes.json.data.sessionId;

  section("POST /verify-liveness/preview (expected pre-challenge failure)");
  const previewRes = await fetchJsonWithTiming("/api/v1/users/me/verify-liveness/preview", {
    method: "POST",
    token,
    body: { sessionId },
  });
  printResult("preview", previewRes);
  console.log(JSON.stringify(previewRes.json, null, 2));

  section("POST /verify-liveness/complete (expected pre-challenge failure)");
  const completeRes = await fetchJsonWithTiming("/api/v1/users/me/verify-liveness/complete", {
    method: "POST",
    token,
    body: { sessionId },
  });
  printResult("complete", completeRes);
  console.log(JSON.stringify(completeRes.json, null, 2));

  section("Contract assertions");
  const hasVerificationPayload = Object.prototype.hasOwnProperty.call(me.json?.data || {}, "verification");
  console.log("GET /me includes verification snapshot:", hasVerificationPayload ? "YES" : "NO");
  console.log(
    "Session endpoint response time:",
    `${sessionRes.elapsedMs.toFixed(1)} ms`,
    sessionRes.elapsedMs < 3000 ? "(OK)" : "(SLOW)"
  );
  console.log(
    "Preview endpoint response time:",
    `${previewRes.elapsedMs.toFixed(1)} ms`,
    previewRes.elapsedMs < 3000 ? "(OK)" : "(SLOW)"
  );
  console.log(
    "Complete endpoint response time:",
    `${completeRes.elapsedMs.toFixed(1)} ms`,
    completeRes.elapsedMs < 3000 ? "(OK)" : "(SLOW)"
  );

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

