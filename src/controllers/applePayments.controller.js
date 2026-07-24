const applePaymentsService = require("../services/applePayments.service");

function mapAppleBillingError(error) {
  const code = error?.code || "APPLE_BILLING_ERROR";
  if (
    code === "INVALID_JWS" ||
    code === "INVALID_PRODUCT" ||
    code === "INVALID_PRODUCT_TYPE" ||
    code === "INVALID_INPUT" ||
    code === "INVALID_PREMIUM_PLAN" ||
    code === "INVALID_BOOST_PACK" ||
    code === "INVALID_COMMENTS_PACK" ||
    code === "INVALID_CHAT_UNLOCK_PACK" ||
    code === "INVALID_SUBSCRIPTION" ||
    code === "THREAD_NOT_FOUND" ||
    code === "THREAD_PEER_NOT_FOUND" ||
    code === "CHAT_ALREADY_UNLOCKED" ||
    code === "PURCHASE_ALREADY_OWNED" ||
    code === "APPLE_JWS_INVALID" ||
    code === "INSUFFICIENT_CHAT_UNLOCK_CREDITS"
  ) {
    return { status: 400, code };
  }
  if (code === "APPLE_NOT_CONFIGURED") {
    return { status: 503, code };
  }
  return { status: 500, code };
}

async function getAppleCatalog(req, res) {
  try {
    const data = await applePaymentsService.getAppleCatalog();
    return res.status(200).json({
      success: true,
      message: "Apple catalog fetched",
      data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch Apple catalog",
      error: error.message,
    });
  }
}

async function verifyApplePurchase(req, res) {
  try {
    const snapshot = await applePaymentsService.verifyApplePurchase({
      userId: req.auth.userId,
      jwsToken: req.body?.jwsToken,
      threadId: req.body?.threadId,
    });
    return res.status(200).json({
      success: true,
      message: "Apple purchase verified",
      data: snapshot,
    });
  } catch (error) {
    const mapped = mapAppleBillingError(error);
    return res.status(mapped.status).json({
      success: false,
      code: mapped.code,
      message: error.message || "Apple purchase verification failed",
    });
  }
}

async function redeemChatUnlockCredit(req, res) {
  try {
    const result = await applePaymentsService.redeemChatUnlockCredit({
      userId: req.auth.userId,
      threadId: req.body?.threadId,
    });
    return res.status(200).json({
      success: true,
      message: "Chat unlock credit redeemed",
      data: result,
    });
  } catch (error) {
    const mapped = mapAppleBillingError(error);
    return res.status(mapped.status).json({
      success: false,
      code: mapped.code,
      message: error.message || "Failed to redeem chat unlock credit",
    });
  }
}

module.exports = {
  getAppleCatalog,
  verifyApplePurchase,
  redeemChatUnlockCredit,
};
