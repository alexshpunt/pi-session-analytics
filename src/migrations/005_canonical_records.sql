CREATE TABLE record_index_state (
  archive_generation_id INTEGER PRIMARY KEY,
  records_count INTEGER NOT NULL,
  invalid_count INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL,
  FOREIGN KEY (archive_generation_id) REFERENCES archive_generations(id)
);

CREATE TABLE session_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_generation_id INTEGER NOT NULL,
  source_path TEXT NOT NULL,
  session_id TEXT NOT NULL,
  record_index INTEGER NOT NULL,
  source_byte_offset INTEGER NOT NULL,
  source_byte_length INTEGER NOT NULL,
  record_type TEXT NOT NULL,
  entry_id TEXT,
  parent_id TEXT,
  timestamp INTEGER,
  raw_json TEXT NOT NULL,
  parse_error TEXT,
  session_version INTEGER,
  cwd TEXT,
  parent_session_path TEXT,
  message_role TEXT,
  content_text TEXT,
  content_json TEXT,
  details_json TEXT,
  data_json TEXT,
  usage_json TEXT,
  provider TEXT,
  model TEXT,
  api TEXT,
  stop_reason TEXT,
  error_message TEXT,
  thinking_level TEXT,
  custom_type TEXT,

  display INTEGER,
  from_hook INTEGER,
  retained_tail_json TEXT,
  summary TEXT,
  tokens_before INTEGER,
  first_kept_entry_id TEXT,
  from_id TEXT,
  target_id TEXT,
  label TEXT,
  name TEXT,
  tool_call_id TEXT,
  tool_name TEXT,
  is_error INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_input REAL NOT NULL DEFAULT 0,
  cost_output REAL NOT NULL DEFAULT 0,
  cost_cache_read REAL NOT NULL DEFAULT 0,
  cost_cache_write REAL NOT NULL DEFAULT 0,
  cost_total REAL NOT NULL DEFAULT 0,
  UNIQUE (archive_generation_id, source_byte_offset),
  FOREIGN KEY (archive_generation_id) REFERENCES archive_generations(id)
);

CREATE TABLE record_content_blocks (
  record_id INTEGER NOT NULL,
  block_index INTEGER NOT NULL,
  type TEXT NOT NULL,
  text TEXT,
  thinking TEXT,
  mime_type TEXT,
  tool_call_id TEXT,
  tool_name TEXT,
  arguments_json TEXT,
  raw_json TEXT NOT NULL,
  PRIMARY KEY (record_id, block_index),
  FOREIGN KEY (record_id) REFERENCES session_records(id)
);

CREATE TABLE record_tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id INTEGER NOT NULL,
  block_index INTEGER NOT NULL,
  source_path TEXT NOT NULL,
  session_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  FOREIGN KEY (record_id) REFERENCES session_records(id),
  UNIQUE (record_id, block_index)
);

CREATE TABLE record_tool_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id INTEGER NOT NULL UNIQUE,
  source_path TEXT NOT NULL,
  session_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  content_text TEXT,
  content_json TEXT NOT NULL,
  details_json TEXT,
  is_error INTEGER NOT NULL,
  FOREIGN KEY (record_id) REFERENCES session_records(id)
);

CREATE INDEX idx_session_records_session
  ON session_records(session_id, source_path);
CREATE INDEX idx_session_records_type
  ON session_records(record_type);
CREATE INDEX idx_session_records_entry_context
  ON session_records(session_id, source_path, entry_id);
CREATE INDEX idx_session_records_parent_context
  ON session_records(session_id, source_path, parent_id);
CREATE INDEX idx_session_records_timestamp
  ON session_records(timestamp);
CREATE INDEX idx_session_records_generation
  ON session_records(archive_generation_id, source_byte_offset);
CREATE INDEX idx_record_tool_calls_context
  ON record_tool_calls(session_id, source_path, tool_call_id);
CREATE INDEX idx_record_tool_calls_name
  ON record_tool_calls(tool_name);
CREATE INDEX idx_record_tool_results_context
  ON record_tool_results(session_id, source_path, tool_call_id);
CREATE INDEX idx_record_tool_results_error
  ON record_tool_results(is_error);
