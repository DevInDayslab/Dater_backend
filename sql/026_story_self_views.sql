-- Tracks when the story owner has viewed their own slide in the client (for reel ring / unseen state).
-- story_interactions disallows actor = owner, so owner "seen" state uses this table instead.
CREATE TABLE IF NOT EXISTS story_self_views (
    story_id UUID PRIMARY KEY REFERENCES stories(id) ON DELETE CASCADE,
    owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_story_self_views_owner_user_id
    ON story_self_views (owner_user_id);
