const { query } = require("../config/db");
const s3Media = require("./s3Media.service");

const CACHE_TTL_MS = 60_000;
const SPLASH_KEY_PREFIX = "platform/";

let publicConfigCache = null;
let publicConfigCacheAt = 0;

const ALLOWED_SPLASH_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

async function loadPlatformConfigRow() {
  const res = await query(
    `SELECT splash_background_s3_key, updated_at
     FROM platform_config
     WHERE id = 1`
  );
  return res.rows[0] || null;
}

function toIsoTimestamp(value) {
  if (!value) return null;
  return new Date(value).toISOString();
}

async function buildSplashBackgroundPayload(s3Key, updatedAt) {
  if (!s3Key) return null;
  const imageUrl = await s3Media.getPresignedGetUrl({ key: s3Key, expiresInSeconds: 3600 });
  return {
    version: toIsoTimestamp(updatedAt),
    imageUrl,
  };
}

function clearPublicConfigCache() {
  publicConfigCache = null;
  publicConfigCacheAt = 0;
}

async function getPublicAppConfig({ bypassCache = false } = {}) {
  const now = Date.now();
  if (!bypassCache && publicConfigCache && now - publicConfigCacheAt < CACHE_TTL_MS) {
    return publicConfigCache;
  }

  const row = await loadPlatformConfigRow();
  const splashBackground = row?.splash_background_s3_key
    ? await buildSplashBackgroundPayload(row.splash_background_s3_key, row.updated_at)
    : null;

  const payload = { splashBackground };
  publicConfigCache = payload;
  publicConfigCacheAt = now;
  return payload;
}

async function getAdminAppConfig() {
  const row = await loadPlatformConfigRow();
  const splashBackgroundS3Key = row?.splash_background_s3_key || null;
  const updatedAt = toIsoTimestamp(row?.updated_at);
  const splashImageUrl = splashBackgroundS3Key
    ? await s3Media.getPresignedGetUrl({ key: splashBackgroundS3Key, expiresInSeconds: 3600 })
    : null;

  return {
    splashBackgroundS3Key,
    splashImageUrl,
    updatedAt,
  };
}

function assertValidSplashS3Key(s3Key) {
  const normalized = String(s3Key || "").trim();
  if (!normalized) {
    const err = new Error("splashBackgroundS3Key is required");
    err.code = "INVALID_INPUT";
    throw err;
  }
  if (!normalized.startsWith(SPLASH_KEY_PREFIX)) {
    const err = new Error("splashBackgroundS3Key must use the platform/ prefix");
    err.code = "INVALID_INPUT";
    throw err;
  }
  if (normalized.includes("..")) {
    const err = new Error("Invalid splashBackgroundS3Key");
    err.code = "INVALID_INPUT";
    throw err;
  }
  return normalized;
}

function assertAllowedSplashContentType(contentType) {
  const normalized = String(contentType || "").trim().toLowerCase();
  if (!ALLOWED_SPLASH_CONTENT_TYPES.has(normalized)) {
    const err = new Error("contentType must be image/jpeg, image/png, or image/webp");
    err.code = "INVALID_INPUT";
    throw err;
  }
  return normalized;
}

async function presignSplashUpload(contentType) {
  const normalizedContentType = assertAllowedSplashContentType(contentType);
  const key = s3Media.buildPlatformSplashObjectKey();
  const presign = await s3Media.getPresignedPutUrl({
    key,
    contentType: normalizedContentType,
  });
  return {
    uploadUrl: presign.uploadUrl,
    s3Key: presign.key,
    publicUrl: presign.publicUrl,
    contentType: normalizedContentType,
  };
}

async function updateSplashBackground(s3Key) {
  const normalizedKey = assertValidSplashS3Key(s3Key);
  const expectedKey = s3Media.buildPlatformSplashObjectKey();
  if (normalizedKey !== expectedKey) {
    const err = new Error(`splashBackgroundS3Key must be ${expectedKey}`);
    err.code = "INVALID_INPUT";
    throw err;
  }

  const res = await query(
    `UPDATE platform_config
     SET splash_background_s3_key = $1,
         updated_at = NOW()
     WHERE id = 1
     RETURNING splash_background_s3_key, updated_at`,
    [normalizedKey]
  );
  const row = res.rows[0];
  clearPublicConfigCache();

  return {
    splashBackgroundS3Key: row.splash_background_s3_key,
    updatedAt: toIsoTimestamp(row.updated_at),
    splashImageUrl: await s3Media.getPresignedGetUrl({
      key: row.splash_background_s3_key,
      expiresInSeconds: 3600,
    }),
  };
}

async function clearSplashBackground() {
  const res = await query(
    `UPDATE platform_config
     SET splash_background_s3_key = NULL,
         updated_at = NOW()
     WHERE id = 1
     RETURNING splash_background_s3_key, updated_at`
  );
  const row = res.rows[0];
  clearPublicConfigCache();
  return {
    splashBackgroundS3Key: row.splash_background_s3_key,
    updatedAt: toIsoTimestamp(row.updated_at),
    splashImageUrl: null,
  };
}

module.exports = {
  getPublicAppConfig,
  getAdminAppConfig,
  presignSplashUpload,
  updateSplashBackground,
  clearSplashBackground,
  clearPublicConfigCache,
};
