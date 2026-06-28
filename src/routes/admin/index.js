const express = require("express");
const { requireAdminAuth } = require("../../middleware/adminAuth.middleware");
const authRoutes = require("./auth.routes");
const dashboardRoutes = require("./dashboard.routes");
const usersRoutes = require("./users.routes");
const reportsRoutes = require("./reports.routes");

const router = express.Router();

router.use("/auth", authRoutes);

router.use(requireAdminAuth);

router.use("/dashboard", dashboardRoutes);
router.use("/users", usersRoutes);
router.use("/reports", reportsRoutes);

module.exports = router;
