import {
	appendFileSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test } from 'vitest';
import {
	ToolDatabase,
	compress_payload,
	decompress_payload,
} from './tool-database.ts';
import { migrate_legacy_database } from './tool-migration.ts';
import { sync_tool_sessions } from './tool-sync.ts';
import { verify_legacy_migration } from './tool-verification.ts';

function temp_path(name: string): string {
	return join(mkdtempSync(join(tmpdir(), 'pi-tool-events-')), name);
}

function session_lines(id = 'session-1'): unknown[] {
	return [
		{
			type: 'session',
			version: 3,
			id,
			timestamp: '2026-09-04T00:00:00.000Z',
			cwd: '/work/project',
		},
		{
			type: 'message',
			id: 'user-1',
			parentId: null,
			timestamp: '2026-09-04T00:00:01.000Z',
			message: {
				role: 'user',
				content: [{ type: 'text', text: 'private' }],
			},
		},
		{
			type: 'message',
			id: 'assistant-1',
			parentId: 'user-1',
			timestamp: '2026-09-04T00:00:02.000Z',
			message: {
				role: 'assistant',
				provider: 'openai',
				model: 'gpt-test',
				content: [
					{ type: 'thinking', thinking: 'never store this' },
					{
						type: 'toolCall',
						id: 'call-1',
						name: 'read',
						arguments: { path: 'README.md' },
					},
				],
				usage: {
					input: 10,
					output: 5,
					cacheRead: 2,
					cacheWrite: 1,
					totalTokens: 18,
					cost: {
						input: 0.1,
						output: 0.2,
						cacheRead: 0.01,
						cacheWrite: 0.02,
						total: 0.33,
					},
				},
			},
		},
		{
			type: 'message',
			id: 'result-1',
			parentId: 'assistant-1',
			timestamp: '2026-09-04T00:00:03.000Z',
			message: {
				role: 'toolResult',
				toolCallId: 'call-1',
				toolName: 'read',
				content: [{ type: 'text', text: 'full result' }],
				details: { source: 'fixture', repeated: 'x'.repeat(2000) },
				isError: false,
			},
		},
	];
}

function write_session(path: string, lines: unknown[]): void {
	writeFileSync(
		path,
		`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
	);
}

describe('compact tool database', () => {
	test('losslessly compresses complete payloads', () => {
		const value = JSON.stringify({
			content: 'x'.repeat(5000),
			details: { ok: true },
		});
		const compressed = compress_payload(value);
		expect(compressed.length).toBeLessThan(value.length);
		expect(decompress_payload(compressed)).toBe(value);
	});

	test('stores ordered calls and results without conversation tables', () => {
		const path = temp_path('tools.db');
		const db = new ToolDatabase(path);
		db.upsert_session({
			id: 's1',
			project_path: '/work',
			first_timestamp: 1,
			last_timestamp: 4,
		});
		db.upsert_tool_call({
			session_id: 's1',
			tool_call_id: 'c1',
			tool_name: 'read',
			turn_index: 1,
			event_index: 2,
			timestamp: 2,
			arguments_json: '{"path":"x"}',
		});
		db.upsert_tool_result({
			session_id: 's1',
			tool_call_id: 'c1',
			tool_name: 'read',
			turn_index: 1,
			event_index: 3,
			timestamp: 3,
			payload_json:
				'{"content":[{"type":"text","text":"ok"}],"details":{"n":1}}',
			is_error: false,
		});
		expect(db.list_tool_events()).toEqual([
			expect.objectContaining({
				event_kind: 'call',
				tool_call_id: 'c1',
				event_index: 2,
			}),
			expect.objectContaining({
				event_kind: 'result',
				tool_call_id: 'c1',
				event_index: 3,
			}),
		]);
		expect(db.read_call_arguments('s1', 'c1')).toBe('{"path":"x"}');
		expect(db.read_result_payload('s1', 'c1')).toContain(
			'"text":"ok"',
		);
		db.close();

		const raw = new DatabaseSync(path, { readOnly: true });
		const tables = raw
			.prepare("SELECT name FROM sqlite_master WHERE type='table'")
			.all()
			.map((row) => String(row.name));
		expect(tables).not.toContain('messages');
		expect(tables).not.toContain('session_records');
		expect(tables.some((name) => name.includes('fts'))).toBe(false);
		raw.close();
	});
});

describe('native tool sync', () => {
	test('adds new events once and follows a moved session by id', async () => {
		const root = mkdtempSync(join(tmpdir(), 'pi-tool-source-'));
		const first = join(root, 'first.jsonl');
		const moved = join(root, 'moved.jsonl');
		const lines = session_lines();
		write_session(first, lines);
		const db = new ToolDatabase(temp_path('sync.db'));

		const initial = await sync_tool_sessions(db, root);
		expect(initial).toMatchObject({
			sessions: 1,
			calls_added: 1,
			results_added: 1,
			usage_added: 1,
		});
		expect((await sync_tool_sessions(db, root)).events_added).toBe(0);

		renameSync(first, moved);
		const appended = [
			...lines,
			{
				type: 'message',
				id: 'assistant-2',
				parentId: 'result-1',
				timestamp: '2026-09-04T00:00:04.000Z',
				message: {
					role: 'assistant',
					provider: 'openai',
					model: 'gpt-test',
					content: [
						{
							type: 'toolCall',
							id: 'call-2',
							name: 'search',
							arguments: { query: 'x' },
						},
					],
				},
			},
		];
		write_session(moved, appended);
		const update = await sync_tool_sessions(db, root);
		expect(update.calls_added).toBe(1);
		expect(db.get_counts()).toMatchObject({
			sessions: 1,
			tool_calls: 2,
			tool_results: 1,
		});
		expect((await sync_tool_sessions(db, root)).events_added).toBe(0);
		db.close();
	});
});

describe('checkpoint recovery', () => {
	test('keeps earlier session commits when a sync is interrupted', async () => {
		const root = mkdtempSync(join(tmpdir(), 'pi-tool-interrupt-'));
		write_session(join(root, 'a.jsonl'), session_lines('session-a'));
		write_session(join(root, 'b.jsonl'), session_lines('session-b'));
		const db = new ToolDatabase(temp_path('interrupt.db'));
		const controller = new AbortController();
		await expect(
			sync_tool_sessions(db, root, {
				signal: controller.signal,
				on_checkpoint: () => controller.abort(),
			}),
		).rejects.toThrow('Sync interrupted');
		expect(db.get_counts()).toMatchObject({
			sessions: 1,
			tool_calls: 1,
			tool_results: 1,
		});
		const resumed = await sync_tool_sessions(db, root);
		expect(resumed).toMatchObject({
			calls_added: 1,
			results_added: 1,
		});
		expect(db.get_counts()).toMatchObject({
			sessions: 2,
			tool_calls: 2,
			tool_results: 2,
		});
		db.close();
	});
});

describe('vanishing sources', () => {
	test('continues when a discovered session vanishes', async () => {
		const root = mkdtempSync(join(tmpdir(), 'pi-tool-vanish-'));
		write_session(join(root, 'a.jsonl'), session_lines('session-a'));
		const vanishing = join(root, 'b.jsonl');
		write_session(vanishing, session_lines('session-b'));
		const db = new ToolDatabase(temp_path('vanish.db'));
		const result = await sync_tool_sessions(db, root, {
			on_checkpoint: (count) => {
				if (count === 1) unlinkSync(vanishing);
			},
		});
		expect(result.sources_vanished).toBe(1);
		expect(db.get_counts().sessions).toBe(1);
		db.close();
	});
});

describe('incremental append', () => {
	test('reads a safe append from the committed byte checkpoint', async () => {
		const root = mkdtempSync(join(tmpdir(), 'pi-tool-append-'));
		const path = join(root, 'session.jsonl');
		write_session(path, session_lines('append-session'));
		const db = new ToolDatabase(temp_path('append.db'));
		await sync_tool_sessions(db, root);
		const next_line = JSON.stringify({
			type: 'message',
			id: 'assistant-next',
			parentId: 'result-1',
			timestamp: '2026-09-04T00:00:05.000Z',
			message: {
				role: 'assistant',
				content: [
					{
						type: 'toolCall',
						id: 'call-next',
						name: 'bash',
						arguments: { command: 'true' },
					},
				],
			},
		});
		const split = Math.floor(next_line.length / 2);
		appendFileSync(path, next_line.slice(0, split));
		expect((await sync_tool_sessions(db, root)).events_added).toBe(0);
		appendFileSync(path, `${next_line.slice(split)}\n`);
		const update = await sync_tool_sessions(db, root);
		expect(update).toMatchObject({
			files_processed: 1,
			calls_added: 1,
			results_added: 0,
		});
		expect(db.get_counts().tool_calls).toBe(2);

		expect(db.get_counts().incomplete_calls).toBe(1);
		appendFileSync(
			path,
			`${JSON.stringify({
				type: 'message',
				id: 'result-next',
				parentId: 'assistant-next',
				timestamp: '2026-09-04T00:00:06.000Z',
				message: {
					role: 'toolResult',
					toolCallId: 'call-next',
					toolName: 'bash',
					content: [{ type: 'text', text: 'done' }],
					isError: false,
				},
			})}\n`,
		);
		expect((await sync_tool_sessions(db, root)).results_added).toBe(
			1,
		);
		expect(db.get_counts().incomplete_calls).toBe(0);
		expect((await sync_tool_sessions(db, root)).events_added).toBe(0);
		db.close();
	});
});

describe('legacy migration', () => {
	test('copies only effective tool and usage data into the compact database', () => {
		const legacy_path = temp_path('legacy.db');
		const legacy = new DatabaseSync(legacy_path);
		legacy.exec(`
			CREATE TABLE sessions (id TEXT PRIMARY KEY, project_path TEXT, first_timestamp INTEGER, last_timestamp INTEGER);
			CREATE TABLE effective_session_records (
				id INTEGER PRIMARY KEY, source_path TEXT, session_id TEXT, source_byte_offset INTEGER,
				message_role TEXT, entry_id TEXT, timestamp INTEGER, provider TEXT, model TEXT, usage_json TEXT,
				input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
				total_tokens INTEGER, cost_input REAL, cost_output REAL, cost_cache_read REAL,
				cost_cache_write REAL, cost_total REAL
			);
			CREATE TABLE record_tool_calls (
				record_id INTEGER, block_index INTEGER, source_path TEXT, session_id TEXT,
				tool_call_id TEXT, tool_name TEXT, arguments_json TEXT
			);
			CREATE TABLE record_tool_results (
				record_id INTEGER, source_path TEXT, session_id TEXT, tool_call_id TEXT, tool_name TEXT,
				content_text TEXT, content_json TEXT, details_json TEXT, is_error INTEGER
			);
			INSERT INTO sessions VALUES ('s1','/work',1,4);
			INSERT INTO effective_session_records VALUES
				(1,'/snapshot/s1','s1',0,'user','u1',1,NULL,NULL,NULL,0,0,0,0,0,0,0,0,0,0),
				(2,'/snapshot/s1','s1',100,'assistant','a1',2,'openai','gpt','{"cost":{"total":0.33}}',10,5,2,1,18,0.1,0.2,0.01,0.02,0.33),
				(3,'/snapshot/s1','s1',200,'toolResult','r1',3,NULL,NULL,NULL,0,0,0,0,0,0,0,0,0,0);
			INSERT INTO record_tool_calls VALUES (2,0,'/snapshot/s1','s1','c1','read','{"path":"x"}');
			INSERT INTO record_tool_results VALUES (3,'/snapshot/s1','s1','c1','read','ok','[{"type":"text","text":"ok"}]','{"n":1}',0);
		`);
		legacy.close();

		const output = temp_path('compact.db');
		const result = migrate_legacy_database(legacy_path, output);
		expect(result).toMatchObject({
			sessions: 1,
			tool_calls: 1,
			tool_results: 1,
			usage_records: 1,
		});
		const db = new ToolDatabase(output, { read_only: true });
		expect(db.read_call_arguments('s1', 'c1')).toBe('{"path":"x"}');
		expect(db.read_result_payload('s1', 'c1')).toBe(
			JSON.stringify({
				content_text: 'ok',
				content_json: '[{"type":"text","text":"ok"}]',
				details_json: '{"n":1}',
			}),
		);
		expect(db.get_counts()).toMatchObject({
			sessions: 1,
			tool_calls: 1,
			tool_results: 1,
			usage_records: 1,
		});

		expect(
			verify_legacy_migration(legacy_path, db, true),
		).toMatchObject({
			pass: true,
			payload_mismatches: 0,
			usage_mismatches: 0,
			order_mismatches: 0,
		});
		db.close();
		expect(readFileSync(legacy_path).length).toBeGreaterThan(0);
	});
});
