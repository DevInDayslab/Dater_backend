/**
 * IAM: the credentials used by this process need at least
 * s3:PutObject, s3:GetObject, s3:DeleteObject on the media bucket/prefix.
 * Many starter policies omit DeleteObject — without it, replaced or rejected
 * photos can linger in S3 and increase storage cost.
 */
const crypto = require("crypto");
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
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

function buildStoryObjectKey(userId, storyId) {
  return `users/${userId}/stories/${storyId}.jpg`;
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

/**
 * If [mediaUrl] is our virtual-hosted public object URL for this bucket/region,
 * return a time-limited presigned GET so clients (Coil) can read private-bucket objects.
 * Otherwise returns [mediaUrl] unchanged (e.g. picsum, randomuser, CloudFront).
 */
async function presignReadIfOurS3Object(mediaUrl) {
  const raw = String(mediaUrl || "").trim();
  if (!raw) return raw;
  const prefix = `https://${bucket}.s3.${region}.amazonaws.com/`;
  if (!raw.startsWith(prefix)) return raw;
  const encodedKey = raw.slice(prefix.length);
  let key;
  try {
    key = decodeURIComponent(encodedKey.replace(/\+/g, " "));
  } catch {
    return raw;
  }
  if (!key || key.includes("..")) return raw;
  try {
    return await getPresignedGetUrl({ key, expiresInSeconds: 3600 });
  } catch {
    return raw;
  }
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

/** Server-side upload (e.g. verification selfie after liveness). */
async function putObjectBytes({ key, body, contentType = "image/webp" }) {
  if (!key || !body) return;
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
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
  buildStoryObjectKey,
  newPhotoId,
  getPresignedPutUrl,
  getPresignedGetUrl,
  presignReadIfOurS3Object,
  deleteObjectByKey,
  getObjectBytes,
  putObjectBytes,
  s3Bucket: bucket,
  s3Region: region,
};
