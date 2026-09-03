import type {
	ToolActivityFilters,
	RecoveryActivityRecord,
	UsageActivityRecord,
	UserTurnBoundary,
} from './db.ts';
import type { ToolRecordProvenance } from './tool-reports.ts';

/** A conservative, explicitly inferred outcome after one recorded tool failure. */
export interface InferredRecovery {
	classification:
		| 'same-tool-recovery'
		| 'alternate-tool-recovery'
		| 'unresolved';
	failure_tool: string;
	recovery_tool: string | null;
	intervening_tool_calls: number;
	intervening_tools: string[];
	failure_call: ToolRecordProvenance;
	failure_result: ToolRecordProvenance;
	recovery_call: ToolRecordProvenance | null;
	recovery_result: ToolRecordProvenance | null;
	provider: string | null;
	model: string | null;
}

/** Supported dimensions for inferred recovery comparisons. */
export type RecoveryGroup =
	| 'model'
	| 'provider'
	| 'project'
	| 'tool'
	| 'day';

/** Aggregate inferred recovery outcomes for one comparison value. */
export interface RecoveryGroupRow {
	group: RecoveryGroup;
	value: string;
	failures: number;
	same_tool: number;
	alternate_tool: number;
	unresolved: number;
	inferred_recovery_rate: number;
}

/** Supported dimensions for recorded usage comparisons. */
export type UsageGroup = 'model' | 'provider' | 'project' | 'day';

/** One recorded assistant usage row with exact archive provenance. */
export interface UsageDetail extends ToolRecordProvenance {
	provider: string | null;
	model: string | null;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	total_tokens: number;
	cost_recorded: boolean;
	cost_input: number | null;
	cost_output: number | null;
	cost_cache_read: number | null;
	cost_cache_write: number | null;
	cost_total: number | null;
}

/** Aggregated recorded usage for one deterministic dimension value. */
export interface UsageGroupRow {
	group: UsageGroup;
	value: string;
	messages: number;
	priced_messages: number;
	unpriced_messages: number;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	total_tokens: number;
	cost_input: number | null;
	cost_output: number | null;
	cost_cache_read: number | null;
	cost_cache_write: number | null;
	cost_total: number | null;
	details: UsageDetail[];
}

/**
 * Infer recovery from a recorded failure to a later recorded success in the
 * same user turn. Same-tool success is preferred; otherwise the first
 * successful alternate tool is used. No success before the next user message
 * is unresolved.
 */
export function infer_recoveries(
	activity: RecoveryActivityRecord[],
	boundaries: UserTurnBoundary[],
	filters: ToolActivityFilters = {},
): InferredRecovery[] {
	const by_source = Map.groupBy(
		activity,
		(record) => record.source_path,
	);
	const boundaries_by_source = Map.groupBy(
		boundaries,
		(boundary) => boundary.source_path,
	);
	const inferred: InferredRecovery[] = [];
	for (const records of by_source.values()) {
		records.sort(
			(left, right) =>
				left.source_byte_offset - right.source_byte_offset ||
				left.call_record_id - right.call_record_id,
		);
		const user_offsets = (
			boundaries_by_source.get(records[0]!.source_path) ?? []
		)
			.map((boundary) => boundary.source_byte_offset)
			.sort((left, right) => left - right);
		for (const [failure_index, failure] of records.entries()) {
			if (
				failure.is_error !== 1 ||
				failure.result_record_id === null ||
				!matches_filters(failure, filters)
			)
				continue;
			const failure_offset =
				failure.result_source_byte_offset ??
				failure.source_byte_offset;
			const turn_end =
				user_offsets.find((offset) => offset > failure_offset) ??
				Infinity;
			const later = records
				.slice(failure_index + 1)
				.filter(
					(record) =>
						record.source_byte_offset > failure_offset &&
						record.source_byte_offset < turn_end &&
						record.result_record_id !== null &&
						record.result_source_byte_offset !== null &&
						record.result_source_byte_offset < turn_end &&
						record.is_error === 0,
				);
			const recovery =
				later.find(
					(record) => record.tool_name === failure.tool_name,
				) ?? later[0];
			const intervening = records.filter(
				(record) =>
					record.source_byte_offset > failure_offset &&
					record.source_byte_offset <
						(recovery?.source_byte_offset ?? turn_end),
			);
			inferred.push({
				classification: recovery
					? recovery.tool_name === failure.tool_name
						? 'same-tool-recovery'
						: 'alternate-tool-recovery'
					: 'unresolved',
				failure_tool: failure.tool_name,
				recovery_tool: recovery?.tool_name ?? null,
				intervening_tool_calls: intervening.length,
				intervening_tools: intervening.map(
					(record) => record.tool_name,
				),
				failure_call: call_provenance(failure),
				failure_result: result_provenance(failure),
				recovery_call: recovery ? call_provenance(recovery) : null,
				recovery_result: recovery
					? result_provenance(recovery)
					: null,
				provider: failure.provider,
				model: failure.model,
			});
		}
	}
	return inferred.sort(
		(left, right) =>
			(left.failure_call.timestamp ?? 0) -
				(right.failure_call.timestamp ?? 0) ||
			left.failure_call.source_path.localeCompare(
				right.failure_call.source_path,
			) ||
			left.failure_call.source_byte_offset -
				right.failure_call.source_byte_offset,
	);
}

/** Aggregate inferred recovery classifications for comparison. */
export function group_recoveries(
	recoveries: InferredRecovery[],
	group: RecoveryGroup,
): RecoveryGroupRow[] {
	const rows = new Map<
		string,
		Omit<RecoveryGroupRow, 'inferred_recovery_rate'>
	>();
	for (const recovery of recoveries) {
		const value = recovery_group_value(recovery, group);
		const row = rows.get(value) ?? {
			group,
			value,
			failures: 0,
			same_tool: 0,
			alternate_tool: 0,
			unresolved: 0,
		};
		row.failures++;
		if (recovery.classification === 'same-tool-recovery')
			row.same_tool++;
		else if (recovery.classification === 'alternate-tool-recovery')
			row.alternate_tool++;
		else row.unresolved++;
		rows.set(value, row);
	}
	return [...rows.values()]
		.map((row) => ({
			...row,
			inferred_recovery_rate:
				row.failures === 0
					? 0
					: (row.same_tool + row.alternate_tool) / row.failures,
		}))
		.sort(
			(left, right) =>
				right.failures - left.failures ||
				left.value.localeCompare(right.value),
		);
}

/** Aggregate only recorded token and cost fields by one requested dimension. */
export function group_usage(
	activity: UsageActivityRecord[],
	group: UsageGroup,
): UsageGroupRow[] {
	const rows = new Map<string, UsageGroupRow>();
	for (const record of activity) {
		const value = usage_group_value(record, group);
		const row = rows.get(value) ?? {
			group,
			value,
			messages: 0,
			input_tokens: 0,
			priced_messages: 0,
			unpriced_messages: 0,
			output_tokens: 0,
			cache_read_tokens: 0,
			cache_write_tokens: 0,
			total_tokens: 0,
			cost_input: 0,
			cost_output: 0,
			cost_cache_read: 0,
			cost_cache_write: 0,
			cost_total: 0,
			details: [],
		};
		row.messages++;
		row.input_tokens += record.input_tokens;
		if (record.cost_recorded === 1) row.priced_messages++;
		else row.unpriced_messages++;
		row.output_tokens += record.output_tokens;
		row.cache_read_tokens += record.cache_read_tokens;
		row.cache_write_tokens += record.cache_write_tokens;
		row.total_tokens += record.total_tokens;
		if (record.cost_recorded === 1) {
			row.cost_input = (row.cost_input ?? 0) + record.cost_input;
			row.cost_output = (row.cost_output ?? 0) + record.cost_output;
			row.cost_cache_read =
				(row.cost_cache_read ?? 0) + record.cost_cache_read;
			row.cost_cache_write =
				(row.cost_cache_write ?? 0) + record.cost_cache_write;
			row.cost_total = (row.cost_total ?? 0) + record.cost_total;
		}
		row.details.push(usage_detail(record));
		rows.set(value, row);
	}
	return [...rows.values()]
		.map((row) =>
			row.priced_messages === 0
				? {
						...row,
						cost_input: null,
						cost_output: null,
						cost_cache_read: null,
						cost_cache_write: null,
						cost_total: null,
					}
				: row,
		)
		.sort(
			(left, right) =>
				(right.cost_total ?? -Infinity) -
					(left.cost_total ?? -Infinity) ||
				right.total_tokens - left.total_tokens ||
				left.value.localeCompare(right.value),
		);
}

function matches_filters(
	record: RecoveryActivityRecord,
	filters: ToolActivityFilters,
): boolean {
	return (
		(!filters.project ||
			record.project_path.includes(filters.project)) &&
		(!filters.session ||
			record.session_id.startsWith(filters.session)) &&
		(!filters.provider || record.provider === filters.provider) &&
		(!filters.model || record.model === filters.model) &&
		(filters.after === undefined ||
			(record.timestamp !== null &&
				record.timestamp >= filters.after)) &&
		(filters.before === undefined ||
			(record.timestamp !== null &&
				record.timestamp < filters.before))
	);
}

function recovery_group_value(
	recovery: InferredRecovery,
	group: RecoveryGroup,
): string {
	if (group === 'provider') return recovery.provider ?? 'unknown';
	if (group === 'project')
		return recovery.failure_call.project_path || 'unknown';
	if (group === 'tool') return recovery.failure_tool;
	if (group === 'day')
		return recovery.failure_call.timestamp === null
			? 'unknown'
			: new Date(recovery.failure_call.timestamp)
					.toISOString()
					.slice(0, 10);
	return `${recovery.provider ?? 'unknown'}/${recovery.model ?? 'unknown'}`;
}

function usage_group_value(
	record: UsageActivityRecord,
	group: UsageGroup,
): string {
	if (group === 'provider') return record.provider ?? 'unknown';
	if (group === 'project') return record.project_path || 'unknown';
	if (group === 'day')
		return record.timestamp === null
			? 'unknown'
			: new Date(record.timestamp).toISOString().slice(0, 10);
	return `${record.provider ?? 'unknown'}/${record.model ?? 'unknown'}`;
}

function call_provenance(
	record: RecoveryActivityRecord,
): ToolRecordProvenance {
	return {
		record_id: record.call_record_id,
		session_id: record.session_id,
		project_path: record.project_path,
		source_path: record.source_path,
		archive_generation_id: record.archive_generation_id,
		timestamp: record.timestamp,
		source_byte_offset: record.source_byte_offset,
		source_byte_length: record.source_byte_length,
	};
}

function result_provenance(
	record: RecoveryActivityRecord,
): ToolRecordProvenance {
	return {
		record_id: record.result_record_id!,
		session_id: record.session_id,
		project_path: record.project_path,
		source_path: record.source_path,
		archive_generation_id: record.result_archive_generation_id!,
		timestamp: record.result_timestamp,
		source_byte_offset: record.result_source_byte_offset!,
		source_byte_length: record.result_source_byte_length!,
	};
}

function usage_detail(record: UsageActivityRecord): UsageDetail {
	return {
		record_id: record.record_id,
		session_id: record.session_id,
		project_path: record.project_path,
		source_path: record.source_path,
		archive_generation_id: record.archive_generation_id,
		timestamp: record.timestamp,
		source_byte_offset: record.source_byte_offset,
		source_byte_length: record.source_byte_length,
		provider: record.provider,
		model: record.model,
		input_tokens: record.input_tokens,
		output_tokens: record.output_tokens,
		cache_read_tokens: record.cache_read_tokens,
		cache_write_tokens: record.cache_write_tokens,
		total_tokens: record.total_tokens,
		cost_recorded: record.cost_recorded === 1,
		cost_input: record.cost_recorded === 1 ? record.cost_input : null,
		cost_output:
			record.cost_recorded === 1 ? record.cost_output : null,
		cost_cache_read:
			record.cost_recorded === 1 ? record.cost_cache_read : null,
		cost_cache_write:
			record.cost_recorded === 1 ? record.cost_cache_write : null,
		cost_total: record.cost_recorded === 1 ? record.cost_total : null,
	};
}
