const express = require("express");
const { requireAdminAuth } = require("../../middleware/adminAuth.middleware");
const authRoutes = require("./auth.routes");
const dashboardRoutes = require("./dashboard.routes");
const usersRoutes = require("./users.routes");
const reportsRoutes = require("./reports.routes");
const broadcastRoutes = require("./broadcast.routes");
const revenueRoutes = require("./revenue.routes");

const router = express.Router();

router.use("/auth", authRoutes);

router.use(requireAdminAuth);

router.use("/dashboard", dashboardRoutes);
router.use("/users", usersRoutes);
router.use("/reports", reportsRoutes);
router.use("/broadcast", broadcastRoutes);
router.use("/revenue", revenueRoutes);

module.exports = router;
