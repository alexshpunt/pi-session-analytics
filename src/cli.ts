import { defineCommand } from 'citty';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_DB_PATH = join(
	process.env.HOME!,
	'.pi',
	'pi-session-analytics.db',
);
const DEFAULT_ARCHIVE_PATH = join(
	process.env.HOME!,
	'.pi',
	'pi-session-analytics',
	'archive',
);
const PACKAGE_VERSION = (
	JSON.parse(
		readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
	) as { version: string }
).version;

/** Convert unix ms timestamp to ISO string */
function iso(ts: number): string {
	return new Date(ts).toISOString();
}

const shared_args = {
	db: {
		type: 'string' as const,
		alias: 'd',
		description: `Database path (default: ${DEFAULT_DB_PATH})`,
	},
	json: {
		type: 'boolean' as const,
		description: 'Output as JSON (for LLM/programmatic use)',
	},
};

export const sync = defineCommand({
	meta: {
		name: 'sync',
		description: 'Sync pi agent sessions to database',
	},
	args: {
		...shared_args,
		sessions: {
			type: 'string',
			description: 'Sessions root (default: ~/.pi/agent/sessions)',
		},
		verbose: {
			type: 'boolean',
			alias: 'v',
			description: 'Show detailed output',
		},

		archive: {
			type: 'string',
			description: `Archive path (default: ${DEFAULT_ARCHIVE_PATH})`,
		},
	},
	async run({ args }) {
		const { Database } = await import('./db.ts');
		const { sync: sync_sessions } = await import('./sync.ts');

		const db_path = args.db ?? DEFAULT_DB_PATH;
		const db = new Database(db_path);

		try {
			if (!args.json) console.log('Syncing sessions...');
			const result = await sync_sessions(
				db,
				Boolean(args.verbose && !args.json),
				args.sessions,
				args.archive ?? DEFAULT_ARCHIVE_PATH,
			);

			if (args.json) {
				console.log(JSON.stringify(result));
				return;
			}

			console.log(`
Done!
  JSONL candidates:   ${result.discovery.candidates}
  Sessions selected:  ${result.discovery.sessions}
  Duplicate IDs:      ${result.discovery.excluded.duplicate_session_id}
  Non-session files:  ${result.discovery.excluded.non_session}
  Malformed JSON:     ${result.discovery.excluded.malformed_json}

  Archive generations:${result.archive.generations_added}
  Archive chunks:     ${result.archive.chunks_added}
  Archive bytes:      ${result.archive.bytes_added}
  Missing sources:    ${result.archive.sources_missing}

  Records indexed:    ${result.records.added}
  Invalid records:    ${result.records.invalid}
  Files processed:    ${result.files_processed}
  Messages added:     ${result.messages_added}
  Sessions added:     ${result.sessions_added}
  Tool calls:         ${result.tool_calls_added}
  Tool results:       ${result.tool_results_added}
  Model changes:      ${result.model_changes_added}
`);
		} finally {
			db.close();
		}
	},
});

export const stats = defineCommand({
	meta: {
		name: 'stats',
		description: 'Show database statistics',
	},
	args: {
		...shared_args,
	},
	async run({ args }) {
		const { Database } = await import('./db.ts');

		const db_path = args.db ?? DEFAULT_DB_PATH;
		const db = new Database(db_path);

		try {
			const s = db.get_stats();

			if (args.json) {
				console.log(JSON.stringify({ db_path, ...s }));
				return;
			}

			console.log(`
Database: ${db_path}
  Sessions:       ${s.sessions}
  Messages:       ${s.messages}
  Tool calls:     ${s.tool_calls}
  Tool results:   ${s.tool_results}
  Model changes:  ${s.model_changes}
  Tokens:
    Input:        ${s.tokens.input?.toLocaleString() ?? 0}
    Output:       ${s.tokens.output?.toLocaleString() ?? 0}
    Cache read:   ${s.tokens.cache_read?.toLocaleString() ?? 0}
    Cache write:  ${s.tokens.cache_write?.toLocaleString() ?? 0}
  Cost:           $${s.tokens.total_cost?.toFixed(4) ?? '0.0000'}
`);
		} finally {
			db.close();
		}
	},
});

export const query = defineCommand({
	meta: {
		name: 'query',
		description: 'Execute read-only SQL against the database',
	},
	args: {
		...shared_args,
		sql: {
			type: 'positional' as const,
			description: 'SQL query to execute',
			required: true,
		},
		format: {
			type: 'string',
			alias: 'f',
			description: 'Output format: table, json, csv (default: table)',
		},
		limit: {
			type: 'string',
			alias: 'l',
			description: 'Limit rows (appends LIMIT clause if not present)',
		},
		wide: {
			type: 'boolean',
			alias: 'w',
			description: 'Disable column truncation',
		},
	},
	async run({ args }) {
		const { DatabaseSync } = await import('node:sqlite');
		const { existsSync } = await import('node:fs');

		const db_path = args.db ?? DEFAULT_DB_PATH;
		if (!existsSync(db_path)) {
			console.error(`Database not found: ${db_path}`);
			process.exit(1);
		}

		const db = new DatabaseSync(db_path, { readOnly: true });

		try {
			let sql = args.sql;
			const format = args.json ? 'json' : (args.format ?? 'table');

			if (args.limit && !/\bLIMIT\b/i.test(sql)) {
				sql = `${sql.replace(/;?\s*$/, '')} LIMIT ${parseInt(args.limit, 10)}`;
			}

			const statement = db.prepare(sql);
			const declared_columns = statement
				.columns()
				.map((column) => column.name);
			if (declared_columns.length === 0) {
				throw new Error(
					'Only read-only row-returning SQL is allowed',
				);
			}
			const rows = statement.all() as Record<string, unknown>[];
			const columns =
				rows.length > 0 ? Object.keys(rows[0]) : declared_columns;

			if (format === 'json') {
				console.log(
					JSON.stringify(
						{
							schema_version: 1,
							kind: 'pi-session-analytics/query-results',
							sql,
							columns,
							count: rows.length,
							rows,
						},
						null,
						2,
					),
				);
			} else if (rows.length === 0) {
				console.log('No results.');
			} else if (format === 'csv') {
				console.log(columns.join(','));
				for (const row of rows) {
					const values = columns.map((c) => {
						const v = row[c];
						if (v === null) return '';
						const s =
							typeof v === 'object'
								? JSON.stringify(v)
								: String(v as string | number | boolean);
						return s.includes(',') ||
							s.includes('"') ||
							s.includes('\n')
							? `"${s.replace(/"/g, '""')}"`
							: s;
					});
					console.log(values.join(','));
				}
			} else {
				const term_width = process.stdout.columns || 120;
				const max_col_width = args.wide
					? Infinity
					: Math.max(
							50,
							Math.floor(term_width / Math.max(columns.length, 1)),
						);

				const widths = columns.map((c) =>
					Math.min(
						max_col_width,
						Math.max(
							c.length,
							...rows.map(
								(r) =>
									String((r[c] as string | number | null) ?? '')
										.length,
							),
						),
					),
				);

				const header = columns
					.map((c, i) => c.padEnd(widths[i]))
					.join(' | ');
				const sep = widths.map((w) => '-'.repeat(w)).join('-+-');

				console.log(header);
				console.log(sep);
				for (const row of rows) {
					const line = columns
						.map((c, i) =>
							String((row[c] as string | number | null) ?? '')
								.slice(0, max_col_width)
								.padEnd(widths[i]),
						)
						.join(' | ');
					console.log(line);
				}
				console.log(`\n${rows.length} row(s)`);
			}
		} catch (err) {
			console.error('SQL error:', (err as Error).message);
			process.exit(1);
		} finally {
			db.close();
		}
	},
});

export const tools = defineCommand({
	meta: {
		name: 'tools',
		description:
			'Report tool usage, failures, and argument structure',
	},
	args: {
		...shared_args,
		_: {
			type: 'positional' as const,
			description:
				'Report: summary (default), failures, or arguments',
			required: false,
		},
		top: {
			type: 'string',
			alias: 't',
			description: 'Number of report rows to show (default: 10)',
		},
		project: {
			type: 'string',
			alias: 'p',
			description: 'Filter by project path',
		},
		session: {
			type: 'string',
			description: 'Filter by session ID prefix',
		},
		provider: {
			type: 'string',
			description: 'Filter by provider',
		},
		model: {
			type: 'string',
			description: 'Filter by model',
		},
		after: {
			type: 'string',
			description: 'Include calls at or after this ISO date',
		},
		before: {
			type: 'string',
			description: 'Include calls before this ISO date',
		},
	},
	async run({ args }) {
		const { Database } = await import('./db.ts');
		const {
			group_tool_failures,
			report_tool_arguments,
			summarize_tools,
		} = await import('./tool-reports.ts');
		const raw_report = args._ as string | string[] | undefined;
		const report = Array.isArray(raw_report)
			? raw_report[0]
			: (raw_report ?? 'summary');
		if (!['summary', 'failures', 'arguments'].includes(report)) {
			throw new Error(
				`Unknown tool report "${report}"; use summary, failures, or arguments`,
			);
		}
		const limit = args.top ? parseInt(args.top, 10) : 10;
		const filters = {
			project: args.project,
			session: args.session,
			provider: args.provider,
			model: args.model,
			after: args.after ? new Date(args.after).getTime() : undefined,
			before: args.before
				? new Date(args.before).getTime()
				: undefined,
		};
		const db = new Database(args.db ?? DEFAULT_DB_PATH);
		try {
			const activity = db.get_tool_activity(
				filters,
				report as 'summary' | 'failures' | 'arguments',
			);
			if (report === 'summary') {
				const all_results = summarize_tools(activity);
				const results = all_results.slice(0, limit);
				const totals = all_results.reduce(
					(total, row) => ({
						calls: total.calls + row.calls,
						matched_results:
							total.matched_results + row.matched_results,
						successes: total.successes + row.successes,
						failures: total.failures + row.failures,
						incomplete: total.incomplete + row.incomplete,
					}),
					{
						calls: 0,
						matched_results: 0,
						successes: 0,
						failures: 0,
						incomplete: 0,
					},
				);
				if (args.json) {
					console.log(
						JSON.stringify(
							{
								schema_version: 1,
								kind: 'pi-session-analytics/tool-summary',
								filters,
								count: results.length,
								totals,
								results,
							},
							null,
							2,
						),
					);
					return;
				}
				if (results.length === 0) {
					console.log('No tool calls found.');
					return;
				}
				console.log(
					'Tool  Calls  Results  Success  Failure  Incomplete  Failure %',
				);
				for (const row of results) {
					console.log(
						`${row.tool_name}  ${row.calls}  ${row.matched_results}  ${row.successes}  ${row.failures}  ${row.incomplete}  ${(row.failure_rate * 100).toFixed(1)}%`,
					);
				}
				return;
			}
			if (report === 'failures') {
				const results = group_tool_failures(activity).slice(0, limit);
				if (args.json) {
					console.log(
						JSON.stringify(
							{
								schema_version: 1,
								kind: 'pi-session-analytics/tool-failures',
								filters,
								count: results.length,
								results,
							},
							null,
							2,
						),
					);
					return;
				}
				if (results.length === 0) {
					console.log('No recorded tool failures found.');
					return;
				}
				console.log('Tool  Count  Fingerprint  Evidence');
				for (const row of results) {
					console.log(
						`${row.tool_name}  ${row.count}  ${row.fingerprint}  ${row.evidence.slice(0, 100)}`,
					);
				}
				return;
			}
			const argument_report = report_tool_arguments(activity);
			const results = {
				keys: argument_report.keys.slice(0, limit),
				shapes: argument_report.shapes.slice(0, limit),
			};
			if (args.json) {
				console.log(
					JSON.stringify(
						{
							schema_version: 1,
							kind: 'pi-session-analytics/tool-arguments',
							filters,
							count: {
								keys: results.keys.length,
								shapes: results.shapes.length,
							},
							results,
						},
						null,
						2,
					),
				);
				return;
			}
			if (results.keys.length === 0 && results.shapes.length === 0) {
				console.log('No tool arguments found.');
				return;
			}
			console.log('Argument keys');
			for (const row of results.keys)
				console.log(`${row.tool_name}  ${row.calls}  ${row.key}`);
			console.log('\nArgument shapes');
			for (const row of results.shapes)
				console.log(`${row.tool_name}  ${row.calls}  ${row.shape}`);
		} finally {
			db.close();
		}
	},
});

export const recoveries = defineCommand({
	meta: {
		name: 'recoveries',
		description:
			'Report inferred recovery after recorded tool failures',
	},
	args: {
		group: {
			type: 'string',
			description:
				'Compare by model (default), provider, project, tool, or day',
		},
		...shared_args,
		project: {
			type: 'string',
			alias: 'p',
			description: 'Filter by project path',
		},
		session: {
			type: 'string',
			description: 'Filter by session ID prefix',
		},
		provider: {
			type: 'string',
			description: 'Filter by failure provider',
		},
		model: { type: 'string', description: 'Filter by failure model' },
		after: {
			type: 'string',
			description: 'Include failures at or after this ISO date',
		},
		before: {
			type: 'string',
			description: 'Include failures before this ISO date',
		},
	},
	async run({ args }) {
		const { Database } = await import('./db.ts');
		const { group_recoveries, infer_recoveries } =
			await import('./recovery-usage-reports.ts');
		const group = (args.group ?? 'model') as
			| 'model'
			| 'provider'
			| 'project'
			| 'tool'
			| 'day';
		if (
			!['model', 'provider', 'project', 'tool', 'day'].includes(group)
		)
			throw new Error(
				`Unknown recovery group "${group}"; use model, provider, project, tool, or day`,
			);
		const filters = {
			project: args.project,
			session: args.session,
			provider: args.provider,
			model: args.model,
			after: args.after ? new Date(args.after).getTime() : undefined,
			before: args.before
				? new Date(args.before).getTime()
				: undefined,
		};
		const db = new Database(args.db ?? DEFAULT_DB_PATH);
		try {
			const results = infer_recoveries(
				db.get_recovery_activity(),
				db.get_user_turn_boundaries(),
				filters,
			);
			const totals = results.reduce(
				(total, row) => {
					total.failures++;
					if (row.classification === 'same-tool-recovery')
						total.same_tool++;
					else if (row.classification === 'alternate-tool-recovery')
						total.alternate_tool++;
					else total.unresolved++;
					return total;
				},
				{
					failures: 0,
					same_tool: 0,
					alternate_tool: 0,
					unresolved: 0,
				},
			);
			const groups = group_recoveries(results, group);
			const heuristic =
				'Inferred: before the next user message, prefer the first successful retry of the same tool; otherwise use the first successful alternate tool; otherwise unresolved.';
			if (args.json) {
				console.log(
					JSON.stringify(
						{
							schema_version: 1,
							kind: 'pi-session-analytics/inferred-recoveries',
							inferred: true,
							heuristic,
							filters,

							group,
							groups,
							count: results.length,
							totals,
							results,
						},
						null,
						2,
					),
				);
				return;
			}
			console.log(heuristic);
			if (results.length === 0) {
				console.log('No recorded tool failures found.');
				return;
			}
			console.log(
				`${group}  Failures  Same tool  Alternate  Unresolved  Inferred %`,
			);
			for (const row of groups) {
				console.log(
					`${row.value}  ${row.failures}  ${row.same_tool}  ${row.alternate_tool}  ${row.unresolved}  ${(row.inferred_recovery_rate * 100).toFixed(1)}%`,
				);
			}
			console.log('');
			console.log(
				'Failure tool  Classification  Recovery tool  Intervening',
			);
			for (const row of results) {
				console.log(
					`${row.failure_tool}  ${row.classification}  ${row.recovery_tool ?? '-'}  ${row.intervening_tool_calls}`,
				);
			}
		} finally {
			db.close();
		}
	},
});

export const usage = defineCommand({
	meta: {
		name: 'usage',
		description: 'Compare recorded tokens and cost',
	},
	args: {
		...shared_args,
		group: {
			type: 'string',
			description:
				'Group by model (default), provider, project, or day',
		},
		details: {
			type: 'boolean',
			description:
				'Include every contributing record with archive provenance',
		},
		top: {
			type: 'string',
			alias: 't',
			description: 'Number of groups to show (default: 20)',
		},
		project: {
			type: 'string',
			alias: 'p',
			description: 'Filter by project path',
		},
		session: {
			type: 'string',
			description: 'Filter by session ID prefix',
		},
		provider: { type: 'string', description: 'Filter by provider' },
		model: { type: 'string', description: 'Filter by model' },
		after: {
			type: 'string',
			description: 'Include usage at or after this ISO date',
		},
		before: {
			type: 'string',
			description: 'Include usage before this ISO date',
		},
	},
	async run({ args }) {
		const { Database } = await import('./db.ts');
		const { group_usage } =
			await import('./recovery-usage-reports.ts');
		const group = (args.group ?? 'model') as
			| 'model'
			| 'provider'
			| 'project'
			| 'day';
		if (!['model', 'provider', 'project', 'day'].includes(group))
			throw new Error(
				`Unknown usage group "${group}"; use model, provider, project, or day`,
			);
		const filters = {
			project: args.project,
			session: args.session,
			provider: args.provider,
			model: args.model,
			after: args.after ? new Date(args.after).getTime() : undefined,
			before: args.before
				? new Date(args.before).getTime()
				: undefined,
		};
		const db = new Database(args.db ?? DEFAULT_DB_PATH);
		try {
			const activity = db.get_usage_activity(filters);
			const limit = args.top ? parseInt(args.top, 10) : 20;
			const grouped = group_usage(activity, group).slice(0, limit);
			const results = grouped.map((row) => {
				if (args.details) return row;
				const { details: _details, ...summary } = row;
				return summary;
			});
			const raw_totals = activity.reduce(
				(total, row) => {
					total.messages++;
					total.input_tokens += row.input_tokens;
					total.output_tokens += row.output_tokens;
					total.cache_read_tokens += row.cache_read_tokens;
					total.cache_write_tokens += row.cache_write_tokens;
					total.total_tokens += row.total_tokens;
					if (row.cost_recorded === 1) {
						total.priced_messages++;
						total.cost_input += row.cost_input;
						total.cost_output += row.cost_output;
						total.cost_cache_read += row.cost_cache_read;
						total.cost_cache_write += row.cost_cache_write;
						total.cost_total += row.cost_total;
					} else total.unpriced_messages++;
					return total;
				},
				{
					messages: 0,
					priced_messages: 0,
					unpriced_messages: 0,
					input_tokens: 0,
					output_tokens: 0,
					cache_read_tokens: 0,
					cache_write_tokens: 0,
					total_tokens: 0,
					cost_input: 0,
					cost_output: 0,
					cost_cache_read: 0,
					cost_cache_write: 0,
					cost_total: 0,
				},
			);
			const totals =
				raw_totals.priced_messages === 0
					? {
							...raw_totals,
							cost_input: null,
							cost_output: null,
							cost_cache_read: null,
							cost_cache_write: null,
							cost_total: null,
						}
					: raw_totals;
			if (args.json) {
				console.log(
					JSON.stringify(
						{
							schema_version: 1,
							kind: 'pi-session-analytics/recorded-usage',
							recorded_only: true,
							group,
							filters,
							details_included: Boolean(args.details),
							count: results.length,
							totals,
							results,
						},
						null,
						2,
					),
				);
				return;
			}
			console.log(
				'Recorded usage only; no price or duration estimates.',
			);
			if (results.length === 0) {
				console.log('No recorded usage found.');
				return;
			}
			console.log(`${group}  Messages  Tokens  Cost`);
			for (const row of grouped) {
				console.log(
					`${row.value}  ${row.messages}  ${row.total_tokens}  ${row.cost_total === null ? 'unknown' : row.cost_total.toFixed(6)}`,
				);
			}
		} finally {
			db.close();
		}
	},
});

export const search = defineCommand({
	meta: {
		name: 'search',
		description:
			'Full-text search across all archived session records',
	},
	args: {
		...shared_args,
		_: {
			type: 'positional' as const,
			description:
				'Search term (supports FTS5 syntax: AND, OR, NOT, "phrase", prefix*)',
			required: true,
		},
		limit: {
			type: 'string',
			alias: 'l',
			description: 'Maximum results (default: 20)',
		},
		project: {
			type: 'string',
			alias: 'p',
			description: 'Filter by project path',
		},
		type: {
			type: 'string',
			description: 'Filter by canonical record type',
		},
		context: {
			type: 'string',
			alias: 'c',
			description:
				'Show N canonical records before/after each match (default: 0)',
		},
		rebuild: {
			type: 'boolean',
			description: 'Rebuild FTS index before searching',
		},
		session: {
			type: 'string',
			description:
				'Filter by session ID (prefix match, e.g. first 8 chars)',
		},
		after: {
			type: 'string',
			alias: 'a',
			description:
				'Only show results after date (ISO format, e.g. 2026-04-06)',
		},
		sort: {
			type: 'string',
			alias: 's',
			description: 'Sort order: relevance (default), time, time-asc',
		},
	},
	async run({ args }) {
		const { Database } = await import('./db.ts');
		const db_path = args.db ?? DEFAULT_DB_PATH;
		const db = new Database(db_path);
		try {
			if (args.rebuild) {
				if (!args.json)
					console.log('Rebuilding canonical FTS index...');
				db.rebuild_record_fts();
			}
			const raw_term = args._ as string | string[];
			const term = Array.isArray(raw_term)
				? raw_term.join(' ')
				: raw_term;
			const limit = args.limit ? parseInt(args.limit, 10) : 20;
			const sort = args.sort as
				| 'relevance'
				| 'time'
				| 'time-asc'
				| undefined;
			const after = args.after
				? new Date(args.after as string).getTime()
				: undefined;
			const context_count = args.context
				? parseInt(args.context, 10)
				: 0;
			const results = term
				? db.search_records(term, {
						limit,
						project: args.project,
						session: args.session as string | undefined,
						record_type: args.type,
						after,
						sort,
					})
				: [];
			const json_results = results.map((result) => {
				const context =
					context_count > 0
						? db.get_record_context(result.record_id, context_count)
						: undefined;
				return {
					...result,
					date:
						result.timestamp === null ? null : iso(result.timestamp),
					context,
				};
			});
			const envelope = {
				schema_version: 1,
				kind: 'pi-session-analytics/search-results',
				query: {
					term: term ?? '',
					limit,
					project: args.project,
					session: args.session,
					record_type: args.type,
					after: args.after,
					sort: sort ?? 'relevance',
				},
				count: json_results.length,
				results: json_results,
			};
			if (args.json) {
				console.log(JSON.stringify(envelope, null, 2));
				return;
			}
			if (!term) {
				console.log('No search term provided.');
				return;
			}
			if (results.length === 0) {
				console.log('No matches found.');
				return;
			}
			console.log(
				`Found ${results.length} canonical record match${results.length === 1 ? '' : 'es'}:\n`,
			);
			for (const result of results) {
				const date =
					result.timestamp === null
						? 'no timestamp'
						: iso(result.timestamp);
				const role = result.message_role
					? `/${result.message_role}`
					: '';
				console.log(
					`[${result.record_type}${role}] ${date} | ${result.session_id.slice(0, 12)} | ${result.project_path}`,
				);
				console.log(
					`  ${result.source_path} | generation ${result.archive_generation_id} | bytes ${result.source_byte_offset}:${result.source_byte_length}`,
				);
				console.log(
					`  ${(result.snippet ?? '').replace(/\n/g, ' ')}`,
				);
				if (context_count > 0) {
					const context = db.get_record_context(
						result.record_id,
						context_count,
					);
					for (const before of context.before) {
						console.log(
							`    [${before.record_type}] ${before.content_text.replace(/\n/g, ' ').slice(0, 100)}`,
						);
					}
					console.log('    >>> match <<<');
					for (const after_record of context.after) {
						console.log(
							`    [${after_record.record_type}] ${after_record.content_text.replace(/\n/g, ' ').slice(0, 100)}`,
						);
					}
				}
				console.log();
			}
		} finally {
			db.close();
		}
	},
});

export const sessions = defineCommand({
	meta: {
		name: 'sessions',
		description: 'List recent sessions',
	},
	args: {
		...shared_args,
		limit: {
			type: 'string',
			alias: 'l',
			description: 'Maximum sessions to show (default: 10)',
		},
		project: {
			type: 'string',
			alias: 'p',
			description: 'Filter by project path',
		},
	},
	async run({ args }) {
		const { Database } = await import('./db.ts');

		const db_path = args.db ?? DEFAULT_DB_PATH;
		const db = new Database(db_path);

		try {
			const results = db.get_sessions({
				limit: args.limit ? parseInt(args.limit, 10) : undefined,
				project: args.project,
			});

			if (results.length === 0) {
				if (args.json) {
					console.log('[]');
				} else {
					console.log('No sessions found.');
				}
				return;
			}

			if (args.json) {
				const enriched = results.map((s) => ({
					...s,
					first_date: iso(s.first_timestamp),
					last_date: iso(s.last_timestamp),
				}));
				console.log(JSON.stringify(enriched, null, 2));
				return;
			}

			console.log(
				'ID                                   | Date       | Project                          | Msgs | Tokens    | Cost     | Duration',
			);
			console.log(
				'-------------------------------------|------------|----------------------------------|------|-----------|----------|----------',
			);

			for (const s of results) {
				const id = s.id.padEnd(36).slice(0, 36);
				const date = new Date(s.first_timestamp)
					.toISOString()
					.split('T')[0];
				const project = s.project_path
					.split('/')
					.slice(-2)
					.join('/')
					.padEnd(32)
					.slice(0, 32);
				const msgs = String(s.message_count).padStart(4);
				const tokens = s.total_tokens.toLocaleString().padStart(9);
				const cost = `$${s.total_cost.toFixed(4)}`.padStart(8);
				const duration =
					s.duration_mins > 0 ? `${s.duration_mins}m` : '<1m';
				console.log(
					`${id} | ${date} | ${project} | ${msgs} | ${tokens} | ${cost} | ${duration.padStart(8)}`,
				);
			}
		} finally {
			db.close();
		}
	},
});

export const recall = defineCommand({
	meta: {
		name: 'recall',
		description:
			'Recall context from past sessions (LLM-optimised, always JSON)',
	},
	args: {
		...shared_args,
		_: {
			type: 'positional' as const,
			description: 'Search term',
			required: true,
		},
		limit: {
			type: 'string',
			alias: 'l',
			description: 'Maximum matches (default: 5)',
		},
		context: {
			type: 'string',
			alias: 'c',
			description: 'Messages before/after each match (default: 2)',
		},
		project: {
			type: 'string',
			alias: 'p',
			description: 'Filter by project path',
		},
	},
	async run({ args }) {
		const { Database } = await import('./db.ts');

		const db_path = args.db ?? DEFAULT_DB_PATH;
		const db = new Database(db_path);

		try {
			const raw_term = args._ as string | string[];
			const term = Array.isArray(raw_term)
				? raw_term.join(' ')
				: raw_term;
			if (!term) {
				console.log(JSON.stringify({ matches: [], term: '' }));
				return;
			}

			const limit = args.limit ? parseInt(args.limit, 10) : 5;
			const context_count = args.context
				? parseInt(args.context, 10)
				: 2;

			const results = db.search(term, {
				limit,
				project: args.project,
			});

			const matches = results.map((r) => {
				const ctx = db.get_context_around(
					r.session_id,
					r.timestamp,
					context_count,
				);

				return {
					session_id: r.session_id,
					project_path: r.project_path,
					date: iso(r.timestamp),
					relevance: r.relevance,
					match: {
						id: r.id,
						content_text: r.content_text,
						timestamp: r.timestamp,
					},
					before: ctx.before.map((m) => ({
						type: m.type,
						content_text: m.content_text,
						date: iso(m.timestamp),
					})),
					after: ctx.after.map((m) => ({
						type: m.type,
						content_text: m.content_text,
						date: iso(m.timestamp),
					})),
				};
			});

			console.log(
				JSON.stringify(
					{ term, total: matches.length, matches },
					null,
					2,
				),
			);
		} finally {
			db.close();
		}
	},
});

export const resumable = defineCommand({
	meta: {
		name: 'resumable',
		description: 'List live sessions available for fast resume',
	},
	args: {
		...shared_args,
		cwd: {
			type: 'string',
			description: 'Canonical project working directory',
		},
		scope: {
			type: 'string',
			description: 'Session scope: project or all (default: all)',
		},
		query: {
			type: 'string',
			alias: 'q',
			description: 'Search names, paths, and user/assistant messages',
		},
		limit: {
			type: 'string',
			alias: 'l',
			description: 'Maximum results (default: 100)',
		},
		offset: {
			type: 'string',
			description: 'Pagination offset (default: 0)',
		},
	},
	async run({ args }) {
		const { list_resumable_sessions } =
			await import('./resumable.ts');
		const scope = args.scope ?? (args.cwd ? 'project' : 'all');
		if (scope !== 'project' && scope !== 'all') {
			throw new Error('--scope must be "project" or "all"');
		}
		const result = await list_resumable_sessions({
			db_path: args.db,
			cwd: args.cwd,
			scope,
			query: args.query,
			limit: args.limit ? parseInt(args.limit, 10) : undefined,
			offset: args.offset ? parseInt(args.offset, 10) : undefined,
		});
		console.log(JSON.stringify(result, null, 2));
	},
});

export const compact = defineCommand({
	meta: {
		name: 'compact',
		description: 'Compact old tool results to save space',
	},
	args: {
		...shared_args,
		'older-than': {
			type: 'string' as const,
			description:
				'Only compact data older than N days (default: 30)',
		},
		'dry-run': {
			type: 'boolean' as const,
			description:
				'Show what would be compacted without changing anything',
		},
	},
	async run({ args }) {
		const { Database } = await import('./db.ts');

		const db_path = args.db ?? DEFAULT_DB_PATH;
		const db = new Database(db_path);

		try {
			const older_than_days = args['older-than']
				? parseInt(args['older-than'] as string, 10)
				: 30;
			const dry_run = (args['dry-run'] as boolean) ?? false;

			if (!args.json && !dry_run) {
				console.log(
					`Compacting data older than ${older_than_days} days...`,
				);
			}

			const result = db.compact({ older_than_days, dry_run });

			if (args.json) {
				console.log(JSON.stringify(result, null, 2));
				return;
			}

			const total_compacted =
				result.tool_results_compacted.read +
				result.tool_results_compacted.bash +
				result.tool_results_compacted.grep_glob +
				result.tool_results_compacted.write;

			const fmt_bytes = (b: number) => {
				if (b >= 1073741824)
					return `${(b / 1073741824).toFixed(1)} GB`;
				if (b >= 1048576) return `${(b / 1048576).toFixed(1)} MB`;
				if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
				return `${b} B`;
			};

			const saved = result.bytes_before - result.bytes_after;

			console.log(`
${result.dry_run ? '[DRY RUN] ' : ''}Compact results (cutoff: ${result.cutoff_date}):
  Tool results compacted: ${total_compacted}
    Read:      ${result.tool_results_compacted.read}
    Bash:      ${result.tool_results_compacted.bash}
    Grep/Glob: ${result.tool_results_compacted.grep_glob}
    Write:     ${result.tool_results_compacted.write}
  Database size: ${fmt_bytes(result.bytes_before)} -> ${fmt_bytes(result.bytes_after)} (saved ${fmt_bytes(saved)})
`);
		} finally {
			db.close();
		}
	},
});

export const verify = defineCommand({
	meta: {
		name: 'verify',
		description: 'Verify database and immutable archive integrity',
	},
	args: {
		...shared_args,
		archive: {
			type: 'string',
			description: `Archive path (default: ${DEFAULT_ARCHIVE_PATH})`,
		},
		deep: {
			type: 'boolean',
			description: 'Hash every chunk, generation, and present source',
		},
	},
	async run({ args }) {
		const { existsSync } = await import('node:fs');
		const { Database } = await import('./db.ts');
		const { verify_archive } = await import('./verification.ts');
		const db_path = args.db ?? DEFAULT_DB_PATH;
		if (!existsSync(db_path))
			throw new Error(`Database not found: ${db_path}`);
		const db = new Database(db_path);
		try {
			const result = await verify_archive(
				db,
				args.archive ?? DEFAULT_ARCHIVE_PATH,
				{
					deep: Boolean(args.deep),
					on_progress: args.json
						? undefined
						: (message) => console.log(message),
				},
			);
			if (args.json) console.log(JSON.stringify(result, null, 2));
			else {
				for (const check of result.checks) {
					console.log(
						`${check.passed ? 'PASS' : 'FAIL'}  ${check.name}  (${check.checked})`,
					);
					for (const failure of check.failures)
						console.log(`  ${failure}`);
				}
				console.log(
					`\n${result.passed ? 'Verification passed' : 'Verification failed'} in ${result.elapsed_ms} ms`,
				);
			}
			if (!result.passed) process.exitCode = 1;
		} finally {
			db.close();
		}
	},
});

export const schema = defineCommand({
	meta: {
		name: 'schema',
		description: 'Show database table structure',
	},
	args: {
		...shared_args,
		table: {
			type: 'positional' as const,
			description: 'Table name (omit to list all tables)',
			required: false,
		},
	},
	async run({ args }) {
		const { Database } = await import('./db.ts');

		const db_path = args.db ?? DEFAULT_DB_PATH;
		const db = new Database(db_path);

		try {
			const result = db.get_schema(args.table as string | undefined);

			if (result.tables.length === 0) {
				if (args.json) {
					console.log('{"tables":[]}');
				} else if (args.table) {
					console.log(`Table not found: ${args.table}`);
				} else {
					console.log('No tables found.');
				}
				return;
			}

			if (args.json) {
				console.log(JSON.stringify(result.tables, null, 2));
				return;
			}

			if (!args.table) {
				const max_name_len = Math.max(
					5,
					...result.tables.map((t) => t.name.length),
				);
				const max_type_len = Math.max(
					4,
					...result.tables.map((t) => t.type.length),
				);

				console.log(
					`${'Table'.padEnd(max_name_len)}  ${'Type'.padEnd(max_type_len)}  Rows`,
				);
				console.log(
					`${'-'.repeat(max_name_len)}  ${'-'.repeat(max_type_len)}  --------`,
				);

				for (const t of result.tables) {
					console.log(
						`${t.name.padEnd(max_name_len)}  ${t.type.padEnd(max_type_len)}  ${t.row_count.toLocaleString().padStart(8)}`,
					);
				}
				return;
			}

			const t = result.tables[0];
			console.log(
				`\nTable: ${t.name} (${t.row_count.toLocaleString()} rows)\n`,
			);

			const max_col_len = Math.max(
				6,
				...t.columns.map((c) => c.name.length),
			);
			const max_type_len = Math.max(
				4,
				...t.columns.map((c) => c.type.length),
			);

			console.log(
				`${'Column'.padEnd(max_col_len)}  ${'Type'.padEnd(max_type_len)}  Null  PK  Default`,
			);
			console.log(
				`${'-'.repeat(max_col_len)}  ${'-'.repeat(max_type_len)}  ----  --  -------`,
			);

			for (const c of t.columns) {
				const nullable = c.notnull ? 'NO' : 'YES';
				const pk = c.pk ? '*' : '';
				const def =
					c.default_value !== null
						? String(c.default_value as string | number)
						: '';
				console.log(
					`${c.name.padEnd(max_col_len)}  ${c.type.padEnd(max_type_len)}  ${nullable.padEnd(4)}  ${pk.padEnd(2)}  ${def}`,
				);
			}

			if (t.foreign_keys.length > 0) {
				console.log(`\nForeign Keys:`);
				for (const fk of t.foreign_keys) {
					console.log(`  ${fk.from} -> ${fk.table}(${fk.to})`);
				}
			}

			if (t.indexes.length > 0) {
				console.log(`\nIndexes:`);
				for (const idx of t.indexes) {
					console.log(`  ${idx.name}`);
				}
			}
		} finally {
			db.close();
		}
	},
});

export const main = defineCommand({
	meta: {
		name: 'pi-session-analytics',
		version: PACKAGE_VERSION,
		description:
			'Archive and analyze pi.dev agent sessions in SQLite',
	},
	args: {
		db: {
			type: 'string',
			alias: 'd',
			description: `Database path (default: ${DEFAULT_DB_PATH})`,
		},
		json: {
			type: 'boolean',
			description: 'Output as JSON (for LLM/programmatic use)',
		},
	},
	subCommands: {
		sync,
		stats,
		search,
		sessions,
		query,
		tools,

		recoveries,
		usage,
		recall,
		resumable,
		verify,
		schema,
		compact,
	},
});
