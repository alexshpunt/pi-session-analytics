---
name: pi-session-analytics
description:
  Operate Pi Session Analytics end to end. Use this skill whenever the
  user asks about recorded Pi tool use, tool failures, incomplete
  calls, inferred recovery, model or project token use, compact
  database sync, migration, verification, periodic scheduling,
  read-only SQL, or safe removal of old session-analysis data.
compatibility:
  Requires Node.js 22+ and either this repository or an installed
  pi-session-analytics CLI.
---

# Pi Session Analytics

Use Pi Session Analytics for compact, offline analysis of Pi tool
activity. Give the user the answer or insight, not a command dump.

## Ground rules

- Prefer `--json` for agent-readable output.
- Never change native Pi JSONL sessions.
- The compact database stores tool calls, full compressed tool
  results, and assistant-turn usage. It does not store conversation or
  reasoning text.
- Treat `is_error = 1` as a recorded hard failure. A missing result is
  incomplete, not a recorded failure.
- Always label recovery as inferred. Sequence does not prove intent or
  causation.
- Use only tokens and prices recorded by Pi. Never assign
  assistant-turn cost to individual tool calls or turn timestamp gaps
  into active duration.
- Ask before deleting a database, old archive, snapshot, native
  session, or report.

## Choose the executable

Inside this repository:

```bash
pnpm build
PSA="node dist/index.js"
```

Outside it:

```bash
PSA="npx pi-session-analytics"
```

Defaults:

- native sessions: `~/.pi/agent/sessions/`
- compact database: `~/.pi/pi-session-analytics.db`

Use `--database <path>` (or `-d`) with database commands.

## Prepare trustworthy data

For a current answer, sync and run the normal check:

```bash
$PSA sync --json
$PSA verify --json
```

Sync selects only files with a valid native Pi session header. It
identifies a logical session by session ID, not absolute path. It
skips unchanged sources, reads safe appends from the last committed
byte, deduplicates moved or copied sessions, and commits one session
at a time.

Use deep verification after a large import, before an exact payload
claim, or before deleting old storage:

```bash
$PSA verify --deep --json
```

Deep verification decompresses and hashes every stored argument and
result. Stop if `pass` is false.

## Choose the report

| Need                                     | Command                          |
| ---------------------------------------- | -------------------------------- |
| Counts and storage size                  | `stats --json`                   |
| Tool volume and outcomes                 | `tools summary --json`           |
| Recorded errors and incomplete calls     | `tools failures --json`          |
| Argument keys and value-free shapes      | `tools arguments --json`         |
| Inferred same-turn recovery              | `recoveries --json`              |
| Recorded usage by day, model, or project | `usage --group-by model --json`  |
| Public tables and columns                | `schema --json`                  |
| Custom aggregate                         | `query "<read-only SQL>" --json` |
| Install recurring sync                   | `schedule install --interval 1h` |

Tool reports accept `--tool`, `--provider`, `--model`, `--project`,
and `--limit`.

### Failure and recovery

`tools failures` reports two different states:

- `hard_error`: Pi recorded `isError: true` on the result;
- `incomplete`: the call has no stored result.

Do not merge them into one failure count.

`recoveries` finds the next tool call in the same user turn. Its
values begin with `inferred_`: same tool, alternate tool, or
unresolved. Never describe these as a proven fix or time-to-recovery.

### Usage

```bash
$PSA usage --group-by day --json
$PSA usage --group-by model --json
$PSA usage --group-by project --json
```

Usage is stored per assistant message and is independent of tool rows.
State how many turns recorded a price. Do not estimate absent prices.

### SQL and exact payloads

Inspect `schema --json` before a non-trivial query. `query` accepts
`SELECT`, `WITH`, and `PRAGMA`, opens SQLite read-only, and sets
query-only mode.

Arguments and results are compressed BLOBs. Use the public API for an
exact value:

```ts
import { ToolDatabase } from 'pi-session-analytics';

const db = new ToolDatabase('/path/to/tools.db', { read_only: true });
const args = db.read_call_arguments('session-id', 'call-id');
const result = db.read_result_payload('session-id', 'call-id');
db.close();
```

Keep decoded private payloads out of Git unless the user explicitly
asks to publish them.

## Migrate an old archive database

Migration reads the old SQLite effective-record views and creates a
separate compact candidate. It does not parse native JSONL or change
the old database.

```bash
$PSA migrate --from <old.db> --to <candidate.db> --json
$PSA verify --database <candidate.db> --legacy <old.db> --deep --json
```

The deep comparison must match all sessions, effective calls,
effective results, usage records, and every decoded tool payload.
Then:

1. sync the candidate from the real native session root;
2. repeat sync and require `events_added: 0`;
3. deep-verify the caught-up candidate;
4. install and exercise the periodic timer;
5. only then ask for the exact destructive cutover or cleanup.

Never sync the old snapshot-based database directly from the native
session root. Its old source identity is path-based and can duplicate
data.

## Periodic sync

```bash
$PSA schedule install --interval 1h
$PSA schedule status
```

The generated systemd user service is `Type=oneshot`, and the CLI also
takes a per-database sync lock. Use `schedule remove` to remove it.

## Deletion boundaries

Before deletion, show separate sizes for:

- native sessions;
- compact candidate;
- old database;
- old archive;
- frozen snapshots;
- saved private reports.

A successful migration check permits a cutover; it is not permission
to delete. Ask the user to approve the exact paths. Native sessions
remain the source of truth and should normally stay.

## Recurring friction

For tool failure clusters, empty-result friction, stale anchors, and
inferred recovery patterns, also read
`../session-friction-insights/SKILL.md`. The analyzer must use a
verified compact database.

## Answer the user

Lead with the requested result. State the data freshness and scope,
keep recorded facts separate from inference, mention missing prices or
incomplete results, and include session/call/source coordinates for
representative evidence when useful.
