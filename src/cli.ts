import { defineCommand } from 'citty';
import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	rmSync,
	writeSync,
} from 'node:fs';
import { statSync } from 'node:fs';
import { ToolDatabase, DEFAULT_DB_PATH } from './tool-database.ts';
import { migrate_legacy_database } from './tool-migration.ts';
import {
	argument_report,
	failure_report,
	recovery_report,
	tool_summary,
	usage_report,
} from './tool-reports.ts';
import {
	install_schedule,
	remove_schedule,
	schedule_status,
} from './scheduler.ts';
import {
	DEFAULT_SESSIONS_PATH,
	sync_tool_sessions,
} from './tool-sync.ts';
import {
	verify_legacy_migration,
	verify_tool_database,
} from './tool-verification.ts';

const PACKAGE_VERSION = (
	JSON.parse(
		readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
	) as { version: string }
).version;

const shared_args = {
	database: {
		type: 'string' as const,
		alias: 'd',
		description: `Compact database path (default: ${DEFAULT_DB_PATH})`,
	},
	json: {
		type: 'boolean' as const,
		description: 'Print stable JSON output',
	},
};

function print(kind: string, value: unknown, json = false): void {
	if (json) {
		console.log(
			JSON.stringify(
				{ schema_version: 1, kind, data: value },
				null,
				2,
			),
		);
		return;
	}
	if (Array.isArray(value)) console.table(value);
	else console.log(value);
}

function open_database(
	path: string | undefined,
	read_only = true,
): ToolDatabase {
	return new ToolDatabase(path ?? DEFAULT_DB_PATH, { read_only });
}

export const sync = defineCommand({
	meta: {
		name: 'sync',
		description: 'Incrementally import native Pi tool activity',
	},
	args: {
		...shared_args,
		sessions: {
			type: 'string',
			description: `Native session root (default: ${DEFAULT_SESSIONS_PATH})`,
		},
	},
	async run({ args }) {
		const path = args.database ?? DEFAULT_DB_PATH;
		const result = await with_database_lock(path, async () => {
			const db = open_database(path, false);
			try {
				return await sync_tool_sessions(
					db,
					args.sessions ?? DEFAULT_SESSIONS_PATH,
				);
			} finally {
				db.close();
			}
		});
		print('pi-session-analytics/sync', result, args.json);
	},
});

export const migrate = defineCommand({
	meta: {
		name: 'migrate',
		description: 'Build a compact candidate from a legacy database',
	},
	args: {
		from: {
			type: 'string',
			required: true,
			description: 'Legacy database path',
		},
		to: {
			type: 'string',
			required: true,
			description: 'New compact database path',
		},
		replace: {
			type: 'boolean',
			description: 'Replace an existing candidate',
		},
		json: shared_args.json,
	},
	run({ args }) {
		const result = migrate_legacy_database(args.from, args.to, {
			replace: args.replace,
		});
		print('pi-session-analytics/migration', result, args.json);
	},
});

export const stats = defineCommand({
	meta: {
		name: 'stats',
		description: 'Show compact dataset counts and payload size',
	},
	args: shared_args,
	run({ args }) {
		const db = open_database(args.database);
		try {
			const payload = db.raw
				.prepare(`
				SELECT
					(SELECT COALESCE(SUM(arguments_bytes), 0) FROM tool_calls) +
					(SELECT COALESCE(SUM(payload_bytes), 0) FROM tool_results) AS uncompressed_bytes,
					(SELECT COALESCE(SUM(LENGTH(arguments_blob)), 0) FROM tool_calls) +
					(SELECT COALESCE(SUM(LENGTH(payload_blob)), 0) FROM tool_results) AS compressed_bytes
			`)
				.get();
			print(
				'pi-session-analytics/stats',
				{
					...db.get_counts(),
					database_bytes: statSync(db.path).size,
					...payload,
				},
				args.json,
			);
		} finally {
			db.close();
		}
	},
});

const report_args = {
	...shared_args,
	tool: {
		type: 'string' as const,
		description: 'Filter by exact tool name',
	},
	provider: {
		type: 'string' as const,
		description: 'Filter by provider',
	},
	model: { type: 'string' as const, description: 'Filter by model' },
	project: {
		type: 'string' as const,
		description: 'Filter by project path',
	},
	limit: {
		type: 'string' as const,
		alias: 'l',
		description: 'Maximum rows',
	},
};

export const tools = defineCommand({
	meta: {
		name: 'tools',
		description:
			'Report tool summary, hard failures, or argument shapes',
	},
	args: {
		...report_args,
		mode: {
			type: 'positional',
			description: 'summary, failures, or arguments',
			default: 'summary',
		},
	},
	run({ args }) {
		const db = open_database(args.database);
		try {
			const filter = {
				tool: args.tool,
				provider: args.provider,
				model: args.model,
				project: args.project,
				limit: args.limit ? Number(args.limit) : undefined,
			};
			const rows =
				args.mode === 'failures'
					? failure_report(db, filter)
					: args.mode === 'arguments'
						? argument_report(db, filter)
						: tool_summary(db, filter);
			print(
				`pi-session-analytics/tools-${args.mode}`,
				rows,
				args.json,
			);
		} finally {
			db.close();
		}
	},
});

export const recoveries = defineCommand({
	meta: {
		name: 'recoveries',
		description: 'Show explicitly inferred same-turn recovery',
	},
	args: report_args,
	run({ args }) {
		const db = open_database(args.database);
		try {
			const rows = recovery_report(db, {
				tool: args.tool,
				provider: args.provider,
				model: args.model,
				project: args.project,
				limit: args.limit ? Number(args.limit) : undefined,
			});
			print(
				'pi-session-analytics/inferred-recoveries',
				rows,
				args.json,
			);
		} finally {
			db.close();
		}
	},
});

export const usage = defineCommand({
	meta: {
		name: 'usage',
		description:
			'Aggregate recorded turn usage without per-tool attribution',
	},
	args: {
		...shared_args,
		groupBy: {
			type: 'string',
			description: 'day, model, or project',
			default: 'day',
		},
		limit: {
			type: 'string',
			alias: 'l',
			description: 'Maximum rows',
		},
	},
	run({ args }) {
		if (!['day', 'model', 'project'].includes(args.groupBy))
			throw new Error('--group-by must be day, model, or project');
		const db = open_database(args.database);
		try {
			print(
				'pi-session-analytics/usage',
				usage_report(db, {
					group_by: args.groupBy as 'day' | 'model' | 'project',
					limit: args.limit ? Number(args.limit) : undefined,
				}),
				args.json,
			);
		} finally {
			db.close();
		}
	},
});

export const verify = defineCommand({
	meta: {
		name: 'verify',
		description:
			'Verify compact storage and optional legacy migration',
	},
	args: {
		...shared_args,
		deep: {
			type: 'boolean',
			description: 'Check every compressed payload',
		},
		legacy: {
			type: 'string',
			description: 'Legacy database to compare with the candidate',
		},
	},
	run({ args }) {
		const db = open_database(args.database);
		try {
			const database = verify_tool_database(db, args.deep);
			const migration = args.legacy
				? verify_legacy_migration(args.legacy, db, args.deep)
				: undefined;
			const result = {
				pass: database.pass && (migration?.pass ?? true),
				database,
				migration,
			};
			print('pi-session-analytics/verification', result, args.json);
			if (!result.pass) process.exitCode = 1;
		} finally {
			db.close();
		}
	},
});

export const schema = defineCommand({
	meta: {
		name: 'schema',
		description: 'Show the compact public SQLite schema',
	},
	args: shared_args,
	run({ args }) {
		const db = open_database(args.database);
		try {
			const rows = db.raw
				.prepare(`
				SELECT type, name, sql FROM sqlite_master
				WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
				ORDER BY type, name
			`)
				.all();
			print('pi-session-analytics/schema', rows, args.json);
		} finally {
			db.close();
		}
	},
});

export const query = defineCommand({
	meta: {
		name: 'query',
		description: 'Run read-only SQL against the compact database',
	},
	args: {
		...shared_args,
		sql: {
			type: 'positional',
			required: true,
			description: 'SELECT, WITH, or PRAGMA query',
		},
		limit: {
			type: 'string',
			alias: 'l',
			description: 'Maximum returned rows',
			default: '1000',
		},
	},
	run({ args }) {
		if (!/^\s*(SELECT|WITH|PRAGMA)\b/i.test(args.sql))
			throw new Error(
				'Only SELECT, WITH, and PRAGMA queries are allowed',
			);
		const db = open_database(args.database);
		try {
			db.raw.exec('PRAGMA query_only = ON');
			const rows = db.raw
				.prepare(args.sql)
				.all()
				.slice(0, Number(args.limit));
			print('pi-session-analytics/query', rows, args.json);
		} finally {
			db.close();
		}
	},
});

export const schedule = defineCommand({
	meta: {
		name: 'schedule',
		description: 'Manage periodic systemd user sync',
	},
	args: {
		action: {
			type: 'positional',
			required: true,
			description: 'install, status, or remove',
		},
		...shared_args,
		sessions: { type: 'string', description: 'Native session root' },
		interval: {
			type: 'string',
			description: 'systemd interval, for example 1h',
			default: '1h',
		},
	},
	run({ args }) {
		if (args.action === 'install') {
			print(
				'pi-session-analytics/schedule',
				install_schedule({
					database_path: args.database,
					sessions_path: args.sessions,
					interval: args.interval,
				}),
				args.json,
			);
			return;
		}
		if (args.action === 'remove') {
			remove_schedule();
			print(
				'pi-session-analytics/schedule',
				{ removed: true },
				args.json,
			);
			return;
		}
		if (args.action === 'status') {
			console.log(schedule_status());
			return;
		}
		throw new Error(
			'schedule action must be install, status, or remove',
		);
	},
});

export const main = defineCommand({
	meta: {
		name: 'pi-session-analytics',
		version: PACKAGE_VERSION,
		description:
			'Compact offline analytics for ordered Pi tool activity',
	},
	subCommands: {
		sync,
		migrate,
		stats,
		tools,
		recoveries,
		usage,
		verify,
		schema,
		query,
		schedule,
	},
});

async function with_database_lock<T>(
	database_path: string,
	action: () => Promise<T>,
): Promise<T> {
	const lock_path = `${database_path}.sync.lock`;
	const handle = acquire_lock(lock_path);
	try {
		writeSync(handle, String(process.pid));
		return await action();
	} finally {
		closeSync(handle);
		if (existsSync(lock_path)) rmSync(lock_path);
	}
}

function acquire_lock(lock_path: string): number {
	try {
		return openSync(lock_path, 'wx');
	} catch {
		let active = true;
		try {
			const pid = Number(readFileSync(lock_path, 'utf8'));
			if (!Number.isInteger(pid) || pid <= 0) active = false;
			else process.kill(pid, 0);
		} catch (error) {
			active = !['ESRCH', 'ENOENT'].includes(
				(error as NodeJS.ErrnoException).code ?? '',
			);
		}
		if (active)
			throw new Error(`Another sync is active: ${lock_path}`);
		rmSync(lock_path, { force: true });
		return openSync(lock_path, 'wx');
	}
}
