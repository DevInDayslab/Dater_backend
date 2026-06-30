const express = require("express");
const configController = require("../controllers/config.controller");

const router = express.Router();

router.get("/products", configController.getProducts);
router.get("/app", configController.getApp);

module.exports = router;
