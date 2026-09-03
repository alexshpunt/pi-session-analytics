import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { verify } from './cli.ts';
import { Database } from './db.ts';
import { sync } from './sync.ts';
import { verify_archive } from './verification.ts';

const dirs: string[] = [];

afterEach(() => {
	process.exitCode = undefined;
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function jsonl(entries: unknown[]): string {
	return entries
		.map((entry) => `${JSON.stringify(entry)}\n`)
		.join('');
}

type CommandRun = (context: {
	args: Record<string, unknown>;
}) => Promise<void>;

async function capture_json(args: Record<string, unknown>) {
	const output: string[] = [];
	vi.spyOn(console, 'log').mockImplementation((value) =>
		output.push(String(value)),
	);
	await (verify.run as CommandRun)({ args });
	return JSON.parse(output.at(-1)!) as Record<string, unknown>;
}

describe('archive verification', () => {
	test('passes complete state and fails corrupted archived bytes', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'pi-session-verify-'));
		dirs.push(dir);
		const sessions_dir = join(dir, 'sessions');
		const archive_dir = join(dir, 'archive');
		const db_path = join(dir, 'analytics.db');
		const source = join(sessions_dir, '--project--', 'session.jsonl');
		mkdirSync(dirname(source), { recursive: true });
		writeFileSync(
			source,
			jsonl([
				{
					type: 'session',
					version: 3,
					id: 'verify-session',
					timestamp: '2026-09-03T00:00:00.000Z',
					cwd: '/verify/project',
				},
				{
					type: 'message',
					id: 'assistant-1',
					parentId: null,
					timestamp: '2026-09-03T00:00:01.000Z',
					message: {
						role: 'assistant',
						provider: 'provider',
						model: 'model',
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: {
								input: 0.1,
								output: 0.1,
								cacheRead: 0,
								cacheWrite: 0,
								total: 0.2,
							},
						},
						content: [
							{
								type: 'toolCall',
								id: 'call-1',
								name: 'read',
								arguments: { path: '/tmp/a' },
							},
						],
					},
				},
				{
					type: 'message',
					id: 'result-1',
					parentId: 'assistant-1',
					timestamp: '2026-09-03T00:00:02.000Z',
					message: {
						role: 'toolResult',
						toolCallId: 'call-1',
						toolName: 'read',
						content: [{ type: 'text', text: 'ok' }],
						isError: false,
					},
				},
			]),
		);

		const db = new Database(db_path);
		try {
			await sync(db, false, sessions_dir, archive_dir);
			const shallow = await verify_archive(db, archive_dir);
			expect(shallow).toMatchObject({
				schema_version: 1,
				kind: 'pi-session-analytics/verification',
				passed: true,
				deep: false,
			});
			expect(shallow.counts).toMatchObject({
				archive_sources: 1,
				archive_generations: 1,
				session_records: 3,
				effective_tool_calls: 1,
				effective_tool_results: 1,
				effective_usage_records: 1,
			});
			const deep = await verify_archive(db, archive_dir, {
				deep: true,
			});
			expect(deep.passed).toBe(true);
			expect(deep.checks.map((check) => check.name)).toEqual(
				expect.arrayContaining([
					'archive-chunks',
					'archive-generations',
					'present-sources',
					'archive-file-set',
				]),
			);
		} finally {
			db.close();
		}

		const cli_result = await capture_json({
			db: db_path,
			archive: archive_dir,
			deep: true,
			json: true,
		});
		expect(cli_result).toMatchObject({
			passed: true,
			checks: expect.any(Array),
		});
		expect(process.exitCode).toBeUndefined();
		vi.restoreAllMocks();

		const provenance_db = new DatabaseSync(db_path);
		provenance_db.exec(
			'UPDATE session_records SET source_byte_length = source_byte_length + 1 WHERE id = 1',
		);
		provenance_db.close();
		const failed_provenance = await capture_json({
			db: db_path,
			archive: archive_dir,
			deep: false,
			json: true,
		});
		expect(
			(
				failed_provenance.checks as Array<{
					name: string;
					passed: boolean;
				}>
			).find((check) => check.name === 'canonical-record-provenance'),
		).toMatchObject({ passed: false });
		const repaired_db = new DatabaseSync(db_path);
		repaired_db.exec(
			'UPDATE session_records SET source_byte_length = source_byte_length - 1 WHERE id = 1',
		);
		repaired_db.close();
		process.exitCode = undefined;
		vi.restoreAllMocks();

		const corrupt_db = new Database(db_path);
		const chunk = corrupt_db.list_archive_chunks()[0]!;
		corrupt_db.close();
		const chunk_path = join(
			archive_dir,
			'chunks',
			chunk.hash.slice(0, 2),
			chunk.hash,
		);
		writeFileSync(chunk_path, Buffer.alloc(chunk.size_bytes, 0));
		const failed = await capture_json({
			db: db_path,
			archive: archive_dir,
			deep: true,
			json: true,
		});
		expect(failed.passed).toBe(false);
		expect(
			(
				failed.checks as Array<{ name: string; passed: boolean }>
			).find((check) => check.name === 'archive-chunks'),
		).toMatchObject({ passed: false });
		expect(process.exitCode).toBe(1);
	});
});
