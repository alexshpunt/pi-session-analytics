# Pi Session Analytics

[![built with vite+](https://img.shields.io/badge/built%20with-Vite+-646CFF?logo=vite&logoColor=white)](https://viteplus.dev)
[![tested with vitest](https://img.shields.io/badge/tested%20with-Vitest-6E9F18?logo=vitest&logoColor=white)](https://vitest.dev)

Compact, offline analytics for the tools used in [Pi](https://pi.dev)
sessions.

Pi Session Analytics stores ordered tool calls and results. It keeps
complete tool payloads with lossless compression, but does not copy
prompts, assistant replies, system messages, or reasoning. Model usage
and recorded cost stay at assistant-turn level. The program never
invents per-tool cost.

This project is a fork of
[pirecall](https://github.com/spences10/pirecall) by Scott Spence. It
keeps the original MIT license and copyright notice.

## Install

```bash
pi install npm:pi-session-analytics
```

This installs the CLI and two Pi skills. Running the package through
`npx` works, but does not install the skills.

Node.js 22 or newer is required.

## Start a new database

```bash
pi-session-analytics sync --json
pi-session-analytics verify --deep --json
pi-session-analytics stats --json
```

The default database is `~/.pi/pi-session-analytics.db`. Sync reads
native Pi sessions from `~/.pi/agent/sessions`.

Sync identifies a logical session by its native session ID, not its
path. Moving or copying a session does not duplicate its tool events.
An unchanged session is skipped. An appended session is read from its
last committed byte. Each session is committed separately, so a later
run can continue after interruption.

Use `--database <path>` or `-d <path>` with database commands. Use
`sync --sessions <path>` for another native session root.

## Move from the old archive database

Migration creates a separate candidate. It does not change the old
database or read native JSONL files.

```bash
pi-session-analytics migrate \
  --from ~/.pi/pi-session-analytics.db \
  --to ~/.pi/pi-session-analytics.compact.db \
  --json

pi-session-analytics verify \
  --database ~/.pi/pi-session-analytics.compact.db \
  --legacy ~/.pi/pi-session-analytics.db \
  --deep \
  --json
```

The deep comparison checks every effective legacy call and result
against the losslessly decoded candidate. Keep the old database and
archive until this passes, then run a native sync against the
candidate and repeat it to confirm that the second run adds no events.

## Periodic sync

Install a persistent systemd user timer:

```bash
pi-session-analytics schedule install --interval 1h
pi-session-analytics schedule status
```

The service is a `Type=oneshot` unit, so systemd does not overlap two
scheduled runs of the same service. The CLI also uses a database lock
to reject overlapping manual and scheduled syncs.

Remove the timer with:

```bash
pi-session-analytics schedule remove
```

## Reports

```bash
pi-session-analytics tools summary --json
pi-session-analytics tools failures --json
pi-session-analytics tools arguments --json
pi-session-analytics recoveries --json
pi-session-analytics usage --group-by model --json
pi-session-analytics usage --group-by project --json
```

`tools failures` includes recorded error results and calls with no
recorded result. It reports an incomplete call as `incomplete`, never
as a recorded hard error.

`recoveries` labels every conclusion as inferred. It checks the next
tool call in the same user turn and reports a same-tool retry, an
alternate tool, or unresolved. It does not claim intent, causation, or
active duration.

Argument reports store keys and value types, not values. Usage reports
sum only values recorded by Pi and keep priced and unpriced turns
distinct.

Reports accept `--tool`, `--provider`, `--model`, `--project`, and
`--limit` where they apply.

## SQL and payload access

```bash
pi-session-analytics schema --json
pi-session-analytics query \
  "SELECT tool_name, COUNT(*) AS calls FROM tool_calls GROUP BY tool_name ORDER BY calls DESC" \
  --json
```

`query` opens SQLite in read-only and query-only mode. It accepts
`SELECT`, `WITH`, and `PRAGMA` statements.

Tool arguments and results are compressed SQLite BLOBs. Use the public
API when you need their exact decoded value:

```ts
import { ToolDatabase } from 'pi-session-analytics';

const db = new ToolDatabase('/home/me/.pi/pi-session-analytics.db', {
	read_only: true,
});

const argumentsJson = db.read_call_arguments(
	'session-id',
	'tool-call-id',
);
const resultJson = db.read_result_payload(
	'session-id',
	'tool-call-id',
);
db.close();
```

## Stored data

The compact schema has these primary tables:

- `sessions`: logical session and project identity
- `session_sources`: current path and incremental checkpoint
- `tool_calls`: ordered calls with compressed arguments
- `tool_results`: ordered results with full compressed content and
  details
- `usage_records`: recorded tokens and cost per assistant turn

There are no conversation, reasoning, raw-record, archive, or
full-text-search tables. Native Pi sessions remain the source of
truth.

## Commands

```text
sync        Incrementally import native Pi tool activity
migrate     Build a compact candidate from a legacy database
verify      Check integrity and lossless payload round trips
stats       Show row and payload sizes
tools       Show summary, failures, or argument shapes
recoveries  Show inferred same-turn recovery
usage       Group recorded turn usage by day, model, or project
query       Run read-only SQL
schema      Show the public SQLite schema
schedule    Install, inspect, or remove periodic sync
```

All structured output uses a versioned JSON envelope when `--json` is
set.

## License

MIT
