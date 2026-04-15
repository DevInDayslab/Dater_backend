CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_country_code VARCHAR(8) NOT NULL DEFAULT '+91',
    phone_number VARCHAR(20) NOT NULL,
    phone_e164 VARCHAR(24) UNIQUE,
    is_phone_verified BOOLEAN NOT NULL DEFAULT FALSE,
    name VARCHAR(80),
    age_years SMALLINT CHECK (age_years BETWEEN 10 AND 100),
    date_of_birth DATE,
    underage_until TIMESTAMPTZ,
    age_agreement_timestamp TIMESTAMPTZ,
    gender VARCHAR(64),
    gender_main VARCHAR(32),
    show_gender_on_profile BOOLEAN NOT NULL DEFAULT TRUE,
    marital_status VARCHAR(40),
    height_inches SMALLINT CHECK (height_inches BETWEEN 36 AND 96),
    drinking VARCHAR(64),
    smoking VARCHAR(64),
    exercise VARCHAR(64),
    religion VARCHAR(64),
    education VARCHAR(64),
    star_sign VARCHAR(32),
    kids VARCHAR(64),
    political_leanings VARCHAR(64),
    pets VARCHAR(64),
    location GEOMETRY(Point, 4326),
    location_granted BOOLEAN NOT NULL DEFAULT FALSE,
    notifications_granted BOOLEAN NOT NULL DEFAULT FALSE,
    onboarding_step VARCHAR(64) NOT NULL DEFAULT 'auth_enter_number',
    onboarding_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    onboarding_completed_at TIMESTAMPTZ,
    is_banned BOOLEAN NOT NULL DEFAULT FALSE,
    is_verified BOOLEAN NOT NULL DEFAULT FALSE,
    is_premium BOOLEAN NOT NULL DEFAULT FALSE,
    last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_users_phone UNIQUE (phone_country_code, phone_number),
    CONSTRAINT chk_users_age_or_dob_present CHECK (
        age_years IS NOT NULL OR date_of_birth IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_users_location_gist ON users USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_users_last_active_at_desc ON users (last_active_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_onboarding_updated_at ON users (onboarding_updated_at);
CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users (deleted_at);

CREATE TABLE IF NOT EXISTS user_gender_more_options (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    gender_option VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, gender_option)
);

CREATE TABLE IF NOT EXISTS user_dating_preferences (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    preferred_gender VARCHAR(32) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, preferred_gender)
);

CREATE TABLE IF NOT EXISTS user_looking_for (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    looking_for_option VARCHAR(80) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, looking_for_option)
);

CREATE TABLE IF NOT EXISTS user_interests (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    interest VARCHAR(80) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, interest)
);

CREATE TABLE IF NOT EXISTS user_photos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    photo_url TEXT NOT NULL,
    photo_order SMALLINT NOT NULL CHECK (photo_order >= 1),
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_photos_user_order
    ON user_photos(user_id, photo_order)
    WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS auth_otp_challenges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_e164 VARCHAR(24) NOT NULL,
    otp_code_hash TEXT NOT NULL,
    captcha_required BOOLEAN NOT NULL DEFAULT FALSE,
    attempts SMALLINT NOT NULL DEFAULT 0,
    max_attempts SMALLINT NOT NULL DEFAULT 5,
    expires_at TIMESTAMPTZ NOT NULL,
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_otp_phone_created_at
    ON auth_otp_challenges (phone_e164, created_at DESC);

CREATE TABLE IF NOT EXISTS user_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    jwt_id UUID NOT NULL UNIQUE,
    device_id VARCHAR(128),
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_last_seen_desc
    ON user_sessions (user_id, last_seen_at DESC);
