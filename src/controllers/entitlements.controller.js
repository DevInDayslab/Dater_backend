const entitlementsService = require("../services/entitlements.service");

function mapServiceError(error) {
  const code = error?.code || "ENTITLEMENT_ERROR";
  if (
    code === "INVALID_PREMIUM_PLAN" ||
    code === "INVALID_BOOST_PACK" ||
    code === "INVALID_COMMENTS_PACK" ||
    code === "INVALID_CHAT_UNLOCK_PACK" ||
    code === "INVALID_BOOST_COUNT" ||
    code === "INVALID_INPUT"
  ) {
    return { status: 400, code };
  }
  if (code === "THREAD_NOT_FOUND" || code === "THREAD_PEER_NOT_FOUND") {
    return { status: 404, code };
  }
  if (
    code === "INSUFFICIENT_BOOST_CREDITS" ||
    code === "INSUFFICIENT_COMMENT_CREDITS" ||
    code === "CHAT_ALREADY_UNLOCKED"
  ) {
    return { status: 409, code };
  }
  return { status: 500, code };
}

async function getMyEntitlements(req, res) {
  try {
    const snapshot = await entitlementsService.getEntitlementsSnapshot(req.auth.userId);
    return res.status(200).json({
      success: true,
      message: "Entitlements fetched",
      data: snapshot,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch entitlements",
      error: error.message,
    });
  }
}

async function purchasePremium(req, res) {
  try {
    const snapshot = await entitlementsService.purchasePremium({
      userId: req.auth.userId,
      planCode: req.body?.planCode,
      packCode: req.body?.packCode,
      transactionId: req.body?.transactionId,
    });
    return res.status(200).json({
      success: true,
      message: "Premium purchased",
      data: snapshot,
    });
  } catch (error) {
    const mapped = mapServiceError(error);
    return res.status(mapped.status).json({
      success: false,
      code: mapped.code,
      message: error.message || "Failed to purchase premium",
    });
  }
}

async function purchaseBoost(req, res) {
  try {
    const snapshot = await entitlementsService.purchaseBoost({
      userId: req.auth.userId,
      packSize: req.body?.packSize,
      packCode: req.body?.packCode,
      transactionId: req.body?.transactionId,
    });
    return res.status(200).json({
      success: true,
      message: "Boost pack purchased",
      data: snapshot,
    });
  } catch (error) {
    const mapped = mapServiceError(error);
    return res.status(mapped.status).json({
      success: false,
      code: mapped.code,
      message: error.message || "Failed to purchase boost pack",
    });
  }
}

async function activateBoost(req, res) {
  try {
    const snapshot = await entitlementsService.activateBoost({
      userId: req.auth.userId,
      activateCount: req.body?.activateCount,
    });
    return res.status(200).json({
      success: true,
      message: "Boost activated",
      data: snapshot,
    });
  } catch (error) {
    const mapped = mapServiceError(error);
    return res.status(mapped.status).json({
      success: false,
      code: mapped.code,
      message: error.message || "Failed to activate boost",
    });
  }
}

async function purchaseComments(req, res) {
  try {
    const snapshot = await entitlementsService.purchaseComments({
      userId: req.auth.userId,
      packSize: req.body?.packSize,
      packCode: req.body?.packCode,
      transactionId: req.body?.transactionId,
    });
    return res.status(200).json({
      success: true,
      message: "Comment pack purchased",
      data: snapshot,
    });
  } catch (error) {
    const mapped = mapServiceError(error);
    return res.status(mapped.status).json({
      success: false,
      code: mapped.code,
      message: error.message || "Failed to purchase comments pack",
    });
  }
}

async function consumeComments(req, res) {
  try {
    const snapshot = await entitlementsService.consumePaidComments({
      userId: req.auth.userId,
      useCount: req.body?.useCount ?? 1,
      reason: req.body?.reason || "COMMENT_REQUEST",
    });
    return res.status(200).json({
      success: true,
      message: "Comments consumed",
      data: snapshot,
    });
  } catch (error) {
    const mapped = mapServiceError(error);
    return res.status(mapped.status).json({
      success: false,
      code: mapped.code,
      message: error.message || "Failed to consume comments",
    });
  }
}

async function purchaseChatUnlock(req, res) {
  try {
    const result = await entitlementsService.purchaseChatUnlock({
      userId: req.auth.userId,
      threadId: req.body?.threadId,
      packCode: req.body?.packCode,
      transactionId: req.body?.transactionId,
    });
    return res.status(200).json({
      success: true,
      message: "Chat unlocked",
      data: result,
    });
  } catch (error) {
    const mapped = mapServiceError(error);
    return res.status(mapped.status).json({
      success: false,
      code: mapped.code,
      message: error.message || "Failed to purchase chat unlock",
    });
  }
}

module.exports = {
  getMyEntitlements,
  purchasePremium,
  purchaseBoost,
  activateBoost,
  purchaseComments,
  purchaseChatUnlock,
  consumeComments,
};

