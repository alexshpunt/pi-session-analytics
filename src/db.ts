import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { StatementSync } from 'node:sqlite';
import { apply_schema } from './schema.ts';

const DEFAULT_DB_PATH = join(
	process.env.HOME!,
	'.pi',
	'pi-session-analytics.db',
);

/**
 * Escape a search term for FTS5 MATCH queries.
 */
function escape_fts5_query(term: string): string {
	if (term.startsWith('"') && term.endsWith('"')) {
		return term;
	}

	const is_prefix = term.endsWith('*');
	const base_term = is_prefix ? term.slice(0, -1) : term;

	const has_special = /[./\-:()^+']/.test(base_term);

	if (!has_special && !base_term.includes('"')) {
		return term;
	}

	const escaped = `"${base_term.replace(/"/g, '""')}"`;
	return is_prefix ? escaped + '*' : escaped;
}

export interface CompactResult {
	dry_run: boolean;
	older_than_days: number;
	cutoff_date: string;
	tool_results_compacted: {
		read: number;
		bash: number;
		grep_glob: number;
		write: number;
	};
	bytes_before: number;
	bytes_after: number;
}

interface SyncState {
	last_modified: number;
	last_byte_offset: number;
	metadata_indexed: number;
}

/** Metadata for one archived Pi session source path. */
export interface ArchiveSourceRecord {
	source_path: string;
	session_id: string;
	current_generation_id: number | null;
	source_exists: number;
	source_mtime_ms: number;
	source_size_bytes: number;
	first_seen_at: number;
	last_seen_at: number;
}

/** One immutable byte generation of an archived session source. */
export interface ArchiveGenerationRecord {
	id: number;
	source_path: string;
	session_id: string;
	generation_number: number;
	kind: 'base' | 'append' | 'rewrite';
	previous_generation_id: number | null;
	content_parent_generation_id: number | null;
	size_bytes: number;
	content_sha256: string;
	source_mtime_ms: number;
	observed_at: number;
}

/** One content chunk referenced by an archive generation. */
export interface ArchiveGenerationChunkRecord {
	generation_id: number;
	ordinal: number;
	chunk_hash: string;
	source_offset: number;
	size_bytes: number;
}

/** Lossless common and typed fields for one archived JSONL record. */
export interface SessionRecordInsert {
	archive_generation_id: number;
	source_path: string;
	session_id: string;
	record_index: number;
	source_byte_offset: number;
	source_byte_length: number;
	record_type: string;
	entry_id?: string;
	parent_id?: string;
	timestamp?: number;
	raw_json: string;
	parse_error?: string;

	search_text: string;
	session_version?: number;
	cwd?: string;
	parent_session_path?: string;
	message_role?: string;
	content_text?: string;
	content_json?: string;
	details_json?: string;
	data_json?: string;
	usage_json?: string;
	provider?: string;
	model?: string;
	api?: string;
	stop_reason?: string;
	error_message?: string;
	thinking_level?: string;
	custom_type?: string;

	display?: boolean;
	from_hook?: boolean;
	retained_tail_json?: string;
	summary?: string;
	tokens_before?: number;
	first_kept_entry_id?: string;
	from_id?: string;
	target_id?: string;
	label?: string;
	name?: string;
	tool_call_id?: string;
	tool_name?: string;
	is_error?: boolean;
	input_tokens?: number;
	output_tokens?: number;
	cache_read_tokens?: number;
	cache_write_tokens?: number;
	total_tokens?: number;
	cost_input?: number;
	cost_output?: number;
	cost_cache_read?: number;
	cost_cache_write?: number;
	cost_total?: number;
}

/** One full-text match with exact canonical archive provenance. */
export interface CanonicalSearchResult {
	record_id: number;
	session_id: string;
	project_path: string;
	source_path: string;
	archive_generation_id: number;
	record_type: string;
	entry_id: string | null;
	message_role: string | null;
	content_text: string | null;
	timestamp: number | null;
	source_byte_offset: number;
	source_byte_length: number;
	snippet: string;
	relevance: number;
}

/** Filters shared by every canonical tool activity report. */
export interface ToolActivityFilters {
	project?: string;
	session?: string;
	provider?: string;
	model?: string;
	after?: number;
	before?: number;
}

/** One effective tool call and its recorded result, with archive provenance. */
export interface ToolActivityRecord {
	call_record_id: number;
	result_record_id: number | null;
	session_id: string;
	project_path: string;
	source_path: string;
	archive_generation_id: number;
	tool_call_id: string;
	tool_name: string;
	arguments_json: string;
	provider: string | null;
	model: string | null;
	timestamp: number | null;
	source_byte_offset: number;
	source_byte_length: number;
	result_archive_generation_id: number | null;
	result_timestamp: number | null;
	result_source_byte_offset: number | null;
	result_source_byte_length: number | null;
	result_content: string | null;
	result_details_json: string | null;
	is_error: number | null;
}

export class Database {
	private db: DatabaseSync;
	private db_path: string;
	private stmt_upsert_session: StatementSync;
	private stmt_insert_message: StatementSync;
	private stmt_update_session_timestamp: StatementSync;
	private stmt_insert_tool_call: StatementSync;
	private stmt_insert_tool_result: StatementSync;
	private stmt_insert_model_change: StatementSync;
	private stmt_get_sync_state: StatementSync;
	private stmt_set_sync_state: StatementSync;

	constructor(db_path = DEFAULT_DB_PATH) {
		this.db_path = db_path;
		this.db = new DatabaseSync(db_path, {
			enableForeignKeyConstraints: true,
		});
		this.db.exec('PRAGMA busy_timeout = 5000');
		apply_schema(this.db);

		this.stmt_upsert_session = this.db.prepare(`
			INSERT INTO sessions (id, project_path, cwd, first_timestamp, last_timestamp)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				last_timestamp = MAX(last_timestamp, excluded.last_timestamp)
		`);

		this.stmt_insert_message = this.db.prepare(`
			INSERT OR IGNORE INTO messages (
				id, session_id, parent_id, type, provider, model,
				content_text, content_json, thinking, timestamp,
				input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
				cost_total
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		this.stmt_update_session_timestamp = this.db.prepare(`
			UPDATE sessions SET last_timestamp = MAX(last_timestamp, ?)
			WHERE id = ?
		`);

		this.stmt_insert_tool_call = this.db.prepare(`
			INSERT OR IGNORE INTO tool_calls (id, message_id, session_id, tool_name, tool_input, timestamp)
			VALUES (?, ?, ?, ?, ?, ?)
		`);

		this.stmt_insert_tool_result = this.db.prepare(`
			INSERT OR IGNORE INTO tool_results (tool_call_id, message_id, session_id, content, is_error, timestamp)
			VALUES (?, ?, ?, ?, ?, ?)
		`);

		this.stmt_insert_model_change = this.db.prepare(`
			INSERT OR IGNORE INTO model_changes (id, session_id, parent_id, provider, model_id, timestamp)
			VALUES (?, ?, ?, ?, ?, ?)
		`);

		this.stmt_get_sync_state = this.db.prepare(
			'SELECT last_modified, last_byte_offset, metadata_indexed FROM sync_state WHERE file_path = ?',
		);

		this.stmt_set_sync_state = this.db.prepare(`
			INSERT INTO sync_state (
				file_path, last_modified, last_byte_offset, metadata_indexed
			)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(file_path) DO UPDATE SET
				last_modified = excluded.last_modified,
				last_byte_offset = excluded.last_byte_offset,
				metadata_indexed = excluded.metadata_indexed
		`);
	}

	begin() {
		this.db.exec('BEGIN TRANSACTION');
	}

	commit() {
		this.db.exec('COMMIT');
	}

	disable_foreign_keys() {
		this.db.exec('PRAGMA foreign_keys = OFF');
	}

	enable_foreign_keys() {
		this.db.exec('PRAGMA foreign_keys = ON');
	}

	upsert_session(session: {
		id: string;
		project_path: string;
		cwd?: string;
		timestamp: number;
	}) {
		this.stmt_upsert_session.run(
			session.id,
			session.project_path,
			session.cwd ?? null,
			session.timestamp,
			session.timestamp,
		);
	}

	update_session_source(session: {
		id: string;
		path: string;
		mtime_ms: number;
		size_bytes: number;
		last_seen_at: number;
		name?: string;
		name_seen?: boolean;
		parent_session_path?: string;
		first_message?: string;
	}) {
		this.db
			.prepare(`
				UPDATE sessions SET
					source_path = ?, source_exists = 1,
					source_mtime_ms = ?, source_size_bytes = ?,
					last_seen_at = ?,
					name = CASE WHEN ? THEN ? ELSE name END,
					parent_session_path = COALESCE(?, parent_session_path),
					first_message = COALESCE(first_message, ?)
				WHERE id = ?
			`)
			.run(
				session.path,
				session.mtime_ms,
				session.size_bytes,
				session.last_seen_at,
				(session.name_seen ?? session.name !== undefined) ? 1 : 0,
				session.name ?? null,
				session.parent_session_path ?? null,
				session.first_message ?? null,
				session.id,
			);
	}

	mark_unseen_sources_missing(seen_at: number) {
		this.db
			.prepare(`
				UPDATE sessions SET source_exists = 0
				WHERE source_exists = 1
				  AND (last_seen_at IS NULL OR last_seen_at < ?)
			`)
			.run(seen_at);
	}

	insert_message(msg: {
		id: string;
		session_id: string;
		parent_id?: string;
		type: string;
		provider?: string;
		model?: string;
		content_text?: string;
		content_json?: string;
		thinking?: string;
		timestamp: number;
		input_tokens?: number;
		output_tokens?: number;
		cache_read_tokens?: number;
		cache_write_tokens?: number;
		cost_total?: number;
	}) {
		this.stmt_insert_message.run(
			msg.id,
			msg.session_id,
			msg.parent_id ?? null,
			msg.type,
			msg.provider ?? null,
			msg.model ?? null,
			msg.content_text ?? null,
			msg.content_json ?? null,
			msg.thinking ?? null,
			msg.timestamp,
			msg.input_tokens ?? 0,
			msg.output_tokens ?? 0,
			msg.cache_read_tokens ?? 0,
			msg.cache_write_tokens ?? 0,
			msg.cost_total ?? 0,
		);
		this.stmt_update_session_timestamp.run(
			msg.timestamp,
			msg.session_id,
		);
	}

	insert_tool_call(call: {
		id: string;
		message_id: string;
		session_id: string;
		tool_name: string;
		tool_input: string;
		timestamp: number;
	}) {
		this.stmt_insert_tool_call.run(
			call.id,
			call.message_id,
			call.session_id,
			call.tool_name,
			call.tool_input,
			call.timestamp,
		);
	}

	insert_tool_result(result: {
		tool_call_id: string;
		message_id: string;
		session_id: string;
		content: string;
		is_error: boolean;
		timestamp: number;
	}) {
		this.stmt_insert_tool_result.run(
			result.tool_call_id,
			result.message_id,
			result.session_id,
			result.content,
			result.is_error ? 1 : 0,
			result.timestamp,
		);
	}

	insert_model_change(change: {
		id: string;
		session_id: string;
		parent_id?: string;
		provider: string;
		model_id: string;
		timestamp: number;
	}) {
		this.stmt_insert_model_change.run(
			change.id,
			change.session_id,
			change.parent_id ?? null,
			change.provider,
			change.model_id,
			change.timestamp,
		);
	}

	/** Return archive tracking metadata for one source path. */
	get_archive_source(
		source_path: string,
	): ArchiveSourceRecord | undefined {
		return this.db
			.prepare('SELECT * FROM archive_sources WHERE source_path = ?')
			.get(source_path) as ArchiveSourceRecord | undefined;
	}

	/** Return every archived generation for a source in observation order. */
	list_archive_generations(
		source_path: string,
	): ArchiveGenerationRecord[] {
		return this.db
			.prepare(
				'SELECT * FROM archive_generations WHERE source_path = ? ORDER BY generation_number',
			)
			.all(source_path) as unknown as ArchiveGenerationRecord[];
	}

	/** Return one archived generation by its stable database ID. */
	get_archive_generation(
		id: number,
	): ArchiveGenerationRecord | undefined {
		return this.db
			.prepare('SELECT * FROM archive_generations WHERE id = ?')
			.get(id) as ArchiveGenerationRecord | undefined;
	}

	/** Return the ordered content chunks introduced by one generation. */
	get_archive_generation_chunks(
		generation_id: number,
	): ArchiveGenerationChunkRecord[] {
		return this.db
			.prepare(
				'SELECT * FROM archive_generation_chunks WHERE generation_id = ? ORDER BY ordinal',
			)
			.all(
				generation_id,
			) as unknown as ArchiveGenerationChunkRecord[];
	}

	/** Mark an archive source as observed and update its current file metadata. */
	upsert_archive_source_seen(source: {
		source_path: string;
		session_id: string;
		mtime_ms: number;
		size_bytes: number;
		seen_at: number;
	}): void {
		this.db
			.prepare(
				`INSERT INTO archive_sources (
					source_path, session_id, current_generation_id,
					source_exists, source_mtime_ms, source_size_bytes,
					first_seen_at, last_seen_at
				) VALUES (?, ?, NULL, 1, ?, ?, ?, ?)
				ON CONFLICT(source_path) DO UPDATE SET
					session_id = excluded.session_id,
					source_exists = 1,
					source_mtime_ms = excluded.source_mtime_ms,
					source_size_bytes = excluded.source_size_bytes,
					last_seen_at = excluded.last_seen_at`,
			)
			.run(
				source.source_path,
				source.session_id,
				source.mtime_ms,
				source.size_bytes,
				source.seen_at,
				source.seen_at,
			);
	}

	/** Register immutable chunk metadata if the content is new. */
	insert_archive_chunk(
		hash: string,
		size_bytes: number,
		created_at: number,
	): boolean {
		const result = this.db
			.prepare(
				'INSERT OR IGNORE INTO archive_chunks (hash, size_bytes, created_at) VALUES (?, ?, ?)',
			)
			.run(hash, size_bytes, created_at);
		return Number(result.changes) > 0;
	}

	/** Insert one immutable archive generation and return its database ID. */
	insert_archive_generation(generation: {
		source_path: string;
		session_id: string;
		generation_number: number;
		kind: ArchiveGenerationRecord['kind'];
		previous_generation_id?: number;
		content_parent_generation_id?: number;
		size_bytes: number;
		content_sha256: string;
		source_mtime_ms: number;
		observed_at: number;
	}): number {
		const result = this.db
			.prepare(
				`INSERT INTO archive_generations (
					source_path, session_id, generation_number, kind,
					previous_generation_id, content_parent_generation_id,
					size_bytes, content_sha256, source_mtime_ms, observed_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				generation.source_path,
				generation.session_id,
				generation.generation_number,
				generation.kind,
				generation.previous_generation_id ?? null,
				generation.content_parent_generation_id ?? null,
				generation.size_bytes,
				generation.content_sha256,
				generation.source_mtime_ms,
				generation.observed_at,
			);
		return Number(result.lastInsertRowid);
	}

	/** Link one ordered content chunk to an archive generation. */
	insert_archive_generation_chunk(
		chunk: ArchiveGenerationChunkRecord,
	): void {
		this.db
			.prepare(
				`INSERT INTO archive_generation_chunks (
					generation_id, ordinal, chunk_hash, source_offset, size_bytes
				) VALUES (?, ?, ?, ?, ?)`,
			)
			.run(
				chunk.generation_id,
				chunk.ordinal,
				chunk.chunk_hash,
				chunk.source_offset,
				chunk.size_bytes,
			);
	}

	/** Point a source at its latest committed archive generation. */
	set_archive_current_generation(
		source_path: string,
		generation_id: number,
	): void {
		this.db
			.prepare(
				'UPDATE archive_sources SET current_generation_id = ? WHERE source_path = ?',
			)
			.run(generation_id, source_path);
	}

	/** Mark every archive source missing before the current pass observes live ones. */
	mark_all_archive_sources_missing(): void {
		this.db
			.prepare('UPDATE archive_sources SET source_exists = 0')
			.run();
	}

	/** Count archive sources that are currently missing. */
	count_missing_archive_sources(): number {
		return (
			this.db
				.prepare(
					'SELECT COUNT(*) AS count FROM archive_sources WHERE source_exists = 0',
				)
				.get() as { count: number }
		).count;
	}

	/** Return archive generations that have not been indexed into canonical records. */
	list_unindexed_archive_generations(): ArchiveGenerationRecord[] {
		return this.db
			.prepare(
				`SELECT g.* FROM archive_generations g
				LEFT JOIN record_index_state s ON s.archive_generation_id = g.id
				WHERE s.archive_generation_id IS NULL
				ORDER BY g.id`,
			)
			.all() as unknown as ArchiveGenerationRecord[];
	}

	/** Insert one canonical record and return its contextual database ID. */
	insert_session_record(record: SessionRecordInsert): number {
		const columns = [
			'archive_generation_id',
			'source_path',
			'session_id',
			'record_index',
			'source_byte_offset',
			'source_byte_length',
			'record_type',
			'entry_id',
			'parent_id',
			'timestamp',
			'raw_json',
			'parse_error',
			'search_text',
			'session_version',
			'cwd',
			'parent_session_path',
			'message_role',
			'content_text',
			'content_json',
			'details_json',
			'data_json',
			'usage_json',
			'provider',
			'model',
			'api',
			'stop_reason',
			'error_message',
			'thinking_level',
			'custom_type',
			'display',
			'from_hook',
			'retained_tail_json',
			'summary',
			'tokens_before',
			'first_kept_entry_id',
			'from_id',
			'target_id',
			'label',
			'name',
			'tool_call_id',
			'tool_name',
			'is_error',
			'input_tokens',
			'output_tokens',
			'cache_read_tokens',
			'cache_write_tokens',
			'total_tokens',
			'cost_input',
			'cost_output',
			'cost_cache_read',
			'cost_cache_write',
			'cost_total',
		] as const;
		const values = [
			record.archive_generation_id,
			record.source_path,
			record.session_id,
			record.record_index,
			record.source_byte_offset,
			record.source_byte_length,
			record.record_type,
			record.entry_id ?? null,
			record.parent_id ?? null,
			record.timestamp ?? null,
			record.raw_json,
			record.parse_error ?? null,

			record.search_text,
			record.session_version ?? null,
			record.cwd ?? null,
			record.parent_session_path ?? null,
			record.message_role ?? null,
			record.content_text ?? null,
			record.content_json ?? null,
			record.details_json ?? null,
			record.data_json ?? null,
			record.usage_json ?? null,
			record.provider ?? null,
			record.model ?? null,
			record.api ?? null,
			record.stop_reason ?? null,
			record.error_message ?? null,
			record.thinking_level ?? null,
			record.custom_type ?? null,
			record.display === undefined ? null : Number(record.display),
			record.from_hook === undefined
				? null
				: Number(record.from_hook),
			record.retained_tail_json ?? null,
			record.summary ?? null,
			record.tokens_before ?? null,
			record.first_kept_entry_id ?? null,
			record.from_id ?? null,
			record.target_id ?? null,
			record.label ?? null,
			record.name ?? null,
			record.tool_call_id ?? null,
			record.tool_name ?? null,
			record.is_error === undefined ? null : Number(record.is_error),
			record.input_tokens ?? 0,
			record.output_tokens ?? 0,
			record.cache_read_tokens ?? 0,
			record.cache_write_tokens ?? 0,
			record.total_tokens ?? 0,
			record.cost_input ?? 0,
			record.cost_output ?? 0,
			record.cost_cache_read ?? 0,
			record.cost_cache_write ?? 0,
			record.cost_total ?? 0,
		];
		const result = this.db
			.prepare(
				`INSERT INTO session_records (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
			)
			.run(...values);
		return Number(result.lastInsertRowid);
	}

	/** Insert one ordered message content block without losing its raw JSON. */
	insert_record_content_block(block: {
		record_id: number;
		block_index: number;
		type: string;
		text?: string;
		thinking?: string;
		mime_type?: string;
		tool_call_id?: string;
		tool_name?: string;
		arguments_json?: string;
		raw_json: string;
	}): void {
		this.db
			.prepare(
				`INSERT INTO record_content_blocks (
					record_id, block_index, type, text, thinking, mime_type,
					tool_call_id, tool_name, arguments_json, raw_json
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				block.record_id,
				block.block_index,
				block.type,
				block.text ?? null,
				block.thinking ?? null,
				block.mime_type ?? null,
				block.tool_call_id ?? null,
				block.tool_name ?? null,
				block.arguments_json ?? null,
				block.raw_json,
			);
	}

	/** Insert one contextual tool call extracted from a content block. */
	insert_record_tool_call(call: {
		record_id: number;
		block_index: number;
		source_path: string;
		session_id: string;
		tool_call_id: string;
		tool_name: string;
		arguments_json: string;
	}): void {
		this.db
			.prepare(
				`INSERT INTO record_tool_calls (
					record_id, block_index, source_path, session_id,
					tool_call_id, tool_name, arguments_json
				) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				call.record_id,
				call.block_index,
				call.source_path,
				call.session_id,
				call.tool_call_id,
				call.tool_name,
				call.arguments_json,
			);
	}

	/** Insert one contextual tool result extracted from a message record. */
	insert_record_tool_result(result: {
		record_id: number;
		source_path: string;
		session_id: string;
		tool_call_id: string;
		tool_name: string;
		content_text?: string;
		content_json: string;
		details_json?: string;
		is_error: boolean;
	}): void {
		this.db
			.prepare(
				`INSERT INTO record_tool_results (
					record_id, source_path, session_id, tool_call_id,
					tool_name, content_text, content_json, details_json, is_error
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				result.record_id,
				result.source_path,
				result.session_id,
				result.tool_call_id,
				result.tool_name,
				result.content_text ?? null,
				result.content_json,
				result.details_json ?? null,
				Number(result.is_error),
			);
	}

	/** Mark one archive generation fully indexed into canonical records. */
	mark_record_generation_indexed(
		archive_generation_id: number,
		records_count: number,
		invalid_count: number,
		indexed_at: number,
	): void {
		this.db
			.prepare(
				`INSERT INTO record_index_state (
					archive_generation_id, records_count, invalid_count, indexed_at
				) VALUES (?, ?, ?, ?)`,
			)
			.run(
				archive_generation_id,
				records_count,
				invalid_count,
				indexed_at,
			);
	}

	get_sync_state(file_path: string): SyncState | undefined {
		return this.stmt_get_sync_state.get(file_path) as
			| SyncState
			| undefined;
	}

	set_sync_state(
		file_path: string,
		last_modified: number,
		last_byte_offset: number,
		metadata_indexed = true,
	) {
		this.stmt_set_sync_state.run(
			file_path,
			last_modified,
			last_byte_offset,
			metadata_indexed ? 1 : 0,
		);
	}

	get_stats() {
		const sessions = this.db
			.prepare('SELECT COUNT(*) as count FROM sessions')
			.get() as { count: number };
		const messages = this.db
			.prepare('SELECT COUNT(*) as count FROM messages')
			.get() as { count: number };
		const tool_calls = this.db
			.prepare('SELECT COUNT(*) as count FROM tool_calls')
			.get() as { count: number };
		const tool_results = this.db
			.prepare('SELECT COUNT(*) as count FROM tool_results')
			.get() as { count: number };
		const model_changes = this.db
			.prepare('SELECT COUNT(*) as count FROM model_changes')
			.get() as { count: number };
		const tokens = this.db
			.prepare(
				`
			SELECT
				SUM(input_tokens) as input,
				SUM(output_tokens) as output,
				SUM(cache_read_tokens) as cache_read,
				SUM(cache_write_tokens) as cache_write,
				SUM(cost_total) as total_cost
			FROM messages
		`,
			)
			.get() as {
			input: number;
			output: number;
			cache_read: number;
			cache_write: number;
			total_cost: number;
		};

		return {
			sessions: sessions.count,
			messages: messages.count,
			tool_calls: tool_calls.count,
			tool_results: tool_results.count,
			model_changes: model_changes.count,
			tokens,
		};
	}

	reset_sync_state() {
		this.db.exec('DELETE FROM sync_state');
	}

	/** Search every canonical archived record and return exact provenance. */
	search_records(
		term: string,
		options: {
			limit?: number;
			project?: string;
			session?: string;
			record_type?: string;
			after?: number;
			sort?: 'relevance' | 'time' | 'time-asc';
		} = {},
	): CanonicalSearchResult[] {
		const limit = options.limit ?? 20;
		const sort = options.sort ?? 'relevance';
		let query = `
			SELECT
				r.id AS record_id,
				r.session_id,
				COALESCE(s.project_path, r.cwd, '') AS project_path,
				r.source_path,
				r.archive_generation_id,
				r.record_type,
				r.entry_id,
				r.message_role,
				r.content_text,
				r.timestamp,
				r.source_byte_offset,
				r.source_byte_length,
				snippet(session_records_fts, 0, '>>>', '<<<', '...', 32) AS snippet,
				bm25(session_records_fts) AS relevance
			FROM session_records_fts
			JOIN session_records r ON r.id = session_records_fts.rowid
			LEFT JOIN sessions s ON s.id = r.session_id
			WHERE session_records_fts MATCH ?
		`;
		const params: (string | number)[] = [escape_fts5_query(term)];
		if (options.project) {
			query += ` AND COALESCE(s.project_path, r.cwd, '') LIKE ?`;
			params.push(`%${options.project}%`);
		}
		if (options.session) {
			query += ` AND r.session_id LIKE ?`;
			params.push(`${options.session}%`);
		}
		if (options.record_type) {
			query += ` AND r.record_type = ?`;
			params.push(options.record_type);
		}
		if (options.after !== undefined) {
			query += ` AND r.timestamp >= ?`;
			params.push(options.after);
		}
		if (sort === 'time') {
			query += ` ORDER BY COALESCE(r.timestamp, 0) DESC`;
		} else if (sort === 'time-asc') {
			query += ` ORDER BY COALESCE(r.timestamp, 0) ASC`;
		} else {
			query += ` ORDER BY relevance`;
		}
		query += ` LIMIT ?`;
		params.push(limit);
		return this.db
			.prepare(query)
			.all(...params) as unknown as CanonicalSearchResult[];
	}

	/** Return neighboring canonical records from the same source history. */
	get_record_context(
		record_id: number,
		count: number,
	): {
		before: Array<{
			record_type: string;
			content_text: string;
			timestamp: number | null;
		}>;
		after: Array<{
			record_type: string;
			content_text: string;
			timestamp: number | null;
		}>;
	} {
		const target = this.db
			.prepare(
				'SELECT source_path, session_id FROM session_records WHERE id = ?',
			)
			.get(record_id) as
			| { source_path: string; session_id: string }
			| undefined;
		if (!target || count <= 0) return { before: [], after: [] };
		const select = `record_type,
			COALESCE(content_text, summary, error_message, raw_json) AS content_text,
			timestamp`;
		const before = this.db
			.prepare(
				`SELECT ${select} FROM session_records
				WHERE source_path = ? AND session_id = ? AND id < ?
				ORDER BY id DESC LIMIT ?`,
			)
			.all(
				target.source_path,
				target.session_id,
				record_id,
				count,
			) as Array<{
			record_type: string;
			content_text: string;
			timestamp: number | null;
		}>;
		const after = this.db
			.prepare(
				`SELECT ${select} FROM session_records
				WHERE source_path = ? AND session_id = ? AND id > ?
				ORDER BY id ASC LIMIT ?`,
			)
			.all(
				target.source_path,
				target.session_id,
				record_id,
				count,
			) as Array<{
			record_type: string;
			content_text: string;
			timestamp: number | null;
		}>;
		return { before: before.reverse(), after };
	}

	/** Rebuild canonical full-text search from stored search documents. */
	rebuild_record_fts(): void {
		this.db.exec(
			"INSERT INTO session_records_fts(session_records_fts) VALUES ('rebuild')",
		);
	}

	search(
		term: string,
		options: {
			limit?: number;
			project?: string;
			session?: string;
			after?: number;
			sort?: 'relevance' | 'time' | 'time-asc';
		} = {},
	): Array<{
		id: string;
		session_id: string;
		project_path: string;
		content_text: string;
		timestamp: number;
		snippet: string;
		relevance: number;
	}> {
		const limit = options.limit ?? 20;
		const sort = options.sort ?? 'relevance';
		let query = `
			SELECT
				m.id,
				m.session_id,
				s.project_path,
				m.content_text,
				m.timestamp,
				COALESCE(
					snippet(messages_fts, 0, '>>>', '<<<', '...', 32),
					snippet(messages_fts, 1, '>>>', '<<<', '...', 32)
				) as snippet,
				bm25(messages_fts, 10.0, 1.0) as relevance
			FROM messages_fts
			JOIN messages m ON m.rowid = messages_fts.rowid
			JOIN sessions s ON s.id = m.session_id
			WHERE messages_fts MATCH ?
		`;
		const params: (string | number)[] = [escape_fts5_query(term)];

		if (options.project) {
			query += ` AND s.project_path LIKE ?`;
			params.push(`%${options.project}%`);
		}

		if (options.session) {
			query += ` AND m.session_id LIKE ?`;
			params.push(`${options.session}%`);
		}

		if (options.after) {
			query += ` AND m.timestamp >= ?`;
			params.push(options.after);
		}

		if (sort === 'time') {
			query += ` ORDER BY m.timestamp DESC`;
		} else if (sort === 'time-asc') {
			query += ` ORDER BY m.timestamp ASC`;
		} else {
			query += ` ORDER BY relevance`;
		}

		query += ` LIMIT ?`;
		params.push(limit);

		return this.db.prepare(query).all(...params) as Array<{
			id: string;
			session_id: string;
			project_path: string;
			content_text: string;
			timestamp: number;
			snippet: string;
			relevance: number;
		}>;
	}

	get_messages_around(
		session_id: string,
		timestamp: number,
		count: number,
	): {
		before: Array<{
			id: string;
			type: string;
			content_text: string;
			timestamp: number;
		}>;
		after: Array<{
			id: string;
			type: string;
			content_text: string;
			timestamp: number;
		}>;
	} {
		const before = this.db
			.prepare(
				`SELECT id, type, content_text, timestamp
				FROM messages
				WHERE session_id = ? AND timestamp < ?
				ORDER BY timestamp DESC
				LIMIT ?`,
			)
			.all(session_id, timestamp, count) as Array<{
			id: string;
			type: string;
			content_text: string;
			timestamp: number;
		}>;

		const after = this.db
			.prepare(
				`SELECT id, type, content_text, timestamp
				FROM messages
				WHERE session_id = ? AND timestamp > ?
				ORDER BY timestamp ASC
				LIMIT ?`,
			)
			.all(session_id, timestamp, count) as Array<{
			id: string;
			type: string;
			content_text: string;
			timestamp: number;
		}>;

		return { before: before.reverse(), after };
	}

	get_context_around(
		session_id: string,
		timestamp: number,
		count: number,
	): {
		before: Array<{
			type: string;
			content_text: string;
			tool_names?: string[];
			timestamp: number;
		}>;
		after: Array<{
			type: string;
			content_text: string;
			tool_names?: string[];
			timestamp: number;
		}>;
	} {
		const fetch_limit = count * 4;

		const raw_before = this.db
			.prepare(
				`SELECT m.id, m.type, m.content_text, m.timestamp,
					(SELECT GROUP_CONCAT(tc.tool_name, ', ')
					 FROM tool_calls tc WHERE tc.message_id = m.id) as tool_names
				FROM messages m
				WHERE m.session_id = ? AND m.timestamp < ?
				ORDER BY m.timestamp DESC
				LIMIT ?`,
			)
			.all(session_id, timestamp, fetch_limit) as Array<{
			id: string;
			type: string;
			content_text: string | null;
			timestamp: number;
			tool_names: string | null;
		}>;

		const raw_after = this.db
			.prepare(
				`SELECT m.id, m.type, m.content_text, m.timestamp,
					(SELECT GROUP_CONCAT(tc.tool_name, ', ')
					 FROM tool_calls tc WHERE tc.message_id = m.id) as tool_names
				FROM messages m
				WHERE m.session_id = ? AND m.timestamp > ?
				ORDER BY m.timestamp ASC
				LIMIT ?`,
			)
			.all(session_id, timestamp, fetch_limit) as Array<{
			id: string;
			type: string;
			content_text: string | null;
			timestamp: number;
			tool_names: string | null;
		}>;

		const enrich = (
			row: (typeof raw_before)[number],
		): {
			type: string;
			content_text: string;
			tool_names?: string[];
			timestamp: number;
		} | null => {
			const tools = row.tool_names
				? row.tool_names.split(', ')
				: undefined;
			if (row.content_text) {
				return {
					type: row.type,
					content_text: row.content_text,
					tool_names: tools,
					timestamp: row.timestamp,
				};
			}
			if (tools) {
				return {
					type: row.type,
					content_text: `[used tools: ${tools.join(', ')}]`,
					tool_names: tools,
					timestamp: row.timestamp,
				};
			}
			return null;
		};

		const before = raw_before
			.map(enrich)
			.filter((m) => m !== null)
			.slice(0, count)
			.reverse();

		const after = raw_after
			.map(enrich)
			.filter((m) => m !== null)
			.slice(0, count);

		return { before, after };
	}

	rebuild_fts() {
		this.db.exec(
			`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`,
		);
	}

	get_sessions(
		options: { limit?: number; project?: string } = {},
	): Array<{
		id: string;
		project_path: string;
		first_timestamp: number;
		last_timestamp: number;
		message_count: number;
		total_tokens: number;
		total_cost: number;
		duration_mins: number;
	}> {
		const limit = options.limit ?? 10;
		let query = `
			SELECT
				s.id,
				s.project_path,
				s.first_timestamp,
				s.last_timestamp,
				COUNT(m.id) as message_count,
				COALESCE(SUM(m.input_tokens + m.output_tokens), 0) as total_tokens,
				COALESCE(SUM(m.cost_total), 0) as total_cost,
				CAST((s.last_timestamp - s.first_timestamp) / 60000.0 AS INTEGER) as duration_mins
			FROM sessions s
			LEFT JOIN messages m ON m.session_id = s.id
		`;
		const params: (string | number)[] = [];

		if (options.project) {
			query += ` WHERE s.project_path LIKE ?`;
			params.push(`%${options.project}%`);
		}

		query += ` GROUP BY s.id ORDER BY s.last_timestamp DESC LIMIT ?`;
		params.push(limit);

		return this.db.prepare(query).all(...params) as Array<{
			id: string;
			project_path: string;
			first_timestamp: number;
			last_timestamp: number;
			message_count: number;
			total_tokens: number;
			total_cost: number;
			duration_mins: number;
		}>;
	}

	list_resumable_sessions(
		options: {
			cwd?: string;
			query?: string;
			limit?: number;
			offset?: number;
		} = {},
	) {
		const conditions = ['s.source_exists = 1'];
		const params: (string | number)[] = [];
		if (options.cwd) {
			conditions.push('s.cwd = ?');
			params.push(options.cwd);
		}
		if (options.query) {
			conditions.push(`(
				s.name LIKE ? OR s.cwd LIKE ? OR s.first_message LIKE ? OR
				EXISTS (
					SELECT 1 FROM messages m
					WHERE m.session_id = s.id
					  AND m.type IN ('user', 'assistant')
					  AND m.content_text LIKE ?
				)
			)`);
			const pattern = `%${options.query}%`;
			params.push(pattern, pattern, pattern, pattern);
		}
		params.push(options.limit ?? 100, options.offset ?? 0);
		return this.db
			.prepare(`
				SELECT s.id, s.source_path AS path, s.cwd, s.name,
					s.parent_session_path, s.first_timestamp,
					COALESCE(
						s.source_mtime_ms,
						(SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id),
						s.last_timestamp
					) AS modified_timestamp,
					COALESCE(
						s.first_message,
						(SELECT m.content_text FROM messages m
						 WHERE m.session_id = s.id AND m.type = 'user'
						   AND m.content_text IS NOT NULL
						 ORDER BY m.timestamp ASC LIMIT 1)
					) AS first_message,
					s.source_mtime_ms, s.source_size_bytes, s.last_seen_at,
					(SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
				FROM sessions s
				WHERE ${conditions.join(' AND ')}
				ORDER BY modified_timestamp DESC, s.source_path ASC
				LIMIT ? OFFSET ?
			`)
			.all(...params);
	}

	/** Return effective canonical tool calls and their recorded outcomes. */
	get_tool_activity(
		filters: ToolActivityFilters = {},
	): ToolActivityRecord[] {
		const conditions: string[] = [];
		const params: Array<string | number> = [];
		if (filters.project) {
			conditions.push("COALESCE(projects.project_path, '') LIKE ?");
			params.push(`%${filters.project}%`);
		}
		if (filters.session) {
			conditions.push('calls.session_id LIKE ?');
			params.push(`${filters.session}%`);
		}
		if (filters.provider) {
			conditions.push('call_record.provider = ?');
			params.push(filters.provider);
		}
		if (filters.model) {
			conditions.push('call_record.model = ?');
			params.push(filters.model);
		}
		if (filters.after !== undefined) {
			conditions.push('call_record.timestamp >= ?');
			params.push(filters.after);
		}
		if (filters.before !== undefined) {
			conditions.push('call_record.timestamp < ?');
			params.push(filters.before);
		}
		const where =
			conditions.length > 0
				? `WHERE ${conditions.join(' AND ')}`
				: '';
		return this.db
			.prepare(
				`WITH source_projects AS (
					SELECT source_path,
						MAX(CASE WHEN record_type = 'session' THEN cwd END) AS project_path
					FROM effective_session_records
					GROUP BY source_path
				), effective_results AS (
					SELECT results.*, result_record.archive_generation_id,
						result_record.timestamp, result_record.source_byte_offset,
						result_record.source_byte_length,
						ROW_NUMBER() OVER (
							PARTITION BY results.source_path, results.session_id, results.tool_call_id
							ORDER BY result_record.timestamp, result_record.id
						) AS result_number
					FROM record_tool_results results
					JOIN effective_session_records result_record
						ON result_record.id = results.record_id
				)
				SELECT calls.record_id AS call_record_id,
					results.record_id AS result_record_id,
					calls.session_id,
					COALESCE(projects.project_path, '') AS project_path,
					calls.source_path,
					call_record.archive_generation_id,
					calls.tool_call_id, calls.tool_name, calls.arguments_json,
					call_record.provider, call_record.model, call_record.timestamp,
					call_record.source_byte_offset, call_record.source_byte_length,
					results.archive_generation_id AS result_archive_generation_id,
					results.timestamp AS result_timestamp,
					results.source_byte_offset AS result_source_byte_offset,
					results.source_byte_length AS result_source_byte_length,
					COALESCE(results.content_text, results.content_json) AS result_content,
					results.details_json AS result_details_json,
					results.is_error
				FROM record_tool_calls calls
				JOIN effective_session_records call_record
					ON call_record.id = calls.record_id
				LEFT JOIN source_projects projects
					ON projects.source_path = calls.source_path
				LEFT JOIN effective_results results
					ON results.source_path = calls.source_path
					AND results.session_id = calls.session_id
					AND results.tool_call_id = calls.tool_call_id
					AND results.result_number = 1
				${where}
				ORDER BY call_record.timestamp, calls.source_path, calls.record_id, calls.block_index`,
			)
			.all(...params) as unknown as ToolActivityRecord[];
	}

	get_tool_stats(
		options: { limit?: number; project?: string } = {},
	): Array<{
		tool_name: string;
		count: number;
		percentage: number;
	}> {
		const limit = options.limit ?? 10;
		let query = `
			SELECT
				tc.tool_name,
				COUNT(*) as count
			FROM tool_calls tc
		`;
		const params: (string | number)[] = [];

		if (options.project) {
			query += `
				JOIN sessions s ON s.id = tc.session_id
				WHERE s.project_path LIKE ?
			`;
			params.push(`%${options.project}%`);
		}

		query += `
			GROUP BY tc.tool_name
			ORDER BY count DESC
			LIMIT ?
		`;
		params.push(limit);

		const rows = this.db.prepare(query).all(...params) as Array<{
			tool_name: string;
			count: number;
		}>;

		let total_query = 'SELECT COUNT(*) as total FROM tool_calls tc';
		const total_params: (string | number)[] = [];
		if (options.project) {
			total_query +=
				' JOIN sessions s ON s.id = tc.session_id WHERE s.project_path LIKE ?';
			total_params.push(`%${options.project}%`);
		}
		const total = (
			this.db.prepare(total_query).get(...total_params) as {
				total: number;
			}
		).total;

		return rows.map((r) => ({
			tool_name: r.tool_name,
			count: r.count,
			percentage: total > 0 ? (r.count / total) * 100 : 0,
		}));
	}

	get_schema(table_name?: string): {
		tables: Array<{
			name: string;
			type: string;
			row_count: number;
			columns: Array<{
				name: string;
				type: string;
				notnull: boolean;
				default_value: unknown;
				pk: boolean;
			}>;
			indexes: Array<{ name: string; sql: string }>;
			foreign_keys: Array<{
				from: string;
				table: string;
				to: string;
			}>;
		}>;
	} {
		const table_rows = this.db
			.prepare(
				`SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name`,
			)
			.all() as Array<{ name: string; type: string }>;

		const tables = table_rows
			.filter((t) => !table_name || t.name === table_name)
			.map((t) => {
				const row_count = (
					this.db
						.prepare(`SELECT COUNT(*) as count FROM "${t.name}"`)
						.get() as { count: number }
				).count;

				const columns = this.db
					.prepare(`PRAGMA table_info("${t.name}")`)
					.all() as Array<{
					name: string;
					type: string;
					notnull: number;
					dflt_value: unknown;
					pk: number;
				}>;

				const indexes = (
					this.db
						.prepare(`PRAGMA index_list("${t.name}")`)
						.all() as Array<{ name: string }>
				)
					.map((idx) => {
						const sql_row = this.db
							.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`)
							.get(idx.name) as { sql: string } | undefined;
						return {
							name: idx.name,
							sql: sql_row?.sql ?? '',
						};
					})
					.filter((idx) => idx.sql);

				const foreign_keys = this.db
					.prepare(`PRAGMA foreign_key_list("${t.name}")`)
					.all() as Array<{
					from: string;
					table: string;
					to: string;
				}>;

				return {
					name: t.name,
					type: t.type,
					row_count,
					columns: columns.map((c) => ({
						name: c.name,
						type: c.type,
						notnull: c.notnull === 1,
						default_value: c.dflt_value,
						pk: c.pk > 0,
					})),
					indexes,
					foreign_keys: foreign_keys.map((fk) => ({
						from: fk.from,
						table: fk.table,
						to: fk.to,
					})),
				};
			});

		return { tables };
	}

	compact(options: {
		older_than_days: number;
		dry_run: boolean;
	}): CompactResult {
		const cutoff_ts =
			Date.now() - options.older_than_days * 24 * 60 * 60 * 1000;
		const cutoff_date = new Date(cutoff_ts)
			.toISOString()
			.split('T')[0];

		const bytes_before = existsSync(this.db_path)
			? statSync(this.db_path).size
			: 0;

		if (options.dry_run) {
			const count_tool = (names: string[], min: number) =>
				(
					this.db
						.prepare(
							`SELECT COUNT(*) as n FROM tool_results tr
							 JOIN tool_calls tc ON tr.tool_call_id = tc.id
							 WHERE tc.tool_name IN (${names.map(() => '?').join(',')})
							   AND tr.timestamp < ?
							   AND tr.content IS NOT NULL
							   AND tr.content NOT LIKE '[compacted:%'
							   AND LENGTH(tr.content) > ?`,
						)
						.get(...names, cutoff_ts, min) as {
						n: number;
					}
				).n;

			return {
				dry_run: true,
				older_than_days: options.older_than_days,
				cutoff_date,
				tool_results_compacted: {
					read: count_tool(['read'], 200),
					bash: count_tool(['bash'], 200),
					grep_glob: count_tool(['grep', 'glob'], 100),
					write: count_tool(['write'], 100),
				},
				bytes_before,
				bytes_after: bytes_before,
			};
		}

		let read_count = 0;
		let bash_count = 0;
		let grep_glob_count = 0;
		let write_count = 0;

		const changes = () =>
			(
				this.db.prepare('SELECT changes() as n').get() as {
					n: number;
				}
			).n;

		this.disable_foreign_keys();
		this.begin();

		try {
			// Compact read tool results
			this.db
				.prepare(
					`UPDATE tool_results
					 SET content = '[compacted: ' || LENGTH(content) || 'B — file: ' ||
						COALESCE(JSON_EXTRACT(tc.tool_input, '$.file_path'), 'unknown') ||
						' recoverable from git]'
					 FROM tool_calls tc
					 WHERE tool_results.tool_call_id = tc.id
					   AND tc.tool_name = 'read'
					   AND tool_results.timestamp < ?
					   AND tool_results.content IS NOT NULL
					   AND tool_results.content NOT LIKE '[compacted:%'
					   AND LENGTH(tool_results.content) > 200`,
				)
				.run(cutoff_ts);
			read_count = changes();

			// Compact bash tool results (keep first 200 chars)
			this.db
				.prepare(
					`UPDATE tool_results
					 SET content = SUBSTR(content, 1, 200) || CHAR(10) ||
						'[compacted: truncated from ' || LENGTH(content) || 'B]'
					 FROM tool_calls tc
					 WHERE tool_results.tool_call_id = tc.id
					   AND tc.tool_name = 'bash'
					   AND tool_results.timestamp < ?
					   AND tool_results.content IS NOT NULL
					   AND tool_results.content NOT LIKE '[compacted:%'
					   AND LENGTH(tool_results.content) > 200`,
				)
				.run(cutoff_ts);
			bash_count = changes();

			// Compact grep/glob tool results
			this.db
				.prepare(
					`UPDATE tool_results
					 SET content = '[compacted: ' || LENGTH(content) || 'B]'
					 FROM tool_calls tc
					 WHERE tool_results.tool_call_id = tc.id
					   AND tc.tool_name IN ('grep', 'glob')
					   AND tool_results.timestamp < ?
					   AND tool_results.content IS NOT NULL
					   AND tool_results.content NOT LIKE '[compacted:%'
					   AND LENGTH(tool_results.content) > 100`,
				)
				.run(cutoff_ts);
			grep_glob_count = changes();

			// Compact write tool results
			this.db
				.prepare(
					`UPDATE tool_results
					 SET content = '[compacted: ' || LENGTH(content) || 'B]'
					 FROM tool_calls tc
					 WHERE tool_results.tool_call_id = tc.id
					   AND tc.tool_name = 'write'
					   AND tool_results.timestamp < ?
					   AND tool_results.content IS NOT NULL
					   AND tool_results.content NOT LIKE '[compacted:%'
					   AND LENGTH(tool_results.content) > 100`,
				)
				.run(cutoff_ts);
			write_count = changes();

			this.commit();
		} catch (err) {
			this.db.exec('ROLLBACK');
			throw err;
		} finally {
			this.enable_foreign_keys();
		}

		this.rebuild_fts();
		this.db.exec('VACUUM');

		const bytes_after = existsSync(this.db_path)
			? statSync(this.db_path).size
			: 0;

		return {
			dry_run: false,
			older_than_days: options.older_than_days,
			cutoff_date,
			tool_results_compacted: {
				read: read_count,
				bash: bash_count,
				grep_glob: grep_glob_count,
				write: write_count,
			},
			bytes_before,
			bytes_after,
		};
	}

	close() {
		this.db.close();
	}
}
