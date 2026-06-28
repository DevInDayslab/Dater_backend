const adminProductsService = require("../../services/admin/adminProducts.service");

function handleError(res, error, fallbackMessage) {
  const code = error.code;
  if (
    code === "INVALID_INPUT" ||
    code === "INVALID_PRICE" ||
    code === "INVALID_QUANTITY" ||
    code === "INVALID_DURATION"
  ) {
    return res.status(400).json({ success: false, message: error.message, code });
  }
  if (code === "PRODUCT_NOT_FOUND") {
    return res.status(404).json({ success: false, message: error.message, code });
  }
  return res.status(500).json({
    success: false,
    message: fallbackMessage,
    error: error.message,
  });
}

async function listProducts(req, res) {
  try {
    const products = await adminProductsService.listProducts();
    return res.status(200).json({
      success: true,
      message: "Products fetched",
      data: { products },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch products",
      error: error.message,
    });
  }
}

async function updateProducts(req, res) {
  try {
    const products = await adminProductsService.updateProducts(req.body?.products);
    return res.status(200).json({
      success: true,
      message: "Products updated",
      data: { products },
    });
  } catch (error) {
    return handleError(res, error, "Failed to update products");
  }
}

module.exports = {
  listProducts,
  updateProducts,
};
