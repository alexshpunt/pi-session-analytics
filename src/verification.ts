import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { SessionArchive } from './archive.ts';
import type { Database, VerificationSnapshot } from './db.ts';

/** One independently evaluated archive or database invariant. */
export interface VerificationCheck {
	name: string;
	passed: boolean;
	checked: number;
	failures: string[];
}

/** Stable result of local archive and database verification. */
export interface VerificationResult {
	schema_version: 1;
	kind: 'pi-session-analytics/verification';
	passed: boolean;
	deep: boolean;
	elapsed_ms: number;
	counts: VerificationSnapshot;
	checks: VerificationCheck[];
}

/** Controls for potentially long deep archive verification. */
export interface VerificationOptions {
	deep?: boolean;
	on_progress?: (message: string) => void;
}

/** Verify database invariants and, in deep mode, every archived byte. */
export async function verify_archive(
	db: Database,
	archive_dir: string,
	options: VerificationOptions = {},
): Promise<VerificationResult> {
	const started_at = Date.now();
	const deep = options.deep === true;
	const snapshot = db.get_verification_snapshot();
	const checks: VerificationCheck[] = [
		value_check(
			'sqlite-integrity',
			snapshot.integrity_messages.length,
			snapshot.integrity_messages.every(
				(message) => message === 'ok',
			),
			snapshot.integrity_messages.filter(
				(message) => message !== 'ok',
			),
		),
		zero_check('foreign-keys', snapshot.foreign_key_violations),
		value_check(
			'foreign-key-enforcement',
			1,
			snapshot.foreign_keys_enabled === 1,
			snapshot.foreign_keys_enabled === 1
				? []
				: ['SQLite foreign-key enforcement is disabled'],
		),
		zero_check(
			'current-generation-links',
			snapshot.current_generation_mismatches,
		),
		zero_check(
			'unindexed-generations',
			snapshot.unindexed_generations,
		),
		zero_check(
			'record-index-counts',
			snapshot.record_index_mismatches,
		),
		zero_check(
			'canonical-record-provenance',
			snapshot.canonical_provenance_mismatches,
		),
		value_check(
			'full-text-index-count',
			snapshot.session_records,
			snapshot.fts_records === snapshot.session_records,
			snapshot.fts_records === snapshot.session_records
				? []
				: [
						`session_records=${snapshot.session_records}, session_records_fts=${snapshot.fts_records}`,
					],
		),
		value_check(
			'effective-report-provenance',
			snapshot.effective_tool_calls +
				snapshot.effective_tool_results +
				snapshot.effective_usage_records,
			snapshot.report_provenance_mismatches === 0,
			snapshot.report_provenance_mismatches === 0
				? []
				: [
						`${snapshot.report_provenance_mismatches} provenance mismatch(es)`,
					],
		),
	];

	if (deep) {
		const archive = new SessionArchive(db, archive_dir);
		const chunks = db.list_archive_chunks();
		const generations = db.list_all_archive_generations();
		const sources = db
			.list_archive_sources()
			.filter((source) => source.source_exists === 1);
		checks.push(
			run_item_check('archive-chunks', chunks, (chunk) => {
				archive.verify_chunk(chunk.hash, chunk.size_bytes);
			}),
		);
		options.on_progress?.(`Verified ${chunks.length} archive chunks`);
		checks.push(
			run_item_check(
				'archive-generations',
				generations,
				(generation) => {
					archive.verify_generation(generation.id);
				},
			),
		);
		options.on_progress?.(
			`Verified ${generations.length} archive generations`,
		);
		checks.push(
			run_item_check('present-sources', sources, (source) => {
				if (source.current_generation_id === null)
					throw new Error(
						`Source has no current generation: ${source.source_path}`,
					);
				archive.verify_source(
					source.source_path,
					source.current_generation_id,
				);
			}),
		);
		options.on_progress?.(
			`Verified ${sources.length} present sources`,
		);
		checks.push(
			check_archive_file_set(
				archive_dir,
				chunks.map((chunk) => chunk.hash),
			),
		);
	}

	return {
		schema_version: 1,
		kind: 'pi-session-analytics/verification',
		passed: checks.every((check) => check.passed),
		deep,
		elapsed_ms: Date.now() - started_at,
		counts: snapshot,
		checks,
	};
}

function zero_check(
	name: string,
	failures: number,
): VerificationCheck {
	return value_check(
		name,
		failures,
		failures === 0,
		failures === 0 ? [] : [`${failures} violation(s)`],
	);
}

function value_check(
	name: string,
	checked: number,
	passed: boolean,
	failures: string[],
): VerificationCheck {
	return { name, passed, checked, failures };
}

function run_item_check<T>(
	name: string,
	items: T[],
	verify: (item: T) => void,
): VerificationCheck {
	let failed = 0;
	const failures: string[] = [];
	for (const item of items) {
		try {
			verify(item);
		} catch (error) {
			failed++;
			if (failures.length < 20)
				failures.push(
					error instanceof Error ? error.message : String(error),
				);
		}
	}
	if (failed > failures.length)
		failures.push(
			`${failed - failures.length} additional failure(s)`,
		);
	return {
		name,
		passed: failed === 0,
		checked: items.length,
		failures,
	};
}

function check_archive_file_set(
	archive_dir: string,
	database_hashes: string[],
): VerificationCheck {
	const chunks_dir = join(archive_dir, 'chunks');
	const actual = new Set<string>();
	if (existsSync(chunks_dir)) {
		for (const prefix of readdirSync(chunks_dir)) {
			const prefix_dir = join(chunks_dir, prefix);
			if (!statSync(prefix_dir).isDirectory()) continue;
			for (const name of readdirSync(prefix_dir)) {
				if (statSync(join(prefix_dir, name)).isFile())
					actual.add(name);
			}
		}
	}
	const expected = new Set(database_hashes);
	const failures = [
		...[...expected]
			.filter((hash) => !actual.has(hash))
			.map((hash) => `Missing chunk file: ${hash}`),
		...[...actual]
			.filter((hash) => !expected.has(hash))
			.map((hash) => `Untracked chunk file: ${hash}`),
	];
	return {
		name: 'archive-file-set',
		passed: failures.length === 0,
		checked: actual.size,
		failures: failures.slice(0, 20),
	};
}
