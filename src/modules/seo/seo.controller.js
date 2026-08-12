"use strict";

const seoService = require("./seo.service");
const { isKnownPageSlug, LANDING_SEO_PAGES } = require("./seo.pages");

function isNonEmptyString(value, maxLen) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLen;
}

function normalizeOptionalUrl(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function parseUpdateBody(body) {
  const { meta_title, meta_description, is_indexed } = body || {};

  if (!isNonEmptyString(meta_title, 255)) {
    return { error: "meta_title is required (max 255 characters)" };
  }

  if (typeof meta_description !== "string" || !meta_description.trim()) {
    return { error: "meta_description is required" };
  }

  if (typeof is_indexed !== "boolean") {
    return { error: "is_indexed must be a boolean" };
  }

  const og_image_url = normalizeOptionalUrl(body.og_image_url);
  const canonical_url = normalizeOptionalUrl(body.canonical_url);
  if (og_image_url === undefined || canonical_url === undefined) {
    return { error: "og_image_url and canonical_url must be strings or null" };
  }

  return {
    data: {
      meta_title: meta_title.trim(),
      meta_description: meta_description.trim(),
      og_image_url,
      canonical_url,
      is_indexed,
    },
  };
}

async function listSeoHandler(req, res) {
  try {
    const rows = await seoService.listSeo();
    return res.status(200).json({
      success: true,
      message: "Landing SEO pages fetched",
      data: {
        pages: LANDING_SEO_PAGES,
        items: rows,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch landing SEO pages",
      error: error.message,
    });
  }
}

async function getSeoHandler(req, res) {
  try {
    const slug = req.params.slug || req.query.slug || seoService.HOME_SLUG;
    if (req.params.slug && !isKnownPageSlug(req.params.slug)) {
      return res.status(404).json({
        success: false,
        message: `Unknown page_slug: ${req.params.slug}`,
      });
    }

    const data = await seoService.getSeoBySlug(slug);
    return res.status(200).json({
      success: true,
      message: "Landing SEO fetched",
      data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch landing SEO",
      error: error.message,
    });
  }
}

async function updateSeoHandler(req, res) {
  try {
    const slug = req.params.slug || req.body?.page_slug || seoService.HOME_SLUG;
    if (!isKnownPageSlug(slug)) {
      return res.status(404).json({
        success: false,
        message: `Unknown page_slug: ${slug}`,
      });
    }

    const parsed = parseUpdateBody(req.body);
    if (parsed.error) {
      return res.status(400).json({
        success: false,
        message: parsed.error,
      });
    }

    const data = await seoService.updateSeoBySlug(slug, parsed.data);
    return res.status(200).json({
      success: true,
      message: "Landing SEO updated",
      data,
    });
  } catch (error) {
    const status = error.code === "NOT_FOUND" || error.code === "UNKNOWN_SLUG" ? 404 : 500;
    return res.status(status).json({
      success: false,
      message: "Failed to update landing SEO",
      error: error.message,
    });
  }
}

module.exports = {
  listSeoHandler,
  getSeoHandler,
  updateSeoHandler,
};
