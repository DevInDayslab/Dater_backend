const express = require("express");
const adminLandingContactsController = require("../../controllers/admin/adminLandingContacts.controller");

const router = express.Router();

router.get("/", adminLandingContactsController.listForms);
router.get("/:formId", adminLandingContactsController.getForm);

module.exports = router;
