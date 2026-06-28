const productConfigService = require("../services/productConfig.service");

async function getProducts(req, res) {
  try {
    const data = await productConfigService.getPublicProductsPayload();
    return res.status(200).json({
      success: true,
      message: "Products fetched",
      data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch products",
      error: error.message,
    });
  }
}

module.exports = {
  getProducts,
};
