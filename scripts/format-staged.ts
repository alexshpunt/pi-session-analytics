/// <reference types="node" />

import type { Buffer } from 'node:buffer';
import {
	spawnSync,
	type SpawnSyncOptionsWithBufferEncoding,
} from 'node:child_process';
import {
	lstatSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { TextDecoder } from 'node:util';

const require = createRequire(import.meta.url);
const gitOptions = [
	'--no-optional-locks',
	'-c',
	'core.quotePath=true',
];
const maxBuffer = 64 * 1024 * 1024;

function run(
	command: string,
	args: string[],
	options?: SpawnSyncOptionsWithBufferEncoding,
) {
	const result = spawnSync(command, args, { maxBuffer, ...options });
	if (result.error) throw result.error;
	return result;
}

function checked(
	command: string,
	args: string[],
	options?: SpawnSyncOptionsWithBufferEncoding,
) {
	const result = run(command, args, options);
	if (result.status !== 0) {
		const detail =
			options?.stdio === 'inherit'
				? ''
				: `\n${result.stderr.toString().trimEnd()}`;
		throw new Error(
			`${command} failed (${String(result.signal ?? result.status)})${detail}`,
		);
	}
	return result.stdout;
}

function git(
	args: string[],
	options?: SpawnSyncOptionsWithBufferEncoding,
) {
	return checked('git', [...gitOptions, ...args], options);
}

function records(output: Buffer) {
	return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
		.decode(output)
		.split('\0')
		.slice(0, -1);
}

function stagedFiles() {
	// Treat renames as additions plus deletions; only format the new regular file.
	const entries = records(
		git([
			'diff',
			'--cached',
			'--raw',
			'-z',
			'--no-renames',
			'--diff-filter=AMT',
			'--',
		]),
	);
	return entries.filter(
		(_, i) =>
			i % 2 === 1 && /^:\d+ 100[67]\d\d /.test(entries[i - 1] ?? ''),
	);
}

function formattingContext() {
	return records(
		git([
			'ls-files',
			'--stage',
			'-z',
			'--',
			'vite.config.ts',
			'package.json',
			'**/.gitignore',
			'.gitignore',
			'**/.prettierignore',
			'.prettierignore',
		]),
	).flatMap((entry) => {
		const tab = entry.indexOf('\t');
		return /^100[67]\d\d [0-9a-f]+ 0$/.test(entry.slice(0, tab))
			? [entry.slice(tab + 1)]
			: [];
	});
}

const applyArgs = [
	'-c',
	'apply.ignoreWhitespace=no',
	'apply',
	'--whitespace=nowarn',
];

function workingCopyMatches(file: string, stagedCopy: string) {
	return (
		lstatSync(file, { throwIfNoEntry: false })?.isFile() &&
		readFileSync(file).equals(readFileSync(stagedCopy))
	);
}

function snapshotPatch(scratch: string, index: string) {
	// Ignore absent paths: they were not part of the staged snapshot.
	return git(
		[
			`--work-tree=${scratch}`,
			'-c',
			'core.filemode=false',
			'diff',
			'--diff-filter=M',
			'--binary',
			'--full-index',
			'--no-renames',
			'--no-ext-diff',
			'--no-textconv',
			'--no-color',
			'--no-relative',
			'--src-prefix=a/',
			'--dst-prefix=b/',
			'--',
		],
		{ env: { ...process.env, GIT_INDEX_FILE: index } },
	);
}

function main() {
	const files = new Set(stagedFiles());
	if (files.size === 0) return;

	let formatter;
	try {
		formatter = path.join(
			path.dirname(require.resolve('vite-plus/package.json')),
			'bin/vp',
		);
	} catch (error) {
		throw new Error(
			'Vite+ is not installed. Run pnpm install in this checkout.',
			{ cause: error },
		);
	}
	const context = formattingContext();
	const scratch = mkdtempSync(path.join(tmpdir(), 'format-staged-'));
	try {
		const snapshot = [...new Set([...files, ...context])];
		git(['checkout-index', `--prefix=${scratch}/`, '--stdin', '-z'], {
			input: `${snapshot.join('\0')}\0`,
		});
		// Do not try to merge formatting into files with unstaged edits.
		const dirty = [...files].filter(
			(file) => !workingCopyMatches(file, path.join(scratch, file)),
		);

		// Resolve the staged Vite config against this checkout's installed dependencies.
		symlinkSync(
			path.resolve('node_modules'),
			path.join(scratch, 'node_modules'),
			'junction',
		);
		checked(
			process.execPath,
			[formatter, 'fmt', '--no-error-on-unmatched-pattern', '.'],
			{
				cwd: scratch,
				stdio: 'inherit',
			},
		);

		// Config and ignore files that weren't staged provided context only.
		for (const file of context) {
			if (!files.has(file)) rmSync(path.join(scratch, file));
		}
		// Git changes its working directory for --work-tree. Commit hooks can
		// receive a relative path to a temporary index (for example, git commit -a).
		const index = git([
			'rev-parse',
			'--path-format=absolute',
			'--git-path',
			'index',
		])
			.toString()
			.slice(0, -1);
		const patch = snapshotPatch(scratch, index);
		if (patch.length === 0) return;

		for (const file of dirty) rmSync(path.join(scratch, file));
		const worktreePatch = dirty.length
			? snapshotPatch(scratch, index)
			: patch;

		git([...applyArgs, '--cached', '-'], { input: patch });
		if (worktreePatch.length) {
			const result = run('git', [...applyArgs, '-'], {
				input: worktreePatch,
			});
			if (result.status !== 0) {
				console.warn(
					`Formatting staged; working files left unchanged:\n${result.stderr.toString().trimEnd()}`,
				);
			}
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

try {
	main();
} catch (error) {
	console.error(
		`Could not format staged files: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exitCode = 1;
}
