-- Landing page contact submissions. Does not alter mobile-app or admin tables.

CREATE TABLE IF NOT EXISTS landing_contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(120) NOT NULL,
    email VARCHAR(255) NOT NULL,
    mobile VARCHAR(20) NOT NULL,
    description TEXT NOT NULL,
    attachment_url TEXT,
    attachment_s3_key TEXT,
    ip_address INET,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_landing_contacts_created_at
    ON landing_contacts (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_landing_contacts_email_created
    ON landing_contacts (email, created_at DESC);
