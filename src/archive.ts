import { createHash, randomUUID } from 'node:crypto';
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type {
	ArchiveGenerationChunkRecord,
	ArchiveGenerationRecord,
	Database,
} from './db.ts';

const CHUNK_SIZE = 4 * 1024 * 1024;

/** Default owner-only content archive used by the CLI. */
export const DEFAULT_ARCHIVE_DIR = join(
	process.env.HOME!,
	'.pi',
	'pi-session-analytics',
	'archive',
);

/** Changes made while observing one session source. */
export interface ArchiveObservation {
	generation_added: boolean;
	chunks_added: number;
	bytes_added: number;
}

/** Stores and restores immutable byte generations of Pi session sources. */
export class SessionArchive {
	private readonly chunks_dir: string;

	constructor(
		private readonly db: Database,
		private readonly archive_dir = DEFAULT_ARCHIVE_DIR,
	) {
		this.chunks_dir = join(archive_dir, 'chunks');
		secure_directory(archive_dir);
		secure_directory(this.chunks_dir);
	}

	/** Archive the current source bytes unless this exact observation is unchanged. */
	archive_source(
		file_path: string,
		session_id: string,
		seen_at: number,
	): ArchiveObservation {
		const file_stats = statSync(file_path);
		const existing = this.db.get_archive_source(file_path);
		this.db.upsert_archive_source_seen({
			source_path: file_path,
			session_id,
			mtime_ms: file_stats.mtimeMs,
			size_bytes: file_stats.size,
			seen_at,
		});

		if (
			existing?.current_generation_id &&
			existing.source_mtime_ms === file_stats.mtimeMs &&
			existing.source_size_bytes === file_stats.size
		) {
			return {
				generation_added: false,
				chunks_added: 0,
				bytes_added: 0,
			};
		}

		const previous = existing?.current_generation_id
			? this.db.get_archive_generation(existing.current_generation_id)
			: undefined;
		const prefix_matches = previous
			? this.source_starts_with_generation(file_path, previous)
			: false;
		if (
			previous &&
			prefix_matches &&
			previous.size_bytes === file_stats.size
		) {
			return {
				generation_added: false,
				chunks_added: 0,
				bytes_added: 0,
			};
		}

		const kind: ArchiveGenerationRecord['kind'] = !previous
			? 'base'
			: prefix_matches
				? 'append'
				: 'rewrite';
		const start_offset = kind === 'append' ? previous!.size_bytes : 0;
		const stored = this.store_segment(
			file_path,
			start_offset,
			file_stats.size,
			seen_at,
		);
		const content_sha256 =
			start_offset === 0
				? stored.segment_sha256
				: this.hash_chunks([
						...this.content_chunks(previous!),
						...stored.chunks.map((chunk) => ({
							chunk_hash: chunk.hash,
							size_bytes: chunk.size_bytes,
						})),
					]);
		if (hash_file(file_path, file_stats.size) !== content_sha256) {
			throw new Error(
				`Session source changed while archiving: ${file_path}`,
			);
		}
		const generation_id = this.db.insert_archive_generation({
			source_path: file_path,
			session_id,
			generation_number: (previous?.generation_number ?? 0) + 1,
			kind,
			previous_generation_id: previous?.id,
			content_parent_generation_id:
				kind === 'append' ? previous?.id : undefined,
			size_bytes: file_stats.size,
			content_sha256,
			source_mtime_ms: file_stats.mtimeMs,
			observed_at: seen_at,
		});
		for (const [ordinal, chunk] of stored.chunks.entries()) {
			this.db.insert_archive_generation_chunk({
				generation_id,
				ordinal,
				chunk_hash: chunk.hash,
				source_offset: chunk.source_offset,
				size_bytes: chunk.size_bytes,
			});
		}
		this.db.set_archive_current_generation(file_path, generation_id);
		return {
			generation_added: true,
			chunks_added: stored.chunks_added,
			bytes_added: file_stats.size - start_offset,
		};
	}

	/** Read only the bytes introduced by one generation in source order. */
	read_generation_segment(
		generation_id: number,
		on_chunk: (bytes: Buffer, source_offset: number) => void,
	): void {
		this.required_generation(generation_id);
		for (const chunk of this.db.get_archive_generation_chunks(
			generation_id,
		)) {
			const bytes = readFileSync(this.chunk_path(chunk.chunk_hash));
			if (
				bytes.length !== chunk.size_bytes ||
				createHash('sha256').update(bytes).digest('hex') !==
					chunk.chunk_hash
			) {
				throw new Error(
					`Archived chunk ${chunk.chunk_hash} failed verification`,
				);
			}
			on_chunk(bytes, chunk.source_offset);
		}
	}

	/** Verify one content-addressed chunk against its recorded size and hash. */
	verify_chunk(hash: string, size_bytes: number): void {
		const path = this.chunk_path(hash);
		if (
			!existsSync(path) ||
			statSync(path).size !== size_bytes ||
			hash_file(path, size_bytes) !== hash
		) {
			throw new Error(`Archived chunk ${hash} failed verification`);
		}
	}

	/** Verify the complete reconstructed bytes of one immutable generation. */
	verify_generation(generation_id: number): void {
		const generation = this.required_generation(generation_id);
		const hash = createHash('sha256');
		let size_bytes = 0;
		for (const chunk of this.content_chunks(generation)) {
			const bytes = readFileSync(this.chunk_path(chunk.chunk_hash));
			if (
				bytes.length !== chunk.size_bytes ||
				createHash('sha256').update(bytes).digest('hex') !==
					chunk.chunk_hash
			) {
				throw new Error(
					`Archived chunk ${chunk.chunk_hash} failed verification`,
				);
			}
			hash.update(bytes);
			size_bytes += bytes.length;
		}
		if (
			size_bytes !== generation.size_bytes ||
			hash.digest('hex') !== generation.content_sha256
		) {
			throw new Error(
				`Archived generation ${generation_id} failed verification`,
			);
		}
	}

	/** Verify a present source still matches its current archived generation. */
	verify_source(file_path: string, generation_id: number): void {
		const generation = this.required_generation(generation_id);
		if (
			!existsSync(file_path) ||
			statSync(file_path).size !== generation.size_bytes ||
			hash_file(file_path, generation.size_bytes) !==
				generation.content_sha256
		) {
			throw new Error(
				`Session source does not match generation ${generation_id}: ${file_path}`,
			);
		}
	}

	/** Restore one committed archive generation exactly to a destination file. */
	restore_generation(
		generation_id: number,
		destination: string,
	): void {
		const generation = this.required_generation(generation_id);
		mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
		const fd = openSync(destination, 'w', 0o600);
		const hash = createHash('sha256');
		let bytes_written = 0;
		try {
			for (const chunk of this.content_chunks(generation)) {
				const bytes = readFileSync(this.chunk_path(chunk.chunk_hash));
				if (bytes.length !== chunk.size_bytes) {
					throw new Error(
						`Archived chunk ${chunk.chunk_hash} has the wrong size`,
					);
				}
				write_all(fd, bytes);
				hash.update(bytes);
				bytes_written += bytes.length;
			}
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		chmodSync(destination, 0o600);
		if (
			bytes_written !== generation.size_bytes ||
			hash.digest('hex') !== generation.content_sha256
		) {
			unlinkSync(destination);
			throw new Error(
				`Archived generation ${generation_id} failed verification`,
			);
		}
	}

	private source_starts_with_generation(
		file_path: string,
		generation: ArchiveGenerationRecord,
	): boolean {
		const file_stats = statSync(file_path);
		if (file_stats.size < generation.size_bytes) return false;
		const fd = openSync(file_path, 'r');
		try {
			let compared = 0;
			for (const chunk of this.content_chunks(generation)) {
				const archived = readFileSync(
					this.chunk_path(chunk.chunk_hash),
				);
				const current = Buffer.allocUnsafe(archived.length);
				const bytes_read = readSync(
					fd,
					current,
					0,
					current.length,
					chunk.source_offset,
				);
				if (
					bytes_read !== archived.length ||
					!current.equals(archived)
				) {
					return false;
				}
				compared += archived.length;
			}
			return compared === generation.size_bytes;
		} finally {
			closeSync(fd);
		}
	}

	private content_chunks(
		generation: ArchiveGenerationRecord,
	): ArchiveGenerationChunkRecord[] {
		const generations: ArchiveGenerationRecord[] = [];
		let current: ArchiveGenerationRecord | undefined = generation;
		while (current) {
			generations.unshift(current);
			current = current.content_parent_generation_id
				? this.db.get_archive_generation(
						current.content_parent_generation_id,
					)
				: undefined;
		}
		return generations.flatMap((item) =>
			this.db.get_archive_generation_chunks(item.id),
		);
	}

	private store_segment(
		file_path: string,
		start_offset: number,
		end_offset: number,
		created_at: number,
	) {
		const fd = openSync(file_path, 'r');
		const chunks: Array<{
			hash: string;
			source_offset: number;
			size_bytes: number;
		}> = [];
		const segment_hash = createHash('sha256');
		let chunks_added = 0;
		let source_offset = start_offset;
		try {
			while (source_offset < end_offset) {
				const buffer = Buffer.allocUnsafe(
					Math.min(CHUNK_SIZE, end_offset - source_offset),
				);
				const bytes_read = readSync(
					fd,
					buffer,
					0,
					buffer.length,
					source_offset,
				);
				if (bytes_read === 0) {
					throw new Error(
						`Session source changed while archiving: ${file_path}`,
					);
				}
				const bytes = buffer.subarray(0, bytes_read);
				segment_hash.update(bytes);
				const hash = createHash('sha256').update(bytes).digest('hex');
				this.write_chunk(hash, bytes);
				if (
					this.db.insert_archive_chunk(hash, bytes.length, created_at)
				) {
					chunks_added++;
				}
				chunks.push({
					hash,
					source_offset,
					size_bytes: bytes.length,
				});
				source_offset += bytes.length;
			}
		} finally {
			closeSync(fd);
		}
		return {
			chunks,
			chunks_added,
			segment_sha256: segment_hash.digest('hex'),
		};
	}

	private hash_chunks(
		chunks: Array<{ chunk_hash: string; size_bytes: number }>,
	): string {
		const hash = createHash('sha256');
		for (const chunk of chunks) {
			const bytes = readFileSync(this.chunk_path(chunk.chunk_hash));
			if (bytes.length !== chunk.size_bytes) {
				throw new Error(
					`Archived chunk ${chunk.chunk_hash} has the wrong size`,
				);
			}
			hash.update(bytes);
		}
		return hash.digest('hex');
	}

	private write_chunk(hash: string, bytes: Buffer): void {
		const destination = this.chunk_path(hash);
		if (
			existsSync(destination) &&
			statSync(destination).size === bytes.length &&
			hash_file(destination, bytes.length) === hash
		) {
			chmodSync(destination, 0o600);
			return;
		}
		secure_directory(dirname(destination));
		const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
		const fd = openSync(temporary, 'wx', 0o600);
		try {
			write_all(fd, bytes);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temporary, destination);
		chmodSync(destination, 0o600);
	}

	private chunk_path(hash: string): string {
		return join(this.chunks_dir, hash.slice(0, 2), hash);
	}

	private required_generation(id: number): ArchiveGenerationRecord {
		const generation = this.db.get_archive_generation(id);
		if (!generation)
			throw new Error(`Archive generation ${id} was not found`);
		return generation;
	}
}

function secure_directory(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	chmodSync(path, 0o700);
}

function write_all(fd: number, bytes: Buffer): void {
	let offset = 0;
	while (offset < bytes.length) {
		offset += writeSync(fd, bytes, offset, bytes.length - offset);
	}
}

function hash_file(path: string, size_bytes: number): string {
	const fd = openSync(path, 'r');
	const hash = createHash('sha256');
	let offset = 0;
	try {
		while (offset < size_bytes) {
			const buffer = Buffer.allocUnsafe(
				Math.min(CHUNK_SIZE, size_bytes - offset),
			);
			const bytes_read = readSync(
				fd,
				buffer,
				0,
				buffer.length,
				offset,
			);
			if (bytes_read === 0) {
				throw new Error(
					`Session source changed while hashing: ${path}`,
				);
			}
			hash.update(buffer.subarray(0, bytes_read));
			offset += bytes_read;
		}
	} finally {
		closeSync(fd);
	}
	return hash.digest('hex');
}
