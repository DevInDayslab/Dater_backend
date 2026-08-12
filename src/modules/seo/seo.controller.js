"use strict";

const seoService = require("./seo.service");

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

async function getSeoHandler(req, res) {
  try {
    const data = await seoService.getSeo();
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
    const body = req.body || {};
    const { meta_title, meta_description, is_indexed } = body;

    if (!isNonEmptyString(meta_title, 255)) {
      return res.status(400).json({
        success: false,
        message: "meta_title is required (max 255 characters)",
      });
    }

    if (typeof meta_description !== "string" || !meta_description.trim()) {
      return res.status(400).json({
        success: false,
        message: "meta_description is required",
      });
    }

    if (typeof is_indexed !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "is_indexed must be a boolean",
      });
    }

    const og_image_url = normalizeOptionalUrl(body.og_image_url);
    const canonical_url = normalizeOptionalUrl(body.canonical_url);
    if (og_image_url === undefined || canonical_url === undefined) {
      return res.status(400).json({
        success: false,
        message: "og_image_url and canonical_url must be strings or null",
      });
    }

    const data = await seoService.updateSeo({
      meta_title: meta_title.trim(),
      meta_description: meta_description.trim(),
      og_image_url,
      canonical_url,
      is_indexed,
    });

    return res.status(200).json({
      success: true,
      message: "Landing SEO updated",
      data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to update landing SEO",
      error: error.message,
    });
  }
}

module.exports = {
  getSeoHandler,
  updateSeoHandler,
};
