import type { ToolDatabase } from './tool-database.ts';

export interface ToolFilter {
	tool?: string;
	provider?: string;
	model?: string;
	project?: string;
	limit?: number;
}

/** Aggregate recorded tool calls, results, hard errors, and incomplete calls. */
export function tool_summary(
	db: ToolDatabase,
	filter: ToolFilter = {},
): Array<Record<string, unknown>> {
	const { where, values } = call_filter(filter, 'calls');
	return db.raw
		.prepare(`
		SELECT calls.tool_name,
			COUNT(*) AS calls,
			COUNT(results.id) AS results,
			SUM(CASE WHEN results.is_error = 1 THEN 1 ELSE 0 END) AS hard_errors,
			SUM(CASE WHEN results.id IS NULL THEN 1 ELSE 0 END) AS incomplete
		FROM tool_calls calls
		JOIN sessions ON sessions.id = calls.session_id
		LEFT JOIN tool_results results
			ON results.session_id = calls.session_id
			AND results.tool_call_id = calls.tool_call_id
		${where}
		GROUP BY calls.tool_name
		ORDER BY calls DESC, calls.tool_name
		LIMIT ?
	`)
		.all(...values, filter.limit ?? 100) as Array<
		Record<string, unknown>
	>;
}

/** Group tool-call argument shapes without exposing argument values. */
export function argument_report(
	db: ToolDatabase,
	filter: ToolFilter = {},
): Array<Record<string, unknown>> {
	const { where, values } = call_filter(filter, 'calls');
	return db.raw
		.prepare(`
		SELECT calls.tool_name, calls.argument_shape, COUNT(*) AS calls
		FROM tool_calls calls
		JOIN sessions ON sessions.id = calls.session_id
		${where}
		GROUP BY calls.tool_name, calls.argument_shape
		ORDER BY calls DESC, calls.tool_name, calls.argument_shape
		LIMIT ?
	`)
		.all(...values, filter.limit ?? 100) as Array<
		Record<string, unknown>
	>;
}

/** Return recorded hard errors and calls whose result is absent. */
export function failure_report(
	db: ToolDatabase,
	filter: ToolFilter = {},
): Array<Record<string, unknown>> {
	const { where, values } = call_filter(filter, 'calls');
	const condition = where ? `${where} AND` : 'WHERE';
	return db.raw
		.prepare(`
		SELECT calls.session_id, calls.tool_call_id, calls.tool_name,
			calls.turn_index, calls.event_index AS call_event_index,
			calls.timestamp AS call_timestamp,
			results.event_index AS result_event_index,
			results.timestamp AS result_timestamp,
			CASE WHEN results.is_error = 1 THEN 'hard_error' ELSE 'incomplete' END AS failure_kind,
			results.error_fingerprint,
			COALESCE(results.source_path, calls.source_path) AS source_path,
			COALESCE(results.source_byte_offset, calls.source_byte_offset) AS source_byte_offset
		FROM tool_calls calls
		JOIN sessions ON sessions.id = calls.session_id
		LEFT JOIN tool_results results
			ON results.session_id = calls.session_id
			AND results.tool_call_id = calls.tool_call_id
		${condition} (results.is_error = 1 OR results.id IS NULL)
		ORDER BY COALESCE(results.timestamp, calls.timestamp) DESC, calls.session_id, calls.event_index
		LIMIT ?
	`)
		.all(...values, filter.limit ?? 100) as Array<
		Record<string, unknown>
	>;
}

/** Infer same-turn recovery from the next recorded tool call after each failure. */
export function recovery_report(
	db: ToolDatabase,
	filter: ToolFilter = {},
): Array<Record<string, unknown>> {
	const failures = failure_report(db, {
		...filter,
		limit: filter.limit ?? 100,
	});
	const next_call = db.raw.prepare(`
		SELECT calls.tool_call_id, calls.tool_name, calls.event_index, calls.timestamp
		FROM tool_calls calls
		JOIN tool_results results
			ON results.session_id = calls.session_id
			AND results.tool_call_id = calls.tool_call_id
		WHERE calls.session_id = ? AND calls.turn_index = ?
			AND calls.event_index > ? AND results.is_error = 0
		ORDER BY (calls.tool_name = ?) DESC, calls.event_index, calls.id
		LIMIT 1
	`);
	return failures.map((failure) => {
		const failed_index = Number(
			failure.result_event_index ?? failure.call_event_index,
		);
		const next = next_call.get(
			String(failure.session_id),
			Number(failure.turn_index),
			failed_index,
			String(failure.tool_name),
		) as Record<string, unknown> | undefined;
		return {
			...failure,
			recovery_inference: next
				? String(next.tool_name) === String(failure.tool_name)
					? 'inferred_same_tool'
					: 'inferred_alternate_tool'
				: 'inferred_unresolved',
			next_tool_call_id: next?.tool_call_id ?? null,
			next_tool_name: next?.tool_name ?? null,
			next_event_index: next?.event_index ?? null,
		};
	});
}

/** Aggregate recorded assistant-turn usage independently from tool calls. */
export function usage_report(
	db: ToolDatabase,
	options: {
		group_by?: 'day' | 'model' | 'project';
		limit?: number;
	} = {},
): Array<Record<string, unknown>> {
	const group_by = options.group_by ?? 'day';
	const expression =
		group_by === 'model'
			? "COALESCE(provider, '') || '/' || COALESCE(model, '')"
			: group_by === 'project'
				? 'project_path'
				: "date(timestamp / 1000, 'unixepoch')";
	return db.raw
		.prepare(`
		SELECT ${expression} AS group_value,
			COUNT(*) AS turns,
			SUM(input_tokens) AS input_tokens,
			SUM(output_tokens) AS output_tokens,
			SUM(cache_read_tokens) AS cache_read_tokens,
			SUM(cache_write_tokens) AS cache_write_tokens,
			SUM(total_tokens) AS total_tokens,
			SUM(CASE WHEN cost_recorded = 1 THEN cost_total ELSE 0 END) AS recorded_cost,
			SUM(cost_recorded) AS turns_with_recorded_cost
		FROM usage_records
		GROUP BY ${expression}
		ORDER BY total_tokens DESC, group_value
		LIMIT ?
	`)
		.all(options.limit ?? 100) as Array<Record<string, unknown>>;
}

function call_filter(
	filter: ToolFilter,
	alias: string,
): { where: string; values: string[] } {
	const clauses: string[] = [];
	const values: string[] = [];
	if (filter.tool) {
		clauses.push(`${alias}.tool_name = ?`);
		values.push(filter.tool);
	}
	if (filter.provider) {
		clauses.push(`${alias}.provider = ?`);
		values.push(filter.provider);
	}
	if (filter.model) {
		clauses.push(`${alias}.model = ?`);
		values.push(filter.model);
	}
	if (filter.project) {
		clauses.push('sessions.project_path = ?');
		values.push(filter.project);
	}
	return {
		where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
		values,
	};
}
