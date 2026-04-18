ALTER TABLE chat_restrictions
    ADD COLUMN IF NOT EXISTS is_locally_unlocked BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_chat_restrictions_local_unlock
    ON chat_restrictions (user_id, target_id, is_locally_unlocked);
