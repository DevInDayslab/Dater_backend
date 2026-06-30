const { query } = require("../../config/db");
const productConfigService = require("../productConfig.service");
const { durationDaysFromDisplay } = require("../../utils/productFormatting");

async function listProducts() {
  return productConfigService.loadAllProducts();
}

async function updateProducts(updates = []) {
  if (!Array.isArray(updates) || !updates.length) {
    const err = new Error("At least one product update is required");
    err.code = "INVALID_INPUT";
    throw err;
  }

  for (const item of updates) {
    const packCode = String(item.packCode || "").trim();
    if (!packCode) {
      const err = new Error("packCode is required for each update");
      err.code = "INVALID_INPUT";
      throw err;
    }

    const existingRes = await query(
      `SELECT pack_code, category, display_label, plan_code
       FROM product_configurations
       WHERE pack_code = $1`,
      [packCode]
    );
    const existing = existingRes.rows[0];
    if (!existing) {
      const err = new Error(`Unknown product: ${packCode}`);
      err.code = "PRODUCT_NOT_FOUND";
      throw err;
    }

    const pricePaise =
      item.pricePaise != null
        ? Number(item.pricePaise)
        : item.priceRupees != null
          ? Math.round(Number(item.priceRupees) * 100)
          : null;
    if (pricePaise != null && (!Number.isFinite(pricePaise) || pricePaise <= 0)) {
      const err = new Error(`Invalid price for ${packCode}`);
      err.code = "INVALID_PRICE";
      throw err;
    }

    let compareAtPricePaise;
    if (item.compareAtPricePaise !== undefined) {
      compareAtPricePaise =
        item.compareAtPricePaise === null ? null : Number(item.compareAtPricePaise);
    } else if (item.compareAtPriceRupees !== undefined) {
      compareAtPricePaise =
        item.compareAtPriceRupees === null ? null : Math.round(Number(item.compareAtPriceRupees) * 100);
    }
    if (
      compareAtPricePaise != null &&
      (!Number.isFinite(compareAtPricePaise) || compareAtPricePaise <= 0)
    ) {
      const err = new Error(`Invalid compare-at price for ${packCode}`);
      err.code = "INVALID_PRICE";
      throw err;
    }
    if (pricePaise != null && compareAtPricePaise != null && compareAtPricePaise <= pricePaise) {
      const err = new Error(`Compare-at price must be greater than price for ${packCode}`);
      err.code = "INVALID_PRICE";
      throw err;
    }

    const quantity = item.quantity != null ? Number(item.quantity) : null;
    if (quantity != null && (!Number.isFinite(quantity) || quantity <= 0)) {
      const err = new Error(`Invalid quantity for ${packCode}`);
      err.code = "INVALID_QUANTITY";
      throw err;
    }

    const durationDays = item.durationDays != null ? Number(item.durationDays) : null;
    if (durationDays != null && (!Number.isFinite(durationDays) || durationDays <= 0)) {
      const err = new Error(`Invalid duration for ${packCode}`);
      err.code = "INVALID_DURATION";
      throw err;
    }

    const displayTitle =
      item.displayTitle != null ? String(item.displayTitle).trim() : null;
    const displayLabel =
      item.displayLabel != null ? String(item.displayLabel).trim() : null;

    const fields = [];
    const values = [];
    let idx = 1;

    if (pricePaise != null) {
      fields.push(`price_paise = $${idx++}`);
      values.push(pricePaise);
    }
    if (item.compareAtPricePaise !== undefined || item.compareAtPriceRupees !== undefined) {
      fields.push(`compare_at_price_paise = $${idx++}`);
      values.push(compareAtPricePaise ?? null);
    }
    if (displayTitle != null && displayTitle !== "") {
      fields.push(`display_title = $${idx++}`);
      values.push(displayTitle);
    }
    if (displayLabel != null && displayLabel !== "") {
      fields.push(`display_label = $${idx++}`);
      values.push(displayLabel);
    }
    if (quantity != null) {
      fields.push(`quantity = $${idx++}`);
      values.push(quantity);
      if (existing.category !== "PREMIUM") {
        fields.push(`display_title = $${idx++}`);
        values.push(String(quantity));
      }
    }
    if (existing.category === "PREMIUM") {
      const nextTitle = displayTitle ?? null;
      const nextLabel = displayLabel ?? null;
      if (nextTitle != null || nextLabel != null) {
        const currentRes = await query(
          `SELECT display_title, display_label
           FROM product_configurations
           WHERE pack_code = $1`,
          [packCode]
        );
        const current = currentRes.rows[0] || {};
        const resolvedTitle = nextTitle ?? current.display_title;
        const resolvedLabel = nextLabel ?? current.display_label;
        const computedDays = durationDaysFromDisplay(resolvedTitle, resolvedLabel);
        if (computedDays != null) {
          fields.push(`duration_days = $${idx++}`);
          values.push(computedDays);
        }
      } else if (durationDays != null) {
        fields.push(`duration_days = $${idx++}`);
        values.push(durationDays);
      }
    } else if (durationDays != null) {
      fields.push(`duration_days = $${idx++}`);
      values.push(durationDays);
    }
    if (item.badgeType !== undefined) {
      fields.push(`badge_type = $${idx++}`);
      values.push(item.badgeType || null);
    }
    if (item.badgeText !== undefined) {
      fields.push(`badge_text = $${idx++}`);
      values.push(item.badgeText || null);
    }
    if (item.isActive !== undefined) {
      fields.push(`is_active = $${idx++}`);
      values.push(Boolean(item.isActive));
    }
    if (item.googlePlayProductId !== undefined) {
      fields.push(`google_play_product_id = $${idx++}`);
      values.push(item.googlePlayProductId || null);
    }
    if (item.appleProductId !== undefined) {
      fields.push(`apple_product_id = $${idx++}`);
      values.push(item.appleProductId || null);
    }

    if (!fields.length) continue;

    fields.push("updated_at = NOW()");
    values.push(packCode);

    await query(
      `UPDATE product_configurations
       SET ${fields.join(", ")}
       WHERE pack_code = $${idx}`,
      values
    );
  }

  const defaultUpdates = updates.filter((item) => item.isDefault === true);
  for (const item of defaultUpdates) {
    const packCode = String(item.packCode || "").trim();
    const rowRes = await query(
      `SELECT category FROM product_configurations WHERE pack_code = $1`,
      [packCode]
    );
    const category = rowRes.rows[0]?.category;
    if (!category) continue;
    await query(
      `UPDATE product_configurations
       SET is_default = FALSE
       WHERE category = $1`,
      [category]
    );
    await query(
      `UPDATE product_configurations
       SET is_default = TRUE, updated_at = NOW()
       WHERE pack_code = $1`,
      [packCode]
    );
  }

  productConfigService.clearCatalogCache();
  return listProducts();
}

module.exports = {
  listProducts,
  updateProducts,
};
