const { query } = require("../config/db");
const s3Media = require("../services/s3Media.service");
const photoModeration = require("../services/photoModeration.service");
const photoMaintenance = require("../services/photoMaintenance.service");
const verificationService = require("../services/verification.service");
const profileMeExtension = require("../services/profileMeExtension.service");
const { debugLog } = require("../utils/serverDebugLog");
const photoUploadDebugLog = require("../utils/photoUploadDebugLog");

function normalizeBlurHash(raw) {
  if (raw == null || typeof raw !== "string") return null;
  const s = raw.trim();
  if (s.length < 6 || s.length > 100) return null;
  if (/\s/.test(s)) return null;
  return s;
}

function isS3ObjectMissingError(err) {
  const candidates = [err, err?.cause].filter(Boolean);
  for (const e of candidates) {
    const name = String(e?.name || "");
    const code = String(e?.Code || "");
    const msg = String(e?.message || "").toLowerCase();
    const http = e?.$metadata?.httpStatusCode;
    if (name === "NoSuchKey" || code === "NoSuchKey") return true;
    if (msg.includes("the specified key does not exist")) return true;
    if (msg.includes("nosuchkey")) return true;
    if (http === 404 && msg.includes("key")) return true;
  }
  return false;
}

function photoUrlIdentity(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const q = s.indexOf("?");
  return (q >= 0 ? s.slice(0, q) : s).trim();
}

/** Staging slot for replacement uploads: target slot N → order 100+N until moderation passes. */
const PENDING_REPLACEMENT_ORDER_OFFSET = 100;

function stagingOrderForSlot(photoOrder) {
  return PENDING_REPLACEMENT_ORDER_OFFSET + photoOrder;
}

async function softDeletePhotoRows(userId, rows) {
  for (const row of rows) {
    if (row.s3_key) {
      try {
        await s3Media.deleteObjectByKey(row.s3_key);
      } catch (_) {
        /* best-effort */
      }
    }
  }
}

async function softDeletePhotosAtOrders(userId, photoOrders, { approvedOnly = false } = {}) {
  if (!photoOrders.length) return;
  const moderationClause = approvedOnly ? " AND moderation_status = 'APPROVED'" : "";
  const res = await query(
    `UPDATE user_photos
     SET deleted_at = NOW(),
         moderation_status = 'FAILED_MODERATION'
     WHERE user_id = $1
       AND photo_order = ANY($2::smallint[])
       AND deleted_at IS NULL${moderationClause}
     RETURNING s3_key`,
    [userId, photoOrders]
  );
  await softDeletePhotoRows(userId, res.rows);
  return res.rowCount;
}

/**
 * After moderation passes: move staged replacement (order 100+N) onto slot N and remove prior approved photo.
 */
async function finalizeApprovedPhotoSlot(userId, photoId, photoOrder) {
  if (photoOrder <= PENDING_REPLACEMENT_ORDER_OFFSET) {
    await query(
      `UPDATE user_photos
       SET is_primary = ($2 = 1)
       WHERE id = $1 AND user_id = $3`,
      [photoId, photoOrder, userId]
    );
    return;
  }

  const targetOrder = photoOrder - PENDING_REPLACEMENT_ORDER_OFFSET;
  if (!Number.isInteger(targetOrder) || targetOrder < 1 || targetOrder > 6) {
    throw new Error(`Invalid staged photo_order ${photoOrder}`);
  }

  await softDeletePhotosAtOrders(userId, [targetOrder], { approvedOnly: true });

  await query(
    `UPDATE user_photos
     SET photo_order = $3,
         is_primary = ($3 = 1)
     WHERE id = $1 AND user_id = $2`,
    [photoId, userId, targetOrder]
  );

  debugLog("photo_replacement_finalized", { userId, photoId, targetOrder });
}

async function rejectPhotoHard(userId, photoId, s3Key, code, extra = {}) {
  const { rejectStep, rejectDetail, ...clientExtra } = extra;
  if (rejectStep) {
    photoUploadDebugLog.logPhotoConfirmRejected(
      { userId, photoId, s3Key: s3Key || null },
      rejectStep,
      code,
      rejectDetail || {}
    );
  }
  if (s3Key) {
    try {
      await s3Media.deleteObjectByKey(s3Key);
    } catch (_) {
      /* best-effort */
    }
  }
  await query(
    `UPDATE user_photos
     SET deleted_at = NOW(),
         moderation_status = 'FAILED_MODERATION'
     WHERE id = $1 AND user_id = $2`,
    [photoId, userId]
  );
  const data = photoUploadDebugLog.attachRejectDebugToPayload(
    {
      moderationPassed: false,
      photoId,
      code,
      ...clientExtra,
    },
    rejectStep || "UNKNOWN",
    rejectDetail || {}
  );
  return {
    success: true,
    data,
  };
}

/**
 * POST /me/photos/presign
 * Body: { photoOrder: number, blurHash?: string } — 1..6, slot order (1 = front / primary).
 */
async function presignPhotoUpload(req, res) {
  try {
    const userId = req.auth.userId;
    await photoMaintenance.expireStalePendingPhotosForUser(userId);
    await photoMaintenance.normalizePhotoOrdersForUser(userId);

    const photoOrder = Number(req.body?.photoOrder);
    if (!Number.isInteger(photoOrder) || photoOrder < 1 || photoOrder > 6) {
      return res.status(400).json({
        success: false,
        message: "photoOrder must be an integer between 1 and 6",
      });
    }

    const approvedAtSlot = await query(
      `SELECT id
       FROM user_photos
       WHERE user_id = $1
         AND photo_order = $2
         AND deleted_at IS NULL
         AND moderation_status = 'APPROVED'
       LIMIT 1`,
      [userId, photoOrder]
    );
    const isReplacement = approvedAtSlot.rows.length > 0;
    let insertOrder = photoOrder;

    if (isReplacement) {
      // Keep the current approved photo until /confirm succeeds.
      insertOrder = stagingOrderForSlot(photoOrder);
      await softDeletePhotosAtOrders(userId, [insertOrder]);
    } else {
      await softDeletePhotosAtOrders(userId, [photoOrder]);
    }

    const photoId = s3Media.newPhotoId();
    const s3Key = s3Media.buildUserPhotoObjectKey(userId, photoId);
    const { uploadUrl, publicUrl } = await s3Media.getPresignedPutUrl({ key: s3Key });
    const blurHash = normalizeBlurHash(req.body?.blurHash);

    await query(
      `INSERT INTO user_photos (
         id, user_id, photo_url, photo_order, is_primary, s3_key, moderation_status, blur_hash, uploaded_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'PENDING_MODERATION', $7, NOW())`,
      [photoId, userId, publicUrl, insertOrder, insertOrder === 1, s3Key, blurHash]
    );

    debugLog("photo_presign_ok", {
      userId,
      photoId,
      photoOrder,
      insertOrder,
      isReplacement,
      s3Key,
      contentType: "image/webp",
      blurHashStored: Boolean(blurHash),
    });

    return res.status(200).json({
      success: true,
      message: "Presigned upload URL issued",
      data: {
        photoId,
        uploadUrl,
        publicUrl,
        s3Key,
        photoOrder,
        contentType: "image/webp",
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to create presigned upload",
      error: error.message,
    });
  }
}

/**
 * POST /me/photos/:photoId/confirm
 * After client PUT to S3: run Rekognition; delete object + row on failure.
 */
async function confirmPhotoUpload(req, res) {
  try {
    const userId = req.auth.userId;
    await photoMaintenance.expireStalePendingPhotosForUser(userId);

    const photoId = req.params.photoId;
    if (!photoId || typeof photoId !== "string") {
      return res.status(400).json({ success: false, message: "photoId is required" });
    }

    const rowResult = await query(
      `SELECT id, s3_key, moderation_status, photo_url, blur_hash, photo_order
       FROM user_photos
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       LIMIT 1`,
      [photoId, userId]
    );
    const row = rowResult.rows[0];
    if (!row) {
      return res.status(404).json({ success: false, message: "Photo not found" });
    }

    if (row.moderation_status === "APPROVED") {
      debugLog("photo_confirm_skip_already_approved", { userId, photoId: row.id });
      return res.status(200).json({
        success: true,
        data: {
          moderationPassed: true,
          photoId: row.id,
          photoUrl: row.photo_url,
          blurHash: row.blur_hash || null,
        },
      });
    }

    if (!row.s3_key) {
      return res.status(400).json({
        success: false,
        message: "Photo record missing storage key",
      });
    }

    const confirmCtx = {
      userId,
      photoId: row.id,
      photoOrder: row.photo_order,
      s3Key: row.s3_key,
    };

    let scan = null;
    try {
      scan = await photoModeration.scanS3ObjectForUploadValidation(row.s3_key);
      photoUploadDebugLog.logPhotoConfirmScan(confirmCtx, scan);
    } catch (e) {
      if (isS3ObjectMissingError(e)) {
        debugLog("photo_confirm_s3_missing", { userId, photoId: row.id, s3Key: row.s3_key });
        return res.status(409).json({
          success: false,
          code: "S3_OBJECT_MISSING",
          message:
            "Photo file is not in storage yet. Complete the PUT to the presigned URL, then call confirm again.",
        });
      }
      debugLog("photo_confirm_moderation_unavailable", {
        userId,
        photoId: row.id,
        error: e.message,
      });
      return res.status(502).json({
        success: false,
        message: "Moderation service unavailable",
        error: e.message,
      });
    }

    if (scan.moderation.failedModeration) {
      const policyHits = scan.moderation.policyHits ?? [];
      return res.status(200).json(
        await rejectPhotoHard(userId, row.id, row.s3_key, "FAILED_MODERATION", {
          rejectStep: "MODERATION",
          rejectDetail: {
            policyHits,
            labelsAtThreshold: scan.moderation.labelsAtThreshold ?? [],
            hint: "Rekognition moderation labels triggered NSFW/violence/weapons policy",
          },
        })
      );
    }

    if (!scan.facePresence.passed) {
      const faceCode = scan.facePresence.code || "FACE_NOT_DETECTED";
      return res.status(200).json(
        await rejectPhotoHard(userId, row.id, row.s3_key, faceCode, {
          rejectStep: "FACE_PRESENCE",
          rejectDetail: {
            reason: scan.facePresence.reason ?? null,
            faceCount: scan.facePresence.faceCount,
            primaryConfidence: scan.facePresence.primaryConfidence,
            primaryAreaFraction: scan.facePresence.primaryAreaFraction,
            multipleFaces: scan.facePresence.multipleFaces === true,
            facesDetected: photoUploadDebugLog.serializeFacesForLog(scan.faceDetails),
            hint:
              scan.facePresence.reason === "face_too_small"
                ? "Primary face bbox below minimum area fraction"
                : scan.facePresence.faceCount === 0
                  ? "No faces in DetectFaces response"
                  : "Primary face confidence below threshold",
          },
          multipleFaces: scan.facePresence.multipleFaces === true,
        })
      );
    }

    let faceResult;
    try {
      faceResult = await verificationService.assertNewPhotoMatchesVerificationAnchor(
        userId,
        row.s3_key,
        row.id,
        confirmCtx
      );
    } catch (e) {
      return res.status(200).json(
        await rejectPhotoHard(userId, row.id, row.s3_key, e.code || "FACE_MATCH_ERROR", {
          rejectStep: "FACE_COMPARE_ERROR",
          rejectDetail: { error: e.message, hint: "CompareFaces anchor step threw" },
        })
      );
    }

    if (!faceResult.skipped && !faceResult.ok) {
      return res.status(200).json(
        await rejectPhotoHard(userId, row.id, row.s3_key, "FACE_MISMATCH", {
          rejectStep: "FACE_COMPARE",
          rejectDetail: {
            similarity: faceResult.similarity,
            minRequired: verificationService.FACE_MATCH_MIN_SIMILARITY,
            hint: "New photo did not match verification selfie anchor",
          },
        })
      );
    }

    photoUploadDebugLog.logPhotoConfirmApproved(confirmCtx, {
      faceCompareSkipped: faceResult.skipped === true,
      faceCompareSimilarity: faceResult.similarity ?? null,
    });

    await query(
      `UPDATE user_photos
       SET moderation_status = 'APPROVED'
       WHERE id = $1 AND user_id = $2`,
      [photoId, userId]
    );

    await finalizeApprovedPhotoSlot(userId, row.id, row.photo_order);

    const acct = await query(
      `SELECT account_state FROM users WHERE id = $1 LIMIT 1`,
      [userId]
    );
    const accountState = String(acct.rows[0]?.account_state || "ACTIVE");
    if (accountState === "HIDDEN_BY_MODERATION") {
      const cntRes = await query(
        `SELECT COUNT(*)::int AS cnt
         FROM user_photos
         WHERE user_id = $1
           AND deleted_at IS NULL
           AND moderation_status = 'APPROVED'`,
        [userId]
      );
      const approvedCount = cntRes.rows[0]?.cnt ?? 0;
      if (approvedCount >= 2) {
        await query(
          `UPDATE users
           SET account_state = 'ACTIVE'::account_state_enum,
               is_verified = TRUE,
               verified_at = COALESCE(verified_at, NOW()),
               updated_at = NOW()
           WHERE id = $1`,
          [userId]
        );
        debugLog("photo_confirm_unhidden_after_match", { userId, approvedCount });
      }
    }

    await profileMeExtension.recomputeAndPersistProfileCompletion(userId);

    debugLog("photo_moderation_approved", { userId, photoId: row.id });

    return res.status(200).json({
      success: true,
      data: {
        moderationPassed: true,
        photoId: row.id,
        photoUrl: row.photo_url,
        blurHash: row.blur_hash || null,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to confirm photo upload",
      error: error.message,
    });
  }
}

/**
 * POST /me/photos/delete
 * Body: { photoOrder: number } — 1..6 slot order.
 * Soft-deletes selected slot, shifts later photos up, and reassigns primary to slot 1.
 */
async function deletePhotoByOrder(req, res) {
  try {
    const userId = req.auth.userId;
    const photoOrder = Number(req.body?.photoOrder);
    if (!Number.isInteger(photoOrder) || photoOrder < 1 || photoOrder > 6) {
      return res.status(400).json({
        success: false,
        message: "photoOrder must be an integer between 1 and 6",
      });
    }

    const countRes = await query(
      `SELECT COUNT(*)::int AS cnt
       FROM user_photos
       WHERE user_id = $1
         AND deleted_at IS NULL
         AND moderation_status = 'APPROVED'`,
      [userId]
    );
    const activeCount = countRes.rows[0]?.cnt ?? 0;
    if (activeCount <= 2) {
      return res.status(400).json({
        success: false,
        code: "MIN_2_PHOTOS_REQUIRED",
        message: "You need minimum 2 photos",
      });
    }

    const targetRes = await query(
      `UPDATE user_photos
       SET deleted_at = NOW(),
           moderation_status = 'FAILED_MODERATION'
       WHERE user_id = $1
         AND photo_order = $2
         AND deleted_at IS NULL
       RETURNING id, s3_key`,
      [userId, photoOrder]
    );
    const target = targetRes.rows[0];
    if (!target) {
      return res.status(404).json({
        success: false,
        message: "Photo not found for this slot",
      });
    }

    if (target.s3_key) {
      try {
        await s3Media.deleteObjectByKey(target.s3_key);
      } catch (e) {
        // best-effort cleanup
      }
    }

    await query(
      `UPDATE user_photos
       SET photo_order = photo_order - 1
       WHERE user_id = $1
         AND deleted_at IS NULL
         AND photo_order > $2`,
      [userId, photoOrder]
    );

    await query(
      `UPDATE user_photos
       SET is_primary = (photo_order = 1)
       WHERE user_id = $1
         AND deleted_at IS NULL`,
      [userId]
    );

    debugLog("photo_deleted_and_reordered", {
      userId,
      photoOrder,
      deletedPhotoId: target.id,
    });

    return res.status(200).json({
      success: true,
      message: "Photo deleted",
      data: { photoOrder },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to delete photo",
      error: error.message,
    });
  }
}

/**
 * POST /me/photos/reorder
 * Body: { orderedPhotoUrls: string[] } — full ordered active list (front first).
 */
async function reorderPhotos(req, res) {
  try {
    const userId = req.auth.userId;
    const orderedPhotoUrls = Array.isArray(req.body?.orderedPhotoUrls)
      ? req.body.orderedPhotoUrls.map((v) => String(v || "").trim()).filter(Boolean)
      : [];
    const orderedIdentities = orderedPhotoUrls.map(photoUrlIdentity).filter(Boolean);
    if (orderedIdentities.length < 1 || orderedIdentities.length > 6) {
      return res.status(400).json({
        success: false,
        message: "orderedPhotoUrls must contain between 1 and 6 URLs",
      });
    }
    if (new Set(orderedIdentities).size !== orderedIdentities.length) {
      return res.status(400).json({
        success: false,
        message: "orderedPhotoUrls must not contain duplicates",
      });
    }

    const existingRes = await query(
      `SELECT id, photo_url
       FROM user_photos
       WHERE user_id = $1
         AND deleted_at IS NULL
         AND moderation_status = 'APPROVED'
       ORDER BY photo_order ASC, uploaded_at ASC, id ASC`,
      [userId]
    );
    const existing = existingRes.rows;
    if (existing.length !== orderedIdentities.length) {
      return res.status(400).json({
        success: false,
        message: "orderedPhotoUrls count must match active photos count",
      });
    }
    const existingByIdentity = new Map(
      existing.map((r) => [photoUrlIdentity(r.photo_url), r.id]).filter(([k]) => Boolean(k))
    );
    if (existingByIdentity.size !== existing.length) {
      return res.status(400).json({
        success: false,
        message: "Server photos contain duplicate identities; cannot reorder safely",
      });
    }
    const orderedIds = [];
    for (const identity of orderedIdentities) {
      const id = existingByIdentity.get(identity);
      if (!id) {
        return res.status(400).json({
          success: false,
          message: "orderedPhotoUrls must exactly match active server photos",
        });
      }
      orderedIds.push(id);
    }

    await query("BEGIN");
    try {
      // Step 1: bump current orders to avoid unique collisions.
      await query(
        `UPDATE user_photos
         SET photo_order = photo_order + 100
         WHERE user_id = $1
           AND deleted_at IS NULL`,
        [userId]
      );

      // Step 2: assign new order by provided array position.
      const caseClauses = orderedIds.map((id, idx) => `WHEN '${id}'::uuid THEN ${idx + 1}`).join(" ");
      await query(
        `UPDATE user_photos
         SET photo_order = CASE id ${caseClauses} ELSE photo_order END,
             is_primary = FALSE
         WHERE user_id = $1
           AND deleted_at IS NULL
           AND id = ANY($2::uuid[])`,
        [userId, orderedIds]
      );
      await query(
        `UPDATE user_photos
         SET is_primary = (photo_order = 1)
         WHERE user_id = $1
           AND deleted_at IS NULL`,
        [userId]
      );
      await query("COMMIT");
    } catch (e) {
      await query("ROLLBACK");
      throw e;
    }

    debugLog("photos_reordered", { userId, photoCount: orderedIds.length });
    return res.status(200).json({
      success: true,
      message: "Photos reordered",
      data: { photoCount: orderedIds.length },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to reorder photos",
      error: error.message,
    });
  }
}

module.exports = {
  presignPhotoUpload,
  confirmPhotoUpload,
  deletePhotoByOrder,
  reorderPhotos,
};
