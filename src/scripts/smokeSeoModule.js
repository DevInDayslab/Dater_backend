"use strict";

/**
 * Offline smoke tests for SEO module (no database required).
 */
require("dotenv").config();
if (!process.env.DATABASE_URL) {
  // seo.service pulls db config at require-time; smoke stubs DB usage.
  process.env.DATABASE_URL = "postgres://smoke:smoke@127.0.0.1:5432/smoke";
}

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");

const { injectSeoIntoHtml } = require("../modules/seo/seo.inject");
const { pathToPageSlug } = require("../modules/seo/seo.pages");
const seoService = require("../modules/seo/seo.service");
const {
  serveLandingWithDynamicSeo,
  resolveLandingDistPath,
} = require("../modules/seo/seo.middleware");

async function testInject() {
  const html = "<!doctype html><html><head><title>OLD</title></head><body></body></html>";
  const out = injectSeoIntoHtml(html, {
    meta_title: "DATER SEO",
    meta_description: "Hello",
    og_image_url: "https://cdn.example/og.png",
    canonical_url: "https://dater.social/",
    is_indexed: true,
  });
  assert.ok(out.includes("<title>DATER SEO</title>"));
  assert.ok(out.includes('content="index, follow"'));
  assert.ok(out.includes("og:title"));
  assert.ok(out.includes("og:site_name"));
  assert.ok(out.includes("twitter:image"));
  console.log("ok inject");
}

async function testPrivateS3OgRewrite() {
  const { toCrawlerVisibleOgImageUrl } = require("../modules/seo/seo.publicUrl");
  const s3Media = require("../services/s3Media.service");
  const key = "landing/seo/home/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.webp";
  const privateUrl = `https://${s3Media.s3Bucket}.s3.${s3Media.s3Region}.amazonaws.com/${key}`;
  const rewritten = toCrawlerVisibleOgImageUrl(privateUrl);
  assert.ok(rewritten.includes("/api/v1/landing/seo-media/landing/seo/home/"));
  assert.ok(!rewritten.includes("amazonaws.com"));

  const html = injectSeoIntoHtml("<html><head><title>x</title></head></html>", {
    meta_title: "T",
    meta_description: "D",
    og_image_url: privateUrl,
    canonical_url: "https://dater.social/",
    is_indexed: true,
  });
  assert.ok(html.includes("/api/v1/landing/seo-media/"));
  assert.ok(!html.includes("amazonaws.com"));
  console.log("ok private_s3_og_rewrite");
}

async function testPathMapping() {
  assert.equal(pathToPageSlug("/"), "home");
  assert.equal(pathToPageSlug("/about"), "about");
  assert.equal(pathToPageSlug("/about/"), "about");
  assert.equal(pathToPageSlug("/contact"), "contact-us");
  assert.equal(pathToPageSlug("/faqs"), "faq");
  assert.equal(pathToPageSlug("/privacy"), "privacy-policy");
  assert.equal(pathToPageSlug("/cookies"), "cookie-policy");
  assert.equal(pathToPageSlug("/download"), "download");
  assert.equal(pathToPageSlug("/unknown-route"), "home");
  console.log("ok path_mapping");
}

async function testMiddlewareWithStub() {
  const originalGetSeoBySlug = seoService.getSeoBySlug;
  seoService.getSeoBySlug = async (slug) => {
    if (slug === "about") {
      return {
        id: 2,
        page_slug: "about",
        meta_title: "About Stub",
        meta_description: "About Description",
        og_image_url: "https://cdn.example/about.png",
        canonical_url: "https://dater.social/about",
        is_indexed: true,
        updated_at: new Date().toISOString(),
      };
    }
    return {
      id: 1,
      page_slug: "home",
      meta_title: "Stub Title",
      meta_description: "Stub Description",
      og_image_url: "https://cdn.example/stub.png",
      canonical_url: "https://dater.social/",
      is_indexed: false,
      updated_at: new Date().toISOString(),
    };
  };

  const landingPath = resolveLandingDistPath();
  assert.ok(fs.existsSync(path.join(landingPath, "index.html")), "placeholder index.html missing");

  const app = express();
  app.get(["/", "/about", "/contact"], serveLandingWithDynamicSeo);
  app.use((err, req, res, _next) => {
    res.status(500).send(String(err && err.stack ? err.stack : err));
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const home = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { "user-agent": "facebookexternalhit/1.1" },
    });
    const homeBody = await home.text();
    assert.equal(home.status, 200);
    assert.ok(homeBody.includes("<title>Stub Title</title>"));
    assert.ok(homeBody.includes("noindex, nofollow"));
    assert.equal(home.headers.get("x-landing-seo-slug"), "home");

    const about = await fetch(`http://127.0.0.1:${port}/about`, {
      headers: { "user-agent": "facebookexternalhit/1.1" },
    });
    const aboutBody = await about.text();
    assert.equal(about.status, 200);
    assert.ok(aboutBody.includes("<title>About Stub</title>"));
    assert.ok(aboutBody.includes("About Description"));
    assert.equal(about.headers.get("x-landing-seo-slug"), "about");

    const contactAlias = await fetch(`http://127.0.0.1:${port}/contact`);
    assert.equal(contactAlias.headers.get("x-landing-seo-slug"), "contact-us");

    console.log("ok middleware_multipage_injection");
  } finally {
    seoService.getSeoBySlug = originalGetSeoBySlug;
    await new Promise((resolve) => server.close(resolve));
  }
}

async function testAdminRouterMount() {
  const seoRoutes = require("../modules/seo/seo.routes");
  assert.ok(seoRoutes);
  const seoController = require("../modules/seo/seo.controller");
  assert.equal(typeof seoController.listSeoHandler, "function");
  assert.equal(typeof seoController.getSeoHandler, "function");
  assert.equal(typeof seoController.updateSeoHandler, "function");
  console.log("ok routes_load");
}

async function main() {
  await testInject();
  await testPrivateS3OgRewrite();
  await testPathMapping();
  await testMiddlewareWithStub();
  await testAdminRouterMount();
  console.log("all_seo_smoke_ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
