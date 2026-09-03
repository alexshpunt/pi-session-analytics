CREATE VIEW effective_archive_generations AS
WITH RECURSIVE generation_lineage(source_path, generation_id) AS (
  SELECT source_path, current_generation_id
  FROM archive_sources
  WHERE current_generation_id IS NOT NULL
  UNION ALL
  SELECT generation_lineage.source_path, archive_generations.content_parent_generation_id
  FROM generation_lineage
  JOIN archive_generations ON archive_generations.id = generation_lineage.generation_id
  WHERE archive_generations.content_parent_generation_id IS NOT NULL
)
SELECT source_path, generation_id
FROM generation_lineage;

CREATE VIEW effective_session_records AS
SELECT session_records.*
FROM session_records
JOIN effective_archive_generations
  ON effective_archive_generations.source_path = session_records.source_path
 AND effective_archive_generations.generation_id = session_records.archive_generation_id;
