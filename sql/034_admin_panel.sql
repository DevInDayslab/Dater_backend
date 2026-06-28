-- Admin panel foundation: operator accounts, sessions, broadcast history.
-- Does not alter any mobile-app tables.

CREATE TABLE IF NOT EXISTS admin_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(120) NOT NULL,
    password_hash TEXT NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE', 'SUSPENDED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_admin_users_status
    ON admin_users (status);

CREATE TABLE IF NOT EXISTS admin_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_user_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    jwt_id UUID NOT NULL UNIQUE,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin_last_seen
    ON admin_sessions (admin_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_jwt_active
    ON admin_sessions (jwt_id)
    WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS admin_broadcasts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(50) NOT NULL,
    body VARCHAR(150) NOT NULL,
    target_audience VARCHAR(64) NOT NULL,
    deep_link TEXT,
    scheduled_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    recipients_count INTEGER NOT NULL DEFAULT 0 CHECK (recipients_count >= 0),
    sent_by_admin_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_broadcasts_sent_at_desc
    ON admin_broadcasts (sent_at DESC);
