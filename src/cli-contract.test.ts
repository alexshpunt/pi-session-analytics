import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { query, search } from './cli.ts';
import { Database } from './db.ts';
import { sync } from './sync.ts';

const dirs: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

type CommandRun = (context: {
	args: Record<string, unknown>;
}) => Promise<void>;

async function capture_json(
	command: { run?: unknown },
	args: Record<string, unknown>,
) {
	const output: string[] = [];
	vi.spyOn(console, 'log').mockImplementation((value) =>
		output.push(String(value)),
	);
	await (command.run as CommandRun)({ args });
	return JSON.parse(output.at(-1)!) as Record<string, unknown>;
}

describe('versioned CLI result contracts', () => {
	test('search and query keep the same envelope when results are empty', async () => {
		const dir = mkdtempSync(
			join(tmpdir(), 'pi-session-cli-contract-'),
		);
		dirs.push(dir);
		const db_path = join(dir, 'analytics.db');
		const source = join(dir, 'sessions', '--project--', 'one.jsonl');
		mkdirSync(dirname(source), { recursive: true });
		writeFileSync(
			source,
			[
				{
					type: 'session',
					version: 3,
					id: 'contract-session',
					timestamp: '2026-09-03T00:00:00.000Z',
					cwd: '/project',
				},
				{
					type: 'custom',
					id: 'custom-1',
					parentId: null,
					timestamp: '2026-09-03T00:00:01.000Z',
					customType: 'contractneedle',
					data: { value: 'present' },
				},
			]
				.map((entry) => `${JSON.stringify(entry)}\n`)
				.join(''),
		);
		const db = new Database(db_path);
		await sync(
			db,
			false,
			join(dir, 'sessions'),
			join(dir, 'archive'),
		);
		db.close();

		const found = await capture_json(search, {
			_: 'contractneedle',
			db: db_path,
			json: true,
		});
		expect(found).toMatchObject({
			schema_version: 1,
			kind: 'pi-session-analytics/search-results',
			count: 1,
		});
		expect((found.results as unknown[])[0]).toMatchObject({
			session_id: 'contract-session',
			record_type: 'custom',
		});
		vi.restoreAllMocks();
		const empty = await capture_json(search, {
			_: 'absentneedle',
			db: db_path,
			json: true,
		});
		expect(empty).toMatchObject({
			schema_version: 1,
			kind: 'pi-session-analytics/search-results',
			count: 0,
			results: [],
		});
		vi.restoreAllMocks();
		const queried = await capture_json(query, {
			sql: 'SELECT record_type FROM session_records WHERE 0',
			db: db_path,
			json: true,
		});
		expect(queried).toEqual({
			schema_version: 1,
			kind: 'pi-session-analytics/query-results',
			sql: 'SELECT record_type FROM session_records WHERE 0',
			columns: ['record_type'],
			count: 0,
			rows: [],
		});
	});
});
