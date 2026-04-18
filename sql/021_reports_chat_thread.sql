ALTER TABLE reports
    ADD COLUMN IF NOT EXISTS chat_thread_id UUID REFERENCES chat_threads(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_reports_chat_thread
    ON reports (chat_thread_id, created_at DESC);
