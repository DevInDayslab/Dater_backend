const { query } = require("../config/db");
const s3Media = require("./s3Media.service");

/** Pending rows older than this are treated as abandoned (no /confirm after presign). */
const rawStaleHours = Number(process.env.PHOTO_PENDING_STALE_HOURS);
const STALE_PENDING_HOURS =
  Number.isFinite(rawStaleHours) && rawStaleHours > 0 ? rawStaleHours : 1;

/**
 * Soft-deletes stale PENDING_MODERATION rows and best-effort deletes their S3 objects.
 * Frees (user_id, photo_order) for a new presign and keeps discovery from treating zombies as real.
 */
async function expireStalePendingPhotosForUser(userId) {
  const res = await query(
    `UPDATE user_photos
     SET deleted_at = NOW(),
         moderation_status = 'FAILED_MODERATION'
     WHERE user_id = $1
       AND deleted_at IS NULL
       AND moderation_status = 'PENDING_MODERATION'
       AND uploaded_at < NOW() - ($2::numeric * interval '1 hour')
     RETURNING s3_key`,
    [userId, STALE_PENDING_HOURS]
  );

  for (const row of res.rows) {
    if (row.s3_key) {
      try {
        await s3Media.deleteObjectByKey(row.s3_key);
      } catch (e) {
        // IAM must include s3:DeleteObject for bucket cleanup
      }
    }
  }

  return { expiredCount: res.rowCount };
}

module.exports = {
  expireStalePendingPhotosForUser,
  STALE_PENDING_HOURS,
};
