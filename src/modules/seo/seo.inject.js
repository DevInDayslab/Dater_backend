"use strict";

/**
 * Escape text for HTML attribute/text content.
 * @param {unknown} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * @param {string} key
 */
function escapeRegex(key) {
  return String(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Upsert a <meta name="..."> or <meta property="..."> tag.
 * @param {string} html
 * @param {"name" | "property"} attr
 * @param {string} key
 * @param {string} content
 */
function upsertMeta(html, attr, key, content) {
  const tag = `<meta ${attr}="${escapeHtml(key)}" content="${escapeHtml(content)}" />`;
  const re = new RegExp(
    `<meta\\s+[^>]*${attr}\\s*=\\s*["']${escapeRegex(key)}["'][^>]*>`,
    "i"
  );

  if (re.test(html)) {
    return html.replace(re, tag);
  }

  return html.replace(/<\/head>/i, `  ${tag}\n</head>`);
}

/**
 * Upsert <link rel="canonical" href="..."> or remove if href is empty.
 * @param {string} html
 * @param {string | null | undefined} href
 */
function upsertCanonical(html, href) {
  const re = /<link\s+[^>]*rel\s*=\s*["']canonical["'][^>]*>/i;
  if (!href) {
    return html.replace(re, "");
  }
  const tag = `<link rel="canonical" href="${escapeHtml(href)}" />`;
  if (re.test(html)) {
    return html.replace(re, tag);
  }
  return html.replace(/<\/head>/i, `  ${tag}\n</head>`);
}

/**
 * Replace <title>...</title>.
 * @param {string} html
 * @param {string} title
 */
function upsertTitle(html, title) {
  const tag = `<title>${escapeHtml(title)}</title>`;
  if (/<title>[\s\S]*?<\/title>/i.test(html)) {
    return html.replace(/<title>[\s\S]*?<\/title>/i, tag);
  }
  return html.replace(/<\/head>/i, `  ${tag}\n</head>`);
}

/**
 * Inject SEO tags into a Vite-built index.html string.
 * @param {string} html
 * @param {{
 *   meta_title: string,
 *   meta_description: string,
 *   og_image_url?: string | null,
 *   canonical_url?: string | null,
 *   is_indexed: boolean
 * }} seo
 * @returns {string}
 */
function injectSeoIntoHtml(html, seo) {
  const title = seo.meta_title || "DATER";
  const description = seo.meta_description || "";
  const robots = seo.is_indexed ? "index, follow" : "noindex, nofollow";
  const ogImage = seo.og_image_url || "";
  const canonical = seo.canonical_url || "";

  let out = html;
  out = upsertTitle(out, title);
  out = upsertMeta(out, "name", "description", description);
  out = upsertMeta(out, "name", "robots", robots);
  out = upsertCanonical(out, canonical || null);

  out = upsertMeta(out, "property", "og:type", "website");
  out = upsertMeta(out, "property", "og:title", title);
  out = upsertMeta(out, "property", "og:description", description);
  if (canonical) {
    out = upsertMeta(out, "property", "og:url", canonical);
  }
  if (ogImage) {
    out = upsertMeta(out, "property", "og:image", ogImage);
  }

  out = upsertMeta(out, "name", "twitter:card", "summary_large_image");
  out = upsertMeta(out, "name", "twitter:title", title);
  out = upsertMeta(out, "name", "twitter:description", description);
  if (ogImage) {
    out = upsertMeta(out, "name", "twitter:image", ogImage);
  }

  return out;
}

module.exports = {
  injectSeoIntoHtml,
  escapeHtml,
  upsertMeta,
  upsertTitle,
  upsertCanonical,
};
