const { query } = require("../config/db");
const s3Media = require("./s3Media.service");

const rawStoryPurgeBatch = Number(process.env.STORY_MEDIA_PURGE_BATCH);
const STORY_MEDIA_PURGE_BATCH =
  Number.isFinite(rawStoryPurgeBatch) && rawStoryPurgeBatch > 0 ? Math.min(rawStoryPurgeBatch, 200) : 50;

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

/**
 * Compacts active photo slots into contiguous order 1..N.
 * Prevents hidden gaps (e.g., slots 1 and 3) from causing unintended replacements.
 */
async function normalizePhotoOrdersForUser(userId) {
  // Temporary bump avoids unique collisions on (user_id, photo_order) partial index.
  await query(
    `UPDATE user_photos
     SET photo_order = photo_order + 100
     WHERE user_id = $1
       AND deleted_at IS NULL
       AND moderation_status = 'APPROVED'`,
    [userId]
  );

  await query(
    `WITH ranked AS (
       SELECT id,
              ROW_NUMBER() OVER (ORDER BY photo_order ASC, uploaded_at ASC, id ASC) AS rn
       FROM user_photos
       WHERE user_id = $1
         AND deleted_at IS NULL
         AND moderation_status = 'APPROVED'
     )
     UPDATE user_photos p
     SET photo_order = r.rn,
         is_primary = (r.rn = 1)
     FROM ranked r
     WHERE p.id = r.id`,
    [userId]
  );
}

/**
 * Hard-delete story media in S3 after retention window (stories.media_purge_after).
 * Keeps DB rows for audit; clears scheduled purge and media URL so clients do not load stale keys.
 */
async function purgeDueStoryMedia() {
  const res = await query(
    `SELECT id, user_id
     FROM stories
     WHERE deleted_at IS NOT NULL
       AND media_purge_after IS NOT NULL
       AND media_purge_after <= NOW()
     ORDER BY media_purge_after ASC
     LIMIT $1::int`,
    [STORY_MEDIA_PURGE_BATCH]
  );

  let purgedCount = 0;
  for (const row of res.rows) {
    const key = s3Media.buildStoryObjectKey(row.user_id, row.id);
    try {
      await s3Media.deleteObjectByKey(key);
    } catch (_) {
      /* Leave media_purge_after set so the next poll retries (e.g. transient IAM / network). */
      continue;
    }
    await query(
      `UPDATE stories
       SET media_purge_after = NULL,
           media_url = ''
       WHERE id = $1::uuid`,
      [row.id]
    );
    purgedCount += 1;
  }

  return { purgedCount, scanned: res.rows.length };
}

module.exports = {
  expireStalePendingPhotosForUser,
  normalizePhotoOrdersForUser,
  purgeDueStoryMedia,
  STALE_PENDING_HOURS,
  STORY_MEDIA_PURGE_BATCH,
};
