-- Client-generated BlurHash for progressive image placeholders (feed / profile).
ALTER TABLE user_photos
    ADD COLUMN IF NOT EXISTS blur_hash VARCHAR(128);

COMMENT ON COLUMN user_photos.blur_hash IS 'BlurHash string from client at presign time; decode for placeholder until full image loads.';
