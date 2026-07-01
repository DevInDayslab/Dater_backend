const { getAndroidPublisher, getPackageName } = require("../config/googlePlay");

async function verifyInAppPurchase({ productId, purchaseToken }) {
  const androidPublisher = getAndroidPublisher();
  const packageName = getPackageName();
  const res = await androidPublisher.purchases.products.get({
    packageName,
    productId,
    token: purchaseToken,
  });
  return res.data || {};
}

async function verifySubscription({ purchaseToken }) {
  const androidPublisher = getAndroidPublisher();
  const packageName = getPackageName();
  const res = await androidPublisher.purchases.subscriptionsv2.get({
    packageName,
    token: purchaseToken,
  });
  return res.data || {};
}

async function acknowledgeSubscription({ productId, purchaseToken }) {
  const androidPublisher = getAndroidPublisher();
  const packageName = getPackageName();
  await androidPublisher.purchases.subscriptions.acknowledge({
    packageName,
    subscriptionId: productId,
    token: purchaseToken,
  });
}

async function consumeInApp({ productId, purchaseToken }) {
  const androidPublisher = getAndroidPublisher();
  const packageName = getPackageName();
  await androidPublisher.purchases.products.consume({
    packageName,
    productId,
    token: purchaseToken,
  });
}

module.exports = {
  verifyInAppPurchase,
  verifySubscription,
  acknowledgeSubscription,
  consumeInApp,
};
