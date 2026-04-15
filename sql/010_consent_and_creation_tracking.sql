ALTER TABLE users
    ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS privacy_accepted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS consent_source VARCHAR(64),
    ADD COLUMN IF NOT EXISTS account_created_ip_address INET,
    ADD COLUMN IF NOT EXISTS account_created_device_id VARCHAR(128),
    ADD COLUMN IF NOT EXISTS account_created_user_agent TEXT,
    ADD COLUMN IF NOT EXISTS underage_attempted_at TIMESTAMPTZ;
