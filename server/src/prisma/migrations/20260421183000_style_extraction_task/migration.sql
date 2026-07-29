-- No-op for PostgreSQL migration replay.
--
-- Superseded by 20260422190000_style_extraction_task, which creates the same
-- table with PostgreSQL-compatible types and the usage columns included.
SELECT 1;
