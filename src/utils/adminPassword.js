const crypto = require("crypto");

const SCRYPT_KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !String(storedHash).includes(":")) return false;
  const [salt, expectedHex] = String(storedHash).split(":");
  if (!salt || !expectedHex) return false;
  const actualHex = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString("hex");
  const a = Buffer.from(actualHex, "hex");
  const b = Buffer.from(expectedHex, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  hashPassword,
  verifyPassword,
};
