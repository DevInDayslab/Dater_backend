const express = require("express");
const { requireAdminAuth } = require("../../middleware/adminAuth.middleware");
const authRoutes = require("./auth.routes");
const dashboardRoutes = require("./dashboard.routes");

const router = express.Router();

router.use("/auth", authRoutes);

router.use(requireAdminAuth);

router.use("/dashboard", dashboardRoutes);

module.exports = router;
