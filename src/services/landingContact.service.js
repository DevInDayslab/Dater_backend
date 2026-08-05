const crypto = require("crypto");
const { query } = require("../config/db");
const s3Media = require("./s3Media.service");

const ALLOWED_ATTACHMENT_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
]);

const CONTENT_TYPE_TO_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
};

const EXTENSION_TO_CONTENT_TYPE = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
};

const LANDING_CONTACT_KEY_PREFIX = "landing/contacts/";

function inferContentTypeFromFileName(fileName) {
  const extension = String(fileName || "")
    .split(".")
    .pop()
    ?.toLowerCase();
  return EXTENSION_TO_CONTENT_TYPE[extension] || null;
}

function assertAllowedAttachmentContentType(contentType, fileName) {
  let normalized = String(contentType || "").trim().toLowerCase();
  if (!normalized || normalized === "application/octet-stream") {
    normalized = inferContentTypeFromFileName(fileName) || "";
  }
  if (!ALLOWED_ATTACHMENT_CONTENT_TYPES.has(normalized)) {
    const err = new Error(
      "contentType must be image/jpeg, image/png, image/webp, image/gif, or application/pdf"
    );
    err.code = "INVALID_INPUT";
    throw err;
  }
  return normalized;
}

function assertValidLandingContactS3Key(s3Key) {
  const normalized = String(s3Key || "").trim();
  if (!normalized.startsWith(LANDING_CONTACT_KEY_PREFIX)) {
    const err = new Error("Invalid attachment key");
    err.code = "INVALID_INPUT";
    throw err;
  }
  if (normalized.includes("..")) {
    const err = new Error("Invalid attachment key");
    err.code = "INVALID_INPUT";
    throw err;
  }
  return normalized;
}

async function presignAttachment(contentType, fileName) {
  const normalizedContentType = assertAllowedAttachmentContentType(contentType, fileName);
  const contactId = crypto.randomUUID();
  const ext = CONTENT_TYPE_TO_EXT[normalizedContentType];
  const key = s3Media.buildLandingContactObjectKey(contactId, ext);
  const presign = await s3Media.getPresignedPutUrl({
    key,
    contentType: normalizedContentType,
  });
  return {
    uploadUrl: presign.uploadUrl,
    s3Key: presign.key,
    publicUrl: presign.publicUrl,
    contentType: normalizedContentType,
  };
}

async function createContact({
  name,
  email,
  mobile,
  description,
  attachmentUrl,
  attachmentS3Key,
  ipAddress,
}) {
  const normalizedAttachmentS3Key = attachmentS3Key
    ? assertValidLandingContactS3Key(attachmentS3Key)
    : null;
  const normalizedAttachmentUrl = attachmentUrl ? String(attachmentUrl).trim() : null;

  if (normalizedAttachmentS3Key && !normalizedAttachmentUrl) {
    const err = new Error("attachmentUrl is required when attachmentS3Key is provided");
    err.code = "INVALID_INPUT";
    throw err;
  }

  const result = await query(
    `INSERT INTO landing_contacts (
       name, email, mobile, description, attachment_url, attachment_s3_key, ip_address
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7::inet)
     RETURNING id`,
    [
      name,
      email,
      mobile,
      description,
      normalizedAttachmentUrl,
      normalizedAttachmentS3Key,
      ipAddress || null,
    ]
  );

  return { id: result.rows[0].id };
}

module.exports = {
  presignAttachment,
  createContact,
  assertValidLandingContactS3Key,
  LANDING_CONTACT_KEY_PREFIX,
};
