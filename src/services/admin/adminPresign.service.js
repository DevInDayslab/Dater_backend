const s3Media = require("../s3Media.service");

async function presignMediaUrl({ s3Key, fallbackUrl }) {
  const key = String(s3Key || "").trim();
  if (key && !key.includes("..")) {
    try {
      return await s3Media.getPresignedGetUrl({ key, expiresInSeconds: 3600 });
    } catch {
      /* fall through */
    }
  }
  const raw = String(fallbackUrl || "").trim();
  if (!raw) return null;
  return s3Media.presignReadIfOurS3Object(raw);
}

module.exports = {
  presignMediaUrl,
};
