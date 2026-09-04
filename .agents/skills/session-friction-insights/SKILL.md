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
