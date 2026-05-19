-- GENDER_MISMATCH uses FAILED_MODERATION + deleted_at (hard reject). PENDING_GENDER_REVIEW reserved for future admin tooling.
COMMENT ON COLUMN user_photos.moderation_status IS
    'APPROVED | PENDING_MODERATION | FAILED_MODERATION | PENDING_GENDER_REVIEW (reserved)';
