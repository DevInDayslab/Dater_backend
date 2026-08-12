const express = require("express");
const {
  requireAdminAuth,
  requireFullAdmin,
  requireSeoAccess,
} = require("../../middleware/adminAuth.middleware");
const authRoutes = require("./auth.routes");
const dashboardRoutes = require("./dashboard.routes");
const usersRoutes = require("./users.routes");
const reportsRoutes = require("./reports.routes");
const broadcastRoutes = require("./broadcast.routes");
const revenueRoutes = require("./revenue.routes");
const productsRoutes = require("./products.routes");
const appConfigRoutes = require("./appConfig.routes");
const formsRoutes = require("./forms.routes");
const settingsRoutes = require("./settings.routes");
const seoRoutes = require("../../modules/seo/seo.routes");

const router = express.Router();

router.use("/auth", authRoutes);

router.use("/seo", requireAdminAuth, requireSeoAccess, seoRoutes);

router.use(requireAdminAuth);
router.use(requireFullAdmin);

router.use("/settings", settingsRoutes);
router.use("/dashboard", dashboardRoutes);
router.use("/users", usersRoutes);
router.use("/reports", reportsRoutes);
router.use("/broadcast", broadcastRoutes);
router.use("/revenue", revenueRoutes);
router.use("/products", productsRoutes);
router.use("/app-config", appConfigRoutes);
router.use("/forms", formsRoutes);

module.exports = router;
