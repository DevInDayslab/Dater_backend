function formatInrPaise(paise, { spaced = false } = {}) {
  const rupees = Math.round(Number(paise) / 100);
  const formatted = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(rupees);
  return spaced ? `₹ ${formatted}` : `₹${formatted}`;
}

function compactInrPaise(paise) {
  const rupees = Math.round(Number(paise) / 100);
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(rupees);
}

function buildPremiumButtonLabel(planCode, pricePaise) {
  const price = compactInrPaise(pricePaise);
  const normalized = String(planCode || "").toUpperCase();
  if (normalized === "WEEK") return `Get 1 week for ₹${price}`;
  if (normalized === "MONTH") return `Get 1 month for ₹${price}`;
  if (normalized === "THREE_MONTHS") return `Get 3 months for ₹${price}`;
  return `Get premium for ₹${price}`;
}

function buildPackButtonLabel(quantity, label, pricePaise) {
  const price = compactInrPaise(pricePaise);
  const unit = String(label || "").trim();
  const qty = Number(quantity);
  if (unit.toLowerCase() === "boosts" || unit.toLowerCase() === "boost") {
    return `Get ${qty} boost for ₹${price}`;
  }
  return `Get ${qty} ${unit.toLowerCase()} for ₹${price}`;
}

function mapProductRow(row) {
  const category = row.category;
  const pricePaise = Number(row.price_paise);
  const priceLabel =
    category === "PREMIUM"
      ? formatInrPaise(pricePaise, { spaced: true })
      : formatInrPaise(pricePaise);
  const buttonLabel =
    category === "PREMIUM"
      ? buildPremiumButtonLabel(row.plan_code, pricePaise)
      : buildPackButtonLabel(row.quantity, row.display_label, pricePaise);

  return {
    packCode: row.pack_code,
    category,
    quantity: Number(row.quantity),
    durationDays: row.duration_days == null ? null : Number(row.duration_days),
    planCode: row.plan_code || null,
    displayTitle: row.display_title,
    displayLabel: row.display_label,
    pricePaise,
    currency: row.currency || "INR",
    priceLabel,
    buttonLabel,
    badgeType: row.badge_type || null,
    badgeText: row.badge_text || null,
    isDefault: Boolean(row.is_default),
    isActive: Boolean(row.is_active),
    sortOrder: Number(row.sort_order),
    googlePlayProductId: row.google_play_product_id || null,
    appleProductId: row.apple_product_id || null,
    teaserFromLabel: `From ${formatInrPaise(pricePaise)}`,
    upgradeFromLabel: `Upgrade from ${formatInrPaise(pricePaise)}`,
  };
}

module.exports = {
  formatInrPaise,
  compactInrPaise,
  buildPremiumButtonLabel,
  buildPackButtonLabel,
  mapProductRow,
};
