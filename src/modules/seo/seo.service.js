"use strict";

const { query } = require("../../config/db");

const HOME_SLUG = "home";

/** @type {object | null} */
let cachedSeo = null;

/**
 * @returns {Promise<{
 *   id: number,
 *   page_slug: string,
 *   meta_title: string,
 *   meta_description: string,
 *   og_image_url: string | null,
 *   canonical_url: string | null,
 *   is_indexed: boolean,
 *   updated_at: string
 * }>}
 */
async function getSeo() {
  if (cachedSeo) {
    return cachedSeo;
  }

  const result = await query(
    `SELECT id, page_slug, meta_title, meta_description, og_image_url, canonical_url, is_indexed, updated_at
     FROM landing_page_seo
     WHERE page_slug = $1
     LIMIT 1`,
    [HOME_SLUG]
  );

  if (!result.rows[0]) {
    throw new Error("Landing page SEO row not found. Run migrations.");
  }

  cachedSeo = result.rows[0];
  return cachedSeo;
}

/**
 * @param {{
 *   meta_title: string,
 *   meta_description: string,
 *   og_image_url?: string | null,
 *   canonical_url?: string | null,
 *   is_indexed: boolean
 * }} data
 */
async function updateSeo(data) {
  const result = await query(
    `UPDATE landing_page_seo
     SET meta_title = $1,
         meta_description = $2,
         og_image_url = $3,
         canonical_url = $4,
         is_indexed = $5,
         updated_at = NOW()
     WHERE page_slug = $6
     RETURNING id, page_slug, meta_title, meta_description, og_image_url, canonical_url, is_indexed, updated_at`,
    [
      data.meta_title,
      data.meta_description,
      data.og_image_url ?? null,
      data.canonical_url ?? null,
      data.is_indexed,
      HOME_SLUG,
    ]
  );

  if (!result.rows[0]) {
    throw new Error("Landing page SEO row not found. Run migrations.");
  }

  cachedSeo = null;
  return result.rows[0];
}

function clearSeoCache() {
  cachedSeo = null;
}

module.exports = {
  getSeo,
  updateSeo,
  clearSeoCache,
  HOME_SLUG,
};
