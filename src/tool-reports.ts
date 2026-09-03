import { createHash } from 'node:crypto';

import type { ToolActivityRecord } from './db.ts';

/** Exact location of a canonical record in the immutable session archive. */
export interface ToolRecordProvenance {
	record_id: number;
	session_id: string;
	project_path: string;
	source_path: string;
	archive_generation_id: number;
	timestamp: number | null;
	source_byte_offset: number;
	source_byte_length: number;
}

/** Aggregate recorded outcomes for one tool. */
export interface ToolSummaryRow {
	tool_name: string;
	calls: number;
	matched_results: number;
	successes: number;
	failures: number;
	incomplete: number;
	failure_rate: number;
}

/** Repeated recorded failure evidence with every contributing result location. */
export interface ToolFailureRow {
	tool_name: string;
	fingerprint: string;
	evidence: string;
	count: number;
	occurrences: ToolRecordProvenance[];
}

/** One deterministic argument key frequency. */
export interface ToolArgumentKeyRow {
	tool_name: string;
	key: string;
	calls: number;
}

/** One deterministic argument shape with every contributing call location. */
export interface ToolArgumentShapeRow {
	tool_name: string;
	shape: string;
	calls: number;
	occurrences: ToolRecordProvenance[];
}

/** Build per-tool call and recorded outcome totals. */
export function summarize_tools(
	activity: ToolActivityRecord[],
): ToolSummaryRow[] {
	const rows = new Map<
		string,
		Omit<ToolSummaryRow, 'failure_rate'>
	>();
	for (const record of activity) {
		const row = rows.get(record.tool_name) ?? {
			tool_name: record.tool_name,
			calls: 0,
			matched_results: 0,
			successes: 0,
			failures: 0,
			incomplete: 0,
		};
		row.calls++;
		if (record.result_record_id === null) row.incomplete++;
		else {
			row.matched_results++;
			if (record.is_error === 1) row.failures++;
			else row.successes++;
		}
		rows.set(record.tool_name, row);
	}
	return [...rows.values()]
		.map((row) => ({
			...row,
			failure_rate:
				row.matched_results === 0
					? 0
					: row.failures / row.matched_results,
		}))
		.sort(
			(left, right) =>
				right.calls - left.calls ||
				left.tool_name.localeCompare(right.tool_name),
		);
}

/** Group recorded tool errors by stable normalized evidence. */
export function group_tool_failures(
	activity: ToolActivityRecord[],
): ToolFailureRow[] {
	const groups = new Map<string, ToolFailureRow>();
	for (const record of activity) {
		if (record.is_error !== 1 || record.result_record_id === null)
			continue;
		const evidence = normalize_failure_evidence(
			record.result_content ??
				record.result_details_json ??
				'(empty error result)',
		);
		const fingerprint = createHash('sha256')
			.update(`${record.tool_name}\0${evidence}`)
			.digest('hex')
			.slice(0, 16);
		const key = `${record.tool_name}\0${fingerprint}`;
		const row = groups.get(key) ?? {
			tool_name: record.tool_name,
			fingerprint,
			evidence,
			count: 0,
			occurrences: [],
		};
		row.count++;
		row.occurrences.push(result_provenance(record));
		groups.set(key, row);
	}
	return [...groups.values()].sort(
		(left, right) =>
			right.count - left.count ||
			left.tool_name.localeCompare(right.tool_name) ||
			left.evidence.localeCompare(right.evidence),
	);
}

/** Count argument paths and normalized JSON shapes without retaining values. */
export function report_tool_arguments(
	activity: ToolActivityRecord[],
): {
	keys: ToolArgumentKeyRow[];
	shapes: ToolArgumentShapeRow[];
} {
	const keys = new Map<string, ToolArgumentKeyRow>();
	const shapes = new Map<string, ToolArgumentShapeRow>();
	for (const record of activity) {
		const parsed = parse_arguments(record.arguments_json);
		for (const key of new Set(argument_paths(parsed))) {
			const map_key = `${record.tool_name}\0${key}`;
			const row = keys.get(map_key) ?? {
				tool_name: record.tool_name,
				key,
				calls: 0,
			};
			row.calls++;
			keys.set(map_key, row);
		}
		const shape = argument_shape(parsed);
		const map_key = `${record.tool_name}\0${shape}`;
		const row = shapes.get(map_key) ?? {
			tool_name: record.tool_name,
			shape,
			calls: 0,
			occurrences: [],
		};
		row.calls++;
		row.occurrences.push(call_provenance(record));
		shapes.set(map_key, row);
	}
	const by_frequency = <
		T extends { calls: number; tool_name: string },
	>(
		left: T,
		right: T,
	) =>
		right.calls - left.calls ||
		left.tool_name.localeCompare(right.tool_name);
	return {
		keys: [...keys.values()].sort(
			(left, right) =>
				by_frequency(left, right) ||
				left.key.localeCompare(right.key),
		),
		shapes: [...shapes.values()].sort(
			(left, right) =>
				by_frequency(left, right) ||
				left.shape.localeCompare(right.shape),
		),
	};
}

function call_provenance(
	record: ToolActivityRecord,
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
	record: ToolActivityRecord,
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

function normalize_failure_evidence(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function parse_arguments(value: string): unknown {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return Symbol.for('invalid-json');
	}
}

function argument_paths(value: unknown, prefix = ''): string[] {
	if (Array.isArray(value)) {
		return value.flatMap((item) =>
			argument_paths(item, `${prefix}[]`),
		);
	}
	if (!value || typeof value !== 'object') return [];
	return Object.entries(value as Record<string, unknown>).flatMap(
		([key, child]) => {
			const path = prefix ? `${prefix}.${key}` : key;
			return [path, ...argument_paths(child, path)];
		},
	);
}

function argument_shape(value: unknown): string {
	if (value === Symbol.for('invalid-json')) return 'invalid-json';
	if (value === null) return 'null';
	if (Array.isArray(value)) {
		if (value.length === 0) return '[]';
		const shapes = [...new Set(value.map(argument_shape))].sort();
		return `[${shapes.join('|')}]`;
	}
	if (typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(
				([key, child]) =>
					`${JSON.stringify(key)}:${argument_shape(child)}`,
			);
		return `{${entries.join(',')}}`;
	}
	return typeof value;
}
