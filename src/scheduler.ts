import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_DB_PATH } from './tool-database.ts';
import { DEFAULT_SESSIONS_PATH } from './tool-sync.ts';

export const SERVICE_NAME = 'pi-session-analytics-sync.service';
export const TIMER_NAME = 'pi-session-analytics-sync.timer';

export interface ScheduleOptions {
	home?: string;
	node_path?: string;
	cli_path?: string;
	database_path?: string;
	sessions_path?: string;
	interval?: string;
	start?: boolean;
}

/** Install a non-overlapping systemd user timer for incremental sync. */
export function install_schedule(options: ScheduleOptions = {}): {
	service_path: string;
	timer_path: string;
} {
	const home = options.home ?? process.env.HOME ?? '';
	const directory = join(home, '.config', 'systemd', 'user');
	const service_path = join(directory, SERVICE_NAME);
	const timer_path = join(directory, TIMER_NAME);
	const node_path = options.node_path ?? process.execPath;
	const cli_path = options.cli_path ?? process.argv[1];
	const database_path = options.database_path ?? DEFAULT_DB_PATH;
	const sessions_path =
		options.sessions_path ?? DEFAULT_SESSIONS_PATH;
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		service_path,
		`[Unit]\nDescription=Incrementally sync Pi tool activity\n\n[Service]\nType=oneshot\nExecStart=${quote(node_path)} ${quote(cli_path)} sync --database ${quote(database_path)} --sessions ${quote(sessions_path)} --json\n`,
	);
	writeFileSync(
		timer_path,
		`[Unit]\nDescription=Periodically sync Pi tool activity\n\n[Timer]\nOnBootSec=5m\nOnUnitActiveSec=${options.interval ?? '1h'}\nPersistent=true\nUnit=${SERVICE_NAME}\n\n[Install]\nWantedBy=timers.target\n`,
	);
	if (options.start !== false) {
		systemctl(['daemon-reload']);
		systemctl(['enable', '--now', TIMER_NAME]);
	}
	return { service_path, timer_path };
}

/** Remove the periodic user timer and its unit files. */
export function remove_schedule(
	home = process.env.HOME ?? '',
	stop = true,
): void {
	if (stop) systemctl(['disable', '--now', TIMER_NAME], true);
	const directory = join(home, '.config', 'systemd', 'user');
	rmSync(join(directory, SERVICE_NAME), { force: true });
	rmSync(join(directory, TIMER_NAME), { force: true });
	if (stop) systemctl(['daemon-reload']);
}

/** Return systemd's recorded timer and service state. */
export function schedule_status(): string {
	return execFileSync(
		'systemctl',
		['--user', 'status', TIMER_NAME, SERVICE_NAME, '--no-pager'],
		{
			encoding: 'utf8',
		},
	);
}

function systemctl(args: string[], tolerate_failure = false): void {
	try {
		execFileSync('systemctl', ['--user', ...args], {
			stdio: 'inherit',
		});
	} catch (error) {
		if (!tolerate_failure) throw error;
	}
}

function quote(value: string): string {
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
