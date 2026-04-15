-- =========================================================
-- DATABASE FLOW 8: STORY REPLY -> CHAT MESSAGE FK
-- Applied after chat tables exist (005).
-- =========================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'fk_story_replies_chat_message'
    ) THEN
        ALTER TABLE story_replies
            ADD CONSTRAINT fk_story_replies_chat_message
            FOREIGN KEY (chat_message_id)
            REFERENCES chat_messages(id)
            ON DELETE SET NULL;
    END IF;
END $$;
