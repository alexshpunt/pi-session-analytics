---
name: session-friction-insights
description:
  Extracts actionable failure and friction insights from a local
  pi-session-analytics database. Use whenever the user asks which Pi
  tools fail, why search returned nothing, why read was unhelpful,
  what stale anchors occur, how agents recover, or what tool behavior
  should be improved. Focus on non-happy paths and exact archive
  provenance.
compatibility:
  Requires Python 3 and a verified pi-session-analytics SQLite
  database.
---

# Session friction insights

Turn accumulated Pi sessions into a short list of things worth fixing.
The sessions and database are inputs; the insight is the result.

## Safety and privacy

- Keep generated reports under `.agents/insights/`; this repository
  ignores that private content.
- Do not publish raw arguments, session text, paths, or generated
  reports unless the user explicitly asks.
- Do not delete native sessions, the database, or the archive as part
  of analysis. Deletion is a separate user decision after the insight
  is reviewed.
- Treat `is_error = 1` as a recorded failure. Label empty results and
  other semantic judgements as inferred friction.

## Before analysis

Use the repository CLI and verify the database first:

```bash
pnpm run build
node dist/index.js verify --deep --json
```

If the database does not exist, sync it before verification:

```bash
node dist/index.js sync --json
```

A changing live corpus may need one final sync before verification.
Never hide a failed verification.

## Extract the focused report

Resolve this skill directory, then run:

```bash
python3 <skill-dir>/scripts/analyze.py \
  --db "$HOME/.pi/pi-session-analytics.db" \
  --archive "$HOME/.pi/pi-session-analytics/archive" \
  --output .agents/insights/session-friction.md \
  --json-output .agents/insights/session-friction.json
```

Use `--format json` for machine-readable output. Running the same
command twice against an unchanged database must produce identical
bytes.

The analyzer intentionally includes only:

- recorded search/read failures;
- inferred empty search and empty read outcomes;
- recorded stale-anchor failures from edit tools;
- search/read/edit calls with no recorded result;
- the inferred recovery observed before the next user message.

## Turn clusters into insights

Read the highest-frequency clusters and representative examples. For
each proposed improvement, state:

1. **Evidence** — recorded or inferred category, count, tools, and
   exact provenance.
2. **Friction** — what useful work failed to happen.
3. **Recovery** — same-tool retry, alternate-tool recovery, or
   unresolved; always call this inferred.
4. **Improvement lever** — tool contract, error message, agent
   strategy, or documentation.
5. **Confidence** — high only when the evidence and recovery pattern
   support the claim.

Do not report a large count alone as an insight. Empty search can mean
a correct negative answer, and truncation can be useful. Prefer
patterns with repeated avoidable retries, unresolved outcomes, or a
clear contract mismatch.

## Expected answer

Lead with 3–7 actionable findings, strongest first. Keep aggregate
counts separate from examples. Link each example to its record ID,
generation, byte offset, and byte length. End with the next small
experiment that could prove whether the top proposed improvement
works.
