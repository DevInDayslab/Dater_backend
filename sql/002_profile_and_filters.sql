-- =========================================================
-- DATABASE FLOW 2: PROFILE & PREFERENCES
-- Consistency rules:
-- 1) Keep profile "height" in a single source: users.height_inches
-- 2) Keep "who you want to date" in a single source: user_dating_preferences
-- 3) user_filters stores filter preferences only (ideal match side)
-- =========================================================

-- ---------------------------------------------------------
-- Expand users table (profile side)
-- ---------------------------------------------------------
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS profile_completion_percentage NUMERIC(5,2) NOT NULL DEFAULT 0
        CHECK (profile_completion_percentage >= 0 AND profile_completion_percentage <= 100),
    ADD COLUMN IF NOT EXISTS ethnicity VARCHAR(64),
    ADD COLUMN IF NOT EXISTS occupation_job_title VARCHAR(120),
    ADD COLUMN IF NOT EXISTS occupation_company VARCHAR(120),
    ADD COLUMN IF NOT EXISTS education_institution_name VARCHAR(160),
    ADD COLUMN IF NOT EXISTS education_passing_year SMALLINT
        CHECK (education_passing_year IS NULL OR education_passing_year BETWEEN 1900 AND 2100),
    ADD COLUMN IF NOT EXISTS living_in_city VARCHAR(120),
    ADD COLUMN IF NOT EXISTS home_town_city VARCHAR(120),
    ADD COLUMN IF NOT EXISTS bio TEXT,
    ADD COLUMN IF NOT EXISTS preset_message TEXT,
    ADD COLUMN IF NOT EXISTS profile_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_users_profile_completion_desc
    ON users (profile_completion_percentage DESC);

-- ---------------------------------------------------------
-- Profile relational tables (multi-select profile fields)
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_pronouns (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pronoun VARCHAR(40) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, pronoun)
);

CREATE TABLE IF NOT EXISTS user_languages (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    language VARCHAR(60) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, language)
);

CREATE TABLE IF NOT EXISTS user_written_prompts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    prompt_order SMALLINT NOT NULL CHECK (prompt_order BETWEEN 1 AND 3),
    prompt_question VARCHAR(160) NOT NULL,
    prompt_answer VARCHAR(180) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, prompt_order)
);

-- ---------------------------------------------------------
-- user_filters (ideal match side only)
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_filters (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

    -- Basic filters
    distance_pref_km INTEGER NOT NULL DEFAULT 20
        CHECK (distance_pref_km BETWEEN 2 AND 150),
    age_min SMALLINT NOT NULL DEFAULT 20
        CHECK (age_min BETWEEN 18 AND 100),
    age_max SMALLINT NOT NULL DEFAULT 36
        CHECK (age_max BETWEEN 18 AND 100),
    expand_age_range BOOLEAN NOT NULL DEFAULT FALSE,
    expand_distance BOOLEAN NOT NULL DEFAULT FALSE,
    only_verified_profiles BOOLEAN NOT NULL DEFAULT FALSE,
    preferred_location_city VARCHAR(120),

    -- Advanced scalar preferences
    min_height_inches SMALLINT CHECK (min_height_inches IS NULL OR min_height_inches BETWEEN 36 AND 96),
    max_height_inches SMALLINT CHECK (max_height_inches IS NULL OR max_height_inches BETWEEN 36 AND 96),
    show_other_people_if_run_out BOOLEAN NOT NULL DEFAULT TRUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (age_max >= age_min),
    CHECK (
        min_height_inches IS NULL
        OR max_height_inches IS NULL
        OR max_height_inches >= min_height_inches
    )
);

-- ---------------------------------------------------------
-- Filter preference tables (multi-select)
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_filter_preferred_genders (
    user_id UUID NOT NULL REFERENCES user_filters(user_id) ON DELETE CASCADE,
    gender VARCHAR(32) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, gender)
);

CREATE TABLE IF NOT EXISTS user_filter_languages (
    user_id UUID NOT NULL REFERENCES user_filters(user_id) ON DELETE CASCADE,
    language VARCHAR(60) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, language)
);

CREATE TABLE IF NOT EXISTS user_filter_marital_statuses (
    user_id UUID NOT NULL REFERENCES user_filters(user_id) ON DELETE CASCADE,
    marital_status VARCHAR(40) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, marital_status)
);

CREATE TABLE IF NOT EXISTS user_filter_looking_for (
    user_id UUID NOT NULL REFERENCES user_filters(user_id) ON DELETE CASCADE,
    looking_for_option VARCHAR(80) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, looking_for_option)
);

CREATE TABLE IF NOT EXISTS user_filter_drinking_preferences (
    user_id UUID NOT NULL REFERENCES user_filters(user_id) ON DELETE CASCADE,
    drinking_option VARCHAR(40) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, drinking_option)
);

CREATE TABLE IF NOT EXISTS user_filter_smoking_preferences (
    user_id UUID NOT NULL REFERENCES user_filters(user_id) ON DELETE CASCADE,
    smoking_option VARCHAR(40) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, smoking_option)
);

CREATE TABLE IF NOT EXISTS user_filter_exercise_preferences (
    user_id UUID NOT NULL REFERENCES user_filters(user_id) ON DELETE CASCADE,
    exercise_option VARCHAR(40) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, exercise_option)
);

CREATE TABLE IF NOT EXISTS user_filter_religion_preferences (
    user_id UUID NOT NULL REFERENCES user_filters(user_id) ON DELETE CASCADE,
    religion_option VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, religion_option)
);

CREATE TABLE IF NOT EXISTS user_filter_education_preferences (
    user_id UUID NOT NULL REFERENCES user_filters(user_id) ON DELETE CASCADE,
    education_option VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, education_option)
);

CREATE TABLE IF NOT EXISTS user_filter_star_sign_preferences (
    user_id UUID NOT NULL REFERENCES user_filters(user_id) ON DELETE CASCADE,
    star_sign_option VARCHAR(32) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, star_sign_option)
);

CREATE TABLE IF NOT EXISTS user_filter_kids_preferences (
    user_id UUID NOT NULL REFERENCES user_filters(user_id) ON DELETE CASCADE,
    kids_option VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, kids_option)
);

CREATE TABLE IF NOT EXISTS user_filter_political_preferences (
    user_id UUID NOT NULL REFERENCES user_filters(user_id) ON DELETE CASCADE,
    political_option VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, political_option)
);

CREATE TABLE IF NOT EXISTS user_filter_pet_preferences (
    user_id UUID NOT NULL REFERENCES user_filters(user_id) ON DELETE CASCADE,
    pet_option VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, pet_option)
);

CREATE TABLE IF NOT EXISTS user_filter_ethnicity_preferences (
    user_id UUID NOT NULL REFERENCES user_filters(user_id) ON DELETE CASCADE,
    ethnicity_option VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, ethnicity_option)
);

CREATE TABLE IF NOT EXISTS user_filter_pronoun_preferences (
    user_id UUID NOT NULL REFERENCES user_filters(user_id) ON DELETE CASCADE,
    pronoun_option VARCHAR(40) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, pronoun_option)
);

-- ---------------------------------------------------------
-- Consistency bootstrap (one-time safe backfill)
-- ---------------------------------------------------------
-- Ensure each user has a base filter row.
INSERT INTO user_filters (user_id)
SELECT u.id
FROM users u
LEFT JOIN user_filters uf ON uf.user_id = u.id
WHERE uf.user_id IS NULL;

-- If user already selected "who you want to date" during onboarding,
-- prefill filter preferred genders from the same source-of-truth table.
INSERT INTO user_filter_preferred_genders (user_id, gender)
SELECT udp.user_id, udp.preferred_gender
FROM user_dating_preferences udp
LEFT JOIN user_filter_preferred_genders ufg
    ON ufg.user_id = udp.user_id AND ufg.gender = udp.preferred_gender
WHERE ufg.user_id IS NULL;
