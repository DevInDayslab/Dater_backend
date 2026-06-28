const assert = require("assert");
const {
  formatInrPaise,
  buildPremiumButtonLabel,
  buildPackButtonLabel,
  mapProductRow,
} = require("../src/utils/productFormatting");

assert.strictEqual(formatInrPaise(49900), "₹499");
assert.strictEqual(formatInrPaise(49900, { spaced: true }), "₹ 499");
assert.strictEqual(formatInrPaise(219900), "₹2,199");
assert.strictEqual(buildPremiumButtonLabel("1", "Week", 49900), "Get 1 week for ₹499");
assert.strictEqual(buildPremiumButtonLabel("10", "Days", 49900), "Get 10 days for ₹499");
assert.strictEqual(buildPackButtonLabel(3, "Boosts", 19900), "Get 3 boost for ₹199");

const mapped = mapProductRow({
  pack_code: "PREMIUM_WEEK",
  category: "PREMIUM",
  quantity: 1,
  duration_days: 7,
  plan_code: "WEEK",
  display_title: "1",
  display_label: "Week",
  price_paise: 49900,
  currency: "INR",
  badge_type: null,
  badge_text: null,
  is_default: true,
  is_active: true,
  sort_order: 1,
  google_play_product_id: null,
  apple_product_id: null,
});

assert.strictEqual(mapped.priceLabel, "₹ 499");
assert.strictEqual(mapped.buttonLabel, "Get 1 week for ₹499");
assert.strictEqual(mapped.teaserFromLabel, "From ₹499");

console.log("productFormatting tests passed");
