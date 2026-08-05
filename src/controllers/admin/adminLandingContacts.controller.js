const adminLandingContactsService = require("../../services/admin/adminLandingContacts.service");

async function listForms(req, res) {
  try {
    const data = await adminLandingContactsService.listLandingContacts(req.query);
    return res.status(200).json({
      success: true,
      message: "Landing contact forms fetched",
      data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch landing contact forms",
      error: error.message,
    });
  }
}

async function getForm(req, res) {
  try {
    const data = await adminLandingContactsService.getLandingContactDetail(req.params.formId);
    if (!data) {
      return res.status(404).json({ success: false, message: "Form submission not found" });
    }
    return res.status(200).json({
      success: true,
      message: "Form submission detail fetched",
      data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch form submission detail",
      error: error.message,
    });
  }
}

module.exports = {
  listForms,
  getForm,
};
