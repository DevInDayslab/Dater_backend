-- Seed SEO rows for all DaterLanding marketing routes (idempotent).

INSERT INTO landing_page_seo (page_slug, meta_title, meta_description, og_image_url, canonical_url, is_indexed)
VALUES
  (
    'home',
    'DATER',
    'Find your next date.',
    NULL,
    'https://dater.social/',
    TRUE
  ),
  (
    'about',
    'About | DATER',
    'Learn about Dater — the dating app built for real connections.',
    NULL,
    'https://dater.social/about',
    TRUE
  ),
  (
    'contact-us',
    'Contact Us | DATER',
    'Get in touch with the Dater team for press, partnerships, and support.',
    NULL,
    'https://dater.social/contact-us',
    TRUE
  ),
  (
    'faq',
    'FAQs | DATER',
    'Answers to common questions about Dater, accounts, safety, and downloads.',
    NULL,
    'https://dater.social/faq',
    TRUE
  ),
  (
    'privacy-policy',
    'Privacy Policy | DATER',
    'How Dater collects, uses, and protects your personal information.',
    NULL,
    'https://dater.social/privacy-policy',
    TRUE
  ),
  (
    'terms',
    'Terms of Service | DATER',
    'The terms that govern your use of the Dater app and website.',
    NULL,
    'https://dater.social/terms',
    TRUE
  ),
  (
    'community-guidelines',
    'Community Guidelines | DATER',
    'Standards for respectful, safe behavior on Dater.',
    NULL,
    'https://dater.social/community-guidelines',
    TRUE
  ),
  (
    'cookie-policy',
    'Cookie Policy | DATER',
    'How Dater uses cookies and similar technologies on the website.',
    NULL,
    'https://dater.social/cookie-policy',
    TRUE
  ),
  (
    'download',
    'Download | DATER',
    'Download Dater on the App Store or Google Play.',
    NULL,
    'https://dater.social/download',
    TRUE
  )
ON CONFLICT (page_slug) DO NOTHING;
