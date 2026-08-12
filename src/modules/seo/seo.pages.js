"use strict";

/**
 * Canonical SEO page catalog for DaterLanding routes.
 * page_slug is the DB key; path is the public URL path.
 */
const LANDING_SEO_PAGES = [
  { page_slug: "home", path: "/", label: "Home" },
  { page_slug: "about", path: "/about", label: "About" },
  { page_slug: "contact-us", path: "/contact-us", label: "Contact Us" },
  { page_slug: "faq", path: "/faq", label: "FAQs" },
  { page_slug: "privacy-policy", path: "/privacy-policy", label: "Privacy Policy" },
  { page_slug: "terms", path: "/terms", label: "Terms of Service" },
  { page_slug: "community-guidelines", path: "/community-guidelines", label: "Community Guidelines" },
  { page_slug: "cookie-policy", path: "/cookie-policy", label: "Cookie Policy" },
  { page_slug: "download", path: "/download", label: "Download" },
];

/** Alias paths that redirect in the SPA — still resolve SEO for direct hits. */
const PATH_ALIASES = {
  "/contact": "contact-us",
  "/faqs": "faq",
  "/privacy": "privacy-policy",
  "/cookies": "cookie-policy",
};

const SLUG_SET = new Set(LANDING_SEO_PAGES.map((p) => p.page_slug));

/**
 * Normalize request path and map to page_slug.
 * @param {string} rawPath
 * @returns {string}
 */
function pathToPageSlug(rawPath) {
  let pathname = String(rawPath || "/").split("?")[0].split("#")[0];
  if (!pathname.startsWith("/")) {
    pathname = `/${pathname}`;
  }
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }

  if (pathname === "/" || pathname === "") {
    return "home";
  }

  if (PATH_ALIASES[pathname]) {
    return PATH_ALIASES[pathname];
  }

  const withoutSlash = pathname.replace(/^\//, "");
  if (SLUG_SET.has(withoutSlash)) {
    return withoutSlash;
  }

  // Unknown SPA paths fall back to home metadata.
  return "home";
}

function isKnownPageSlug(slug) {
  return SLUG_SET.has(String(slug || ""));
}

module.exports = {
  LANDING_SEO_PAGES,
  PATH_ALIASES,
  pathToPageSlug,
  isKnownPageSlug,
};
