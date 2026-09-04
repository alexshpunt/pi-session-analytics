import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

const module_dir = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_DB_PATH = join(
	process.env.HOME ?? '',
	'.pi',
	'pi-session-analytics.db',
);

export interface SessionInput {
	id: string;
	project_path: string;
	first_timestamp: number;
	last_timestamp: number;
	current_source_path?: string;
	last_seen_at?: number;
}

export interface ToolCallInput {
	session_id: string;
	tool_call_id: string;
	tool_name: string;
	turn_index: number;
	event_index: number;
	timestamp?: number;
	provider?: string;
	model?: string;
	arguments_json: string;
	source_path?: string;
	source_byte_offset?: number;
	source_block_index?: number;
	seen_at?: number;
}

export interface ToolResultInput {
	session_id: string;
	tool_call_id: string;
	tool_name: string;
	turn_index: number;
	event_index: number;
	timestamp?: number;
	payload_json: string;
	is_error: boolean;
	source_path?: string;
	source_byte_offset?: number;
	seen_at?: number;
}

export interface UsageInput {
	session_id: string;
	message_id: string;
	project_path: string;
	timestamp: number;
	provider?: string;
	model?: string;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	total_tokens: number;
	cost_recorded: boolean;
	cost_input: number;
	cost_output: number;
	cost_cache_read: number;
	cost_cache_write: number;
	cost_total: number;
}

export interface SourceInput {
	session_id: string;
	current_path: string;
	source_mtime_ms: number;
	source_size_bytes: number;
	processed_bytes: number;
	processed_prefix_sha256: string;
	last_seen_at: number;
}

export interface SourceRecord {
	session_id: string;
	current_path: string;
	source_mtime_ms: number;
	source_size_bytes: number;
	processed_bytes: number;
	processed_prefix_sha256: string;
	last_seen_at: number;
}

export interface DatabaseCounts {
	sessions: number;
	tool_calls: number;
	tool_results: number;
	incomplete_calls: number;
	usage_records: number;
}

/** Losslessly compress one UTF-8 tool payload for compact SQLite storage. */
export function compress_payload(value: string): Buffer {
	return deflateRawSync(Buffer.from(value), { level: 6 });
}

/** Restore one payload produced by {@link compress_payload}. */
export function decompress_payload(value: Uint8Array): string {
	return inflateRawSync(value).toString('utf8');
}

/** Stable SHA-256 for the uncompressed UTF-8 payload. */
export function payload_sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

/** Value-free JSON shape used by argument reports. */
export function argument_shape(value: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value) as unknown;
	} catch {
		return 'invalid-json';
	}
	return JSON.stringify(shape_of(parsed));
}

function shape_of(value: unknown): unknown {
	if (value === null) return 'null';
	if (Array.isArray(value))
		return value.length === 0 ? [] : [shape_of(value[0])];
	if (typeof value !== 'object') return typeof value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => [key, shape_of(item)]),
	);
}

/** Normalized recorded error text used only for grouping failures. */
export function error_fingerprint(
	payload_json: string,
): string | undefined {
	let text = payload_json;
	try {
		const value = JSON.parse(payload_json) as {
			content_text?: string | null;
			content?: unknown;
		};
		text =
			value.content_text ?? JSON.stringify(value.content ?? value);
	} catch {
		// The full payload remains available; normalize the input itself.
	}
	const normalized = text
		.replace(/(?:[A-Za-z]:)?\/(?:[^\s:'"]+\/)+[^\s:'"]*/g, '<path>')
		.replace(
			/\b(?:LINE|SEARCH|CHANGE)#[0-9A-Fa-f:.-]+\b/g,
			'<anchor>',
		)
		.replace(/\b\d+\b/g, '<n>')
		.replace(/\s+/g, ' ')
		.trim();
	return normalized.slice(0, 500) || undefined;
}

/** Compact SQLite store for ordered Pi tool activity and independent usage. */
export class ToolDatabase {
	readonly raw: DatabaseSync;

	constructor(
		readonly path = DEFAULT_DB_PATH,
		options: { read_only?: boolean } = {},
	) {
		const existed = existsSync(path);
		this.raw = new DatabaseSync(path, {
			readOnly: options.read_only ?? false,
		});
		this.raw.exec(
			'PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 30000;',
		);
		if (!existed && !options.read_only) {
			this.raw.exec(
				readFileSync(join(module_dir, 'schema.sql'), 'utf8'),
			);
		}
		this.assert_compact_schema();
	}

	close(): void {
		this.raw.close();
	}

	transaction<T>(action: () => T): T {
		this.raw.exec('BEGIN IMMEDIATE');
		try {
			const result = action();
			this.raw.exec('COMMIT');
			return result;
		} catch (error) {
			this.raw.exec('ROLLBACK');
			throw error;
		}
	}

	async transaction_async<T>(action: () => Promise<T>): Promise<T> {
		this.raw.exec('BEGIN IMMEDIATE');
		try {
			const result = await action();
			this.raw.exec('COMMIT');
			return result;
		} catch (error) {
			this.raw.exec('ROLLBACK');
			throw error;
		}
	}

	upsert_session(input: SessionInput): void {
		this.raw
			.prepare(`
				INSERT INTO sessions(
					id, project_path, first_timestamp, last_timestamp,
					current_source_path, source_exists, last_seen_at
				) VALUES (?, ?, ?, ?, ?, 1, ?)
				ON CONFLICT(id) DO UPDATE SET
					project_path = excluded.project_path,
					first_timestamp = MIN(sessions.first_timestamp, excluded.first_timestamp),
					last_timestamp = MAX(sessions.last_timestamp, excluded.last_timestamp),
					current_source_path = COALESCE(excluded.current_source_path, sessions.current_source_path),
					source_exists = 1,
					last_seen_at = COALESCE(excluded.last_seen_at, sessions.last_seen_at)
			`)
			.run(
				input.id,
				input.project_path,
				input.first_timestamp,
				input.last_timestamp,
				input.current_source_path ?? null,
				input.last_seen_at ?? null,
			);
	}

	upsert_tool_call(input: ToolCallInput): boolean {
		const seen_at = input.seen_at ?? Date.now();
		const existed =
			this.raw
				.prepare(
					'SELECT 1 FROM tool_calls WHERE session_id = ? AND tool_call_id = ?',
				)
				.get(input.session_id, input.tool_call_id) !== undefined;
		const event_index = existed
			? input.event_index
			: this.append_safe_event_index(
					input.session_id,
					input.event_index,
				);
		const compressed = compress_payload(input.arguments_json);
		this.raw
			.prepare(`
				INSERT INTO tool_calls(
					session_id, tool_call_id, tool_name, turn_index, event_index,
					timestamp, provider, model, arguments_blob, arguments_sha256,
					arguments_bytes, argument_shape, source_path, source_byte_offset,
					source_block_index, first_seen_at, last_seen_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(session_id, tool_call_id) DO UPDATE SET
					tool_name = excluded.tool_name,
					provider = COALESCE(excluded.provider, tool_calls.provider),
					model = COALESCE(excluded.model, tool_calls.model),

					arguments_blob = excluded.arguments_blob,
					arguments_sha256 = excluded.arguments_sha256,
					arguments_bytes = excluded.arguments_bytes,
					argument_shape = excluded.argument_shape,
					source_path = COALESCE(excluded.source_path, tool_calls.source_path),
					source_byte_offset = COALESCE(excluded.source_byte_offset, tool_calls.source_byte_offset),
					source_block_index = COALESCE(excluded.source_block_index, tool_calls.source_block_index),
					last_seen_at = excluded.last_seen_at
			`)
			.run(
				input.session_id,
				input.tool_call_id,
				input.tool_name,
				input.turn_index,
				event_index,
				input.timestamp ?? null,
				input.provider ?? null,
				input.model ?? null,
				compressed,
				payload_sha256(input.arguments_json),
				Buffer.byteLength(input.arguments_json),
				argument_shape(input.arguments_json),
				input.source_path ?? null,
				input.source_byte_offset ?? null,
				input.source_block_index ?? null,
				seen_at,
				seen_at,
			);
		return !existed;
	}

	upsert_tool_result(input: ToolResultInput): boolean {
		const seen_at = input.seen_at ?? Date.now();
		const existed =
			this.raw
				.prepare(
					'SELECT 1 FROM tool_results WHERE session_id = ? AND tool_call_id = ?',
				)
				.get(input.session_id, input.tool_call_id) !== undefined;
		const event_index = existed
			? input.event_index
			: this.append_safe_event_index(
					input.session_id,
					input.event_index,
				);
		const compressed = compress_payload(input.payload_json);
		this.raw
			.prepare(`
				INSERT INTO tool_results(
					session_id, tool_call_id, tool_name, turn_index, event_index,
					timestamp, is_error, payload_blob, payload_sha256, payload_bytes,
					error_fingerprint, source_path, source_byte_offset, first_seen_at, last_seen_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(session_id, tool_call_id) DO UPDATE SET
					tool_name = excluded.tool_name,
					is_error = excluded.is_error,
					payload_blob = excluded.payload_blob,
					payload_sha256 = excluded.payload_sha256,
					payload_bytes = excluded.payload_bytes,
					error_fingerprint = excluded.error_fingerprint,
					source_path = COALESCE(excluded.source_path, tool_results.source_path),
					source_byte_offset = COALESCE(excluded.source_byte_offset, tool_results.source_byte_offset),
					last_seen_at = excluded.last_seen_at
			`)
			.run(
				input.session_id,
				input.tool_call_id,
				input.tool_name,
				input.turn_index,
				event_index,
				input.timestamp ?? null,
				input.is_error ? 1 : 0,
				compressed,
				payload_sha256(input.payload_json),
				Buffer.byteLength(input.payload_json),
				input.is_error
					? (error_fingerprint(input.payload_json) ?? null)
					: null,
				input.source_path ?? null,
				input.source_byte_offset ?? null,
				seen_at,
				seen_at,
			);
		return !existed;
	}

	upsert_usage(input: UsageInput): boolean {
		const result = this.raw
			.prepare(`
				INSERT INTO usage_records(
					session_id, message_id, project_path, timestamp, provider, model,
					input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
					total_tokens, cost_recorded, cost_input, cost_output,
					cost_cache_read, cost_cache_write, cost_total
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(session_id, message_id) DO NOTHING
			`)
			.run(
				input.session_id,
				input.message_id,
				input.project_path,
				input.timestamp,
				input.provider ?? null,
				input.model ?? null,
				input.input_tokens,
				input.output_tokens,
				input.cache_read_tokens,
				input.cache_write_tokens,
				input.total_tokens,
				input.cost_recorded ? 1 : 0,
				input.cost_input,
				input.cost_output,
				input.cost_cache_read,
				input.cost_cache_write,
				input.cost_total,
			);
		return result.changes === 1;
	}

	upsert_source(input: SourceInput): void {
		this.raw
			.prepare(`
				INSERT INTO session_sources(
					session_id, current_path, source_mtime_ms, source_size_bytes,
					processed_bytes, processed_prefix_sha256, last_seen_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(session_id) DO UPDATE SET
					current_path = excluded.current_path,
					source_mtime_ms = excluded.source_mtime_ms,
					source_size_bytes = excluded.source_size_bytes,
					processed_bytes = excluded.processed_bytes,
					processed_prefix_sha256 = excluded.processed_prefix_sha256,
					last_seen_at = excluded.last_seen_at
			`)
			.run(
				input.session_id,
				input.current_path,
				input.source_mtime_ms,
				input.source_size_bytes,
				input.processed_bytes,
				input.processed_prefix_sha256,
				input.last_seen_at,
			);
	}

	get_session_cursor(session_id: string): {
		turn_index: number;
		event_index: number;
	} {
		const row = this.raw
			.prepare(`
				SELECT
					MAX(turn_index) AS turn_index,
					MAX(event_index) AS event_index
				FROM (
					SELECT turn_index, event_index FROM tool_calls WHERE session_id = ?
					UNION ALL
					SELECT turn_index, event_index FROM tool_results WHERE session_id = ?
				)
			`)
			.get(session_id, session_id) as {
			turn_index: number | null;
			event_index: number | null;
		};
		return {
			turn_index: row.turn_index ?? 0,
			event_index: row.event_index ?? 0,
		};
	}

	get_source(session_id: string): SourceRecord | undefined {
		return this.raw
			.prepare('SELECT * FROM session_sources WHERE session_id = ?')
			.get(session_id) as SourceRecord | undefined;
	}

	mark_sources_missing(seen_at: number): void {
		this.raw
			.prepare(`
				UPDATE sessions SET source_exists = CASE
					WHEN EXISTS (
						SELECT 1 FROM session_sources source
						WHERE source.session_id = sessions.id AND source.last_seen_at = ?
					) THEN 1 ELSE 0 END
			`)
			.run(seen_at);
	}

	read_call_arguments(
		session_id: string,
		tool_call_id: string,
	): string | undefined {
		const row = this.raw
			.prepare(
				'SELECT arguments_blob FROM tool_calls WHERE session_id = ? AND tool_call_id = ?',
			)
			.get(session_id, tool_call_id) as
			| { arguments_blob: Uint8Array }
			| undefined;
		return row ? decompress_payload(row.arguments_blob) : undefined;
	}

	read_result_payload(
		session_id: string,
		tool_call_id: string,
	): string | undefined {
		const row = this.raw
			.prepare(
				'SELECT payload_blob FROM tool_results WHERE session_id = ? AND tool_call_id = ?',
			)
			.get(session_id, tool_call_id) as
			| { payload_blob: Uint8Array }
			| undefined;
		return row ? decompress_payload(row.payload_blob) : undefined;
	}

	list_tool_events(): Array<Record<string, unknown>> {
		return this.raw
			.prepare(`
				SELECT 'call' AS event_kind, id, session_id, tool_call_id, tool_name,
					turn_index, event_index, timestamp, 0 AS is_error
				FROM tool_calls
				UNION ALL
				SELECT 'result' AS event_kind, id, session_id, tool_call_id, tool_name,
					turn_index, event_index, timestamp, is_error
				FROM tool_results
				ORDER BY session_id, event_index, event_kind, id
			`)
			.all() as Array<Record<string, unknown>>;
	}

	get_counts(): DatabaseCounts {
		const scalar = (sql: string): number =>
			Number(
				(this.raw.prepare(sql).get() as { count: number }).count,
			);
		return {
			sessions: scalar('SELECT COUNT(*) AS count FROM sessions'),
			tool_calls: scalar('SELECT COUNT(*) AS count FROM tool_calls'),
			tool_results: scalar(
				'SELECT COUNT(*) AS count FROM tool_results',
			),
			incomplete_calls: scalar(`
				SELECT COUNT(*) AS count FROM tool_calls calls
				LEFT JOIN tool_results results
					ON results.session_id = calls.session_id
					AND results.tool_call_id = calls.tool_call_id
				WHERE results.id IS NULL
			`),
			usage_records: scalar(
				'SELECT COUNT(*) AS count FROM usage_records',
			),
		};
	}

	private append_safe_event_index(
		session_id: string,
		proposed: number,
	): number {
		const row = this.raw
			.prepare(`
			SELECT MAX(event_index) AS maximum FROM (
				SELECT event_index FROM tool_calls WHERE session_id = ?
				UNION ALL
				SELECT event_index FROM tool_results WHERE session_id = ?
			)
		`)
			.get(session_id, session_id) as { maximum: number | null };
		return Math.max(proposed, (row.maximum ?? 0) + 1);
	}

	private assert_compact_schema(): void {
		let row: { value: string } | undefined;
		try {
			row = this.raw
				.prepare(
					"SELECT value FROM metadata WHERE key = 'schema_kind'",
				)
				.get() as { value: string } | undefined;
		} catch {
			throw new Error(
				'Database is not a compact tool-event database; run migrate first',
			);
		}
		if (row?.value !== 'compact-tool-events') {
			throw new Error(
				'Database is not a compact tool-event database; run migrate first',
			);
		}
	}
}
