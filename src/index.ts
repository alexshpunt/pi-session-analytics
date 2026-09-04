#!/usr/bin/env node
/* eslint-disable no-process-env */
if (!process.stdout.isTTY) process.env.NO_COLOR = '1';

process.removeAllListeners('warning');
process.on('warning', (warning) => {
	if (warning.name !== 'ExperimentalWarning') console.warn(warning);
});

const { runMain } = await import('citty');
const { main } = await import('./cli.ts');
void runMain(main);
