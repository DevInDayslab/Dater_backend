"use strict";

const s3Media = require("../../services/s3Media.service");

/**
 * Public base URL for crawler-facing OG media (must be fetchable without auth).
 * Prefer PUBLIC_API_BASE / API_PUBLIC_URL, else https://api.dater.social.
 */
function getPublicApiBase() {
  const raw =
    process.env.PUBLIC_API_BASE ||
    process.env.API_PUBLIC_URL ||
    process.env.PUBLIC_WEB_API_BASE ||
    "https://api.dater.social";
  return String(raw).replace(/\/$/, "");
}

function isLandingSeoS3Key(key) {
  const normalized = String(key || "").replace(/^\/+/, "");
  return (
    normalized.startsWith("landing/seo/") &&
    !normalized.includes("..") &&
    !normalized.includes("//") &&
    normalized.length < 512
  );
}

/**
 * Build a publicly fetchable OG image URL that proxies private S3 via Express.
 * @param {string} s3Key
 */
function buildPublicSeoMediaUrl(s3Key) {
  const key = String(s3Key || "").replace(/^\/+/, "");
  if (!isLandingSeoS3Key(key)) {
    throw new Error("Invalid landing SEO media key");
  }
  return `${getPublicApiBase()}/api/v1/landing/seo-media/${key
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

/**
 * If og_image_url points at our private media bucket landing/seo/*, rewrite to public proxy.
 * Leaves external/public URLs unchanged.
 * @param {string | null | undefined} url
 */
function toCrawlerVisibleOgImageUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";

  try {
    const parsed = new URL(raw);
    const host = parsed.hostname;
    const bucketHost = `${s3Media.s3Bucket}.s3.${s3Media.s3Region}.amazonaws.com`;
    const isOurBucket =
      host === bucketHost ||
      host === `${s3Media.s3Bucket}.s3.amazonaws.com` ||
      (host.startsWith("s3.") && parsed.pathname.includes(`/${s3Media.s3Bucket}/`));

    if (!isOurBucket) {
      return raw;
    }

    let key = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    // Path-style: /bucket/key
    if (key.startsWith(`${s3Media.s3Bucket}/`)) {
      key = key.slice(s3Media.s3Bucket.length + 1);
    }
    if (!isLandingSeoS3Key(key)) {
      return raw;
    }
    return buildPublicSeoMediaUrl(key);
  } catch {
    return raw;
  }
}

module.exports = {
  getPublicApiBase,
  isLandingSeoS3Key,
  buildPublicSeoMediaUrl,
  toCrawlerVisibleOgImageUrl,
};
