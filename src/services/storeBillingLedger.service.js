/**
 * Shared store billing helpers with no imports from subscription or verification
 * services — avoids circular dependency between those modules.
 */

function storeMetadata(platform, { purchaseToken, productId, orderId, basePlanId }) {
  return {
    platform,
    purchaseToken,
    productId,
    orderId,
    basePlanId: basePlanId || null,
  };
}

function pickSubscriptionLineItem(subscription, { productId, basePlanId }) {
  const lineItems = subscription?.lineItems || [];
  if (!lineItems.length) return null;
  if (basePlanId) {
    const match = lineItems.find(
      (item) =>
        String(item?.offerDetails?.basePlanId || "").toLowerCase() ===
        String(basePlanId).toLowerCase()
    );
    if (match) return match;
  }
  if (productId) {
    const match = lineItems.find((item) => item?.productId === productId);
    if (match) return match;
  }
  return lineItems[0];
}

async function upsertStoreSubscription(client, {
  platform,
  userId,
  storeProductId,
  purchaseToken,
  storeOrderId,
  expiryTime,
  autoRenewing,
  storeState,
  metadata,
}) {
  await client.query(
    `INSERT INTO store_subscriptions (
       user_id, platform, store_product_id, purchase_token, latest_order_id,
       expiry_time, auto_renewing, store_state, metadata, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9::jsonb, NOW())
     ON CONFLICT (user_id, platform) DO UPDATE SET
       store_product_id = EXCLUDED.store_product_id,
       purchase_token = EXCLUDED.purchase_token,
       latest_order_id = EXCLUDED.latest_order_id,
       expiry_time = EXCLUDED.expiry_time,
       auto_renewing = EXCLUDED.auto_renewing,
       store_state = EXCLUDED.store_state,
       metadata = store_subscriptions.metadata || EXCLUDED.metadata,
       updated_at = NOW()`,
    [
      userId,
      platform,
      storeProductId,
      purchaseToken,
      storeOrderId,
      expiryTime,
      autoRenewing,
      storeState,
      JSON.stringify(metadata || {}),
    ]
  );
}

module.exports = {
  storeMetadata,
  pickSubscriptionLineItem,
  upsertStoreSubscription,
};
