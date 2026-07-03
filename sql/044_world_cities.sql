BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS cities (
  id            INTEGER PRIMARY KEY,
  city          TEXT NOT NULL,
  city_ascii    TEXT NOT NULL,
  lat           DOUBLE PRECISION NOT NULL,
  lng           DOUBLE PRECISION NOT NULL,
  country       TEXT NOT NULL,
  iso2          CHAR(2) NOT NULL,
  iso3          CHAR(3),
  admin_name    TEXT,
  capital       TEXT,
  population    INTEGER,
  state_code    TEXT,
  label         TEXT NOT NULL,
  label_norm    TEXT NOT NULL,
  geom          GEOGRAPHY(Point, 4326) NOT NULL
);

CREATE TABLE IF NOT EXISTS city_label_aliases (
  old_label_norm TEXT PRIMARY KEY,
  new_label_norm TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cities_iso2 ON cities (iso2);
CREATE INDEX IF NOT EXISTS idx_cities_label_norm_search ON cities USING GIN (label_norm gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_cities_city_ascii_search ON cities USING GIN (city_ascii gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_cities_geom ON cities USING GIST (geom);

COMMIT;
