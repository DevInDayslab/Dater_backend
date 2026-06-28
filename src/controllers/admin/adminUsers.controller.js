const adminUsersService = require("../../services/admin/adminUsers.service");

function notFound(res, message = "User not found") {
  return res.status(404).json({ success: false, message });
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
};
