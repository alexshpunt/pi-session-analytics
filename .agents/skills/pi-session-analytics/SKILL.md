---
name: pi-session-analytics
description:
  Operate Pi Session Analytics end to end. Use this skill whenever the
  user asks to find or recall past Pi work, inspect session history,
  compare recorded token use or cost, investigate tool calls or
  failures, infer recovery, list resumable sessions, sync or verify
  the session archive, query the analytics SQLite database, or decide
  what session-analysis data can be removed. Use it even when the user
  describes the question without naming pi-session-analytics.
compatibility:
  Requires Node.js 22+ and either this repository or an installed
  pi-session-analytics CLI.
---

# Pi Session Analytics

Use Pi Session Analytics to answer questions from archived native Pi
sessions. Treat sessions, the SQLite database, and the
content-addressed archive as evidence sources. Give the user the
answer or insight, not a dump of commands and rows.

## Ground rules

- Prefer `--json` when an agent will interpret the result.
- Never alter native Pi JSONL sessions.
- `sync` reads native sessions, archives selected bytes, and updates
  SQLite. It does not delete source sessions.
- Use the database and archive as a pair. A custom database must use
  the archive that was populated with it.
- Treat `is_error = 1` as a recorded tool failure. A missing tool
  result is incomplete, not a failure.
- Always label recovery as inferred. The heuristic does not prove
  intent or causation.
- Report only tokens and prices recorded by Pi. Do not invent missing
  prices or call timestamp spans active work duration.
- Keep raw session content and generated private reports out of Git
  unless the user explicitly asks to publish them.
- Ask before `compact` without `--dry-run`, deleting sessions, or
  deleting the database, archive, or snapshots.

## Choose the executable

Inside this repository, build once after source changes and use the
local code:

```bash
pnpm build
node dist/index.js <command>
```

Outside the repository, use the installed package runner:

```bash
npx pi-session-analytics <command>
```

Set one shell variable when several commands follow, so every command
uses the same executable:

```bash
PSA="node dist/index.js" # repository
# PSA="npx pi-session-analytics" # installed package
```

Do not use `stats` to test whether a database exists because opening
the database may create it. Check the path first:

```bash
test -f "$HOME/.pi/pi-session-analytics.db"
```

The defaults are:

- sessions: `~/.pi/agent/sessions/`
- database: `~/.pi/pi-session-analytics.db`
- archive: `~/.pi/pi-session-analytics/archive/`

All commands accept `--db <path>` (or `-d <path>`). Commands that read
or write archived bytes also accept `--archive <path>`.

## Prepare trustworthy data

### Routine current answer

If the database is missing, or the user asks about the latest
sessions, sync before querying:

```bash
$PSA sync --json
$PSA verify --json
```

Sync is incremental and commits one source at a time. If it stops,
rerun the same command; committed sources are reused.

Do not sync just because a historical query returned no rows. First
check the query, filters, and database path.

### Fixed, reproducible corpus

Use a snapshot when the result must stay reproducible while live
sessions may still change. Put temporary material under
`.agents/tmp/`:

```bash
mkdir -p .agents/tmp/<task>/corpus
cp -a --reflink=auto "$HOME/.pi/agent/sessions/." .agents/tmp/<task>/corpus/
$PSA sync --json \
  --sessions .agents/tmp/<task>/corpus \
  --db .agents/tmp/<task>/sessions.db \
  --archive .agents/tmp/<task>/archive
$PSA verify --deep --json \
  --db .agents/tmp/<task>/sessions.db \
  --archive .agents/tmp/<task>/archive
```

Use independent copies, not hard links: a live append through a hard
link would change the supposed snapshot.

### Verification level

- Run `verify --json` for a routine database consistency check.
- Run `verify --deep --json` before making archive-byte or exact
  provenance claims, after a large import, or before deleting any
  source material.
- A deep check hashes every chunk, reconstructs generations, compares
  present sources, and checks the complete archive file set. It can
  take minutes on a large corpus.
- Stop and report the failed checks when `passed` is false. Do not
  continue as if the evidence were sound.

## Choose the command that answers the question

| User need                                    | Command                                         |
| -------------------------------------------- | ----------------------------------------------- |
| Overall counts                               | `stats --json`                                  |
| Recent archived sessions                     | `sessions --json --limit <n>`                   |
| Sessions that still exist and can be resumed | `resumable --scope project --cwd "$PWD" --json` |
| Find exact archived records                  | `search "<fts query>" --context 2 --json`       |
| Get compact message context for an answer    | `recall "<query>"`                              |
| Tool volume and recorded outcomes            | `tools summary --json`                          |
| Group recorded tool errors                   | `tools failures --json`                         |
| Inspect argument keys and value-free shapes  | `tools arguments --json`                        |
| Compare inferred post-failure recovery       | `recoveries --group tool --json`                |
| Compare recorded tokens and cost             | `usage --group model --json`                    |
| Inspect available tables and columns         | `schema --json` or `schema <table> --json`      |
| Ask a custom aggregate question              | `query "<read-only SQL>" --json --limit <n>`    |
| Check database and archive integrity         | `verify --deep --json`                          |
| Estimate database compaction                 | `compact --dry-run --json`                      |

### Search and recall

Use `search` when record type, archive generation, byte provenance,
date, sorting, or canonical context matters:

```bash
$PSA search '"database migration" OR schema' \
  --project "$PWD" --context 2 --sort time --limit 20 --json
```

FTS supports `AND`, `OR`, `NOT`, quoted phrases, and `prefix*`. Useful
filters are `--project`, `--session`, `--type`, and `--after`.

Use `recall` for a small LLM-oriented message window. It always
returns JSON but uses the legacy message view and does not provide the
full canonical provenance contract. Prefer `search` for auditable
evidence.

A zero-result search is a successful negative result, not a recorded
failure. Broaden a phrase or remove one filter at a time. Do not claim
that the subject never occurred unless the search scope and terms
justify that claim.

### Sessions and resumable sessions

`sessions` lists archived history, including sources that may no
longer exist. `resumable` returns only live source paths suitable for
a resume UI. Before switching a session, check that its returned
absolute JSONL path still exists.

### Tool reports

All tool reports support `--project`, `--session`, `--provider`,
`--model`, `--after`, and `--before`.

```bash
$PSA tools summary --top 20 --json
$PSA tools failures --project "$PWD" --top 20 --json
$PSA tools arguments --provider openai --model gpt-5.4 --json
```

Tool summaries separate calls, matched results, successes, recorded
failures, and incomplete calls. Argument reports expose keys and
value-free shapes; use failure reports when exact evidence and archive
provenance are needed.

### Recovery reports

```bash
$PSA recoveries --group tool --after 2026-09-01 --json
```

The report looks only until the next user message. It prefers the
first successful retry of the same tool, then the first successful
alternate tool, otherwise unresolved. Describe these as observed
sequence patterns or inferred recovery, never as proven cause, intent,
or time-to-recovery.

### Usage and cost

```bash
$PSA usage --group provider --json
$PSA usage --group project --after 2026-09-01 --before 2026-10-01 --json
$PSA usage --group model --details --json
```

State how many contributing messages were priced and unpriced. A
`null` cost means no contributing record had a price. `--details`
includes every contributing canonical record with archive provenance.

### Read-only SQL

Inspect the live schema before writing a non-trivial query:

```bash
$PSA schema --json
$PSA schema effective_session_records --json
$PSA query 'SELECT record_type, COUNT(*) AS count FROM effective_session_records GROUP BY record_type ORDER BY count DESC' --json --limit 100
```

`query` opens SQLite read-only and accepts only row-returning
statements. Prefer `effective_session_records` and canonical detail
tables for current analysis. Effective history adds append suffixes
but replaces superseded rewritten snapshots, so unchanged records are
not counted twice. Use raw `session_records` only when archived
generations themselves are the subject.

## Preserve provenance

For an evidence-backed claim, retain:

- canonical record ID;
- source path and session ID;
- archive generation ID;
- source byte offset and byte length;
- recorded versus inferred status.

`search`, tool failure reports, recovery reports, and detailed usage
reports expose the relevant provenance. Deep verification proves the
archive can reconstruct those bytes; it does not prove an inferred
interpretation.

Do not paste private raw arguments or session text into a public file.
Summarize the pattern and keep exact evidence in an ignored local
report.

## Analyze recurring friction

When the user asks why `search`, `read`, or edit tools fail, which
stale anchors recur, or how agents recover, also read
`../session-friction-insights/SKILL.md`. Run its analyzer only after
the selected database and archive pass verification. Its empty-result
and recovery categories are deliberately inferred.

## Compact or delete data

Start with a dry run:

```bash
$PSA compact --older-than 30 --dry-run --json
```

`compact` changes the SQLite database, so run it without `--dry-run`
only after the user approves that exact mutation. It does not replace
a retention decision about native sessions, snapshots, or the
immutable archive.

Before any deletion, show separate sizes for native sessions,
database, archive, snapshots, and saved reports. Let the user choose
exactly which layers to keep. Reports are not a backup unless they
contain everything the user wants to retain.

## Answer the user

Lead with the requested answer. Then state:

1. the corpus and freshness used;
2. which facts are recorded and which are inferred;
3. the smallest useful aggregate;
4. exact provenance for representative evidence when the claim needs
   auditability;
5. any missing prices, incomplete results, failed verification, or
   scope limits.

Do not make the user interpret a raw JSON payload unless they asked
for it.
