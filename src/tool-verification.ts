import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
	decompress_payload,
	type ToolDatabase,
} from './tool-database.ts';

export interface VerificationResult {
	pass: boolean;
	mode: 'shallow' | 'deep';
	integrity: string[];
	foreign_key_violations: number;
	forbidden_tables: string[];
	payloads_checked: number;
	payload_errors: number;
	ordering_errors: number;
	counts: ReturnType<ToolDatabase['get_counts']>;
	database_bytes: number;
}

/** Verify SQLite integrity, compact schema boundaries, ordering, and payload round trips. */
export function verify_tool_database(
	db: ToolDatabase,
	deep = false,
): VerificationResult {
	const integrity = (
		db.raw.prepare('PRAGMA integrity_check').all() as Array<{
			integrity_check: string;
		}>
	).map((row) => row.integrity_check);
	const foreign_key_violations = db.raw
		.prepare('PRAGMA foreign_key_check')
		.all().length;
	const forbidden = new Set([
		'messages',
		'session_records',
		'record_content_blocks',
		'messages_fts',
		'session_records_fts',
	]);
	const tables = (
		db.raw
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all() as Array<{ name: string }>
	).map((row) => row.name);
	const forbidden_tables = tables.filter(
		(name) => forbidden.has(name) || name.includes('fts'),
	);
	let payloads_checked = 0;
	let payload_errors = 0;
	const limit = deep ? '' : 'LIMIT 100';
	for (const row of db.raw
		.prepare(`
		SELECT arguments_blob AS payload, arguments_sha256 AS sha256, arguments_bytes AS bytes
		FROM tool_calls ORDER BY id ${limit}
	`)
		.iterate() as Iterable<{
		payload: Uint8Array;
		sha256: string;
		bytes: number;
	}>) {
		payloads_checked++;
		if (!payload_valid(row)) payload_errors++;
	}
	for (const row of db.raw
		.prepare(`
		SELECT payload_blob AS payload, payload_sha256 AS sha256, payload_bytes AS bytes
		FROM tool_results ORDER BY id ${limit}
	`)
		.iterate() as Iterable<{
		payload: Uint8Array;
		sha256: string;
		bytes: number;
	}>) {
		payloads_checked++;
		if (!payload_valid(row)) payload_errors++;
	}
	const ordering_errors = Number(
		(
			db.raw
				.prepare(`
				SELECT COUNT(*) AS count FROM (
					SELECT event_index FROM tool_calls
					UNION ALL
					SELECT event_index FROM tool_results
				) WHERE event_index <= 0
			`)
				.get() as { count: number }
		).count,
	);
	const result: VerificationResult = {
		pass:
			integrity.length === 1 &&
			integrity[0] === 'ok' &&
			foreign_key_violations === 0 &&
			forbidden_tables.length === 0 &&
			payload_errors === 0 &&
			ordering_errors === 0,
		mode: deep ? 'deep' : 'shallow',
		integrity,
		foreign_key_violations,
		forbidden_tables,
		payloads_checked,
		payload_errors,
		ordering_errors,
		counts: db.get_counts(),
		database_bytes: statSync(db.path).size,
	};
	return result;
}

export interface MigrationVerification {
	pass: boolean;
	legacy_bytes: number;
	compact_bytes: number;
	compact_ratio: number;
	count_mismatches: Record<
		string,
		{ legacy: number; compact: number }
	>;
	payloads_checked: number;
	payload_mismatches: number;
	usage_records_checked: number;
	usage_mismatches: number;

	order_events_checked: number;
	order_mismatches: number;
}

interface LegacyUsageRow {
	session_id: string;
	entry_id: string | null;
	id: number;
	project_path: string;
	timestamp: number | null;
	provider: string | null;
	model: string | null;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	total_tokens: number;
	usage_json: string | null;
	cost_input: number;
	cost_output: number;
	cost_cache_read: number;
	cost_cache_write: number;
	cost_total: number;
}

interface CompactUsageRow extends Omit<
	LegacyUsageRow,
	'entry_id' | 'id' | 'usage_json'
> {
	message_id: string;
	cost_recorded: number;
}

/** Compare a compact candidate against every effective legacy call/result and count. */
export function verify_legacy_migration(
	legacy_path: string,
	compact: ToolDatabase,
	deep = false,
): MigrationVerification {
	const legacy = new DatabaseSync(legacy_path, { readOnly: true });
	try {
		const legacy_counts = {
			sessions: scalar(
				legacy,
				'SELECT COUNT(*) AS count FROM sessions',
			),
			tool_calls: scalar(
				legacy,
				'SELECT COUNT(*) AS count FROM record_tool_calls calls JOIN effective_session_records records ON records.id = calls.record_id',
			),
			tool_results: scalar(
				legacy,
				'SELECT COUNT(*) AS count FROM record_tool_results results JOIN effective_session_records records ON records.id = results.record_id',
			),
			usage_records: scalar(
				legacy,
				`SELECT COUNT(*) AS count FROM effective_session_records WHERE message_role = 'assistant' AND (usage_json IS NOT NULL OR total_tokens != 0 OR cost_total != 0)`,
			),
		};
		const compact_counts = compact.get_counts();
		const count_mismatches: Record<
			string,
			{ legacy: number; compact: number }
		> = {};
		for (const key of [
			'sessions',
			'tool_calls',
			'tool_results',
			'usage_records',
		] as const) {
			if (legacy_counts[key] !== compact_counts[key]) {
				count_mismatches[key] = {
					legacy: legacy_counts[key],
					compact: compact_counts[key],
				};
			}
		}
		let payloads_checked = 0;
		let payload_mismatches = 0;
		let usage_records_checked = 0;
		let usage_mismatches = 0;

		let order_events_checked = 0;
		let order_mismatches = 0;
		if (deep) {
			const compact_call = compact.raw.prepare(
				'SELECT arguments_blob FROM tool_calls WHERE session_id = ? AND tool_call_id = ?',
			);
			const compact_result = compact.raw.prepare(
				'SELECT payload_blob FROM tool_results WHERE session_id = ? AND tool_call_id = ?',
			);
			for (const call of legacy
				.prepare(`
				SELECT calls.session_id, calls.tool_call_id, calls.arguments_json
				FROM record_tool_calls calls
				JOIN effective_session_records records ON records.id = calls.record_id
				ORDER BY calls.session_id, calls.tool_call_id
			`)
				.iterate() as Iterable<{
				session_id: string;
				tool_call_id: string;
				arguments_json: string;
			}>) {
				payloads_checked++;
				const row = compact_call.get(
					call.session_id,
					call.tool_call_id,
				) as { arguments_blob: Uint8Array } | undefined;
				if (
					!row ||
					decompress_payload(row.arguments_blob) !==
						call.arguments_json
				)
					payload_mismatches++;
			}
			for (const result of legacy
				.prepare(`
				SELECT results.session_id, results.tool_call_id, results.content_text,
					results.content_json, results.details_json
				FROM record_tool_results results
				JOIN effective_session_records records ON records.id = results.record_id
				ORDER BY results.session_id, results.tool_call_id
			`)
				.iterate() as Iterable<{
				session_id: string;
				tool_call_id: string;
				content_text: string | null;
				content_json: string;
				details_json: string | null;
			}>) {
				payloads_checked++;
				const expected = JSON.stringify({
					content_text: result.content_text,
					content_json: result.content_json,
					details_json: result.details_json,
				});
				const row = compact_result.get(
					result.session_id,
					result.tool_call_id,
				) as { payload_blob: Uint8Array } | undefined;
				if (!row || decompress_payload(row.payload_blob) !== expected)
					payload_mismatches++;
			}
			const compact_usage = compact.raw.prepare(
				'SELECT * FROM usage_records WHERE session_id = ? AND message_id = ?',
			);
			for (const usage of legacy
				.prepare(`
				SELECT records.session_id, records.entry_id, records.id, sessions.project_path,
					records.timestamp, records.provider, records.model,
					input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
					total_tokens, usage_json, cost_input, cost_output, cost_cache_read,
					cost_cache_write, cost_total
				FROM effective_session_records records
				JOIN sessions ON sessions.id = records.session_id
				WHERE message_role = 'assistant'
					AND (usage_json IS NOT NULL OR total_tokens != 0 OR cost_total != 0)
				ORDER BY records.session_id, records.entry_id, records.id
			`)
				.iterate() as Iterable<LegacyUsageRow>) {
				usage_records_checked++;
				const message_id = usage.entry_id ?? `legacy-${usage.id}`;
				const row = compact_usage.get(
					usage.session_id,
					message_id,
				) as CompactUsageRow | undefined;
				const cost_recorded = usage_cost_recorded(usage.usage_json);
				if (
					!row ||
					row.project_path !== usage.project_path ||
					row.timestamp !== (usage.timestamp ?? 0) ||
					(row.provider ?? '') !== (usage.provider ?? '') ||
					(row.model ?? '') !== (usage.model ?? '') ||
					Number(row.input_tokens) !== Number(usage.input_tokens) ||
					Number(row.output_tokens) !== Number(usage.output_tokens) ||
					Number(row.cache_read_tokens) !==
						Number(usage.cache_read_tokens) ||
					Number(row.cache_write_tokens) !==
						Number(usage.cache_write_tokens) ||
					Number(row.total_tokens) !== Number(usage.total_tokens) ||
					Number(row.cost_recorded) !== (cost_recorded ? 1 : 0) ||
					Number(row.cost_input) !== Number(usage.cost_input) ||
					Number(row.cost_output) !== Number(usage.cost_output) ||
					Number(row.cost_cache_read) !==
						Number(usage.cost_cache_read) ||
					Number(row.cost_cache_write) !==
						Number(usage.cost_cache_write) ||
					Number(row.cost_total) !== Number(usage.cost_total)
				)
					usage_mismatches++;
			}

			const legacy_order = legacy
				.prepare(`
				SELECT records.session_id AS session_id, 'call' AS event_kind,
					calls.tool_call_id AS tool_call_id, records.source_path AS source_path,
					records.source_byte_offset AS source_byte_offset,
					calls.block_index AS block_index
				FROM record_tool_calls calls
				JOIN effective_session_records records ON records.id = calls.record_id
				UNION ALL
				SELECT records.session_id AS session_id, 'result' AS event_kind,
					results.tool_call_id AS tool_call_id, records.source_path AS source_path,
					records.source_byte_offset AS source_byte_offset, 0 AS block_index
				FROM record_tool_results results
				JOIN effective_session_records records ON records.id = results.record_id
				ORDER BY session_id, source_path, source_byte_offset, block_index, event_kind
			`)
				.iterate()
				[Symbol.iterator]();
			const compact_order = compact.raw
				.prepare(`
				SELECT session_id, 'call' AS event_kind, tool_call_id, event_index
				FROM tool_calls
				UNION ALL
				SELECT session_id, 'result' AS event_kind, tool_call_id, event_index
				FROM tool_results
				ORDER BY session_id, event_index, event_kind
			`)
				.iterate()
				[Symbol.iterator]();
			while (true) {
				const expected = legacy_order.next();
				const actual = compact_order.next();
				if (expected.done || actual.done) {
					if (expected.done !== actual.done) order_mismatches++;
					break;
				}
				order_events_checked++;
				const expected_row = expected.value as {
					session_id: string;
					event_kind: string;
					tool_call_id: string;
				};
				const actual_row = actual.value as {
					session_id: string;
					event_kind: string;
					tool_call_id: string;
				};
				if (
					expected_row.session_id !== actual_row.session_id ||
					expected_row.event_kind !== actual_row.event_kind ||
					expected_row.tool_call_id !== actual_row.tool_call_id
				)
					order_mismatches++;
			}
		}
		const legacy_bytes = statSync(legacy_path).size;
		const compact_bytes = statSync(compact.path).size;
		return {
			pass:
				Object.keys(count_mismatches).length === 0 &&
				payload_mismatches === 0 &&
				usage_mismatches === 0 &&
				order_mismatches === 0,
			legacy_bytes,
			compact_bytes,
			compact_ratio:
				legacy_bytes === 0 ? 0 : compact_bytes / legacy_bytes,
			count_mismatches,
			payloads_checked,
			payload_mismatches,
			usage_records_checked,
			usage_mismatches,
			order_events_checked,
			order_mismatches,
		};
	} finally {
		legacy.close();
	}
}

function usage_cost_recorded(value: unknown): boolean {
	if (typeof value !== 'string') return false;
	try {
		return (
			(JSON.parse(value) as Record<string, unknown>).cost !==
			undefined
		);
	} catch {
		return false;
	}
}

function payload_valid(row: {
	payload: Uint8Array;
	sha256: string;
	bytes: number;
}): boolean {
	try {
		const value = decompress_payload(row.payload);
		return (
			Buffer.byteLength(value) === row.bytes &&
			createHash('sha256').update(value).digest('hex') === row.sha256
		);
	} catch {
		return false;
	}
}

function scalar(database: DatabaseSync, sql: string): number {
	return Number(
		(database.prepare(sql).get() as { count: number }).count,
	);
}
