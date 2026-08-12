"use strict";

const { query } = require("../../config/db");
const s3Media = require("../../services/s3Media.service");
const { isKnownPageSlug } = require("./seo.pages");
const publicMedia = require("./seo.publicUrl");

const HOME_SLUG = "home";
const ALLOWED_OG_CONTENT_TYPES = new Set(["image/webp", "image/jpeg", "image/png"]);

/** @type {Map<string, object>} */
const seoCache = new Map();

const SELECT_COLS =
  "id, page_slug, meta_title, meta_description, og_image_url, canonical_url, is_indexed, updated_at";

/**
 * @param {string} [pageSlug]
 */
async function getSeoBySlug(pageSlug = HOME_SLUG) {
  const slug = String(pageSlug || HOME_SLUG);

  if (seoCache.has(slug)) {
    return seoCache.get(slug);
  }

  const result = await query(
    `SELECT ${SELECT_COLS}
     FROM landing_page_seo
     WHERE page_slug = $1
     LIMIT 1`,
    [slug]
  );

  if (!result.rows[0]) {
    if (slug !== HOME_SLUG) {
      return getSeoBySlug(HOME_SLUG);
    }
    throw new Error("Landing page SEO row not found. Run migrations.");
  }

  seoCache.set(slug, result.rows[0]);
  return result.rows[0];
}

/** @deprecated Prefer getSeoBySlug — kept for home-page callers. */
async function getSeo() {
  return getSeoBySlug(HOME_SLUG);
}

async function listSeo() {
  const result = await query(
    `SELECT ${SELECT_COLS}
     FROM landing_page_seo
     ORDER BY
       CASE page_slug
         WHEN 'home' THEN 0
         WHEN 'about' THEN 1
         WHEN 'contact-us' THEN 2
         WHEN 'faq' THEN 3
         WHEN 'privacy-policy' THEN 4
         WHEN 'terms' THEN 5
         WHEN 'community-guidelines' THEN 6
         WHEN 'cookie-policy' THEN 7
         WHEN 'download' THEN 8
         ELSE 99
       END,
       page_slug ASC`
  );
  return result.rows;
}

/**
 * @param {string} pageSlug
 * @param {{
 *   meta_title: string,
 *   meta_description: string,
 *   og_image_url?: string | null,
 *   canonical_url?: string | null,
 *   is_indexed: boolean
 * }} data
 */
async function updateSeoBySlug(pageSlug, data) {
  const slug = String(pageSlug || "");
  if (!isKnownPageSlug(slug)) {
    const err = new Error(`Unknown page_slug: ${slug}`);
    err.code = "UNKNOWN_SLUG";
    throw err;
  }

  const result = await query(
    `UPDATE landing_page_seo
     SET meta_title = $1,
         meta_description = $2,
         og_image_url = $3,
         canonical_url = $4,
         is_indexed = $5,
         updated_at = NOW()
     WHERE page_slug = $6
     RETURNING ${SELECT_COLS}`,
    [
      data.meta_title,
      data.meta_description,
      data.og_image_url ?? null,
      data.canonical_url ?? null,
      data.is_indexed,
      slug,
    ]
  );

  if (!result.rows[0]) {
    const err = new Error(`Landing page SEO row not found for slug: ${slug}. Run migrations.`);
    err.code = "NOT_FOUND";
    throw err;
  }

  seoCache.delete(slug);
  return result.rows[0];
}

/** @deprecated Prefer updateSeoBySlug */
async function updateSeo(data) {
  return updateSeoBySlug(HOME_SLUG, data);
}

/**
 * Presign a PUT for an optimized OG image (prefer image/webp from the admin client).
 * @param {string} pageSlug
 * @param {string} contentType
 */
async function presignOgImageUpload(pageSlug, contentType) {
  const slug = String(pageSlug || "");
  if (!isKnownPageSlug(slug)) {
    const err = new Error(`Unknown page_slug: ${slug}`);
    err.code = "UNKNOWN_SLUG";
    throw err;
  }

  const normalized = String(contentType || "")
    .trim()
    .toLowerCase()
    .split(";")[0];
  if (!ALLOWED_OG_CONTENT_TYPES.has(normalized)) {
    const err = new Error("contentType must be image/webp, image/jpeg, or image/png");
    err.code = "INVALID_INPUT";
    throw err;
  }

  const key = s3Media.buildLandingOgObjectKey(slug, s3Media.newPhotoId());
  const presign = await s3Media.getPresignedPutUrl({
    key,
    contentType: normalized,
  });
  const readUrl = await s3Media.getPresignedGetUrl({
    key,
    expiresInSeconds: 60 * 60 * 24,
  });

  return {
    uploadUrl: presign.uploadUrl,
    s3Key: presign.key,
    publicUrl: publicMedia.buildPublicSeoMediaUrl(presign.key),
    s3ObjectUrl: presign.publicUrl,
    readUrl,
    contentType: normalized,
  };
}

function clearSeoCache() {
  seoCache.clear();
}

module.exports = {
  getSeo,
  getSeoBySlug,
  listSeo,
  updateSeo,
  updateSeoBySlug,
  presignOgImageUpload,
  clearSeoCache,
  HOME_SLUG,
};
