const express = require("express");
const authController = require("../controllers/auth.controller");
const { requireAuth } = require("../middleware/auth.middleware");

const router = express.Router();

router.post("/request-otp", authController.requestOTP);
router.post("/resend-otp", authController.resendOTP);
router.post("/verify-otp", authController.verifyOTP);
router.post("/verify-otp-and-login", authController.verifyOtpAndLogin);
router.post("/preview-login-route", authController.previewLoginRoute);
router.post("/precheck-login", authController.precheckLogin);
router.post("/captcha-challenge", authController.createCaptchaChallenge);
router.post("/complete-captcha", requireAuth, authController.completeCaptcha);
router.post("/verify-access-token", authController.verifyAccessToken);
router.post("/logout", requireAuth, authController.logout);

module.exports = router;
