-- Privacy / display settings, session audit columns, deletion retention log.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS hide_my_name BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS last_logout_at TIMESTAMPTZ;

COMMENT ON COLUMN users.hide_my_name IS 'When true, outbound display name is first letter only (distinct from moderation hidden).';
COMMENT ON COLUMN users.last_login_at IS 'Last successful Dater JWT session issuance (MSG91 login flow).';
COMMENT ON COLUMN users.last_logout_at IS 'Last explicit logout timestamp for compliance.';

CREATE TABLE IF NOT EXISTS user_account_deletion_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    phone_e164 VARCHAR(24),
    account_deleted_at TIMESTAMPTZ NOT NULL,
    data_retention_until TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_account_deletion_audit_user
    ON user_account_deletion_audit (user_id, account_deleted_at DESC);

COMMENT ON TABLE user_account_deletion_audit IS 'Append-only deletion timestamps; row retained ~6 months after account_deleted_at for compliance.';
