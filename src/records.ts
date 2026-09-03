import type {
	ArchiveGenerationRecord,
	Database,
	SessionRecordInsert,
} from './db.ts';
import type { SessionArchive } from './archive.ts';

type JsonObject = Record<string, unknown>;

/** Canonical record rows added during one indexing pass. */
export interface RecordIndexStats {
	added: number;
	invalid: number;
}

/** Indexes immutable archive segments into lossless contextual SQLite rows. */
export class CanonicalRecordIndexer {
	constructor(
		private readonly db: Database,
		private readonly archive: SessionArchive,
	) {}

	/** Index every committed archive generation not completed by an earlier pass. */
	index_pending_generations(indexed_at: number): RecordIndexStats {
		const total = { added: 0, invalid: 0 };
		for (const generation of this.db.list_unindexed_archive_generations()) {
			const result = this.index_generation(generation);
			this.db.mark_record_generation_indexed(
				generation.id,
				result.added,
				result.invalid,
				indexed_at,
			);
			total.added += result.added;
			total.invalid += result.invalid;
		}
		return total;
	}

	private index_generation(
		generation: ArchiveGenerationRecord,
	): RecordIndexStats {
		const result = { added: 0, invalid: 0 };
		let pending = Buffer.alloc(0);
		let pending_offset = 0;
		let record_index = 0;
		const add_line = (bytes: Buffer, source_byte_offset: number) => {
			if (bytes.length === 0) return;
			const raw_json = bytes.toString('utf8');
			const indexed = this.index_record(
				generation,
				record_index++,
				source_byte_offset,
				bytes.length,
				raw_json,
			);
			result.added++;
			if (!indexed) result.invalid++;
		};

		this.archive.read_generation_segment(
			generation.id,
			(bytes, source_offset) => {
				if (
					pending.length > 0 &&
					source_offset !== pending_offset + pending.length
				) {
					throw new Error(
						`Archive generation ${generation.id} has a byte gap`,
					);
				}
				const combined =
					pending.length > 0
						? Buffer.concat([pending, bytes])
						: bytes;
				const combined_offset =
					pending.length > 0 ? pending_offset : source_offset;
				let line_start = 0;
				for (let index = 0; index < combined.length; index++) {
					if (combined[index] !== 10) continue;
					add_line(
						combined.subarray(line_start, index),
						combined_offset + line_start,
					);
					line_start = index + 1;
				}
				pending = Buffer.from(combined.subarray(line_start));
				pending_offset = combined_offset + line_start;
			},
		);
		if (pending.length > 0) add_line(pending, pending_offset);
		return result;
	}

	private index_record(
		generation: ArchiveGenerationRecord,
		record_index: number,
		source_byte_offset: number,
		source_byte_length: number,
		raw_json: string,
	): boolean {
		let value: unknown;
		try {
			value = JSON.parse(raw_json) as unknown;
		} catch (error) {
			this.db.insert_session_record({
				archive_generation_id: generation.id,
				source_path: generation.source_path,
				session_id: generation.session_id,
				record_index,
				source_byte_offset,
				source_byte_length,
				record_type: 'invalid',
				raw_json,
				search_text: raw_json,
				parse_error:
					error instanceof Error ? error.message : 'Invalid JSON',
			});
			return false;
		}
		if (!is_object(value)) {
			this.db.insert_session_record({
				archive_generation_id: generation.id,
				source_path: generation.source_path,
				session_id: generation.session_id,
				record_index,
				source_byte_offset,
				source_byte_length,
				record_type: 'invalid',
				raw_json,
				search_text: raw_json,
				parse_error: 'Record is not a JSON object',
			});
			return false;
		}

		const record_type = string_value(value.type);
		if (!record_type) {
			this.db.insert_session_record({
				archive_generation_id: generation.id,
				source_path: generation.source_path,
				session_id: generation.session_id,
				record_index,
				source_byte_offset,
				source_byte_length,
				record_type: 'invalid',
				raw_json,
				search_text: raw_json,
				parse_error: 'Record type is missing',
			});
			return false;
		}

		const message = is_object(value.message)
			? value.message
			: undefined;
		const usage = is_object(message?.usage)
			? message.usage
			: is_object(value.usage)
				? value.usage
				: undefined;
		const content = message ? message.content : value.content;
		const content_blocks = Array.isArray(content)
			? content.filter(is_object)
			: [];
		const record: SessionRecordInsert = {
			archive_generation_id: generation.id,
			source_path: generation.source_path,
			session_id: generation.session_id,
			record_index,
			source_byte_offset,
			source_byte_length,
			record_type,
			entry_id:
				value.type === 'session' ? undefined : string_value(value.id),
			parent_id: string_value(value.parentId),
			timestamp: timestamp_value(value.timestamp),
			raw_json,
			session_version: number_value(value.version),
			search_text: searchable_text(value),
			cwd: string_value(value.cwd),
			parent_session_path: string_value(value.parentSession),
			message_role: string_value(message?.role),
			content_text: content_text(content),
			content_json: json_value(content),
			details_json: json_value(message?.details ?? value.details),
			data_json: json_value(value.data),
			usage_json: json_value(usage),
			provider: string_value(message?.provider ?? value.provider),
			model: string_value(message?.model ?? value.modelId),
			api: string_value(message?.api),
			stop_reason: string_value(message?.stopReason),
			error_message: string_value(message?.errorMessage),
			thinking_level: string_value(value.thinkingLevel),
			custom_type: string_value(value.customType),
			display: boolean_value(value.display),
			from_hook: boolean_value(value.fromHook),
			retained_tail_json: json_value(value.retainedTail),
			summary: string_value(value.summary),
			tokens_before: number_value(value.tokensBefore),
			first_kept_entry_id: string_value(value.firstKeptEntryId),
			from_id: string_value(value.fromId),
			target_id: string_value(value.targetId),
			label: string_value(value.label),
			name: string_value(value.name),
			tool_call_id: string_value(message?.toolCallId),
			tool_name: string_value(message?.toolName),
			is_error: boolean_value(message?.isError),
			...usage_values(usage),
		};
		const record_id = this.db.insert_session_record(record);
		for (const [block_index, block] of content_blocks.entries()) {
			const type = string_value(block.type) ?? 'unknown';
			const tool_call_id = string_value(block.id);
			const tool_name = string_value(block.name);
			const arguments_json = json_value(block.arguments);
			this.db.insert_record_content_block({
				record_id,
				block_index,
				type,
				text: string_value(block.text),
				thinking: string_value(block.thinking),
				mime_type: string_value(block.mimeType),
				tool_call_id,
				tool_name,
				arguments_json,
				raw_json: JSON.stringify(block),
			});
			if (type === 'toolCall' && tool_call_id && tool_name) {
				this.db.insert_record_tool_call({
					record_id,
					block_index,
					source_path: generation.source_path,
					session_id: generation.session_id,
					tool_call_id,
					tool_name,
					arguments_json: arguments_json ?? '{}',
				});
			}
		}
		const result_call_id = string_value(message?.toolCallId);
		const result_tool_name = string_value(message?.toolName);
		if (
			message?.role === 'toolResult' &&
			result_call_id &&
			result_tool_name
		) {
			this.db.insert_record_tool_result({
				record_id,
				source_path: generation.source_path,
				session_id: generation.session_id,
				tool_call_id: result_call_id,
				tool_name: result_tool_name,
				content_text: content_text(content),
				content_json: json_value(content) ?? 'null',
				details_json: json_value(message.details),
				is_error: message.isError === true,
			});
		}
		return true;
	}
}

function is_object(value: unknown): value is JsonObject {
	return (
		Boolean(value) &&
		typeof value === 'object' &&
		!Array.isArray(value)
	);
}

function string_value(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function number_value(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value)
		? value
		: undefined;
}

function boolean_value(value: unknown): boolean | undefined {
	return typeof value === 'boolean' ? value : undefined;
}

function timestamp_value(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value))
		return value;
	if (typeof value !== 'string') return undefined;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

function json_value(value: unknown): string | undefined {
	return value === undefined ? undefined : JSON.stringify(value);
}

function content_text(content: unknown): string | undefined {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.filter(is_object)
		.map((block) => string_value(block.text))
		.filter((value): value is string => value !== undefined)
		.join('\n');
	return text || undefined;
}

function searchable_text(value: unknown): string {
	const parts: string[] = [];
	collect_search_values(value, parts);
	return parts.join('\n');
}

function collect_search_values(
	value: unknown,
	parts: string[],
): void {
	if (typeof value === 'string') {
		parts.push(value);
		return;
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		parts.push(String(value));
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collect_search_values(item, parts);
		return;
	}
	if (!is_object(value)) return;
	const image = value.type === 'image';
	for (const [key, child] of Object.entries(value)) {
		if (image && key === 'data') continue;
		parts.push(key);
		collect_search_values(child, parts);
	}
}

function usage_values(
	usage: JsonObject | undefined,
): Pick<
	SessionRecordInsert,
	| 'input_tokens'
	| 'output_tokens'
	| 'cache_read_tokens'
	| 'cache_write_tokens'
	| 'total_tokens'
	| 'cost_input'
	| 'cost_output'
	| 'cost_cache_read'
	| 'cost_cache_write'
	| 'cost_total'
> {
	const cost = is_object(usage?.cost) ? usage.cost : undefined;
	return {
		input_tokens: number_value(usage?.input) ?? 0,
		output_tokens: number_value(usage?.output) ?? 0,
		cache_read_tokens: number_value(usage?.cacheRead) ?? 0,
		cache_write_tokens: number_value(usage?.cacheWrite) ?? 0,
		total_tokens: number_value(usage?.totalTokens) ?? 0,
		cost_input: number_value(cost?.input) ?? 0,
		cost_output: number_value(cost?.output) ?? 0,
		cost_cache_read: number_value(cost?.cacheRead) ?? 0,
		cost_cache_write: number_value(cost?.cacheWrite) ?? 0,
		cost_total: number_value(cost?.total) ?? 0,
	};
}
