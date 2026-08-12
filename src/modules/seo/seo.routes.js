"use strict";

const express = require("express");
const seoController = require("./seo.controller");

const router = express.Router();

router.get("/", seoController.listSeoHandler);
router.get("/:slug", seoController.getSeoHandler);
router.put("/:slug", seoController.updateSeoHandler);
// Backward-compatible home update (no slug in path).
router.put("/", (req, res) => {
  req.params = { ...req.params, slug: "home" };
  return seoController.updateSeoHandler(req, res);
});

module.exports = router;
