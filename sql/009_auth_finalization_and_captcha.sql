-- =========================================================
-- DATABASE FLOW 9: AUTH FINALIZATION + CAPTCHA RISK
-- =========================================================

-- Allow auth-time user creation before age/dob onboarding step.
ALTER TABLE users
    DROP CONSTRAINT IF EXISTS chk_users_age_or_dob_present;

CREATE TABLE IF NOT EXISTS auth_login_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_e164 VARCHAR(24) NOT NULL,
    ip_address INET,
    device_id VARCHAR(128),
    user_agent TEXT,
    action VARCHAR(32) NOT NULL,
    status VARCHAR(16) NOT NULL,
    reason TEXT,
    requires_captcha BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_login_attempts_phone_created_desc
    ON auth_login_attempts (phone_e164, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auth_login_attempts_ip_created_desc
    ON auth_login_attempts (ip_address, created_at DESC);
