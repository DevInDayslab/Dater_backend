CREATE TABLE IF NOT EXISTS platform_config (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  splash_background_s3_key TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO platform_config (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;
