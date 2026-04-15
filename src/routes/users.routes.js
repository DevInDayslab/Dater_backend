const express = require("express");
const usersController = require("../controllers/users.controller");
const photosController = require("../controllers/photos.controller");
const { requireAuth } = require("../middleware/auth.middleware");

const router = express.Router();

router.get("/me", requireAuth, usersController.getMe);
router.get("/me/cities", requireAuth, usersController.listIndianCities);
router.patch("/me/onboarding-step", requireAuth, usersController.updateOnboardingStep);
router.patch("/me/profile-core", requireAuth, usersController.updateProfileCore);
router.patch("/me/onboarding-data", requireAuth, usersController.updateOnboardingData);
router.post("/me/reverse-geocode", requireAuth, usersController.reverseGeocodeLocation);

router.post("/me/photos/presign", requireAuth, photosController.presignPhotoUpload);
router.post("/me/photos/:photoId/confirm", requireAuth, photosController.confirmPhotoUpload);
router.post("/me/photos/delete", requireAuth, photosController.deletePhotoByOrder);

module.exports = router;
