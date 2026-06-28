const express = require("express");
const adminReportsController = require("../../controllers/admin/adminReports.controller");

const router = express.Router();

router.get("/", adminReportsController.listReports);
router.get("/:reportId", adminReportsController.getReport);
router.delete("/:reportId", adminReportsController.dismissReport);

module.exports = router;
