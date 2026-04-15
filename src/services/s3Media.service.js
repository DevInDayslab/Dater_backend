/**
 * IAM: the credentials used by this process need at least
 * s3:PutObject, s3:GetObject, s3:DeleteObject on the media bucket/prefix.
 * Many starter policies omit DeleteObject — without it, replaced or rejected
 * photos can linger in S3 and increase storage cost.
 */
const crypto = require("crypto");
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const region = process.env.AWS_REGION || "ap-south-1";
const bucket = process.env.S3_MEDIA_BUCKET || "dater-media-vault-2026";

const client = new S3Client({ region });

function buildPublicObjectUrl(key) {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`;
}

function buildUserPhotoObjectKey(userId, photoId) {
  return `users/${userId}/photos/${photoId}.webp`;
}

function newPhotoId() {
  return crypto.randomUUID();
}

/**
 * Presigned PUT for client upload. No ACL (bucket owner enforced).
 * Content-Type must match on the client PUT or S3 will reject the signature.
 */
async function getPresignedPutUrl({ key, contentType = "image/webp", expiresInSeconds = 900 }) {
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
  });
  const uploadUrl = await getSignedUrl(client, command, { expiresIn: expiresInSeconds });
  return { uploadUrl, bucket, key, publicUrl: buildPublicObjectUrl(key) };
}

/** Presigned GET so private-bucket objects load in the app (Coil) without public ACL. */
async function getPresignedGetUrl({ key, expiresInSeconds = 3600 }) {
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });
  return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
}

async function deleteObjectByKey(key) {
  if (!key) return;
  await client.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );
}

/** Full object body (e.g. WebP from client) for server-side processing. */
async function getObjectBytes(key) {
  const out = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );
  const chunks = [];
  for await (const chunk of out.Body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

module.exports = {
  buildPublicObjectUrl,
  buildUserPhotoObjectKey,
  newPhotoId,
  getPresignedPutUrl,
  getPresignedGetUrl,
  deleteObjectByKey,
  getObjectBytes,
  s3Bucket: bucket,
  s3Region: region,
};
