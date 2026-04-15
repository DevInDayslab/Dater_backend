-- Moderation + S3 metadata for profile photos (presigned direct uploads).
ALTER TABLE user_photos
    ADD COLUMN IF NOT EXISTS s3_key TEXT,
    ADD COLUMN IF NOT EXISTS moderation_status VARCHAR(32) NOT NULL DEFAULT 'APPROVED';

COMMENT ON COLUMN user_photos.s3_key IS 'Object key in media bucket; used for Rekognition + delete on moderation failure.';
COMMENT ON COLUMN user_photos.moderation_status IS 'APPROVED | PENDING_MODERATION | FAILED_MODERATION';
