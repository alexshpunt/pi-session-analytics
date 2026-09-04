import { existsSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ToolDatabase } from './tool-database.ts';

export interface MigrationResult {
	sessions: number;
	tool_calls: number;
	tool_results: number;
	usage_records: number;
}

interface LegacySession {
	id: string;
	project_path: string | null;
	cwd?: string | null;
	first_timestamp: number | null;
	last_timestamp: number | null;
}

interface LegacyRecord {
	id: number;
	source_path: string;
	session_id: string;
	source_byte_offset: number;
	message_role: string | null;
	entry_id: string | null;
	timestamp: number | null;
	provider: string | null;
	model: string | null;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	total_tokens: number;
	cost_input: number;
	cost_output: number;
	cost_cache_read: number;
	cost_cache_write: number;
	cost_total: number;
	has_usage: number;
	usage_json: string | null;
}

/** Build a new compact database from the effective records in a legacy archive database. */
export function migrate_legacy_database(
	legacy_path: string,
	output_path: string,
	options: {
		replace?: boolean;
		on_session?: (completed: number) => void;
	} = {},
): MigrationResult {
	if (existsSync(output_path)) {
		if (!options.replace)
			throw new Error(
				`Output database already exists: ${output_path}`,
			);
		rmSync(output_path);
	}
	const legacy = new DatabaseSync(legacy_path, { readOnly: true });
	assert_legacy_schema(legacy);
	const output = new ToolDatabase(output_path);
	const result: MigrationResult = {
		sessions: 0,
		tool_calls: 0,
		tool_results: 0,
		usage_records: 0,
	};
	const now = Date.now();
	try {
		const session_columns = table_columns(legacy, 'sessions');
		const session_query = session_columns.has('cwd')
			? 'SELECT id, project_path, cwd, first_timestamp, last_timestamp FROM sessions ORDER BY id'
			: 'SELECT id, project_path, NULL AS cwd, first_timestamp, last_timestamp FROM sessions ORDER BY id';
		const sessions = legacy
			.prepare(session_query)
			.iterate() as Iterable<LegacySession>;
		const record_columns = table_columns(
			legacy,
			'effective_session_records',
		);
		const has_usage_column = record_columns.has('usage_json');
		const has_usage = has_usage_column
			? '(usage_json IS NOT NULL OR total_tokens != 0 OR cost_total != 0)'
			: '(total_tokens != 0 OR input_tokens != 0 OR output_tokens != 0 OR cost_total != 0)';
		const usage_json = has_usage_column ? 'usage_json' : 'NULL';
		const records = legacy.prepare(`
			SELECT id, source_path, session_id, source_byte_offset, message_role,
				entry_id, timestamp, provider, model, input_tokens, output_tokens,
				cache_read_tokens, cache_write_tokens, total_tokens, cost_input,
				cost_output, cost_cache_read, cost_cache_write, cost_total,
				${has_usage} AS has_usage, ${usage_json} AS usage_json
			FROM effective_session_records
			WHERE session_id = ?
			ORDER BY source_path, source_byte_offset, id
		`);
		const calls = legacy.prepare(`
			SELECT block_index, tool_call_id, tool_name, arguments_json
			FROM record_tool_calls WHERE record_id = ? ORDER BY block_index
		`);
		const tool_results = legacy.prepare(`
			SELECT tool_call_id, tool_name, content_text, content_json, details_json, is_error
			FROM record_tool_results WHERE record_id = ?
		`);

		for (const session of sessions) {
			output.transaction(() => {
				const project_path =
					session.project_path ?? session.cwd ?? '';
				output.upsert_session({
					id: session.id,
					project_path,
					first_timestamp: session.first_timestamp ?? 0,
					last_timestamp:
						session.last_timestamp ?? session.first_timestamp ?? 0,
				});
				let turn_index = 0;
				let event_index = 0;
				for (const record of records.iterate(
					session.id,
				) as Iterable<LegacyRecord>) {
					if (record.message_role === 'user') turn_index++;
					for (const call of calls.iterate(record.id) as Iterable<{
						block_index: number;
						tool_call_id: string;
						tool_name: string;
						arguments_json: string;
					}>) {
						event_index++;
						if (
							output.upsert_tool_call({
								session_id: session.id,
								tool_call_id: call.tool_call_id,
								tool_name: call.tool_name,
								turn_index,
								event_index,
								timestamp: record.timestamp ?? undefined,
								provider: record.provider ?? undefined,
								model: record.model ?? undefined,
								arguments_json: call.arguments_json,
								source_path: record.source_path,
								source_byte_offset: record.source_byte_offset,
								source_block_index: call.block_index,
								seen_at: now,
							})
						)
							result.tool_calls++;
					}
					const tool_result = tool_results.get(record.id) as
						| {
								tool_call_id: string;
								tool_name: string;
								content_text: string | null;
								content_json: string;
								details_json: string | null;
								is_error: number;
						  }
						| undefined;
					if (tool_result) {
						event_index++;
						if (
							output.upsert_tool_result({
								session_id: session.id,
								tool_call_id: tool_result.tool_call_id,
								tool_name: tool_result.tool_name,
								turn_index,
								event_index,
								timestamp: record.timestamp ?? undefined,
								payload_json: JSON.stringify({
									content_text: tool_result.content_text,
									content_json: tool_result.content_json,
									details_json: tool_result.details_json,
								}),
								is_error: tool_result.is_error === 1,
								source_path: record.source_path,
								source_byte_offset: record.source_byte_offset,
								seen_at: now,
							})
						)
							result.tool_results++;
					}
					if (
						record.has_usage === 1 &&
						record.message_role === 'assistant'
					) {
						if (
							output.upsert_usage({
								session_id: session.id,
								message_id: record.entry_id ?? `legacy-${record.id}`,
								project_path,
								timestamp:
									record.timestamp ?? session.first_timestamp ?? 0,
								provider: record.provider ?? undefined,
								model: record.model ?? undefined,
								input_tokens: record.input_tokens,
								output_tokens: record.output_tokens,
								cache_read_tokens: record.cache_read_tokens,
								cache_write_tokens: record.cache_write_tokens,
								total_tokens: record.total_tokens,
								cost_recorded: legacy_cost_recorded(record),
								cost_input: record.cost_input,
								cost_output: record.cost_output,
								cost_cache_read: record.cost_cache_read,
								cost_cache_write: record.cost_cache_write,
								cost_total: record.cost_total,
							})
						)
							result.usage_records++;
					}
				}
			});
			result.sessions++;
			options.on_session?.(result.sessions);
		}
		output.raw.exec('PRAGMA optimize');
		return result;
	} finally {
		output.close();
		legacy.close();
	}
}

function legacy_cost_recorded(record: LegacyRecord): boolean {
	if (record.usage_json) {
		try {
			const usage = JSON.parse(record.usage_json) as Record<
				string,
				unknown
			>;
			return usage.cost !== undefined;
		} catch {
			// Fall through to recorded numeric fields for malformed legacy JSON.
		}
	}
	return (
		record.cost_total !== 0 ||
		record.cost_input !== 0 ||
		record.cost_output !== 0 ||
		record.cost_cache_read !== 0 ||
		record.cost_cache_write !== 0
	);
}

function assert_legacy_schema(database: DatabaseSync): void {
	const names = new Set(
		(
			database
				.prepare(
					"SELECT name FROM sqlite_master WHERE type IN ('table','view')",
				)
				.all() as Array<{ name: string }>
		).map((row) => row.name),
	);
	for (const required of [
		'sessions',
		'effective_session_records',
		'record_tool_calls',
		'record_tool_results',
	]) {
		if (!names.has(required))
			throw new Error(`Legacy database is missing ${required}`);
	}
}

function table_columns(
	database: DatabaseSync,
	table: string,
): Set<string> {
	return new Set(
		(
			database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
				name: string;
			}>
		).map((row) => row.name),
	);
}
