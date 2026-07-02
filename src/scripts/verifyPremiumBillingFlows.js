/**
 * Automated backend checks for Dater Premium billing flows.
 * Run on EC2 after deploy: npm run verify:premium-billing-flows
 *
 * Covers subscription state logic, plan inference, and module wiring.
 * Device/Play flows (purchase, restore) still require license tester QA.
 */
require("dotenv").config();

const subscriptionStateService = require("../services/subscriptionState.service");
const storeBillingLedger = require("../services/storeBillingLedger.service");
const productConfigService = require("../services/productConfig.service");
const { isPlayBillingConfigured } = require("../config/googlePlay");

function assert(name, condition) {
  if (!condition) {
    console.error(`FAIL: ${name}`);
    process.exit(1);
  }
  console.log(`PASS: ${name}`);
}

function futureIso(ms = 86_400_000) {
  return new Date(Date.now() + ms).toISOString();
}

function pastIso(ms = 86_400_000) {
  return new Date(Date.now() - ms).toISOString();
}

async function testSubscriptionStateLogic() {
  const { subscriptionStateGrantsAccess, resolvePremiumStatus } = subscriptionStateService;
  const exp = futureIso();

  assert(
    "active subscription grants access",
    subscriptionStateGrantsAccess("SUBSCRIPTION_STATE_ACTIVE", exp)
  );
  assert(
    "grace period grants access",
    subscriptionStateGrantsAccess("SUBSCRIPTION_STATE_IN_GRACE_PERIOD", exp)
  );
  assert(
    "cancelled with future expiry grants access",
    subscriptionStateGrantsAccess("SUBSCRIPTION_STATE_CANCELED", exp)
  );
  assert(
    "expired state revokes access",
    !subscriptionStateGrantsAccess("SUBSCRIPTION_STATE_EXPIRED", exp)
  );
  assert(
    "on hold revokes access",
    !subscriptionStateGrantsAccess("SUBSCRIPTION_STATE_ON_HOLD", exp)
  );
  assert(
    "past expiry revokes access",
    !subscriptionStateGrantsAccess("SUBSCRIPTION_STATE_ACTIVE", pastIso())
  );
  assert(
    "cancelled maps to CANCELLED status",
    resolvePremiumStatus("SUBSCRIPTION_STATE_CANCELED") === "CANCELLED"
  );
  assert(
    "expired maps to EXPIRED status",
    resolvePremiumStatus("SUBSCRIPTION_STATE_EXPIRED") === "EXPIRED"
  );
}

function testPlanInference() {
  const { pickSubscriptionLineItem } = storeBillingLedger;
  const subscription = {
    lineItems: [
      {
        productId: "dater_premium",
        expiryTime: futureIso(),
        offerDetails: { basePlanId: "month" },
      },
      {
        productId: "dater_premium",
        expiryTime: futureIso(),
        offerDetails: { basePlanId: "week-one" },
      },
    ],
  };

  const monthItem = pickSubscriptionLineItem(subscription, {
    productId: "dater_premium",
    basePlanId: "month",
  });
  assert(
    "pickSubscriptionLineItem selects month base plan",
    monthItem?.offerDetails?.basePlanId === "month"
  );

  const weekItem = pickSubscriptionLineItem(subscription, {
    productId: "dater_premium",
    basePlanId: "week-one",
  });
  assert(
    "pickSubscriptionLineItem selects week-one base plan",
    weekItem?.offerDetails?.basePlanId === "week-one"
  );
}

async function testCatalogBasePlans() {
  const catalog = await productConfigService.getPublicProductsPayload();
  const expected = {
    PREMIUM_WEEK: "week-one",
    PREMIUM_MONTH: "month",
    PREMIUM_THREE_MONTHS: "three-month",
  };
  for (const row of catalog.premium) {
    const want = expected[row.packCode];
    if (!want) continue;
    assert(
      `${row.packCode} googlePlayBasePlanId=${row.googlePlayBasePlanId}`,
      row.googlePlayBasePlanId === want
    );
  }
  const monthProduct = await productConfigService.getProductByGooglePlayProductId("dater_premium", {
    basePlanId: "month",
  });
  assert(
    "getProductByGooglePlayProductId(month) -> PREMIUM_MONTH",
    monthProduct?.packCode === "PREMIUM_MONTH"
  );
  const weekProduct = await productConfigService.getProductByGooglePlayProductId("dater_premium", {
    basePlanId: "week-one",
  });
  assert(
    "getProductByGooglePlayProductId(week-one) -> PREMIUM_WEEK",
    weekProduct?.packCode === "PREMIUM_WEEK"
  );
}

async function main() {
  console.log("=== Dater Premium billing flow checks ===\n");
  assert("Play billing configured", isPlayBillingConfigured());

  await testSubscriptionStateLogic();
  testPlanInference();
  await testCatalogBasePlans();

  console.log("\nOK: All automated premium billing flow checks passed.");
  console.log(
    "Next: run device QA (purchase, restore, cancel, renewal) per PREMIUM_QA_CHECKLIST.md sections D–F."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
