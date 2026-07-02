/**
 * Smoke test: billing modules load without circular-dependency warnings
 * and export required functions.
 */
require("dotenv").config();

function assertType(name, value, expected) {
  const actual = typeof value;
  if (actual !== expected) {
    console.error(`FAIL: ${name} expected ${expected}, got ${actual}`);
    process.exit(1);
  }
}

const subscriptionStateService = require("../services/subscriptionState.service");
const billingVerificationService = require("../services/billingVerification.service");
const storeBillingLedger = require("../services/storeBillingLedger.service");

assertType(
  "subscriptionStateGrantsAccess",
  subscriptionStateService.subscriptionStateGrantsAccess,
  "function"
);
assertType(
  "applySubscriptionStateFromGoogle",
  subscriptionStateService.applySubscriptionStateFromGoogle,
  "function"
);
assertType("verifyPurchase", billingVerificationService.verifyPurchase, "function");
assertType("pickSubscriptionLineItem", storeBillingLedger.pickSubscriptionLineItem, "function");

const future = new Date(Date.now() + 86_400_000).toISOString();
const grants = subscriptionStateService.subscriptionStateGrantsAccess(
  "SUBSCRIPTION_STATE_ACTIVE",
  future
);
if (!grants) {
  console.error("FAIL: active subscription should grant access");
  process.exit(1);
}

console.log("OK: billing module graph — no missing exports.");
