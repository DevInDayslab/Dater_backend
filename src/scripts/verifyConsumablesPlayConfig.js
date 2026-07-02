#!/usr/bin/env node
/**
 * Verifies consumable product catalog includes Play SKUs for boost, comments, chat unlock.
 * Usage: npm run verify:consumables-play-config
 */
require("dotenv").config();

const { getPublicProductsPayload } = require("../services/productConfig.service");

const EXPECTED = {
  boost: [
    { packCode: "BOOST_1", googlePlayProductId: "boost_one", sortOrder: 1 },
    { packCode: "BOOST_2", googlePlayProductId: "boost_plan2", sortOrder: 2 },
    { packCode: "BOOST_3", googlePlayProductId: "boost_plan3", sortOrder: 3 },
  ],
  comments: [
    { packCode: "COMMENTS_1", googlePlayProductId: "comment_one", sortOrder: 1 },
    { packCode: "COMMENTS_2", googlePlayProductId: "comment_2", sortOrder: 2 },
    { packCode: "COMMENTS_3", googlePlayProductId: "comment_3", sortOrder: 3 },
  ],
  chat: [{ packCode: "CHAT_UNLOCK_SINGLE", googlePlayProductId: "chat_unlock" }],
};

function assert(name, condition) {
  if (!condition) {
    console.error(`FAIL: ${name}`);
    process.exit(1);
  }
  console.log(`PASS: ${name}`);
}

async function verifyCategory(categoryName, rows, expected) {
  assert(`${categoryName} has ${expected.length} products`, rows.length === expected.length);
  for (const want of expected) {
    const row = rows.find((r) => r.packCode === want.packCode);
    assert(`${categoryName} includes ${want.packCode}`, Boolean(row));
    assert(
      `${want.packCode} googlePlayProductId=${want.googlePlayProductId}`,
      row.googlePlayProductId === want.googlePlayProductId
    );
    if (want.sortOrder != null) {
      assert(
        `${want.packCode} sortOrder=${want.sortOrder}`,
        Number(row.sortOrder) === want.sortOrder
      );
    }
    assert(`${want.packCode} quantity > 0`, Number(row.quantity) > 0);
  }
}

async function main() {
  console.log("=== Consumables Play config verification ===\n");
  const payload = await getPublicProductsPayload();
  await verifyCategory("boost", payload.boost || [], EXPECTED.boost);
  await verifyCategory("comments", payload.comments || [], EXPECTED.comments);
  await verifyCategory("chat", payload.chat || [], EXPECTED.chat);
  console.log("\nOK: All consumables Play config checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
