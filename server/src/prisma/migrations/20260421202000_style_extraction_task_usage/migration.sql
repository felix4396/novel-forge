-- No-op for PostgreSQL migration replay.
--
-- Superseded by 20260422190000_style_extraction_task, which creates
-- StyleExtractionTask with token usage columns already present.
SELECT 1;
