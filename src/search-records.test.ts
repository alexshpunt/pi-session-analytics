import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { Database } from './db.ts';
import { sync } from './sync.ts';

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function jsonl(entries: unknown[]): string {
	return entries
		.map((entry) => `${JSON.stringify(entry)}\n`)
		.join('');
}

describe('canonical archive search', () => {
	test('finds every textual record kind with provenance and filters', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'pi-session-search-'));
		dirs.push(dir);
		const sessions_dir = join(dir, 'sessions');
		const source = join(
			sessions_dir,
			'--search-project--',
			'search.jsonl',
		);
		mkdirSync(dirname(source), { recursive: true });
		writeFileSync(
			source,
			jsonl([
				{
					type: 'session',
					version: 3,
					id: 'search-session',
					timestamp: '2026-09-01T00:00:00.000Z',
					cwd: '/search/project',
				},
				{
					type: 'message',
					id: 'assistant-1',
					parentId: null,
					timestamp: '2026-09-01T00:00:01.000Z',
					message: {
						role: 'assistant',
						provider: 'openai',
						model: 'search-model',
						stopReason: 'error',
						errorMessage: 'errorneedle',
						content: [
							{ type: 'thinking', thinking: 'ponderneedle' },
							{ type: 'text', text: 'messageneedle' },
							{
								type: 'toolCall',
								id: 'call-1',
								name: 'bash',
								arguments: { secretKey: 'argumentneedle' },
							},
						],
					},
				},
				{
					type: 'message',
					id: 'result-1',
					parentId: 'assistant-1',
					timestamp: '2026-09-01T00:00:02.000Z',
					message: {
						role: 'toolResult',
						toolCallId: 'call-1',
						toolName: 'bash',
						content: [{ type: 'text', text: 'outputneedle' }],
						details: { diagnosis: 'detailsneedle' },
						isError: true,
					},
				},
				{
					type: 'compaction',
					id: 'compact-1',
					parentId: 'result-1',
					timestamp: '2026-09-01T00:00:03.000Z',
					summary: 'summaryneedle',
					firstKeptEntryId: 'assistant-1',
					tokensBefore: 100,
					retainedTail: [{ role: 'user', content: 'tailneedle' }],
				},
				{
					type: 'custom_message',
					id: 'custom-1',
					parentId: 'compact-1',
					timestamp: '2026-09-01T00:00:04.000Z',
					customType: 'customneedle',
					content: 'injectedneedle',
					display: true,
				},
				{
					type: 'custom',
					id: 'state-1',
					parentId: 'custom-1',
					timestamp: '2026-09-01T00:00:05.000Z',
					customType: 'state',
					data: { unknownField: 'unknownneedle' },
				},
			]),
		);
		const db = new Database(join(dir, 'search.db'));
		try {
			await sync(db, false, sessions_dir, join(dir, 'archive'));
			for (const term of [
				'messageneedle',
				'ponderneedle',
				'argumentneedle',
				'outputneedle',
				'errorneedle',
				'detailsneedle',
				'summaryneedle',
				'tailneedle',
				'injectedneedle',
				'unknownneedle',
			]) {
				const results = db.search_records(term);
				expect(results, term).toHaveLength(1);
				expect(results[0]).toMatchObject({
					session_id: 'search-session',
					source_path: source,
					project_path: '/search/project',
				});
				expect(results[0]!.archive_generation_id).toBeGreaterThan(0);
				expect(results[0]!.source_byte_length).toBeGreaterThan(0);
			}
			expect(
				db.search_records('summaryneedle', {
					record_type: 'message',
				}),
			).toHaveLength(0);
			expect(
				db.search_records('summaryneedle', {
					record_type: 'compaction',
				}),
			).toHaveLength(1);
			expect(
				db.search_records('summaryneedle', { project: 'other' }),
			).toHaveLength(0);
			expect(
				db.search_records('summaryneedle', {
					project: 'search/project',
				}),
			).toHaveLength(1);
			expect(
				db.search_records('summaryneedle', { session: 'search-' }),
			).toHaveLength(1);
			expect(
				db.search_records('summaryneedle', {
					after: Date.parse('2026-09-02'),
				}),
			).toHaveLength(0);

			writeFileSync(
				source,
				jsonl([
					{
						type: 'session',
						version: 3,
						id: 'search-session',
						timestamp: '2026-09-03T00:00:00.000Z',
						cwd: '/search/project',
					},
					{
						type: 'custom',
						id: 'rewrite-1',
						parentId: null,
						timestamp: '2026-09-03T00:00:01.000Z',
						customType: 'rewrite',
						data: { value: 'currentneedle' },
					},
				]),
			);
			utimesSync(
				source,
				new Date(Date.now() + 1_000),
				new Date(Date.now() + 1_000),
			);
			await sync(db, false, sessions_dir, join(dir, 'archive'));
			expect(db.search_records('messageneedle')).toHaveLength(1);
			expect(db.search_records('currentneedle')).toHaveLength(1);
			db.rebuild_record_fts();
			expect(db.search_records('ponderneedle')).toHaveLength(1);
		} finally {
			db.close();
		}
	});
});
