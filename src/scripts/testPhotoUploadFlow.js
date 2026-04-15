/**
 * Integration checks for presign → S3 PUT → confirm → getMe profilePhotos.
 * Requires: DATABASE_URL, JWT_SECRET, AWS creds, S3_MEDIA_BUCKET, Rekognition access.
 *
 * Run (from backend/): node src/scripts/testPhotoUploadFlow.js
 * Optional: API_BASE_URL=http://127.0.0.1:3000 (default). After changing controllers,
 * restart `npm start` (or point API_BASE_URL at a fresh process) so HTTP tests see new code.
 *
 * If the DB has zero users, the script inserts one dev-only row (random +91 number)
 * unless PHOTO_TEST_NO_AUTO_USER=1 — then it exits (same as before).
 *
 * Presign sends blurHash (SAMPLE_BLUR_HASH or PHOTO_TEST_BLUR_HASH) so getMe returns it.
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
const jwt = require("jsonwebtoken");
const { query } = require("../config/db");
const photoMaintenance = require("../services/photoMaintenance.service");

const API_BASE = process.env.API_BASE_URL || "http://127.0.0.1:3000";

/** Valid BlurHash demo string (matches what the Android app sends). Override with PHOTO_TEST_BLUR_HASH. */
const SAMPLE_BLUR_HASH =
  process.env.PHOTO_TEST_BLUR_HASH || "LEHV6nWB2yk8pyo0adR*.7kCMdnj";

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
  const token = jwt.sign(
    { sub: userId, sid: row.id, jti: row.jwt_id, type: "access" },
    secret,
    { expiresIn: "7d" }
  );
  return token;
}

async function fetchJson(path, { method = "GET", token, body } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { _raw: text };
  }
  return { status: res.status, json };
}

async function downloadSampleWebp() {
  const url =
    process.env.PHOTO_TEST_WEBP_URL ||
    "https://www.gstatic.com/webp/gallery/1.webp";
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Sample WebP download failed ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function putToS3(uploadUrl, contentType, bytes) {
  const r = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: bytes,
  });
  return { status: r.status, text: await r.text() };
}

function section(title) {
  console.log("\n---", title, "---");
}

/**
 * Minimal user row for local / empty-DB photo pipeline tests (not for production data).
 */
async function insertBootstrapUser() {
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
     ) VALUES ('+91', $1, $2, true, 25, 'Photo flow script', 'onboarding_upload_photos')
     RETURNING id`,
    [phoneNumber, phoneE164]
  );
  return { id: ins.rows[0].id, phoneE164 };
}

async function main() {
  section("Pick test user");
  let users = await query(`SELECT id FROM users ORDER BY created_at DESC NULLS LAST LIMIT 1`);
  if (!users.rows.length) {
    if (process.env.PHOTO_TEST_NO_AUTO_USER === "1") {
      console.error(
        "No users in DB. Complete auth once, or unset PHOTO_TEST_NO_AUTO_USER to allow a dev-only insert."
      );
      process.exit(1);
    }
    console.log("No users found — inserting one dev-only user for this test run.");
    const created = await insertBootstrapUser();
    console.log("Bootstrap user id:", created.id, "phone_e164:", created.phoneE164);
    users = { rows: [{ id: created.id }] };
  }
  const userId = users.rows[0].id;
  console.log("userId:", userId);

  const token = await mintBearerForUser(userId);
  console.log("Minted session + bearer (trunc):", token.slice(0, 24) + "...");

  section("Case A: invalid presign (photoOrder 99)");
  const bad = await fetchJson("/api/v1/users/me/photos/presign", {
    method: "POST",
    token,
    body: { photoOrder: 99 },
  });
  console.log("HTTP", bad.status);
  console.log(JSON.stringify(bad.json, null, 2));

  section("Case B: presign slot 1 → PUT WebP → confirm (with blurHash)");
  const presign = await fetchJson("/api/v1/users/me/photos/presign", {
    method: "POST",
    token,
    body: { photoOrder: 1, blurHash: SAMPLE_BLUR_HASH },
  });
  console.log("presign HTTP", presign.status);
  console.log(JSON.stringify(presign.json, null, 2));
  if (!presign.json.success) {
    console.error("Presign failed; check server logs / AWS / DB migration 012.");
    process.exit(1);
  }
  const { photoId, uploadUrl, contentType } = presign.json.data;

  const webp = await downloadSampleWebp();
  console.log("Downloaded WebP bytes:", webp.length);
  const put = await putToS3(uploadUrl, contentType || "image/webp", webp);
  console.log("S3 PUT HTTP", put.status, put.text ? put.text.slice(0, 120) : "");

  const conf = await fetchJson(`/api/v1/users/me/photos/${photoId}/confirm`, {
    method: "POST",
    token,
    body: {},
  });
  console.log("confirm HTTP", conf.status);
  console.log(JSON.stringify(conf.json, null, 2));

  section("Case C: getMe (APPROVED profilePhotos + stale cleanup runs)");
  const me = await fetchJson("/api/v1/users/me", { token });
  console.log("HTTP", me.status);
  console.log("profilePhotos:", JSON.stringify(me.json?.data?.profilePhotos, null, 2));

  section("Case D: confirm with no S3 PUT (expect 409 S3_OBJECT_MISSING)");
  const orphan = await fetchJson("/api/v1/users/me/photos/presign", {
    method: "POST",
    token,
    body: { photoOrder: 5, blurHash: SAMPLE_BLUR_HASH },
  });
  const pidOrphan = orphan.json?.data?.photoId;
  if (pidOrphan) {
    const confEarly = await fetchJson(`/api/v1/users/me/photos/${pidOrphan}/confirm`, {
      method: "POST",
      token,
      body: {},
    });
    console.log("HTTP", confEarly.status);
    console.log(JSON.stringify(confEarly.json, null, 2));
    if (confEarly.status !== 409 || confEarly.json?.code !== "S3_OBJECT_MISSING") {
      console.error("Case D expected HTTP 409 + code S3_OBJECT_MISSING");
      process.exitCode = 1;
    } else {
      console.log("Case D OK: client must PUT to S3 before confirm.");
    }
  }

  section("Case E: stale PENDING (>1h) removed via expire (slot 6)");
  const p6 = await fetchJson("/api/v1/users/me/photos/presign", {
    method: "POST",
    token,
    body: { photoOrder: 6, blurHash: SAMPLE_BLUR_HASH },
  });
  const pid6 = p6.json?.data?.photoId;
  if (pid6) {
    await query(
      `UPDATE user_photos SET uploaded_at = NOW() - interval '2 hours' WHERE id = $1`,
      [pid6]
    );
    const ex = await photoMaintenance.expireStalePendingPhotosForUser(userId);
    console.log("expireStalePendingPhotosForUser:", ex);
    const check = await query(
      `SELECT id, moderation_status, deleted_at IS NOT NULL AS is_deleted
       FROM user_photos WHERE id = $1`,
      [pid6]
    );
    console.log("Row after expire:", check.rows[0]);
  }

  section("Case F: presign slot 6 again (proves zombie freed the unique slot)");
  const p6b = await fetchJson("/api/v1/users/me/photos/presign", {
    method: "POST",
    token,
    body: { photoOrder: 6, blurHash: SAMPLE_BLUR_HASH },
  });
  console.log("HTTP", p6b.status, p6b.json.success ? "success" : "fail");
  console.log(JSON.stringify(p6b.json, null, 2));

  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
