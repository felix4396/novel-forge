-- No-op for PostgreSQL migration replay.
--
-- This historical schema-gap migration was generated before the PostgreSQL
-- baseline but creates only tables that are already present in
-- 20260413120000_postgresql_baseline. Running the original SQL first breaks an
-- empty PostgreSQL deploy because it used SQLite DATETIME types and referenced
-- baseline tables before they existed. Keep the migration name for history and
-- let the baseline own the actual table definitions.
SELECT 1;
