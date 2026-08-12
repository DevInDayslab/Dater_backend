-- Landing page SEO metadata for Express HTML injection. Isolated from mobile-app tables.

CREATE TABLE IF NOT EXISTS landing_page_seo (
    id SERIAL PRIMARY KEY,
    page_slug VARCHAR(120) NOT NULL UNIQUE DEFAULT 'home',
    meta_title VARCHAR(255) NOT NULL,
    meta_description TEXT NOT NULL,
    og_image_url TEXT,
    canonical_url TEXT,
    is_indexed BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO landing_page_seo (page_slug, meta_title, meta_description, og_image_url, canonical_url, is_indexed)
VALUES (
    'home',
    'DATER',
    'Find your next date.',
    NULL,
    'https://dater.social/',
    TRUE
)
ON CONFLICT (page_slug) DO NOTHING;
