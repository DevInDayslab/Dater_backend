-- Tracks when the story owner opened a viewer's profile from story activity (non-friend "View" → "Seen").
CREATE TABLE IF NOT EXISTS story_activity_profile_seen (
    owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_user_id, story_id, actor_user_id)
);

CREATE INDEX IF NOT EXISTS idx_story_activity_profile_seen_story
    ON story_activity_profile_seen (story_id);
