import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { tools } from './cli.ts';
import { Database } from './db.ts';
import { sync } from './sync.ts';
import {
	group_tool_failures,
	report_tool_arguments,
	summarize_tools,
} from './tool-reports.ts';

const dirs: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function jsonl(entries: unknown[]): string {
	return entries
		.map((entry) => `${JSON.stringify(entry)}\n`)
		.join('');
}

function header(id: string, cwd: string, timestamp: string) {
	return { type: 'session', version: 3, id, cwd, timestamp };
}

function call(
	id: string,
	tool_name: string,
	args: unknown,
	timestamp: string,
	provider = 'openai',
	model = 'model-a',
) {
	return {
		type: 'message',
		id: `message-${id}`,
		parentId: null,
		timestamp,
		message: {
			role: 'assistant',
			provider,
			model,
			content: [
				{ type: 'toolCall', id, name: tool_name, arguments: args },
			],
		},
	};
}

function result(
	id: string,
	tool_name: string,
	text: string,
	is_error: boolean,
	timestamp: string,
) {
	return {
		type: 'message',
		id: `result-${id}`,
		parentId: `message-${id}`,
		timestamp,
		message: {
			role: 'toolResult',
			toolCallId: id,
			toolName: tool_name,
			content: [{ type: 'text', text }],
			isError: is_error,
		},
	};
}

type CommandRun = (context: {
	args: Record<string, unknown>;
}) => Promise<void>;

async function capture_json(args: Record<string, unknown>) {
	const output: string[] = [];
	vi.spyOn(console, 'log').mockImplementation((value) =>
		output.push(String(value)),
	);
	await (tools.run as CommandRun)({ args });
	return JSON.parse(output.at(-1)!) as Record<string, unknown>;
}

async function capture_output(
	args: Record<string, unknown>,
): Promise<string> {
	const output: string[] = [];
	vi.spyOn(console, 'log').mockImplementation((value) =>
		output.push(String(value)),
	);
	await (tools.run as CommandRun)({ args });
	return output.join('\n');
}

describe('canonical tool reports', () => {
	test('reports effective outcomes, failures, arguments, filters, and provenance', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'pi-session-tools-'));
		dirs.push(dir);
		const sessions_dir = join(dir, 'sessions');
		const archive_dir = join(dir, 'archive');
		const db_path = join(dir, 'analytics.db');
		const source_a = join(sessions_dir, '--project-a--', 'a.jsonl');
		const source_b = join(sessions_dir, '--project-b--', 'b.jsonl');
		mkdirSync(dirname(source_a), { recursive: true });
		mkdirSync(dirname(source_b), { recursive: true });

		const a_header = header(
			'session-a',
			'/project/a',
			'2026-09-01T00:00:00.000Z',
		);
		const first_call = call(
			'call-1',
			'bash',
			{
				command: 'secret one',
				options: { force: true },
				paths: ['a'],
			},
			'2026-09-01T00:00:01.000Z',
		);
		const first_result = result(
			'call-1',
			'bash',
			'Permission denied',
			true,
			'2026-09-01T00:00:02.000Z',
		);
		writeFileSync(
			source_a,
			jsonl([a_header, first_call, first_result]),
		);
		writeFileSync(
			source_b,
			jsonl([
				header('session-b', '/project/b', '2026-09-02T00:00:00.000Z'),
				call(
					'call-5',
					'bash',
					{ command: 'other secret' },
					'2026-09-02T00:00:01.000Z',
					'anthropic',
					'model-b',
				),
				result(
					'call-5',
					'bash',
					'ok',
					false,
					'2026-09-02T00:00:02.000Z',
				),
			]),
		);

		const db = new Database(db_path);
		try {
			await sync(db, false, sessions_dir, archive_dir);
			const second_call = call(
				'call-2',
				'bash',
				{
					command: 'secret two',
					options: { force: false },
					paths: ['b'],
				},
				'2026-09-01T00:00:03.000Z',
			);
			const second_result = result(
				'call-2',
				'bash',
				' Permission\n denied ',
				true,
				'2026-09-01T00:00:04.000Z',
			);
			appendFileSync(source_a, jsonl([second_call, second_result]));
			utimesSync(
				source_a,
				new Date(Date.now() + 1_000),
				new Date(Date.now() + 1_000),
			);
			await sync(db, false, sessions_dir, archive_dir);

			writeFileSync(
				source_a,
				jsonl([
					header(
						'session-a',
						'/project/a',
						'2026-09-01T00:00:00.500Z',
					),
					first_call,
					first_result,
					second_call,
					second_result,
					call(
						'call-3',
						'read',
						{ path: '/private/path', offset: 2 },
						'2026-09-01T00:00:05.000Z',
					),
					result(
						'call-3',
						'read',
						'ok',
						false,
						'2026-09-01T00:00:06.000Z',
					),
					call(
						'call-4',
						'write',
						{ path: '/private/path', content: 'private value' },
						'2026-09-01T00:00:07.000Z',
					),
				]),
			);
			utimesSync(
				source_a,
				new Date(Date.now() + 2_000),
				new Date(Date.now() + 2_000),
			);
			await sync(db, false, sessions_dir, archive_dir);

			const activity = [...db.get_tool_activity()];
			expect(activity).toHaveLength(5);
			expect(summarize_tools(activity)).toEqual([
				{
					tool_name: 'bash',
					calls: 3,
					matched_results: 3,
					successes: 1,
					failures: 2,
					incomplete: 0,
					failure_rate: 2 / 3,
				},
				{
					tool_name: 'read',
					calls: 1,
					matched_results: 1,
					successes: 1,
					failures: 0,
					incomplete: 0,
					failure_rate: 0,
				},
				{
					tool_name: 'write',
					calls: 1,
					matched_results: 0,
					successes: 0,
					failures: 0,
					incomplete: 1,
					failure_rate: 0,
				},
			]);

			const failures = group_tool_failures(
				db.get_tool_activity({}, 'failures'),
			);
			expect(failures).toHaveLength(1);
			expect(failures[0]).toMatchObject({
				tool_name: 'bash',
				evidence: 'Permission denied',
				count: 2,
			});
			expect(failures[0]!.occurrences).toHaveLength(2);
			expect(failures[0]!.occurrences[0]).toMatchObject({
				session_id: 'session-a',
				project_path: '/project/a',
				source_path: source_a,
			});
			expect(
				failures[0]!.occurrences[0]!.source_byte_length,
			).toBeGreaterThan(0);

			const arguments_report = report_tool_arguments(
				db.get_tool_activity({}, 'arguments'),
			);
			expect(arguments_report.keys).toContainEqual({
				tool_name: 'bash',
				key: 'options.force',
				calls: 2,
			});
			const repeated_shape = arguments_report.shapes.find(
				(row) => row.tool_name === 'bash' && row.calls === 2,
			);
			expect(repeated_shape?.shape).toBe(
				'{"command":string,"options":{"force":boolean},"paths":[string]}',
			);
			expect(repeated_shape?.shape).not.toContain('secret');
			expect(repeated_shape?.occurrences).toHaveLength(2);

			expect([
				...db.get_tool_activity({ project: 'project/a' }),
			]).toHaveLength(4);
			expect([
				...db.get_tool_activity({ session: 'session-b' }),
			]).toHaveLength(1);
			expect([
				...db.get_tool_activity({ provider: 'anthropic' }),
			]).toHaveLength(1);
			expect([
				...db.get_tool_activity({ model: 'model-b' }),
			]).toHaveLength(1);
			expect([
				...db.get_tool_activity({
					after: Date.parse('2026-09-01T00:00:05.000Z'),
					before: Date.parse('2026-09-02T00:00:00.000Z'),
				}),
			]).toHaveLength(2);
		} finally {
			db.close();
		}

		const human_summary = await capture_output({ db: db_path });
		expect(human_summary).toContain('Tool  Calls  Results');
		expect(human_summary).toContain('write  1  0  0  0  1');
		vi.restoreAllMocks();
		const human_failures = await capture_output({
			_: 'failures',
			db: db_path,
		});
		expect(human_failures).toContain('Permission denied');
		vi.restoreAllMocks();
		const human_arguments = await capture_output({
			_: 'arguments',
			db: db_path,
		});
		expect(human_arguments).toContain('Argument keys');
		expect(human_arguments).not.toContain('private value');
		vi.restoreAllMocks();

		const summary = await capture_json({ db: db_path, json: true });
		expect(summary).toMatchObject({
			schema_version: 1,
			kind: 'pi-session-analytics/tool-summary',
			count: 3,
			totals: { calls: 5, failures: 2, incomplete: 1 },
		});
		vi.restoreAllMocks();
		const empty = await capture_json({
			_: 'failures',
			db: db_path,
			json: true,
			provider: 'absent',
		});
		expect(empty).toMatchObject({
			schema_version: 1,
			kind: 'pi-session-analytics/tool-failures',
			count: 0,
			results: [],
		});
	});
});
