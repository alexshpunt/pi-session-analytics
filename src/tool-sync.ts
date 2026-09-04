import { createHash } from 'node:crypto';
import {
	createReadStream,
	openSync,
	closeSync,
	readSync,
	statSync,
} from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { glob } from 'tinyglobby';
import { ToolDatabase } from './tool-database.ts';

export const DEFAULT_SESSIONS_PATH = join(
	process.env.HOME ?? '',
	'.pi',
	'agent',
	'sessions',
);

interface NativeHeader {
	id: string;
	cwd: string;
	timestamp: number;
}

interface Candidate extends NativeHeader {
	path: string;
	mtime_ms: number;
	size_bytes: number;
	safe_size_bytes: number;
}

export interface ToolSyncResult {
	files_scanned: number;
	sessions: number;
	files_processed: number;
	calls_added: number;
	results_added: number;
	usage_added: number;
	events_added: number;

	sources_vanished: number;
	excluded: {
		malformed_or_non_session: number;
		duplicate_session_id: number;
	};
}

interface PiMessage {
	role?: string;
	content?: Array<Record<string, unknown>>;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	details?: unknown;
	provider?: string;
	model?: string;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
			total?: number;
		};
	};
}

export interface SyncControl {
	signal?: AbortSignal;
	on_checkpoint?: (committed_sessions: number) => void;
}

/** Import only ordered tool activity and turn-level usage from native Pi sessions. */
export async function sync_tool_sessions(
	db: ToolDatabase,
	sessions_path = DEFAULT_SESSIONS_PATH,
	control: SyncControl = {},
): Promise<ToolSyncResult> {
	const paths = await glob('**/*.jsonl', {
		cwd: sessions_path,
		absolute: true,
		onlyFiles: true,
		dot: true,
		ignore: ['**/.pi-session-analytics-archive/**'],
	});
	const selected = new Map<string, Candidate>();
	let malformed = 0;
	let duplicates = 0;
	for (const path of paths.sort()) {
		const header = read_header(path);
		if (!header) {
			malformed++;
			continue;
		}
		let candidate: Candidate;
		try {
			const stat = statSync(path);
			const safe_size_bytes = complete_bytes(path, stat.size);
			if (safe_size_bytes === 0) {
				malformed++;
				continue;
			}
			candidate = {
				...header,
				path,
				mtime_ms: stat.mtimeMs,
				size_bytes: stat.size,
				safe_size_bytes,
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT')
				continue;
			throw error;
		}
		const previous = selected.get(header.id);
		if (!previous) {
			selected.set(header.id, candidate);
			continue;
		}
		duplicates++;
		if (
			candidate.mtime_ms > previous.mtime_ms ||
			(candidate.mtime_ms === previous.mtime_ms &&
				candidate.path < previous.path)
		) {
			selected.set(header.id, candidate);
		}
	}

	const result: ToolSyncResult = {
		files_scanned: paths.length,
		sessions: selected.size,
		files_processed: 0,
		calls_added: 0,
		results_added: 0,
		usage_added: 0,
		events_added: 0,

		sources_vanished: 0,
		excluded: {
			malformed_or_non_session: malformed,
			duplicate_session_id: duplicates,
		},
	};
	const seen_at = Date.now();
	let committed_sessions = 0;
	for (const candidate of [...selected.values()].sort((a, b) =>
		a.path.localeCompare(b.path),
	)) {
		if (control.signal?.aborted) throw new Error('Sync interrupted');
		const source = db.get_source(candidate.id);
		const unchanged =
			source !== undefined &&
			String(source.current_path) === candidate.path &&
			Number(source.source_size_bytes) === candidate.size_bytes &&
			Number(source.source_mtime_ms) === candidate.mtime_ms;
		if (unchanged) {
			db.transaction(() => {
				db.upsert_session({
					id: candidate.id,
					project_path: candidate.cwd,
					first_timestamp: candidate.timestamp,
					last_timestamp: candidate.timestamp,
					current_source_path: candidate.path,
					last_seen_at: seen_at,
				});
				db.upsert_source({
					session_id: candidate.id,
					current_path: candidate.path,
					source_mtime_ms: candidate.mtime_ms,
					source_size_bytes: candidate.size_bytes,
					processed_bytes: Number(source.processed_bytes),
					processed_prefix_sha256: String(
						source.processed_prefix_sha256,
					),
					last_seen_at: seen_at,
				});
			});
			committed_sessions++;
			control.on_checkpoint?.(committed_sessions);
			continue;
		}

		let start = 0;
		try {
			if (
				source !== undefined &&
				String(source.current_path) === candidate.path &&
				candidate.safe_size_bytes > Number(source.processed_bytes) &&
				hash_prefix(
					candidate.path,
					Number(source.processed_bytes),
				) === String(source.processed_prefix_sha256)
			) {
				start = Number(source.processed_bytes);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				result.sources_vanished++;
				continue;
			}
			throw error;
		}
		const cursor =
			start > 0
				? db.get_session_cursor(candidate.id)
				: { turn_index: 0, event_index: 0 };
		let imported: { calls: number; results: number; usage: number };
		try {
			imported = await import_candidate(
				db,
				candidate,
				start,
				cursor,
				seen_at,
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				result.sources_vanished++;
				continue;
			}
			throw error;
		}
		result.files_processed++;
		result.calls_added += imported.calls;
		result.results_added += imported.results;
		result.usage_added += imported.usage;

		committed_sessions++;
		control.on_checkpoint?.(committed_sessions);
	}
	db.mark_sources_missing(seen_at);
	result.events_added = result.calls_added + result.results_added;
	return result;
}

async function import_candidate(
	db: ToolDatabase,
	candidate: Candidate,
	start: number,
	cursor: { turn_index: number; event_index: number },
	seen_at: number,
): Promise<{ calls: number; results: number; usage: number }> {
	let turn_index = cursor.turn_index;
	let event_index = cursor.event_index;
	let offset = start;
	let last_timestamp = candidate.timestamp;
	let calls = 0;
	let results = 0;
	let usage = 0;
	await db.transaction_async(async () => {
		db.upsert_session({
			id: candidate.id,
			project_path: candidate.cwd,
			first_timestamp: candidate.timestamp,
			last_timestamp: candidate.timestamp,
			current_source_path: candidate.path,
			last_seen_at: seen_at,
		});
		const input = createReadStream(candidate.path, {
			start,
			end: candidate.safe_size_bytes - 1,
		});
		const lines = createInterface({ input, crlfDelay: Infinity });
		for await (const line of lines) {
			const line_offset = offset;
			offset += Buffer.byteLength(line) + 1;
			if (!line.trim()) continue;
			let record: Record<string, unknown>;
			try {
				record = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			if (record.type !== 'message') continue;
			const message = record.message as PiMessage | undefined;
			if (!message) continue;
			const timestamp = parse_timestamp(record.timestamp);
			if (timestamp !== undefined)
				last_timestamp = Math.max(last_timestamp, timestamp);
			if (message.role === 'user') {
				turn_index++;
				continue;
			}
			if (message.role === 'assistant') {
				const content = Array.isArray(message.content)
					? message.content
					: [];
				for (const [block_index, block] of content.entries()) {
					if (
						block.type !== 'toolCall' ||
						typeof block.id !== 'string' ||
						typeof block.name !== 'string'
					)
						continue;
					event_index++;
					if (
						db.upsert_tool_call({
							session_id: candidate.id,
							tool_call_id: block.id,
							tool_name: block.name,
							turn_index,
							event_index,
							timestamp,
							provider: message.provider,
							model: message.model,
							arguments_json: JSON.stringify(block.arguments ?? {}),
							source_path: candidate.path,
							source_byte_offset: line_offset,
							source_block_index: block_index,
							seen_at,
						})
					)
						calls++;
				}
				if (message.usage) {
					const cost = message.usage.cost;
					if (
						db.upsert_usage({
							session_id: candidate.id,
							message_id:
								typeof record.id === 'string'
									? record.id
									: `${line_offset}`,
							project_path: candidate.cwd,
							timestamp: timestamp ?? candidate.timestamp,
							provider: message.provider,
							model: message.model,
							input_tokens: message.usage.input ?? 0,
							output_tokens: message.usage.output ?? 0,
							cache_read_tokens: message.usage.cacheRead ?? 0,
							cache_write_tokens: message.usage.cacheWrite ?? 0,
							total_tokens: message.usage.totalTokens ?? 0,
							cost_recorded: cost !== undefined,
							cost_input: cost?.input ?? 0,
							cost_output: cost?.output ?? 0,
							cost_cache_read: cost?.cacheRead ?? 0,
							cost_cache_write: cost?.cacheWrite ?? 0,
							cost_total: cost?.total ?? 0,
						})
					)
						usage++;
				}
				continue;
			}
			if (
				message.role === 'toolResult' &&
				typeof message.toolCallId === 'string'
			) {
				event_index++;
				const content_json = JSON.stringify(message.content ?? null);
				const details_json = JSON.stringify(message.details ?? null);
				const content_text = (message.content ?? [])
					.filter(
						(block) =>
							block.type === 'text' && typeof block.text === 'string',
					)
					.map((block) => String(block.text))
					.join('\n');
				if (
					db.upsert_tool_result({
						session_id: candidate.id,
						tool_call_id: message.toolCallId,
						tool_name: message.toolName ?? 'unknown',
						turn_index,
						event_index,
						timestamp,
						payload_json: JSON.stringify({
							content_text,
							content_json,
							details_json,
						}),
						is_error: message.isError ?? false,
						source_path: candidate.path,
						source_byte_offset: line_offset,
						seen_at,
					})
				)
					results++;
			}
		}
		db.upsert_session({
			id: candidate.id,
			project_path: candidate.cwd,
			first_timestamp: candidate.timestamp,
			last_timestamp,
			current_source_path: candidate.path,
			last_seen_at: seen_at,
		});
		db.upsert_source({
			session_id: candidate.id,
			current_path: candidate.path,
			source_mtime_ms: candidate.mtime_ms,
			source_size_bytes: candidate.size_bytes,
			processed_bytes: candidate.safe_size_bytes,
			processed_prefix_sha256: hash_prefix(
				candidate.path,
				candidate.safe_size_bytes,
			),
			last_seen_at: seen_at,
		});
	});
	return { calls, results, usage };
}

function read_header(path: string): NativeHeader | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(path, 'r');
		const buffer = Buffer.alloc(64 * 1024);
		const bytes = readSync(fd, buffer, 0, buffer.length, 0);
		const newline = buffer.subarray(0, bytes).indexOf(10);
		const text = buffer
			.subarray(0, newline >= 0 ? newline : bytes)
			.toString('utf8');
		const value = JSON.parse(text) as Record<string, unknown>;
		if (
			value.type !== 'session' ||
			typeof value.id !== 'string' ||
			typeof value.cwd !== 'string' ||
			typeof value.timestamp !== 'string'
		)
			return undefined;
		const timestamp = Date.parse(value.timestamp);
		if (!Number.isFinite(timestamp)) return undefined;
		return { id: value.id, cwd: value.cwd, timestamp };
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function parse_timestamp(value: unknown): number | undefined {
	if (typeof value !== 'string') return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function complete_bytes(path: string, size: number): number {
	if (size === 0) return 0;
	const fd = openSync(path, 'r');
	try {
		const buffer = Buffer.alloc(Math.min(64 * 1024, size));
		let end = size;
		while (end > 0) {
			const start = Math.max(0, end - buffer.length);
			const count = readSync(fd, buffer, 0, end - start, start);
			for (let index = count - 1; index >= 0; index--) {
				if (buffer[index] === 10) return start + index + 1;
			}
			end = start;
		}
		return 0;
	} finally {
		closeSync(fd);
	}
}

function hash_prefix(path: string, bytes: number): string {
	const hash = createHash('sha256');
	const fd = openSync(path, 'r');
	try {
		const buffer = Buffer.alloc(1024 * 1024);
		let offset = 0;
		while (offset < bytes) {
			const count = readSync(
				fd,
				buffer,
				0,
				Math.min(buffer.length, bytes - offset),
				offset,
			);
			if (count === 0) break;
			hash.update(buffer.subarray(0, count));
			offset += count;
		}
		return hash.digest('hex');
	} finally {
		closeSync(fd);
	}
}
