-- Ephemeral server-side captcha challenges for login (paired with precheck requires_captcha).

CREATE TABLE IF NOT EXISTS auth_captcha_challenges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_e164 VARCHAR(24) NOT NULL,
    answer_hmac TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    invalidated_at TIMESTAMPTZ,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_captcha_challenges_phone_created_desc
    ON auth_captcha_challenges (phone_e164, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auth_captcha_challenges_lookup
    ON auth_captcha_challenges (id, phone_e164)
    WHERE consumed_at IS NULL AND invalidated_at IS NULL;
