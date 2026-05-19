const sharp = require("sharp");
const {
  RekognitionClient,
  CreateFaceLivenessSessionCommand,
  GetFaceLivenessSessionResultsCommand,
  CompareFacesCommand,
} = require("@aws-sdk/client-rekognition");
const { query, pool } = require("../config/db");
const s3Media = require("./s3Media.service");
const { debugLog } = require("../utils/serverDebugLog");
const photoUploadDebugLog = require("../utils/photoUploadDebugLog");

const region = process.env.AWS_REGION || "ap-south-1";
const rekognition = new RekognitionClient({ region });

const LIVENESS_MIN_CONFIDENCE = 90;
const FACE_MATCH_MIN_SIMILARITY = 90;
// Selective cleanup policy: verification succeeds when at least two approved
// profile photos match the selfie; non-matching approved photos are removed.
const MIN_MATCHING_PHOTOS_FOR_VERIFICATION = 2;

function verificationSelfieKey(userId) {
  return `verifications/selfies/${userId}.webp`;
}

async function s3BytesToJpegBuffer(raw) {
  return sharp(raw).rotate().jpeg({ quality: 88, mozjpeg: true }).toBuffer();
}

async function normalizeForCompareFacesJpeg(rawBytes) {
  const img = sharp(rawBytes, { failOn: "none" }).rotate();
  const meta = await img.metadata();
  const width = Number(meta.width || 0);
  const height = Number(meta.height || 0);
  const needsUpscale = width < 120 || height < 120;
  return img
    .resize({
      width: needsUpscale ? Math.max(120, width || 120) : undefined,
      height: needsUpscale ? Math.max(120, height || 120) : undefined,
      fit: "inside",
      withoutEnlargement: !needsUpscale,
    })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
}

async function fetchLivenessSessionRow(userId, awsSessionId) {
  const r = await query(
    `SELECT id, user_id, aws_session_id, status
     FROM user_verification_sessions
     WHERE aws_session_id = $1 AND user_id = $2
     LIMIT 1`,
    [awsSessionId, userId]
  );
  return r.rows[0] || null;
}

async function getFaceLivenessResult(awsSessionId) {
  const out = await rekognition.send(
    new GetFaceLivenessSessionResultsCommand({
      SessionId: awsSessionId,
    })
  );
  return out;
}

/**
 * @returns {Buffer|null}
 */
function extractReferenceImageBytes(livenessOut) {
  const ref = livenessOut.ReferenceImage;
  if (!ref) return null;
  if (ref.Bytes && ref.Bytes.length) return Buffer.from(ref.Bytes);
  return null;
}

async function compareSelfieToTargetJpeg(selfieJpeg, targetJpeg) {
  const out = await rekognition.send(
    new CompareFacesCommand({
      SimilarityThreshold: FACE_MATCH_MIN_SIMILARITY,
      SourceImage: { Bytes: selfieJpeg },
      TargetImage: { Bytes: targetJpeg },
    })
  );
  const matches = out.FaceMatches || [];
  let best = 0;
  for (const m of matches) {
    const s = Number(m.Similarity || 0);
    if (s > best) best = s;
  }
  return best;
}

/**
 * Create AWS Face Liveness session and persist row for this user.
 */
async function createLivenessSessionForUser(userId) {
  const awsOut = await rekognition.send(new CreateFaceLivenessSessionCommand({}));
  const sessionId = awsOut.SessionId;
  if (!sessionId) {
    throw Object.assign(new Error("AWS did not return a liveness session id"), { code: "AWS_TEMPORARY_ERROR" });
  }

  await query(
    `INSERT INTO user_verification_sessions (user_id, aws_session_id, status, created_at, updated_at)
     VALUES ($1, $2, 'CREATED', NOW(), NOW())`,
    [userId, sessionId]
  );

  debugLog("verify_liveness_session_created", { userId, sessionId });

  return { sessionId, region };
}

/**
 * After mobile liveness UI completes: validate confidence and return reference image as base64.
 */
async function getLivenessPreviewForUser(userId, awsSessionId) {
  const row = await fetchLivenessSessionRow(userId, awsSessionId);
  if (!row) {
    const err = new Error("Unknown or expired verification session");
    err.code = "SESSION_NOT_FOUND";
    throw err;
  }

  const livenessOut = await getFaceLivenessResult(awsSessionId);
  const status = String(livenessOut.Status || "");
  const confidence = Number(livenessOut.Confidence ?? 0);
  const refBytes = extractReferenceImageBytes(livenessOut);

  /** Attach AWS reference frame when present so the app retry UI can show the captured selfie, not the profile photo. */
  function attachReferenceSnapshotIfUsable(err) {
    if (refBytes && refBytes.length >= 100) {
      err.previewImageBase64 = refBytes.toString("base64");
      err.previewContentType = "image/jpeg";
    }
    return err;
  }

  await query(
    `UPDATE user_verification_sessions
     SET status = 'PREVIEWED',
         liveness_confidence = $2,
         updated_at = NOW()
     WHERE id = $1`,
    [row.id, confidence]
  );

  if (status !== "SUCCEEDED") {
    throw attachReferenceSnapshotIfUsable(
      Object.assign(new Error(`Liveness not succeeded (status=${status})`), {
        code: "LIVENESS_FAILED",
        details: { status, confidence },
      })
    );
  }
  if (confidence < LIVENESS_MIN_CONFIDENCE) {
    throw attachReferenceSnapshotIfUsable(
      Object.assign(new Error(`Liveness confidence too low (${confidence})`), {
        code: "LIVENESS_FAILED",
        details: { status, confidence },
      })
    );
  }

  if (!refBytes || refBytes.length < 100) {
    const err = new Error("No reference image returned from liveness");
    err.code = "LIVENESS_FAILED";
    throw err;
  }

  const previewBase64 = refBytes.toString("base64");
  return {
    previewImageBase64: previewBase64,
    contentType: "image/jpeg",
    confidence,
    sessionId: awsSessionId,
  };
}

async function loadApprovedPhotoRows(client, userId) {
  const r = await client.query(
    `SELECT id, s3_key, photo_order
     FROM user_photos
     WHERE user_id = $1
       AND deleted_at IS NULL
       AND moderation_status = 'APPROVED'
       AND s3_key IS NOT NULL
     ORDER BY photo_order ASC`,
    [userId]
  );
  return r.rows;
}

async function renormalizePhotoSlots(client, userId) {
  await client.query(
    `UPDATE user_photos
     SET photo_order = photo_order + 100
     WHERE user_id = $1 AND deleted_at IS NULL`,
    [userId]
  );
  const r = await client.query(
    `SELECT id
     FROM user_photos
     WHERE user_id = $1 AND deleted_at IS NULL
     ORDER BY photo_order ASC, uploaded_at ASC`,
    [userId]
  );
  let order = 1;
  for (const row of r.rows) {
    await client.query(
      `UPDATE user_photos
       SET photo_order = $2,
           is_primary = $3
       WHERE id = $1`,
      [row.id, order, order === 1]
    );
    order += 1;
  }
}

async function persistSelfieWebpToS3(userId, referenceBytes) {
  const key = verificationSelfieKey(userId);
  const webp = await sharp(referenceBytes).rotate().webp({ quality: 82 }).toBuffer();
  await s3Media.putObjectBytes({
    key,
    body: webp,
    contentType: "image/webp",
  });
  return key;
}

/**
 * Compare liveness reference to each approved profile photo; remove non-matching.
 * Always persists selfie when liveness succeeded (even if verification fails) for hidden-recovery anchor.
 */
async function completeLivenessVerification(userId, awsSessionId) {
  const row = await fetchLivenessSessionRow(userId, awsSessionId);
  if (!row) {
    const err = new Error("Unknown or expired verification session");
    err.code = "SESSION_NOT_FOUND";
    throw err;
  }

  const livenessOut = await getFaceLivenessResult(awsSessionId);
  const status = String(livenessOut.Status || "");
  const confidence = Number(livenessOut.Confidence ?? 0);
  if (status !== "SUCCEEDED" || confidence < LIVENESS_MIN_CONFIDENCE) {
    const err = new Error("Liveness did not pass");
    err.code = "LIVENESS_FAILED";
    err.details = { status, confidence };
    throw err;
  }

  const refBytes = extractReferenceImageBytes(livenessOut);
  if (!refBytes || refBytes.length < 100) {
    const err = new Error("No reference image for verification");
    err.code = "LIVENESS_FAILED";
    throw err;
  }

  let selfieJpeg;
  try {
    selfieJpeg = await normalizeForCompareFacesJpeg(refBytes);
  } catch (e) {
    const err = new Error("Could not decode reference image");
    err.code = "LIVENESS_FAILED";
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const photoRows = await loadApprovedPhotoRows(client, userId);
    if (photoRows.length === 0) {
      await client.query("ROLLBACK");
      const err = new Error("No approved profile photos to compare");
      err.code = "NO_APPROVED_PHOTOS";
      throw err;
    }

    const matchingIds = [];
    const nonMatching = [];

    for (const p of photoRows) {
      let targetJpeg;
      try {
        const raw = await s3Media.getObjectBytes(p.s3_key);
        targetJpeg = await normalizeForCompareFacesJpeg(raw);
      } catch (e) {
        debugLog("verify_compare_s3_read_failed", { userId, photoId: p.id, error: e.message });
        nonMatching.push(p);
        continue;
      }

      let best = 0;
      try {
        best = await compareSelfieToTargetJpeg(selfieJpeg, targetJpeg);
      } catch (e) {
        debugLog("verify_compare_faces_failed", {
          userId,
          photoId: p.id,
          error: e.message,
          selfieBytes: selfieJpeg.length,
          targetBytes: targetJpeg.length,
        });
        best = 0;
      }

      if (best >= FACE_MATCH_MIN_SIMILARITY) {
        matchingIds.push(p.id);
      } else {
        nonMatching.push(p);
      }
    }

    for (const p of nonMatching) {
      try {
        await s3Media.deleteObjectByKey(p.s3_key);
      } catch (e) {
        debugLog("verify_delete_nonmatch_s3_best_effort", { userId, photoId: p.id, error: e.message });
      }
      await client.query(
        `UPDATE user_photos
         SET deleted_at = NOW(),
             moderation_status = 'FAILED_MODERATION'
         WHERE id = $1 AND user_id = $2`,
        [p.id, userId]
      );
    }

    await renormalizePhotoSlots(client, userId);

    let selfieKey;
    try {
      selfieKey = await persistSelfieWebpToS3(userId, refBytes);
    } catch (e) {
      await client.query("ROLLBACK");
      const err = new Error("Failed to store verification selfie");
      err.code = "AWS_TEMPORARY_ERROR";
      throw err;
    }

    const matchedCount = matchingIds.length;
    const removedCount = nonMatching.length;

    const remaining = await client.query(
      `SELECT COUNT(*)::int AS c
       FROM user_photos
       WHERE user_id = $1 AND deleted_at IS NULL AND moderation_status = 'APPROVED'`,
      [userId]
    );
    const remainingApproved = remaining.rows[0]?.c ?? 0;

    debugLog("verify_match_outcome", {
      userId,
      awsSessionId,
      matchedCount,
      removedCount,
      remainingApproved,
      minRequired: MIN_MATCHING_PHOTOS_FOR_VERIFICATION,
    });

    if (matchedCount < MIN_MATCHING_PHOTOS_FOR_VERIFICATION || remainingApproved < MIN_MATCHING_PHOTOS_FOR_VERIFICATION) {
      await client.query(
        `UPDATE users
         SET verification_selfie_s3_key = $2,
             verification_last_attempt_at = NOW(),
             is_verified = FALSE,
             account_state = 'HIDDEN_BY_MODERATION'::account_state_enum,
             updated_at = NOW()
         WHERE id = $1`,
        [userId, selfieKey]
      );
      await client.query(
        `UPDATE user_verification_sessions
         SET status = 'FAILED',
             failure_reason = 'NO_MATCHING_PHOTOS',
             matched_count = $1,
             removed_count = $2,
             liveness_confidence = $3,
             updated_at = NOW()
         WHERE aws_session_id = $4`,
        [matchedCount, removedCount, confidence, awsSessionId]
      );
      await client.query("COMMIT");

      const userPhotos = await loadUserPhotosPayload(userId);
      return {
        ok: false,
        code: "NO_MATCHING_PHOTOS",
        message: "Selfie did not match any approved profile photo",
        accountState: "HIDDEN_BY_MODERATION",
        isVerified: false,
        matchedCount,
        removedCount,
        userPhotos,
      };
    }

    await client.query(
      `UPDATE users
       SET verification_selfie_s3_key = $2,
           verification_last_attempt_at = NOW(),
           verified_at = NOW(),
           is_verified = TRUE,
           account_state = 'ACTIVE'::account_state_enum,
           onboarding_completed_at = COALESCE(onboarding_completed_at, NOW()),
           updated_at = NOW()
       WHERE id = $1`,
      [userId, selfieKey]
    );

    await client.query(
      `UPDATE user_verification_sessions
       SET status = 'COMPLETED',
           failure_reason = NULL,
           matched_count = $1,
           removed_count = $2,
           liveness_confidence = $3,
           updated_at = NOW()
       WHERE aws_session_id = $4`,
      [matchedCount, removedCount, confidence, awsSessionId]
    );

    await client.query("COMMIT");

    const userPhotos = await loadUserPhotosPayload(userId);
    return {
      ok: true,
      code: "VERIFIED",
      accountState: "ACTIVE",
      isVerified: true,
      matchedCount,
      removedCount,
      userPhotos,
    };
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      /* ignore */
    }
    throw e;
  } finally {
    client.release();
  }
}

async function loadUserPhotosPayload(userId) {
  const photosRes = await query(
    `SELECT id, photo_url, photo_order, is_primary, moderation_status, blur_hash, s3_key
     FROM user_photos
     WHERE user_id = $1
       AND deleted_at IS NULL
       AND moderation_status = 'APPROVED'
     ORDER BY is_primary DESC, photo_order ASC`,
    [userId]
  );

  const rows = [];
  for (const p of photosRes.rows) {
    let readUrl = p.photo_url;
    if (p.s3_key) {
      try {
        readUrl = await s3Media.getPresignedGetUrl({ key: p.s3_key });
      } catch (e) {
        debugLog("verify_me_photo_presign_get_failed", { userId, photoId: p.id, error: e.message });
      }
    }
    rows.push({
      id: p.id,
      photoUrl: readUrl,
      photoOrder: p.photo_order,
      isPrimary: p.is_primary,
      moderationStatus: p.moderation_status,
      blurHash: p.blur_hash || null,
    });
  }
  return rows;
}

/**
 * For new uploads: require CompareFaces only after user is verified.
 * Unverified users should pass on moderation-only (NSFW/weapons/violence) checks.
 */
async function assertNewPhotoMatchesVerificationAnchor(userId, newPhotoS3Key, excludePhotoId, logCtx = {}) {
  const uRes = await query(
    `SELECT account_state, is_verified, verification_selfie_s3_key
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [userId]
  );
  const u = uRes.rows[0];
  if (!u) {
    const err = new Error("User not found");
    err.code = "USER_NOT_FOUND";
    throw err;
  }

  const accountState = String(u.account_state || "ACTIVE");
  const needsMatch = u.is_verified === true || accountState === "HIDDEN_BY_MODERATION";

  if (!needsMatch) {
    photoUploadDebugLog.logFaceCompare(
      { userId, ...logCtx },
      { skipped: true, reason: "user_not_verified", isVerified: u.is_verified === true, accountState }
    );
    return { skipped: true };
  }

  let anchorKey = u.verification_selfie_s3_key;
  let anchorSource = anchorKey ? "verification_selfie_s3_key" : null;
  if (!anchorKey) {
    const excludeId = excludePhotoId || null;
    const fb = excludeId
      ? await query(
          `SELECT s3_key
           FROM user_photos
           WHERE user_id = $1
             AND deleted_at IS NULL
             AND moderation_status = 'APPROVED'
             AND s3_key IS NOT NULL
             AND id IS DISTINCT FROM $2::uuid
           ORDER BY is_primary DESC, photo_order ASC
           LIMIT 1`,
          [userId, excludeId]
        )
      : await query(
          `SELECT s3_key
           FROM user_photos
           WHERE user_id = $1
             AND deleted_at IS NULL
             AND moderation_status = 'APPROVED'
             AND s3_key IS NOT NULL
           ORDER BY is_primary DESC, photo_order ASC
           LIMIT 1`,
          [userId]
        );
    anchorKey = fb.rows[0]?.s3_key || null;
    anchorSource = anchorKey ? "fallback_approved_profile_photo" : null;
  }

  if (!anchorKey) {
    photoUploadDebugLog.logFaceCompare(
      { userId, ...logCtx },
      { skipped: false, error: "NO_VERIFICATION_ANCHOR", isVerified: u.is_verified === true, accountState }
    );
    const err = new Error("No verification anchor available for face match");
    err.code = "NO_VERIFICATION_ANCHOR";
    throw err;
  }

  const anchorRaw = await s3Media.getObjectBytes(anchorKey);
  const newRaw = await s3Media.getObjectBytes(newPhotoS3Key);
  const anchorJpeg = await normalizeForCompareFacesJpeg(anchorRaw);
  const newJpeg = await normalizeForCompareFacesJpeg(newRaw);

  const similarity = await compareSelfieToTargetJpeg(anchorJpeg, newJpeg);
  const compareLog = {
    anchorSource,
    similarity,
    minRequired: FACE_MATCH_MIN_SIMILARITY,
    anchorJpegBytes: anchorJpeg.length,
    newJpegBytes: newJpeg.length,
  };
  if (similarity < FACE_MATCH_MIN_SIMILARITY) {
    photoUploadDebugLog.logFaceCompare({ userId, ...logCtx }, { ok: false, ...compareLog });
    return { ok: false, code: "FACE_MISMATCH", similarity };
  }
  photoUploadDebugLog.logFaceCompare({ userId, ...logCtx }, { ok: true, ...compareLog });
  return { ok: true, similarity };
}

module.exports = {
  createLivenessSessionForUser,
  getLivenessPreviewForUser,
  completeLivenessVerification,
  assertNewPhotoMatchesVerificationAnchor,
  loadUserPhotosPayload,
  verificationSelfieKey,
  FACE_MATCH_MIN_SIMILARITY,
  LIVENESS_MIN_CONFIDENCE,
};
