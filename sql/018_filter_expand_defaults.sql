-- backend_raw.md: expand age / expand distance on by default for new filter rows.
ALTER TABLE user_filters
    ALTER COLUMN expand_age_range SET DEFAULT TRUE;
ALTER TABLE user_filters
    ALTER COLUMN expand_distance SET DEFAULT TRUE;
