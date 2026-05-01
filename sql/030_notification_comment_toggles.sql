-- 030_notification_comment_toggles.sql
-- Adds dedicated comment toggles (push + in-app).

BEGIN;

ALTER TABLE user_notification_preferences
  ADD COLUMN IF NOT EXISTS push_comment BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE user_notification_preferences
  ADD COLUMN IF NOT EXISTS inapp_comment BOOLEAN NOT NULL DEFAULT TRUE;

COMMIT;

