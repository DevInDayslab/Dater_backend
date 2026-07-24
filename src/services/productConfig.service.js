const { query } = require("../config/db");
const { mapProductRow } = require("../utils/productFormatting");

let catalogCache = null;
let catalogCacheAt = 0;
const CACHE_TTL_MS = 60_000;

async function loadActiveProducts() {
  const res = await query(
    `SELECT pack_code, category, quantity, duration_days, plan_code,
            display_title, display_label, price_paise, compare_at_price_paise, currency,
            badge_type, badge_text, is_default, is_active, sort_order,
            google_play_product_id, google_play_base_plan_id, apple_product_id
     FROM product_configurations
     WHERE is_active = TRUE
     ORDER BY category ASC, sort_order ASC`
  );
  return res.rows.map(mapProductRow);
}

async function loadAllProducts() {
  const res = await query(
    `SELECT pack_code, category, quantity, duration_days, plan_code,
            display_title, display_label, price_paise, compare_at_price_paise, currency,
            badge_type, badge_text, is_default, is_active, sort_order,
            google_play_product_id, google_play_base_plan_id, apple_product_id, updated_at
     FROM product_configurations
     ORDER BY category ASC, sort_order ASC`
  );
  return res.rows.map((row) => ({
    ...mapProductRow(row),
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  }));
}

async function getActiveCatalog({ bypassCache = false } = {}) {
  const now = Date.now();
  if (!bypassCache && catalogCache && now - catalogCacheAt < CACHE_TTL_MS) {
    return catalogCache;
  }
  const products = await loadActiveProducts();
  const grouped = {
    premium: products.filter((p) => p.category === "PREMIUM"),
    boost: products.filter((p) => p.category === "BOOST"),
    comments: products.filter((p) => p.category === "COMMENTS"),
    chat: products.filter((p) => p.category === "CHAT"),
  };
  catalogCache = grouped;
  catalogCacheAt = now;
  return grouped;
}

function clearCatalogCache() {
  catalogCache = null;
  catalogCacheAt = 0;
}

async function getProductByPackCode(packCode, { activeOnly = true } = {}) {
  const normalized = String(packCode || "").trim();
  if (!normalized) return null;
  const catalog = await getActiveCatalog();
  const all = [...catalog.premium, ...catalog.boost, ...catalog.comments, ...catalog.chat];
  const found = all.find((p) => p.packCode === normalized);
  if (found) return found;
  if (!activeOnly) {
    const rows = await loadAllProducts();
    return rows.find((p) => p.packCode === normalized) || null;
  }
  return null;
}

async function getProductByPlanCode(planCode) {
  const normalized = String(planCode || "").trim().toUpperCase();
  if (!normalized) return null;
  const catalog = await getActiveCatalog();
  return catalog.premium.find((p) => String(p.planCode || "").toUpperCase() === normalized) || null;
}

async function getProductByPackSize(category, packSize) {
  const size = Number(packSize);
  if (!Number.isFinite(size)) return null;
  const catalog = await getActiveCatalog();
  const bucket =
    category === "BOOST"
      ? catalog.boost
      : category === "COMMENTS"
        ? catalog.comments
        : category === "CHAT"
          ? catalog.chat
          : [];
  return bucket.find((p) => p.quantity === size) || null;
}

function minTeaserPrice(products) {
  if (!products.length) return null;
  const min = products.reduce((acc, p) => (p.pricePaise < acc.pricePaise ? p : acc));
  return min.teaserFromLabel;
}

function minPremiumUpgradeLabel(products) {
  if (!products.length) return null;
  const min = products.reduce((acc, p) => (p.pricePaise < acc.pricePaise ? p : acc));
  return min.upgradeFromLabel;
}

async function getPublicProductsPayload() {
  const catalog = await getActiveCatalog();
  return {
    ...catalog,
    teasers: {
      premiumFrom: minTeaserPrice(catalog.premium),
      premiumUpgradeFrom: minPremiumUpgradeLabel(catalog.premium),
      boostFrom: minTeaserPrice(catalog.boost),
      commentsFrom: minTeaserPrice(catalog.comments),
      chatUnlockFrom: minTeaserPrice(catalog.chat),
    },
  };
}

async function getProductByGooglePlayProductId(googlePlayProductId, { basePlanId } = {}) {
  const normalized = String(googlePlayProductId || "").trim();
  if (!normalized) return null;
  const catalog = await getActiveCatalog();
  const all = [...catalog.premium, ...catalog.boost, ...catalog.comments, ...catalog.chat];
  const matches = all.filter((p) => p.googlePlayProductId === normalized);
  if (!matches.length) return null;
  if (basePlanId) {
    const planMatch = matches.find(
      (p) => String(p.googlePlayBasePlanId || "").toLowerCase() === String(basePlanId).toLowerCase()
    );
    if (planMatch) return planMatch;
  }
  return matches[0];
}

async function getProductByAppleProductId(appleProductId) {
  const normalized = String(appleProductId || "").trim();
  if (!normalized) return null;
  const catalog = await getActiveCatalog();
  const all = [...catalog.premium, ...catalog.boost, ...catalog.comments, ...catalog.chat];
  return all.find((p) => p.appleProductId === normalized) || null;
}

function toAppleCatalogItem(product) {
  return {
    packCode: product.packCode,
    category: product.category,
    quantity: product.quantity,
    durationDays: product.durationDays,
    planCode: product.planCode,
    displayTitle: product.displayTitle,
    displayLabel: product.displayLabel,
    badgeType: product.badgeType,
    badgeText: product.badgeText,
    isDefault: product.isDefault,
    sortOrder: product.sortOrder,
    appleProductId: product.appleProductId,
    buttonLabel: product.buttonLabel,
  };
}

async function getAppleCatalogPayload() {
  const catalog = await getActiveCatalog();
  const mapItems = (items) => items.filter((p) => p.appleProductId).map(toAppleCatalogItem);
  return {
    premium: mapItems(catalog.premium),
    boost: mapItems(catalog.boost),
    comments: mapItems(catalog.comments),
    chat: mapItems(catalog.chat),
  };
}

module.exports = {
  getActiveCatalog,
  getPublicProductsPayload,
  getAppleCatalogPayload,
  getProductByPackCode,
  getProductByPlanCode,
  getProductByPackSize,
  getProductByGooglePlayProductId,
  getProductByAppleProductId,
  loadAllProducts,
  clearCatalogCache,
};
