const adminUsersService = require("../../services/admin/adminUsers.service");
const adminUserMutations = require("../../services/admin/adminUserMutations.service");

function notFound(res, message = "User not found") {
  return res.status(404).json({ success: false, message });
}

function mutationError(res, error, fallbackMessage) {
  const code = error.code;
  if (code === "INVALID_UNTIL" || code === "EMPTY_PATCH" || code === "INVALID_PLAN_CODE") {
    return res.status(400).json({ success: false, message: error.message, code });
  }
  return res.status(500).json({
    success: false,
    message: fallbackMessage,
    error: error.message,
  });
}

async function listUsers(req, res) {
  try {
    const data = await adminUsersService.listUsers(req.query);
    return res.status(200).json({
      success: true,
      message: "Users fetched",
      data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch users",
      error: error.message,
    });
  }
}

async function getProfile(req, res) {
  try {
    const profile = await adminUsersService.getUserProfile(req.params.userId);
    if (!profile) return notFound(res);
    return res.status(200).json({
      success: true,
      message: "User profile fetched",
      data: profile,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch user profile",
      error: error.message,
    });
  }
}

async function getPhotos(req, res) {
  try {
    const exists = await adminUsersService.getUserRow(req.params.userId, { includeDeleted: true });
    if (!exists) return notFound(res);
    const photos = await adminUsersService.getUserPhotos(req.params.userId);
    return res.status(200).json({
      success: true,
      message: "User photos fetched",
      data: { photos },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch user photos",
      error: error.message,
    });
  }
}

async function getFilters(req, res) {
  try {
    const filters = await adminUsersService.getUserFilters(req.params.userId);
    if (!filters) return notFound(res);
    return res.status(200).json({
      success: true,
      message: "User filters fetched",
      data: filters,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch user filters",
      error: error.message,
    });
  }
}

async function getVerification(req, res) {
  try {
    const data = await adminUsersService.getUserVerification(req.params.userId);
    if (!data) return notFound(res);
    return res.status(200).json({
      success: true,
      message: "User verification fetched",
      data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch user verification",
      error: error.message,
    });
  }
}

async function getTrust(req, res) {
  try {
    const data = await adminUsersService.getUserTrust(req.params.userId);
    if (!data) return notFound(res);
    return res.status(200).json({
      success: true,
      message: "User trust data fetched",
      data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch user trust data",
      error: error.message,
    });
  }
}

async function getContent(req, res) {
  try {
    const data = await adminUsersService.getUserContent(req.params.userId);
    if (!data) return notFound(res);
    return res.status(200).json({
      success: true,
      message: "User content fetched",
      data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch user content",
      error: error.message,
    });
  }
}

async function getChatThreads(req, res) {
  try {
    const threads = await adminUsersService.getUserChatThreads(req.params.userId);
    if (threads === null) return notFound(res);
    return res.status(200).json({
      success: true,
      message: "User chat threads fetched",
      data: { threads },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch user chat threads",
      error: error.message,
    });
  }
}

async function getChatMessages(req, res) {
  try {
    const messages = await adminUsersService.getUserChatMessages(
      req.params.userId,
      req.params.threadId
    );
    if (messages === null) return notFound(res, "Chat thread not found for user");
    return res.status(200).json({
      success: true,
      message: "Chat messages fetched",
      data: { messages },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch chat messages",
      error: error.message,
    });
  }
}

async function getSocial(req, res) {
  try {
    const data = await adminUsersService.getUserSocial(req.params.userId);
    if (!data) return notFound(res);
    return res.status(200).json({
      success: true,
      message: "User social data fetched",
      data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch user social data",
      error: error.message,
    });
  }
}

async function getRevenue(req, res) {
  try {
    const data = await adminUsersService.getUserRevenue(req.params.userId);
    if (!data) return notFound(res);
    return res.status(200).json({
      success: true,
      message: "User revenue data fetched",
      data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch user revenue data",
      error: error.message,
    });
  }
}

async function issueWarning(req, res) {
  try {
    const result = await adminUserMutations.issueWarning(req.params.userId, req.body || {});
    if (result.notFound) return notFound(res);
    return res.status(200).json({
      success: true,
      message: "Warning issued",
      data: result,
    });
  } catch (error) {
    return mutationError(res, error, "Failed to issue warning");
  }
}

async function banUser(req, res) {
  try {
    const result = await adminUserMutations.banUser(req.params.userId, req.body || {});
    if (result.notFound) return notFound(res);
    return res.status(200).json({
      success: true,
      message: "User banned",
      data: result,
    });
  } catch (error) {
    return mutationError(res, error, "Failed to ban user");
  }
}

async function unbanUser(req, res) {
  try {
    const result = await adminUserMutations.unbanUser(req.params.userId);
    if (result.notFound) return notFound(res);
    return res.status(200).json({
      success: true,
      message: "User unbanned",
      data: result,
    });
  } catch (error) {
    return mutationError(res, error, "Failed to unban user");
  }
}

async function shadowbanUser(req, res) {
  try {
    const result = await adminUserMutations.shadowbanUser(req.params.userId, req.body || {});
    if (result.notFound) return notFound(res);
    return res.status(200).json({
      success: true,
      message: "User hidden by moderation",
      data: result,
    });
  } catch (error) {
    return mutationError(res, error, "Failed to shadowban user");
  }
}

async function pauseUser(req, res) {
  try {
    const until = req.body?.until ?? req.body?.pausedUntil ?? null;
    const result = await adminUserMutations.pauseUser(req.params.userId, { until });
    if (result.notFound) return notFound(res);
    return res.status(200).json({
      success: true,
      message: "User paused",
      data: result,
    });
  } catch (error) {
    return mutationError(res, error, "Failed to pause user");
  }
}

async function deleteUser(req, res) {
  try {
    const result = await adminUserMutations.deleteUser(req.params.userId);
    if (result.notFound) return notFound(res);
    return res.status(200).json({
      success: true,
      message: result.alreadyDeleted ? "User already deleted" : "User deleted",
      data: result,
    });
  } catch (error) {
    return mutationError(res, error, "Failed to delete user");
  }
}

async function patchProfile(req, res) {
  try {
    const { name, bio, presetMessage } = req.body || {};
    const result = await adminUserMutations.patchProfile(req.params.userId, {
      name,
      bio,
      presetMessage,
    });
    if (result.notFound) return notFound(res);
    return res.status(200).json({
      success: true,
      message: "Profile updated",
      data: result,
    });
  } catch (error) {
    return mutationError(res, error, "Failed to update profile");
  }
}

async function grantPremium(req, res) {
  try {
    const { planCode, expiresAt } = req.body || {};
    const result = await adminUserMutations.grantPremium(req.params.userId, {
      planCode,
      expiresAt,
    });
    if (result.notFound) return notFound(res);
    return res.status(200).json({
      success: true,
      message: "Premium granted",
      data: result,
    });
  } catch (error) {
    return mutationError(res, error, "Failed to grant premium");
  }
}

async function revokeSession(req, res) {
  try {
    const result = await adminUserMutations.revokeSession(
      req.params.userId,
      req.params.sessionId
    );
    if (result.notFound) {
      return res.status(404).json({ success: false, message: "Session not found" });
    }
    return res.status(200).json({
      success: true,
      message: "Session revoked",
      data: result,
    });
  } catch (error) {
    return mutationError(res, error, "Failed to revoke session");
  }
}

module.exports = {
  listUsers,
  getProfile,
  getPhotos,
  getFilters,
  getVerification,
  getTrust,
  getContent,
  getChatThreads,
  getChatMessages,
  getSocial,
  getRevenue,
  issueWarning,
  banUser,
  unbanUser,
  shadowbanUser,
  pauseUser,
  deleteUser,
  patchProfile,
  grantPremium,
  revokeSession,
};
