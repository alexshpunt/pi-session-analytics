import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test } from 'vitest';
import { SessionArchive } from './archive.ts';
import { Database } from './db.ts';
import { sync } from './sync.ts';

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function line(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

function header(id: string, cwd: string): unknown {
	return {
		type: 'session',
		version: 3,
		id,
		timestamp: '2026-09-03T00:00:00.000Z',
		cwd,
	};
}

describe('canonical Pi session records', () => {
	test('keeps complete contextual records with exact archive provenance', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'pi-session-records-'));
		dirs.push(dir);
		const sessions_dir = join(dir, 'sessions');
		const archive_dir = join(dir, 'archive');
		const db_path = join(dir, 'records.db');
		const first_path = join(sessions_dir, '--first--', 'first.jsonl');
		const second_path = join(
			sessions_dir,
			'--second--',
			'second.jsonl',
		);
		mkdirSync(dirname(first_path), { recursive: true });
		mkdirSync(dirname(second_path), { recursive: true });
		const usage = {
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
		};
		const first_entries = [
			header('session-first', '/first'),
			{
				type: 'message',
				id: 'duplicate-entry',
				parentId: null,
				timestamp: '2026-09-03T00:00:01.000Z',
				message: { role: 'user', content: 'hello' },
			},
			{
				type: 'message',
				id: 'assistant-1',
				parentId: 'duplicate-entry',
				timestamp: '2026-09-03T00:00:02.000Z',
				message: {
					role: 'assistant',
					api: 'responses',
					provider: 'openai',
					model: 'model-a',
					stopReason: 'toolUse',
					usage,
					content: [
						{ type: 'thinking', thinking: 'reason' },
						{ type: 'text', text: 'answer' },
						{
							type: 'toolCall',
							id: 'shared-call',
							name: 'bash',
							arguments: { command: 'true' },
						},
					],
				},
			},
			{
				type: 'message',
				id: 'result-1',
				parentId: 'assistant-1',
				timestamp: '2026-09-03T00:00:03.000Z',
				message: {
					role: 'toolResult',
					toolCallId: 'shared-call',
					toolName: 'bash',
					content: [{ type: 'text', text: 'failed' }],
					details: { exitCode: 1 },
					usage,
					isError: true,
				},
			},
			{
				type: 'model_change',
				id: 'model-1',
				parentId: 'result-1',
				timestamp: '2026-09-03T00:00:04.000Z',
				provider: 'deepseek',
				modelId: 'model-b',
			},
			{
				type: 'thinking_level_change',
				id: 'thinking-1',
				parentId: 'model-1',
				timestamp: '2026-09-03T00:00:05.000Z',
				thinkingLevel: 'high',
			},
			{
				type: 'compaction',
				id: 'compact-1',
				parentId: 'thinking-1',
				timestamp: '2026-09-03T00:00:06.000Z',
				summary: 'compact summary',
				firstKeptEntryId: 'assistant-1',
				tokensBefore: 500,
				retainedTail: [{ role: 'user', content: 'tail' }],
				details: { readFiles: ['a.ts'] },
				usage,
			},
			{
				type: 'branch_summary',
				id: 'branch-1',
				parentId: 'compact-1',
				timestamp: '2026-09-03T00:00:07.000Z',
				fromId: 'result-1',
				summary: 'branch summary',
				details: { modifiedFiles: ['b.ts'] },
				usage,
			},
			{
				type: 'custom',
				id: 'custom-1',
				parentId: 'branch-1',
				timestamp: '2026-09-03T00:00:08.000Z',
				customType: 'extension-state',
				data: { count: 4 },
			},
			{
				type: 'custom_message',
				id: 'custom-message-1',
				parentId: 'custom-1',
				timestamp: '2026-09-03T00:00:09.000Z',
				customType: 'extension-context',
				content: [{ type: 'text', text: 'injected' }],
				display: true,
				details: { source: 'test' },
			},
			{
				type: 'label',
				id: 'label-1',
				parentId: 'custom-message-1',
				timestamp: '2026-09-03T00:00:10.000Z',
				targetId: 'assistant-1',
				label: 'checkpoint',
			},
			{
				type: 'session_info',
				id: 'info-1',
				parentId: 'label-1',
				timestamp: '2026-09-03T00:00:11.000Z',
				name: 'First session',
			},
		];
		const second_entries = [
			header('session-second', '/second'),
			{
				type: 'message',
				id: 'duplicate-entry',
				parentId: null,
				timestamp: '2026-09-03T01:00:01.000Z',
				message: {
					role: 'assistant',
					api: 'messages',
					provider: 'anthropic',
					model: 'model-c',
					stopReason: 'toolUse',
					usage,
					content: [
						{
							type: 'toolCall',
							id: 'shared-call',
							name: 'read',
							arguments: { path: 'x.ts' },
						},
					],
				},
			},
			{
				type: 'message',
				id: 'result-2',
				parentId: 'duplicate-entry',
				timestamp: '2026-09-03T01:00:02.000Z',
				message: {
					role: 'toolResult',
					toolCallId: 'shared-call',
					toolName: 'read',
					content: [{ type: 'text', text: 'ok' }],
					isError: false,
				},
			},
		];
		writeFileSync(
			first_path,
			`${first_entries.map(line).join('')}{malformed}\n`,
		);
		writeFileSync(second_path, second_entries.map(line).join(''));
		const db = new Database(db_path);
		try {
			const first = await sync(db, false, sessions_dir, archive_dir);
			expect(first.records).toEqual({ added: 16, invalid: 1 });

			appendFileSync(
				first_path,
				line({
					type: 'custom',
					id: 'appended',
					parentId: 'info-1',
					timestamp: '2026-09-03T00:00:12.000Z',
					customType: 'append',
					data: { value: true },
				}),
			);
			utimesSync(first_path, new Date(), new Date());
			const appended = await sync(
				db,
				false,
				sessions_dir,
				archive_dir,
			);
			expect(appended.records).toEqual({ added: 1, invalid: 0 });

			const rewritten_entries = [
				header('session-second', '/second'),
				{
					type: 'custom_message',
					id: 'rewrite-message',
					parentId: null,
					timestamp: '2026-09-03T02:00:00.000Z',
					customType: 'rewrite',
					content: 'new generation',
					display: false,
				},
			];
			writeFileSync(
				second_path,
				rewritten_entries.map(line).join(''),
			);
			utimesSync(
				second_path,
				new Date(Date.now() + 1_000),
				new Date(Date.now() + 1_000),
			);
			const rewritten = await sync(
				db,
				false,
				sessions_dir,
				archive_dir,
			);
			expect(rewritten.records).toEqual({ added: 2, invalid: 0 });
			expect(
				(await sync(db, false, sessions_dir, archive_dir)).records,
			).toEqual({ added: 0, invalid: 0 });

			const sql = new DatabaseSync(db_path, { readOnly: true });
			try {
				const totals = sql
					.prepare('SELECT COUNT(*) AS count FROM session_records')
					.get() as { count: number };
				expect(totals.count).toBe(19);
				expect(
					sql
						.prepare(
							"SELECT COUNT(DISTINCT session_id) AS count FROM session_records WHERE entry_id = 'duplicate-entry'",
						)
						.get(),
				).toEqual({ count: 2 });
				expect(
					sql
						.prepare(
							"SELECT COUNT(DISTINCT session_id) AS count FROM record_tool_calls WHERE tool_call_id = 'shared-call'",
						)
						.get(),
				).toEqual({ count: 2 });
				const types = sql
					.prepare(
						'SELECT DISTINCT record_type FROM session_records ORDER BY record_type',
					)
					.all()
					.map((row) => (row as { record_type: string }).record_type);
				for (const type of [
					'branch_summary',
					'compaction',
					'custom',
					'custom_message',
					'label',
					'message',
					'model_change',
					'session',
					'session_info',
					'thinking_level_change',
				])
					expect(types).toContain(type);
				const assistant = sql
					.prepare(
						"SELECT * FROM session_records WHERE session_id = 'session-first' AND entry_id = 'assistant-1'",
					)
					.get() as { id: number } & Record<string, unknown>;
				expect(assistant).toMatchObject({
					message_role: 'assistant',
					provider: 'openai',
					model: 'model-a',
					api: 'responses',
					stop_reason: 'toolUse',
					input_tokens: 10,
					total_tokens: 18,
					cost_total: 0.33,
				});
				expect(
					sql
						.prepare(
							'SELECT type, text, thinking, tool_name FROM record_content_blocks WHERE record_id = ? ORDER BY block_index',
						)
						.all(assistant.id),
				).toEqual([
					{
						type: 'thinking',
						text: null,
						thinking: 'reason',
						tool_name: null,
					},
					{
						type: 'text',
						text: 'answer',
						thinking: null,
						tool_name: null,
					},
					{
						type: 'toolCall',
						text: null,
						thinking: null,
						tool_name: 'bash',
					},
				]);
				const provenance = sql
					.prepare(
						"SELECT id, archive_generation_id, source_byte_offset, source_byte_length, raw_json FROM session_records WHERE session_id = 'session-first' AND entry_id = 'assistant-1'",
					)
					.get() as {
					id: number;
					archive_generation_id: number;
					source_byte_offset: number;
					source_byte_length: number;
					raw_json: string;
				};
				const restored = join(dir, 'generation.jsonl');
				new SessionArchive(db, archive_dir).restore_generation(
					provenance.archive_generation_id,
					restored,
				);
				const bytes = readFileSync(restored);
				expect(
					bytes
						.subarray(
							provenance.source_byte_offset,
							provenance.source_byte_offset +
								provenance.source_byte_length,
						)
						.toString('utf8'),
				).toBe(provenance.raw_json);
			} finally {
				sql.close();
			}
		} finally {
			db.close();
		}
	});

	test('backfills an unindexed archive after the source is gone', async () => {
		const dir = mkdtempSync(
			join(tmpdir(), 'pi-session-record-backfill-'),
		);
		dirs.push(dir);
		const sessions_dir = join(dir, 'sessions');
		const archive_dir = join(dir, 'archive');
		const db_path = join(dir, 'records.db');
		const source = join(sessions_dir, '--gone--', 'gone.jsonl');
		mkdirSync(dirname(source), { recursive: true });
		writeFileSync(
			source,
			[
				header('gone-session', '/gone'),
				{
					type: 'custom',
					id: 'state-1',
					parentId: null,
					timestamp: '2026-09-03T00:00:01.000Z',
					customType: 'saved',
					data: { retained: true },
				},
			]
				.map(line)
				.join(''),
		);
		const db = new Database(db_path);
		try {
			expect(
				(await sync(db, false, sessions_dir, archive_dir)).records
					.added,
			).toBe(2);
			const sql = new DatabaseSync(db_path);
			try {
				sql.exec(`
					DELETE FROM record_content_blocks;
					DELETE FROM record_tool_calls;
					DELETE FROM record_tool_results;
					DELETE FROM session_records;
					DELETE FROM record_index_state;
				`);
			} finally {
				sql.close();
			}
			rmSync(source);
			const backfill = await sync(
				db,
				false,
				sessions_dir,
				archive_dir,
			);
			expect(backfill.records).toEqual({ added: 2, invalid: 0 });
			expect(backfill.archive.sources_missing).toBe(1);
			const verify = new DatabaseSync(db_path, { readOnly: true });
			try {
				expect(
					verify
						.prepare(
							'SELECT record_type, custom_type, data_json FROM session_records ORDER BY source_byte_offset',
						)
						.all(),
				).toEqual([
					{
						record_type: 'session',
						custom_type: null,
						data_json: null,
					},
					{
						record_type: 'custom',
						custom_type: 'saved',
						data_json: '{"retained":true}',
					},
				]);
			} finally {
				verify.close();
			}
		} finally {
			db.close();
		}
	});
});
