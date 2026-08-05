const landingContactService = require("../services/landingContact.service");

function normalizeDigits(raw) {
  return String(raw || "").replace(/\D/g, "");
}

function assertValidName(rawName) {
  const name = String(rawName || "").trim();
  if (name.length < 1 || name.length > 120) {
    const err = new Error("name must be between 1 and 120 characters");
    err.code = "INVALID_INPUT";
    throw err;
  }
  return name;
}

function assertValidEmail(rawEmail) {
  const email = String(rawEmail || "").trim().toLowerCase();
  if (!email || email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const err = new Error("email must be a valid email address");
    err.code = "INVALID_INPUT";
    throw err;
  }
  return email;
}

function assertValidMobile(rawMobile) {
  const digits = normalizeDigits(rawMobile);
  let mobile = digits;
  if (digits.length === 12 && digits.startsWith("91")) {
    mobile = digits.slice(2);
  }
  if (mobile.length < 10 || mobile.length > 15) {
    const err = new Error("mobile must be a valid phone number");
    err.code = "INVALID_INPUT";
    throw err;
  }
  return mobile;
}

function assertValidDescription(rawDescription) {
  const description = String(rawDescription || "").trim();
  if (description.length < 1 || description.length > 2000) {
    const err = new Error("description must be between 1 and 2000 characters");
    err.code = "INVALID_INPUT";
    throw err;
  }
  return description;
}

function resolveClientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  return forwarded || req.ip || null;
}

function handleError(res, error, fallbackMessage) {
  if (error.code === "INVALID_INPUT") {
    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
  return res.status(500).json({
    success: false,
    message: fallbackMessage,
    error: error.message,
  });
}

async function presignAttachment(req, res) {
  try {
    const data = await landingContactService.presignAttachment(
      req.body?.contentType,
      req.body?.fileName
    );
    return res.status(200).json({
      success: true,
      message: "Attachment upload URL generated",
      data,
    });
  } catch (error) {
    return handleError(res, error, "Failed to generate attachment upload URL");
  }
}

async function submitContact(req, res) {
  try {
    const name = assertValidName(req.body?.name);
    const email = assertValidEmail(req.body?.email);
    const mobile = assertValidMobile(req.body?.mobile);
    const description = assertValidDescription(req.body?.description);
    const attachmentUrl = req.body?.attachmentUrl
      ? String(req.body.attachmentUrl).trim()
      : null;
    const attachmentS3Key = req.body?.attachmentS3Key
      ? landingContactService.assertValidLandingContactS3Key(req.body.attachmentS3Key)
      : null;

    if (attachmentS3Key && !attachmentUrl) {
      return res.status(400).json({
        success: false,
        message: "attachmentUrl is required when attachmentS3Key is provided",
      });
    }

    const data = await landingContactService.createContact({
      name,
      email,
      mobile,
      description,
      attachmentUrl,
      attachmentS3Key,
      ipAddress: resolveClientIp(req),
    });

    return res.status(201).json({
      success: true,
      message: "Your request has been submitted.",
      data,
    });
  } catch (error) {
    return handleError(res, error, "Failed to submit contact request");
  }
}

module.exports = {
  presignAttachment,
  submitContact,
};
