import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { SessionArchive } from './archive.ts';
import { Database } from './db.ts';
import { sync } from './sync.ts';

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function session_header(id: string): string {
	return `${JSON.stringify({
		type: 'session',
		version: 3,
		id,
		timestamp: '2026-09-03T00:00:00.000Z',
		cwd: '/tmp/archive-project',
	})}\n`;
}

function message(id: string, text: string): string {
	return `${JSON.stringify({
		type: 'message',
		id,
		parentId: null,
		timestamp: '2026-09-03T00:00:01.000Z',
		message: { role: 'user', content: [{ type: 'text', text }] },
	})}\n`;
}

describe('durable session archive', () => {
	test('keeps exact generations through append, rewrite, and deletion', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'pi-session-archive-'));
		dirs.push(dir);
		const sessions_dir = join(dir, 'sessions');
		const archive_dir = join(dir, 'archive');
		const source = join(
			sessions_dir,
			'--tmp-archive-project--',
			'one.jsonl',
		);
		const restored = join(dir, 'restored.jsonl');
		mkdirSync(dirname(source), { recursive: true });
		const first_bytes =
			session_header('session-one') + message('m1', 'first');
		writeFileSync(source, first_bytes);
		const db = new Database(join(dir, 'analytics.db'));
		const archive = new SessionArchive(db, archive_dir);

		try {
			const first = await sync(db, false, sessions_dir, archive_dir);
			expect(first.archive).toMatchObject({
				generations_added: 1,
				bytes_added: Buffer.byteLength(first_bytes),
			});
			let generations = db.list_archive_generations(source);
			expect(
				generations.map((generation) => generation.kind),
			).toEqual(['base']);
			archive.restore_generation(generations[0]!.id, restored);
			expect(readFileSync(restored, 'utf8')).toBe(first_bytes);

			const appended_bytes = message('m2', 'second');
			appendFileSync(source, appended_bytes);
			utimesSync(source, new Date(), new Date());
			const appended = await sync(
				db,
				false,
				sessions_dir,
				archive_dir,
			);
			expect(appended.archive).toMatchObject({
				generations_added: 1,
				bytes_added: Buffer.byteLength(appended_bytes),
			});
			generations = db.list_archive_generations(source);
			expect(
				generations.map((generation) => generation.kind),
			).toEqual(['base', 'append']);
			archive.restore_generation(generations[1]!.id, restored);
			expect(readFileSync(restored, 'utf8')).toBe(
				first_bytes + appended_bytes,
			);

			const unchanged = await sync(
				db,
				false,
				sessions_dir,
				archive_dir,
			);
			expect(unchanged.archive.generations_added).toBe(0);
			expect(unchanged.archive.bytes_added).toBe(0);
			expect(db.list_archive_generations(source)).toHaveLength(2);

			const rewritten_bytes =
				session_header('session-one') + message('m3', 'rewritten');
			writeFileSync(source, rewritten_bytes);
			utimesSync(
				source,
				new Date(Date.now() + 1_000),
				new Date(Date.now() + 1_000),
			);
			const rewritten = await sync(
				db,
				false,
				sessions_dir,
				archive_dir,
			);
			expect(rewritten.archive).toMatchObject({
				generations_added: 1,
				bytes_added: Buffer.byteLength(rewritten_bytes),
			});
			generations = db.list_archive_generations(source);
			expect(
				generations.map((generation) => generation.kind),
			).toEqual(['base', 'append', 'rewrite']);
			for (const [index, bytes] of [
				first_bytes,
				first_bytes + appended_bytes,
				rewritten_bytes,
			].entries()) {
				archive.restore_generation(generations[index]!.id, restored);
				expect(readFileSync(restored, 'utf8')).toBe(bytes);
			}

			rmSync(source);
			const deleted = await sync(
				db,
				false,
				sessions_dir,
				archive_dir,
			);
			expect(deleted.archive.sources_missing).toBe(1);
			expect(db.get_archive_source(source)?.source_exists).toBe(0);
			expect(db.list_archive_generations(source)).toHaveLength(3);
			archive.restore_generation(generations[2]!.id, restored);
			expect(readFileSync(restored, 'utf8')).toBe(rewritten_bytes);

			expect(statSync(archive_dir).mode & 0o077).toBe(0);
			for (const entry of readdirSync(archive_dir, {
				recursive: true,
				withFileTypes: true,
			})) {
				const path = join(entry.parentPath, entry.name);
				expect(statSync(path).mode & 0o077).toBe(0);
			}
		} finally {
			db.close();
		}
	});
});
