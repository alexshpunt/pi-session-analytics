import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ToolDatabase } from './tool-database.ts';
import {
	failure_report,
	recovery_report,
	usage_report,
} from './tool-reports.ts';
import { install_schedule } from './scheduler.ts';
import { verify_tool_database } from './tool-verification.ts';

function database(): ToolDatabase {
	const root = mkdtempSync(join(tmpdir(), 'pi-tool-behavior-'));
	return new ToolDatabase(join(root, 'tools.db'));
}

function add_call(
	db: ToolDatabase,
	id: string,
	name: string,
	event: number,
): void {
	db.upsert_tool_call({
		session_id: 's1',
		tool_call_id: id,
		tool_name: name,
		turn_index: 1,
		event_index: event,
		timestamp: event,
		arguments_json: '{}',
	});
}

describe('failure and usage reports', () => {
	test('keeps recorded failures separate from explicitly inferred recovery', () => {
		const db = database();
		db.upsert_session({
			id: 's1',
			project_path: '/project',
			first_timestamp: 1,
			last_timestamp: 9,
		});
		add_call(db, 'failed', 'read', 1);
		db.upsert_tool_result({
			session_id: 's1',
			tool_call_id: 'failed',
			tool_name: 'read',
			turn_index: 1,
			event_index: 2,
			timestamp: 2,
			payload_json: JSON.stringify({
				content_text: 'ENOENT /tmp/private/123',
			}),
			is_error: true,
		});
		add_call(db, 'retry', 'read', 3);

		db.upsert_tool_result({
			session_id: 's1',
			tool_call_id: 'retry',
			tool_name: 'read',
			turn_index: 1,
			event_index: 4,
			timestamp: 4,
			payload_json: JSON.stringify({ content_text: 'ok' }),
			is_error: false,
		});
		add_call(db, 'incomplete', 'bash', 5);

		expect(failure_report(db)).toEqual([
			expect.objectContaining({
				tool_call_id: 'incomplete',
				failure_kind: 'incomplete',
			}),
			expect.objectContaining({
				tool_call_id: 'failed',
				failure_kind: 'hard_error',
				error_fingerprint: expect.stringContaining('<path>'),
			}),
		]);
		const recovery = recovery_report(db).find(
			(row) => row.tool_call_id === 'failed',
		);
		expect(recovery).toMatchObject({
			recovery_inference: 'inferred_same_tool',
			next_tool_call_id: 'retry',
		});
		expect(recovery).not.toHaveProperty('duration');
		db.close();
	});

	test('aggregates recorded turn usage without putting cost on tool calls', () => {
		const db = database();
		db.upsert_session({
			id: 's1',
			project_path: '/project',
			first_timestamp: 1,
			last_timestamp: 2,
		});
		db.upsert_usage({
			session_id: 's1',
			message_id: 'a1',
			project_path: '/project',
			timestamp: Date.UTC(2026, 8, 4),
			provider: 'openai',
			model: 'gpt',
			input_tokens: 10,
			output_tokens: 5,
			cache_read_tokens: 2,
			cache_write_tokens: 1,
			total_tokens: 18,
			cost_recorded: true,
			cost_input: 0.1,
			cost_output: 0.2,
			cost_cache_read: 0.01,
			cost_cache_write: 0.02,
			cost_total: 0.33,
		});
		expect(usage_report(db, { group_by: 'model' })[0]).toMatchObject({
			group_value: 'openai/gpt',
			total_tokens: 18,
			recorded_cost: 0.33,
		});
		const columns = db.raw
			.prepare('PRAGMA table_info(tool_calls)')
			.all()
			.map((row) => String(row.name));
		expect(columns.some((name) => name.startsWith('cost'))).toBe(
			false,
		);
		db.close();
	});
});

describe('verification and scheduling', () => {
	test('deep verification detects a damaged compressed payload', () => {
		const db = database();
		db.upsert_session({
			id: 's1',
			project_path: '/project',
			first_timestamp: 1,
			last_timestamp: 2,
		});
		add_call(db, 'c1', 'read', 1);
		expect(verify_tool_database(db, true).pass).toBe(true);
		db.raw
			.prepare(
				'UPDATE tool_calls SET arguments_blob = ? WHERE tool_call_id = ?',
			)
			.run(Buffer.from('broken'), 'c1');
		const result = verify_tool_database(db, true);
		expect(result.pass).toBe(false);
		expect(result.payload_errors).toBe(1);
		db.close();
	});

	test('writes a persistent non-overlapping user timer', () => {
		const home = mkdtempSync(join(tmpdir(), 'pi-tool-schedule-'));
		const paths = install_schedule({
			home,
			node_path: '/usr/bin/node',
			cli_path: '/opt/pi-session-analytics.js',
			database_path: '/data/tools.db',
			sessions_path: '/data/sessions',
			interval: '30m',
			start: false,
		});
		const service = readFileSync(paths.service_path, 'utf8');
		const timer = readFileSync(paths.timer_path, 'utf8');
		expect(service).toContain('Type=oneshot');
		expect(service).toContain(
			'sync --database "/data/tools.db" --sessions "/data/sessions" --json',
		);
		expect(timer).toContain('OnUnitActiveSec=30m');
		expect(timer).toContain('Persistent=true');
	});
});
