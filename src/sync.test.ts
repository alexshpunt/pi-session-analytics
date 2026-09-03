import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
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
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe('session metadata backfill', () => {
	test('indexes the latest name from an unchanged legacy session', async () => {
		const dir = mkdtempSync(
			join(tmpdir(), 'pi-session-analytics-sync-'),
		);
		dirs.push(dir);
		const project_dir = join(dir, '--tmp-project--');
		const file_path = join(project_dir, 'named.jsonl');
		mkdirSync(project_dir, { recursive: true });
		const entries = [
			{
				type: 'session',
				version: 3,
				id: 'legacy-named',
				timestamp: '2026-07-15T00:00:00.000Z',
				cwd: '/tmp/project',
			},
			{
				type: 'session_info',
				id: 'info-1',
				parentId: null,
				timestamp: '2026-07-15T00:00:01.000Z',
				name: 'Old name',
			},
			{
				type: 'message',
				id: 'message-1',
				parentId: 'info-1',
				timestamp: '2026-07-15T00:00:02.000Z',
				message: {
					role: 'user',
					content: [{ type: 'text', text: 'first prompt' }],
				},
			},
			{
				type: 'session_info',
				id: 'info-2',
				parentId: 'message-1',
				timestamp: '2026-07-15T00:00:03.000Z',
				name: 'Current name',
			},
		];
		writeFileSync(
			file_path,
			`${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
		);
		const stats = statSync(file_path);
		const db = new Database(join(dir, 'pi-session-analytics.db'));
		db.upsert_session({
			id: 'legacy-named',
			project_path: '/tmp/project',
			cwd: '/tmp/project',
			timestamp: Date.parse('2026-07-15T00:00:00.000Z'),
		});
		db.insert_message({
			id: 'message-1',
			session_id: 'legacy-named',
			type: 'user',
			content_text: 'first prompt',
			timestamp: Date.parse('2026-07-15T00:00:02.000Z'),
		});
		db.update_session_source({
			id: 'legacy-named',
			path: file_path,
			mtime_ms: stats.mtimeMs,
			size_bytes: stats.size,
			last_seen_at: Date.now(),
			first_message: 'first prompt',
		});
		db.set_sync_state(file_path, stats.mtimeMs, stats.size, false);

		const result = await sync(db, false, dir);
		const sessions = db.list_resumable_sessions();
		expect(result.files_processed).toBe(0);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.name).toBe('Current name');
		expect(db.get_sync_state(file_path)?.metadata_indexed).toBe(1);
		expect(db.get_stats().messages).toBe(1);
		db.close();
	});
});

describe('checkpointed sync', () => {
	test('keeps committed source progress after interruption and resumes cleanly', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'pi-session-checkpoint-'));
		dirs.push(dir);
		const sessions_dir = join(dir, 'sessions');
		const archive_dir = join(dir, 'archive');
		const sources = ['one', 'two'].map((name, index) => {
			const path = join(
				sessions_dir,
				`--project-${name}--`,
				`${name}.jsonl`,
			);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(
				path,
				[
					{
						type: 'session',
						version: 3,
						id: `session-${name}`,
						timestamp: `2026-09-0${index + 1}T00:00:00.000Z`,
						cwd: `/project/${name}`,
					},
					{
						type: 'message',
						id: `message-${name}`,
						parentId: null,
						timestamp: `2026-09-0${index + 1}T00:00:01.000Z`,
						message: {
							role: 'user',
							content: [{ type: 'text', text: `checkpoint-${name}` }],
						},
					},
				]
					.map((entry) => `${JSON.stringify(entry)}\n`)
					.join(''),
			);
			return path;
		});
		const db = new Database(join(dir, 'checkpoint.db'));
		try {
			await expect(
				sync(db, false, sessions_dir, archive_dir, {
					on_checkpoint(committed_sources) {
						if (committed_sources === 1)
							throw new Error('intentional interruption');
					},
				}),
			).rejects.toThrow('intentional interruption');
			expect(
				sources.filter((source) => db.get_archive_source(source))
					.length,
			).toBe(1);

			expect(db.search_records('checkpoint-one')).toHaveLength(1);
			expect(db.search_records('checkpoint-two')).toHaveLength(0);
			expect(
				db.get_verification_snapshot().foreign_keys_enabled,
			).toBe(1);
			db.begin();
			db.rollback();
			const resumed = await sync(
				db,
				false,
				sessions_dir,
				archive_dir,
			);
			expect(resumed.archive.generations_added).toBe(1);
			expect(resumed.records.added).toBe(2);
			expect(db.search_records('checkpoint-one')).toHaveLength(1);
			expect(db.search_records('checkpoint-two')).toHaveLength(1);

			const unchanged = await sync(
				db,
				false,
				sessions_dir,
				archive_dir,
			);
			expect(unchanged.archive).toMatchObject({
				generations_added: 0,
				chunks_added: 0,
				bytes_added: 0,
			});
			expect(unchanged.records).toEqual({ added: 0, invalid: 0 });
		} finally {
			db.close();
		}
	});
});

describe('native session discovery', () => {
	function write_session(file_path: string, id: string, cwd: string) {
		mkdirSync(dirname(file_path), { recursive: true });
		writeFileSync(
			file_path,
			`${JSON.stringify({
				type: 'session',
				version: 3,
				id,
				timestamp: '2026-09-03T00:00:00.000Z',
				cwd,
			})}\n`,
		);
	}

	test('selects each header-valid session once and classifies other JSONL files', async () => {
		const dir = mkdtempSync(
			join(tmpdir(), 'pi-session-analytics-discovery-'),
		);
		dirs.push(dir);
		const direct = join(dir, '--tmp-direct--', 'direct.jsonl');
		const nested = join(
			dir,
			'--tmp-nested--',
			'subagents',
			'nested.jsonl',
		);
		const duplicate = join(
			dir,
			'--tmp-direct--',
			'restored',
			'duplicate.jsonl',
		);
		const activity = join(
			dir,
			'--tmp-direct--',
			'artifacts',
			'child.settled.jsonl',
		);
		const malformed = join(
			dir,
			'--tmp-direct--',
			'artifacts',
			'malformed.jsonl',
		);
		write_session(direct, 'session-direct', '/tmp/direct');
		write_session(nested, 'session-nested', '/tmp/nested');
		write_session(duplicate, 'session-direct', '/tmp/direct');
		const now = Date.now() / 1000;
		utimesSync(direct, now - 10, now - 10);
		utimesSync(duplicate, now, now);
		mkdirSync(dirname(activity), { recursive: true });
		writeFileSync(
			activity,
			`${JSON.stringify({ schema: 1, childId: 'child', outcome: 'clean' })}\n`,
		);
		writeFileSync(malformed, '{not json}\n');

		const db = new Database(join(dir, 'discovery.db'));
		try {
			const first = await sync(db, false, dir);
			expect(first.discovery).toEqual({
				candidates: 5,
				sessions: 2,
				excluded: {
					duplicate_session_id: 1,
					malformed_json: 1,
					non_session: 1,
				},
			});
			expect(first.sessions_added).toBe(2);
			expect(db.get_stats().sessions).toBe(2);
			const direct_session = db
				.list_resumable_sessions()
				.find((session) => session.id === 'session-direct');
			expect(direct_session?.path).toBe(duplicate);

			const second = await sync(db, false, dir);
			expect(second.discovery).toEqual(first.discovery);
			expect(second.sessions_added).toBe(0);
			expect(db.get_stats().sessions).toBe(2);
		} finally {
			db.close();
		}
	});
});
