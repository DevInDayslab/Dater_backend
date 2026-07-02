#!/usr/bin/env node
/**
 * Verifies /api/v1/config/products includes googlePlayBasePlanId for premium rows.
 * Usage: npm run verify:products-catalog
 */
require("dotenv").config();

const { getPublicProductsPayload } = require("../services/productConfig.service");

const EXPECTED_PREMIUM_BASE_PLANS = {
  PREMIUM_WEEK: { productId: "dater_premium", basePlanId: "week-one" },
  PREMIUM_MONTH: { productId: "dater_premium", basePlanId: "month" },
  PREMIUM_THREE_MONTHS: { productId: "dater_premium", basePlanId: "three-month" },
};

async function main() {
  const payload = await getPublicProductsPayload();
  const premium = payload.premium || [];
  let failed = false;

  console.log("Premium products (API shape):\n");
  for (const row of premium) {
    const sample = {
      packCode: row.packCode,
      googlePlayProductId: row.googlePlayProductId,
      googlePlayBasePlanId: row.googlePlayBasePlanId,
    };
    console.log(JSON.stringify(sample, null, 2));

    if (!Object.prototype.hasOwnProperty.call(row, "googlePlayBasePlanId")) {
      console.error(`\nFAIL: ${row.packCode} missing googlePlayBasePlanId key in API object`);
      failed = true;
      continue;
    }
    if (!row.googlePlayBasePlanId) {
      console.error(`\nFAIL: ${row.packCode} has null/empty googlePlayBasePlanId`);
      failed = true;
    }
  }

  for (const [packCode, expected] of Object.entries(EXPECTED_PREMIUM_BASE_PLANS)) {
    const row = premium.find((p) => p.packCode === packCode);
    if (!row) {
      console.error(`\nFAIL: missing premium pack ${packCode}`);
      failed = true;
      continue;
    }
    if (row.googlePlayProductId !== expected.productId) {
      console.error(
        `\nFAIL: ${packCode} googlePlayProductId=${row.googlePlayProductId} expected ${expected.productId}`
      );
      failed = true;
    }
    if (row.googlePlayBasePlanId !== expected.basePlanId) {
      console.error(
        `\nFAIL: ${packCode} googlePlayBasePlanId=${row.googlePlayBasePlanId} expected ${expected.basePlanId}`
      );
      failed = true;
    }
  }

  if (failed) {
    console.error("\nProducts catalog verification FAILED. Run npm run migrate and redeploy backend.");
    process.exit(1);
  }
  console.log("\nProducts catalog verification OK.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
