const billingVerificationService = require("../services/billingVerification.service");

function mapBillingError(error) {
  const code = error?.code || "BILLING_ERROR";
  if (code === "INVALID_INPUT" || code === "INVALID_PRODUCT_PACK" || code === "PRODUCT_MISMATCH" || code === "BASE_PLAN_MISMATCH" || code === "INVALID_PREMIUM_PLAN" || code === "INVALID_PRODUCT_TYPE" || code === "SUBSCRIPTION_INACTIVE" || code === "INVALID_SUBSCRIPTION" || code === "PURCHASE_NOT_COMPLETED") {
    return { status: 400, code };
  }
  if (code === "PURCHASE_PENDING") {
    return { status: 202, code };
  }
  if (code === "PLAY_NOT_CONFIGURED" || code === "APP_STORE_NOT_IMPLEMENTED") {
    return { status: 503, code };
  }
  if (code === "UNSUPPORTED_PLATFORM") {
    return { status: 400, code };
  }
  return { status: 500, code };
}

async function verifyPurchase(req, res) {
  try {
    const snapshot = await billingVerificationService.verifyPurchase({
      userId: req.auth.userId,
      platform: req.body?.platform,
      purchaseToken: req.body?.purchaseToken,
      productId: req.body?.productId,
      packCode: req.body?.packCode,
      basePlanId: req.body?.basePlanId,
      threadId: req.body?.threadId,
    });
    return res.status(200).json({
      success: true,
      message: "Purchase verified",
      data: snapshot,
    });
  } catch (error) {
    const mapped = mapBillingError(error);
    return res.status(mapped.status).json({
      success: false,
      code: mapped.code,
      message: error.message || "Purchase verification failed",
    });
  }
}

module.exports = {
  verifyPurchase,
};
