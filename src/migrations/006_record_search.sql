ALTER TABLE session_records ADD COLUMN search_text TEXT NOT NULL DEFAULT '';

UPDATE session_records
SET search_text = raw_json
WHERE search_text = '';

CREATE VIRTUAL TABLE session_records_fts USING fts5(
  search_text,
  content='session_records',
  content_rowid='id'
);

CREATE TRIGGER session_records_fts_insert AFTER INSERT ON session_records BEGIN
  INSERT INTO session_records_fts(rowid, search_text)
  VALUES (new.id, new.search_text);
END;

CREATE TRIGGER session_records_fts_delete AFTER DELETE ON session_records BEGIN
  INSERT INTO session_records_fts(session_records_fts, rowid, search_text)
  VALUES ('delete', old.id, old.search_text);
END;

CREATE TRIGGER session_records_fts_update AFTER UPDATE OF search_text ON session_records BEGIN
  INSERT INTO session_records_fts(session_records_fts, rowid, search_text)
  VALUES ('delete', old.id, old.search_text);
  INSERT INTO session_records_fts(rowid, search_text)
  VALUES (new.id, new.search_text);
END;

INSERT INTO session_records_fts(session_records_fts) VALUES ('rebuild');
