-- Identity verification: Face Liveness sessions + stored verification selfie anchor.

CREATE TABLE IF NOT EXISTS user_verification_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    aws_session_id TEXT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'CREATED',
    liveness_confidence NUMERIC(7, 3),
    failure_reason TEXT,
    matched_count INTEGER,
    removed_count INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_user_verification_sessions_aws UNIQUE (aws_session_id)
);

CREATE INDEX IF NOT EXISTS idx_user_verification_sessions_user_created
    ON user_verification_sessions (user_id, created_at DESC);

COMMENT ON TABLE user_verification_sessions IS 'AWS Rekognition Face Liveness session tracking per verification attempt.';

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS verification_selfie_s3_key TEXT,
    ADD COLUMN IF NOT EXISTS verification_last_attempt_at TIMESTAMPTZ;

COMMENT ON COLUMN users.verification_selfie_s3_key IS 'S3 key for last successful liveness reference (webp), used for future photo CompareFaces.';
