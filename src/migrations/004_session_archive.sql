CREATE TABLE archive_chunks (
  hash TEXT PRIMARY KEY,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE archive_sources (
  source_path TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  current_generation_id INTEGER,
  source_exists INTEGER NOT NULL DEFAULT 1,
  source_mtime_ms INTEGER NOT NULL,
  source_size_bytes INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE archive_generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path TEXT NOT NULL,
  session_id TEXT NOT NULL,
  generation_number INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('base', 'append', 'rewrite')),
  previous_generation_id INTEGER,
  content_parent_generation_id INTEGER,
  size_bytes INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  source_mtime_ms INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  UNIQUE (source_path, generation_number),
  FOREIGN KEY (source_path) REFERENCES archive_sources(source_path),
  FOREIGN KEY (previous_generation_id) REFERENCES archive_generations(id),
  FOREIGN KEY (content_parent_generation_id) REFERENCES archive_generations(id)
);

CREATE TABLE archive_generation_chunks (
  generation_id INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  chunk_hash TEXT NOT NULL,
  source_offset INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  PRIMARY KEY (generation_id, ordinal),
  FOREIGN KEY (generation_id) REFERENCES archive_generations(id),
  FOREIGN KEY (chunk_hash) REFERENCES archive_chunks(hash)
);

CREATE INDEX idx_archive_generations_source
  ON archive_generations(source_path, generation_number);
CREATE INDEX idx_archive_generation_chunks_hash
  ON archive_generation_chunks(chunk_hash);
