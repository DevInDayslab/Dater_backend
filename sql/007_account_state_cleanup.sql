-- =========================================================
-- DATABASE FLOW 7: PRE-LAUNCH ACCOUNT STATE CLEANUP
-- Canonical source of truth => users.account_state
-- =========================================================

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'is_banned'
    ) THEN
        UPDATE users
        SET account_state = CASE
            WHEN account_state = 'ACTIVE'::account_state_enum AND is_banned = TRUE THEN 'BANNED'::account_state_enum
            WHEN account_state = 'ACTIVE'::account_state_enum AND deleted_at IS NOT NULL THEN 'DELETED'::account_state_enum
            WHEN account_state = 'ACTIVE'::account_state_enum AND profile_hidden_at IS NOT NULL THEN 'HIDDEN_BY_MODERATION'::account_state_enum
            WHEN account_state = 'ACTIVE'::account_state_enum AND paused_until IS NOT NULL THEN 'PAUSED'::account_state_enum
            WHEN account_state = 'ACTIVE'::account_state_enum AND privacy_mode_enabled = TRUE THEN 'PRIVACY_MODE'::account_state_enum
            ELSE account_state
        END;
    END IF;
END $$;

-- Remove overlapping flags so state is read from account_state only.
ALTER TABLE users
    DROP COLUMN IF EXISTS is_banned,
    DROP COLUMN IF EXISTS is_paused,
    DROP COLUMN IF EXISTS privacy_mode_enabled;
