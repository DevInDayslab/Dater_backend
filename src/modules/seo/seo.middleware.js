"use strict";

const path = require("path");
const fs = require("fs");
const seoService = require("./seo.service");
const { pathToPageSlug } = require("./seo.pages");
const { injectSeoIntoHtml } = require("./seo.inject");

function resolveLandingDistPath() {
  if (process.env.LANDING_DIST_PATH) {
    return path.resolve(process.env.LANDING_DIST_PATH);
  }
  return path.join(__dirname, "../../../public/landing");
}

function resolveIndexHtmlPath() {
  const distPath = resolveLandingDistPath();
  return path.join(distPath, "index.html");
}

/**
 * Serve Vite landing index.html with SEO meta for the requested path's page_slug.
 */
async function serveLandingWithDynamicSeo(req, res, next) {
  try {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return next();
    }

    const indexPath = resolveIndexHtmlPath();
    if (!fs.existsSync(indexPath)) {
      return res.status(503).json({
        success: false,
        message:
          "Landing page build not found. Build DaterLanding and copy dist to LANDING_DIST_PATH (default: backend/public/landing).",
      });
    }

    const pageSlug = pathToPageSlug(req.path || "/");
    const rawHtml = fs.readFileSync(indexPath, "utf8");
    const seo = await seoService.getSeoBySlug(pageSlug);
    const html = injectSeoIntoHtml(rawHtml, seo);

    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Landing-Seo-Slug", pageSlug);
    return res.status(200).type("html").send(html);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  serveLandingWithDynamicSeo,
  resolveLandingDistPath,
  resolveIndexHtmlPath,
};
