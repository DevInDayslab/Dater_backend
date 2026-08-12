"use strict";

const express = require("express");
const seoController = require("./seo.controller");

const router = express.Router();

router.get("/", seoController.getSeoHandler);
router.put("/", seoController.updateSeoHandler);

module.exports = router;
