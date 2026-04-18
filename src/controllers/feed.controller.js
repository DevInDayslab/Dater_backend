const feedService = require("../services/feed.service");

async function getFeed(req, res) {
  try {
    const userId = req.auth.userId;
    const result = await feedService.getFeed(userId, {
      page: req.query.page,
      pageSize: req.query.pageSize,
      shuffleSeed: req.query.shuffleSeed,
    });
    if (result?.code) {
      const status = result.code === "VIEWER_NOT_FOUND" ? 404 : 400;
      return res.status(status).json({
        success: false,
        code: result.code,
        message: result.message,
      });
    }
    return res.status(200).json({
      success: true,
      message: "Feed fetched",
      data: result,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch feed",
      error: error.message,
    });
  }
}

module.exports = {
  getFeed,
};
