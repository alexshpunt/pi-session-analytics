PRAGMA foreign_keys = ON;

CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO metadata(key, value) VALUES ('schema_kind', 'compact-tool-events');
INSERT INTO metadata(key, value) VALUES ('schema_version', '1');

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  first_timestamp INTEGER NOT NULL,
  last_timestamp INTEGER NOT NULL,
  current_source_path TEXT,
  source_exists INTEGER NOT NULL DEFAULT 1,
  last_seen_at INTEGER
);

CREATE TABLE session_sources (
  session_id TEXT PRIMARY KEY,
  current_path TEXT NOT NULL,
  source_mtime_ms REAL NOT NULL,
  source_size_bytes INTEGER NOT NULL,
  processed_bytes INTEGER NOT NULL,
  processed_prefix_sha256 TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  event_index INTEGER NOT NULL,
  timestamp INTEGER,
  provider TEXT,
  model TEXT,
  arguments_codec TEXT NOT NULL DEFAULT 'deflate-raw',
  arguments_blob BLOB NOT NULL,
  arguments_sha256 TEXT NOT NULL,
  arguments_bytes INTEGER NOT NULL,
  argument_shape TEXT NOT NULL,
  source_path TEXT,
  source_byte_offset INTEGER,
  source_block_index INTEGER,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  UNIQUE (session_id, tool_call_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE tool_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  event_index INTEGER NOT NULL,
  timestamp INTEGER,
  is_error INTEGER NOT NULL,
  payload_codec TEXT NOT NULL DEFAULT 'deflate-raw',
  payload_blob BLOB NOT NULL,
  payload_sha256 TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL,
  error_fingerprint TEXT,
  source_path TEXT,
  source_byte_offset INTEGER,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  UNIQUE (session_id, tool_call_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE usage_records (
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  provider TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_recorded INTEGER NOT NULL DEFAULT 0,
  cost_input REAL NOT NULL DEFAULT 0,
  cost_output REAL NOT NULL DEFAULT 0,
  cost_cache_read REAL NOT NULL DEFAULT 0,
  cost_cache_write REAL NOT NULL DEFAULT 0,
  cost_total REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, message_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX idx_tool_calls_order ON tool_calls(session_id, event_index, id);
CREATE INDEX idx_tool_calls_name ON tool_calls(tool_name);
CREATE INDEX idx_tool_calls_model ON tool_calls(provider, model);
CREATE INDEX idx_tool_results_order ON tool_results(session_id, event_index, id);
CREATE INDEX idx_tool_results_error ON tool_results(is_error, tool_name);
CREATE INDEX idx_usage_timestamp ON usage_records(timestamp);
CREATE INDEX idx_usage_model ON usage_records(provider, model);
CREATE INDEX idx_usage_project ON usage_records(project_path);

PRAGMA user_version = 1;
