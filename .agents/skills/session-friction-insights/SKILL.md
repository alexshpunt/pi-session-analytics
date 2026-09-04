---
name: session-friction-insights
description:
  Extract actionable failure and friction insights from a compact
  local pi-session-analytics database. Use when the user asks which Pi
  tools fail, why search returned nothing, why read was unhelpful,
  what stale anchors occur, how agents recover, or what tool behavior
  should improve.
compatibility:
  Requires Python 3 and a verified compact pi-session-analytics SQLite
  database.
---

# Session friction insights

Turn recorded Pi tool activity into a short list of things worth
fixing. Focus on non-happy paths. Do not treat volume alone as an
insight.

## Safety and evidence

- Keep generated reports under `.agents/insights/`.
- Do not publish raw payloads, paths, or reports unless the user asks.
- Do not delete native sessions or stored analysis as part of this
  skill.
- `is_error = 1` is a recorded hard failure.
- Missing results, empty-result friction, and recovery are inferred.
- Cite the session ID, tool call ID, event index, source path, and
  source byte offset. The compact database does not claim
  archived-byte provenance.

## Prepare the database

```bash
pnpm build
node dist/index.js sync --json
node dist/index.js verify --deep --json
```

Stop if verification fails.

## Build the report

```bash
python3 <skill-dir>/scripts/analyze.py \
  --db "$HOME/.pi/pi-session-analytics.db" \
  --output .agents/insights/session-friction.md \
  --json-output .agents/insights/session-friction.json
```

Use `--format json` for stdout JSON. The same database and options
must produce the same report bytes.

The analyzer includes:

- recorded search and read errors;
- inferred empty search and read results;
- recorded stale or invalid edit anchors;
- target tool calls without a result;
- inferred next-call recovery in the same user turn.

## Analyze recovery without counting parallel siblings

Recovery is only a sequence-based inference. Use the first tool call whose
`event_index` is greater than the failed call's `result_event_index`. Do not
prefer a later call merely because it uses the same tool, and do not count a
parallel sibling launched between the original call and its result as recovery.
For incomplete calls there is no result boundary, so any next-call inference is
weaker and must say so.

Separate these outcomes:

- immediate next call uses the same tool;
- immediate next call uses another tool;
- no later call exists in the same user turn.

Also record whether the next call succeeded, failed, or is incomplete. A later
success does not prove that it fixed the original problem.

## Analyze search friction

For `search`, report schema errors separately from `No matches found`. Empty
search is a correct negative result in many tasks. A stronger friction signal is
an immediate post-result retry that finds a match after changing only one of:
query, path, include, exclude, case sensitivity, whole-word mode, or protocol.

Useful comparisons include:

- literal or Boolean queries versus `regex:`, `files:`, `ast:`, and `lsp:`;
- path-like text sent to content search instead of `files:`;
- empty-result rates with and without include, exclude, and case-sensitive
  filters;
- argument payloads shaped like another tool, such as `command` for `bash` or
  `offset` for `read`.

Treat all rate differences as correlations. Project mix, model mix, tool
versions, and deliberate negative checks can explain them.

## Analyze edit tools

The edit family is `write`, `replace`, `insert`, `delete`, `copy`, `move`,
`undo`, `stage`, and `unstage`. State when a tool has no recorded calls or only
a tiny sample.

Classify recorded hard errors into operationally distinct groups:

- stale line or search anchors;
- exact text not found;
- ambiguous exact text;
- search anchor used on a resource it did not select;
- invalid anchor format or incompatible selection arguments;
- argument order or schema validation;
- no-op edits;
- missing or unreadable files;
- overlapping batched edits and sibling calls canceled after another failure;
- coordination blocks such as mesh reservations;
- undo/change-anchor failures.

Do not combine coordination blocks, canceled batch siblings, incomplete calls,
and editor correctness failures into one rate. For `undo`, distinguish the
special `last` token from `CHANGE#...` anchors. Historical failures may belong
to an older installed tool version, so reproduce a suspected current bug before
opening an implementation task.

## Look for higher-value tooling signals

Failure counts alone often produce weak insights. Prefer analyses that can test
whether a tool contract or error response changes later behavior:

- repeated identical reads or searches without an intervening mutation;
- specialized-tool failure followed immediately by a `bash` fallback;
- retries that reuse a candidate anchor from the error response;
- repeated failure after the tool already supplied a corrective hint;
- batch fan-out where one failure cancels otherwise valid sibling edits;
- result payloads large enough to create avoidable context pressure;
- failure rates by model and project only after controlling for tool and task
  mix.

The compact database has no conversation text or reliable task-success label.
It can show ordered behavior and recorded outcomes, but it cannot establish why
the agent acted, whether an empty result was desired, or whether the user's goal
was achieved.

## Turn clusters into findings

For each proposed change, state:

1. the recorded or inferred evidence and count;
2. what useful work did not happen;
3. the inferred recovery pattern;
4. the smallest tool, error-message, agent, or documentation change;
5. confidence and what evidence limits it.

Empty search can be a correct negative result. Prefer repeated
avoidable retries, unresolved outcomes, and clear contract mismatches.

Lead with three to seven findings. End with the smallest experiment
that could test the strongest proposed change.
