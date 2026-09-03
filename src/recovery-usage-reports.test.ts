import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { recoveries, usage } from './cli.ts';
import { Database } from './db.ts';
import {
	group_recoveries,
	group_usage,
	infer_recoveries,
} from './recovery-usage-reports.ts';
import { sync } from './sync.ts';

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

function user(id: string, timestamp: string) {
	return {
		type: 'message',
		id,
		parentId: null,
		timestamp,
		message: { role: 'user', content: [{ type: 'text', text: id }] },
	};
}

interface UsageFixture {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

function call(
	id: string,
	tool_name: string,
	timestamp: string,
	provider: string,
	model: string,
	usage?: UsageFixture,
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
			usage,
			content: [
				{ type: 'toolCall', id, name: tool_name, arguments: { id } },
			],
		},
	};
}

function result(
	id: string,
	tool_name: string,
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
			content: [{ type: 'text', text: is_error ? 'failed' : 'ok' }],
			isError: is_error,
		},
	};
}

function usage_message(
	id: string,
	timestamp: string,
	provider: string,
	model: string,
	usage: UsageFixture,
) {
	return {
		type: 'message',
		id,
		parentId: null,
		timestamp,
		message: {
			role: 'assistant',
			provider,
			model,
			usage,
			content: [{ type: 'text', text: 'answer' }],
		},
	};
}

const usage_a: UsageFixture = {
	input: 10,
	output: 2,
	cacheRead: 3,
	cacheWrite: 4,
	totalTokens: 19,
	cost: {
		input: 0.1,
		output: 0.2,
		cacheRead: 0.03,
		cacheWrite: 0.04,
		total: 0.37,
	},
};
const usage_b: UsageFixture = {
	input: 4,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 5,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};
const usage_c: UsageFixture = {
	input: 6,
	output: 2,
	cacheRead: 2,
	cacheWrite: 0,
	totalTokens: 10,
	cost: {
		input: 0.04,
		output: 0.05,
		cacheRead: 0.01,
		cacheWrite: 0,
		total: 0.1,
	},
};

const usage_missing_cost: UsageFixture = {
	input: 1,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 1,
};

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

async function capture_output(
	command: { run?: unknown },
	args: Record<string, unknown>,
) {
	const output: string[] = [];
	vi.spyOn(console, 'log').mockImplementation((value) =>
		output.push(String(value)),
	);
	await (command.run as CommandRun)({ args });
	return output.join('\n');
}

describe('recovery and recorded usage reports', () => {
	test('infers bounded recovery and aggregates only recorded effective usage', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'pi-session-recovery-'));
		dirs.push(dir);
		const sessions_dir = join(dir, 'sessions');
		const archive_dir = join(dir, 'archive');
		const db_path = join(dir, 'analytics.db');
		const source_a = join(sessions_dir, '--project-a--', 'a.jsonl');
		const source_b = join(sessions_dir, '--project-b--', 'b.jsonl');
		mkdirSync(dirname(source_a), { recursive: true });
		mkdirSync(dirname(source_b), { recursive: true });

		const session_a_entries = (header_timestamp: string) => [
			{
				type: 'session',
				version: 3,
				id: 'session-a',
				cwd: '/project/a',
				timestamp: header_timestamp,
			},
			user('user-1', '2026-09-01T00:00:01.000Z'),
			call(
				'failure-1',
				'read',
				'2026-09-01T00:00:02.000Z',
				'p1',
				'm1',
				usage_a,
			),
			result('failure-1', 'read', true, '2026-09-01T00:00:03.000Z'),
			call(
				'alternate-1',
				'bash',
				'2026-09-01T00:00:04.000Z',
				'p1',
				'm1',
			),
			result(
				'alternate-1',
				'bash',
				false,
				'2026-09-01T00:00:05.000Z',
			),
			call('retry-1', 'read', '2026-09-01T00:00:06.000Z', 'p1', 'm1'),
			result('retry-1', 'read', false, '2026-09-01T00:00:07.000Z'),
			call(
				'failure-2',
				'edit',
				'2026-09-01T00:00:08.000Z',
				'p2',
				'm2',
				usage_b,
			),
			result('failure-2', 'edit', true, '2026-09-01T00:00:09.000Z'),
			call(
				'alternate-2',
				'write',
				'2026-09-01T00:00:10.000Z',
				'p2',
				'm2',
			),
			result(
				'alternate-2',
				'write',
				false,
				'2026-09-01T00:00:11.000Z',
			),
			call(
				'failure-3',
				'bash',
				'2026-09-01T00:00:12.000Z',
				'p1',
				'm1',
				usage_missing_cost,
			),
			result('failure-3', 'bash', true, '2026-09-01T00:00:13.000Z'),
			user('user-2', '2026-09-01T00:00:14.000Z'),
			call(
				'too-late',
				'bash',
				'2026-09-01T00:00:15.000Z',
				'p1',
				'm1',
			),
			result('too-late', 'bash', false, '2026-09-01T00:00:16.000Z'),
		];
		writeFileSync(
			source_a,
			jsonl(session_a_entries('2026-09-01T00:00:00.000Z')),
		);
		writeFileSync(
			source_b,
			jsonl([
				{
					type: 'session',
					version: 3,
					id: 'session-b',
					cwd: '/project/b',
					timestamp: '2026-09-02T00:00:00.000Z',
				},
				usage_message(
					'usage-b',
					'2026-09-02T00:00:01.000Z',
					'p1',
					'm1',
					usage_c,
				),
			]),
		);

		const db = new Database(db_path);
		try {
			await sync(db, false, sessions_dir, archive_dir);
			writeFileSync(
				source_a,
				jsonl(session_a_entries('2026-09-01T00:00:00.500Z')),
			);
			utimesSync(
				source_a,
				new Date(Date.now() + 1_000),
				new Date(Date.now() + 1_000),
			);
			await sync(db, false, sessions_dir, archive_dir);

			const recoveries_report = infer_recoveries(
				db.get_recovery_activity(),
				db.get_user_turn_boundaries(),
			);
			expect(recoveries_report).toHaveLength(3);
			expect(
				recoveries_report.map((row) => row.classification),
			).toEqual([
				'same-tool-recovery',
				'alternate-tool-recovery',
				'unresolved',
			]);
			expect(recoveries_report[0]).toMatchObject({
				failure_tool: 'read',
				recovery_tool: 'read',
				intervening_tool_calls: 1,
				intervening_tools: ['bash'],
			});
			expect(
				recoveries_report[0]!.failure_result.source_byte_length,
			).toBeGreaterThan(0);
			expect(
				recoveries_report[0]!.recovery_result?.source_byte_length,
			).toBeGreaterThan(0);
			expect(recoveries_report[2]!.recovery_result).toBeNull();

			expect(group_recoveries(recoveries_report, 'model')).toEqual([
				{
					group: 'model',
					value: 'p1/m1',
					failures: 2,
					same_tool: 1,
					alternate_tool: 0,
					unresolved: 1,
					inferred_recovery_rate: 0.5,
				},
				{
					group: 'model',
					value: 'p2/m2',
					failures: 1,
					same_tool: 0,
					alternate_tool: 1,
					unresolved: 0,
					inferred_recovery_rate: 1,
				},
			]);
			expect(
				infer_recoveries(
					db.get_recovery_activity(),
					db.get_user_turn_boundaries(),
					{ provider: 'p2' },
				),
			).toHaveLength(1);

			expect(
				infer_recoveries(
					db.get_recovery_activity(),
					db.get_user_turn_boundaries(),
					{ project: 'project/a', session: 'session-a', model: 'm1' },
				),
			).toHaveLength(2);
			expect(
				infer_recoveries(
					db.get_recovery_activity(),
					db.get_user_turn_boundaries(),
					{
						after: Date.parse('2026-09-01T00:00:12.000Z'),
						before: Date.parse('2026-09-01T00:00:14.000Z'),
					},
				),
			).toHaveLength(1);

			const usage_activity = db.get_usage_activity();
			expect(usage_activity).toHaveLength(4);
			const by_model = group_usage(usage_activity, 'model');
			expect(by_model[0]).toMatchObject({
				value: 'p1/m1',
				messages: 3,
				priced_messages: 2,
				unpriced_messages: 1,
				input_tokens: 17,
				output_tokens: 4,
				cache_read_tokens: 5,
				cache_write_tokens: 4,
				total_tokens: 30,
				cost_total: 0.47,
			});
			expect(by_model[0]!.details).toHaveLength(3);
			expect(
				by_model[0]!.details.some((row) => !row.cost_recorded),
			).toBe(true);
			expect(
				by_model[0]!.details[0]!.source_byte_length,
			).toBeGreaterThan(0);
			expect(group_usage(usage_activity, 'provider')).toHaveLength(2);
			expect(group_usage(usage_activity, 'project')).toHaveLength(2);
			expect(
				group_usage(usage_activity, 'day').map((row) => row.value),
			).toEqual(['2026-09-01', '2026-09-02']);
			expect(
				db.get_usage_activity({ project: 'project/b' }),
			).toHaveLength(1);
			expect(
				db.get_usage_activity({ session: 'session-a' }),
			).toHaveLength(3);
			expect(db.get_usage_activity({ provider: 'p2' })).toHaveLength(
				1,
			);
			expect(db.get_usage_activity({ model: 'm2' })).toHaveLength(1);
			expect(
				db.get_usage_activity({ after: Date.parse('2026-09-02') }),
			).toHaveLength(1);
		} finally {
			db.close();
		}

		const recovery_json = await capture_json(recoveries, {
			db: db_path,
			json: true,
		});
		expect(recovery_json).toMatchObject({
			schema_version: 1,
			kind: 'pi-session-analytics/inferred-recoveries',
			inferred: true,
			count: 3,

			group: 'model',
			groups: [
				expect.objectContaining({ value: 'p1/m1', failures: 2 }),
				expect.objectContaining({ value: 'p2/m2', failures: 1 }),
			],
			totals: { same_tool: 1, alternate_tool: 1, unresolved: 1 },
		});
		vi.restoreAllMocks();
		const usage_json = await capture_json(usage, {
			db: db_path,
			json: true,
			group: 'model',
			details: true,
		});
		expect(usage_json).toMatchObject({
			schema_version: 1,
			kind: 'pi-session-analytics/recorded-usage',
			recorded_only: true,
			details_included: true,
			count: 2,
			totals: {
				messages: 4,
				priced_messages: 3,
				unpriced_messages: 1,
				total_tokens: 35,
				cost_total: 0.47,
			},
		});
		vi.restoreAllMocks();
		const recovery_human = await capture_output(recoveries, {
			db: db_path,
		});
		expect(recovery_human).toContain('Inferred:');
		expect(recovery_human).toContain('unresolved');
		vi.restoreAllMocks();
		const usage_human = await capture_output(usage, { db: db_path });
		expect(usage_human).toContain('Recorded usage only');
		expect(usage_human).toContain('no price or duration estimates');
		vi.restoreAllMocks();
		const empty = await capture_json(usage, {
			db: db_path,
			json: true,
			provider: 'absent',
		});
		expect(empty).toMatchObject({
			count: 0,
			results: [],
		});

		expect(
			(empty.totals as Record<string, unknown>).cost_total,
		).toBeNull();
	});
});
