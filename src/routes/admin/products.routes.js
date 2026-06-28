const express = require("express");
const adminProductsController = require("../../controllers/admin/adminProducts.controller");

const router = express.Router();

router.get("/", adminProductsController.listProducts);
router.patch("/", adminProductsController.updateProducts);

module.exports = router;
