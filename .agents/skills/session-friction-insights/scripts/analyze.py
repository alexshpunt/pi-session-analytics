#!/usr/bin/env python3
"""Extract focused, reproducible Pi tool-friction evidence from SQLite."""

import argparse
import hashlib
import json
import re
import sqlite3
from collections import Counter, defaultdict
from pathlib import Path

TARGET_TOOLS = ("search", "read", "replace", "insert", "delete", "copy", "move")
EDIT_TOOLS = {"replace", "insert", "delete", "copy", "move"}
EMPTY_SEARCH_MARKERS = (
    "no matches found",
    "no results found",
    "no files found",
)
EMPTY_OUTPUT_MARKERS = {"", "(no output)", "(no tool output)", "no output"}


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--db", required=True, help="pi-session-analytics SQLite database"
    )
    parser.add_argument(
        "--archive", required=True, help="content-addressed archive root"
    )
    parser.add_argument("--output", help="write the report to this path")
    parser.add_argument("--json-output", help="also write the JSON report to this path")
    parser.add_argument("--format", choices=("markdown", "json"), default="markdown")
    parser.add_argument("--top", type=int, default=20, help="maximum clusters")
    parser.add_argument("--examples", type=int, default=3, help="examples per cluster")
    return parser.parse_args()


def connect(path):
    connection = sqlite3.connect(f"file:{Path(path).resolve()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def candidate_rows(connection):
    placeholders = ",".join("?" for _ in TARGET_TOOLS)
    sql = f"""
    WITH effective_results AS (
      SELECT results.record_id, results.source_path, results.session_id,
             results.tool_call_id, results.is_error,
             record.archive_generation_id, record.timestamp,
             record.source_byte_offset, record.source_byte_length,
             ROW_NUMBER() OVER (
               PARTITION BY results.source_path, results.session_id, results.tool_call_id
               ORDER BY record.timestamp, record.id
             ) AS result_number
      FROM record_tool_results results
      JOIN effective_session_records record ON record.id = results.record_id
    )
    SELECT calls.record_id AS call_record_id, calls.session_id, calls.source_path,
           calls.tool_call_id, calls.tool_name, calls.arguments_json,
           call_record.archive_generation_id AS call_generation_id,
           call_record.timestamp AS call_timestamp,
           call_record.source_byte_offset AS call_offset,
           call_record.source_byte_length AS call_length,
           results.record_id AS result_record_id,
           results.archive_generation_id AS result_generation_id,
           results.timestamp AS result_timestamp,
           results.source_byte_offset AS result_offset,
           results.source_byte_length AS result_length,
           results.is_error,
           COALESCE(result_payload.content_text, result_payload.content_json, '') AS content
    FROM record_tool_calls calls
    JOIN effective_session_records call_record ON call_record.id = calls.record_id
    LEFT JOIN effective_results results
      ON results.source_path = calls.source_path
     AND results.session_id = calls.session_id
     AND results.tool_call_id = calls.tool_call_id
     AND results.result_number = 1
    LEFT JOIN record_tool_results result_payload
      ON result_payload.record_id = results.record_id
    WHERE calls.tool_name IN ({placeholders})
      AND (
        results.record_id IS NULL
        OR (results.is_error = 1 AND (
          calls.tool_name IN ('search', 'read')
          OR lower(COALESCE(result_payload.content_text, result_payload.content_json, '')) LIKE '%stale%'
          OR lower(COALESCE(result_payload.content_text, result_payload.content_json, '')) LIKE '%anchor%'
        ))
        OR (results.is_error = 0 AND calls.tool_name = 'search' AND (
          trim(lower(COALESCE(result_payload.content_text, result_payload.content_json, ''))) IN ('', '(no output)', '(no tool output)', 'no output')
          OR trim(lower(COALESCE(result_payload.content_text, result_payload.content_json, ''))) LIKE 'no matches found%'
          OR trim(lower(COALESCE(result_payload.content_text, result_payload.content_json, ''))) LIKE 'no results found%'
          OR trim(lower(COALESCE(result_payload.content_text, result_payload.content_json, ''))) LIKE 'no files found%'
        ))
        OR (results.is_error = 0 AND calls.tool_name = 'read'
          AND trim(lower(COALESCE(result_payload.content_text, result_payload.content_json, ''))) IN ('', '(no output)', '(no tool output)', 'no output'))
      )
    ORDER BY calls.source_path, call_record.source_byte_offset, calls.record_id
    """
    return connection.execute(sql, TARGET_TOOLS)


def classify(row):
    tool = row["tool_name"]
    content = (row["content"] or "").strip()
    lower = content.lower()
    if row["result_record_id"] is None:
        return "incomplete-call", tool, "No recorded tool result"
    if row["is_error"] == 1:
        if tool in EDIT_TOOLS and ("stale" in lower or "anchor" in lower):
            if "stale" in lower:
                subtype = "stale"
            elif "ambiguous" in lower or "multiple" in lower or "not unique" in lower:
                subtype = "ambiguous"
            elif "not found" in lower or "was not found" in lower:
                subtype = "not-found"
            else:
                subtype = "other"
            return "anchor-error", subtype, content
        if tool == "search":
            return "search-error", error_subtype(lower), content
        if tool == "read":
            return "read-error", error_subtype(lower), content
        return None
    if tool == "search" and (
        lower in EMPTY_OUTPUT_MARKERS
        or any(lower.startswith(marker) for marker in EMPTY_SEARCH_MARKERS)
    ):
        subtype = next(
            (marker for marker in EMPTY_SEARCH_MARKERS if lower.startswith(marker)),
            "empty-output",
        )
        return "empty-search", subtype, content or "(empty output)"
    if tool == "read" and lower in EMPTY_OUTPUT_MARKERS:
        return "empty-read", "empty-output", content or "(empty output)"
    return None


def error_subtype(text):
    if any(
        token in text
        for token in ("enoent", "not found", "does not exist", "no such file")
    ):
        return "not-found"
    if any(token in text for token in ("permission", "eacces", "access denied")):
        return "access"
    if any(
        token in text for token in ("offset", "out of range", "out of bounds", "beyond")
    ):
        return "range"
    if any(token in text for token in ("binary", "encoding", "utf-8", "unsupported")):
        return "unsupported"
    if any(token in text for token in ("syntax", "parse", "unterminated", "fts")):
        return "query-syntax"
    if "timeout" in text or "timed out" in text:
        return "timeout"
    return "other"


def normalized_signature(text):
    value = re.sub(r"\s+", " ", text.strip())
    value = re.sub(r"(?:[A-Za-z]:)?/(?:[^\s:'\"]+/)+[^\s:'\"]*", "<path>", value)
    value = re.sub(r"\b(?:LINE|SEARCH|CHANGE)#[0-9A-Fa-f:.-]+\b", "<anchor>", value)
    value = re.sub(r"\b[0-9a-f]{16,}\b", "<id>", value, flags=re.IGNORECASE)
    value = re.sub(r"\b\d+\b", "<n>", value)
    return value[:300] or "(empty output)"


def timeline(connection):
    rows = connection.execute("""
      WITH effective_results AS (
        SELECT results.record_id, results.source_path, results.session_id,
               results.tool_call_id, results.is_error,
               record.archive_generation_id, record.timestamp,
               record.source_byte_offset, record.source_byte_length,
               ROW_NUMBER() OVER (
                 PARTITION BY results.source_path, results.session_id, results.tool_call_id
                 ORDER BY record.timestamp, record.id
               ) AS result_number
        FROM record_tool_results results
        JOIN effective_session_records record ON record.id = results.record_id
      )
      SELECT calls.record_id AS call_record_id, calls.source_path, calls.session_id,
             calls.tool_name, call_record.source_byte_offset AS call_offset,
             call_record.timestamp AS call_timestamp,
             results.record_id AS result_record_id, results.is_error,
             results.source_byte_offset AS result_offset,
             results.source_byte_length AS result_length,
             results.archive_generation_id AS result_generation_id
      FROM record_tool_calls calls
      JOIN effective_session_records call_record ON call_record.id = calls.record_id
      LEFT JOIN effective_results results
        ON results.source_path = calls.source_path
       AND results.session_id = calls.session_id
       AND results.tool_call_id = calls.tool_call_id
       AND results.result_number = 1
      ORDER BY calls.source_path, call_record.source_byte_offset, calls.record_id
    """)
    calls_by_source = defaultdict(list)
    for row in rows:
        calls_by_source[row["source_path"]].append(dict(row))
    users_by_source = defaultdict(list)
    for row in connection.execute("""
      SELECT source_path, source_byte_offset
      FROM effective_session_records
      WHERE record_type='message' AND message_role='user'
      ORDER BY source_path, source_byte_offset
    """):
        users_by_source[row["source_path"]].append(row["source_byte_offset"])
    return calls_by_source, users_by_source


def infer_recovery(occurrence, calls_by_source, users_by_source):
    calls = calls_by_source.get(occurrence["source_path"], [])
    boundary_offset = (
        occurrence["result_offset"]
        if occurrence["result_offset"] is not None
        else occurrence["call_offset"]
    )
    turn_end = next(
        (
            offset
            for offset in users_by_source.get(occurrence["source_path"], [])
            if offset > boundary_offset
        ),
        float("inf"),
    )
    later = [
        call
        for call in calls
        if call["call_offset"] > boundary_offset
        and call["call_offset"] < turn_end
        and call["result_record_id"] is not None
        and call["result_offset"] is not None
        and call["result_offset"] < turn_end
        and call["is_error"] == 0
    ]
    recovery = next(
        (call for call in later if call["tool_name"] == occurrence["tool_name"]), None
    )
    if recovery is None and later:
        recovery = later[0]
    if recovery is None:
        return {
            "classification": "unresolved",
            "tool": None,
            "intervening_calls": len(
                [
                    call
                    for call in calls
                    if boundary_offset < call["call_offset"] < turn_end
                ]
            ),
        }
    intervening = sum(
        1
        for call in calls
        if boundary_offset < call["call_offset"] < recovery["call_offset"]
    )
    return {
        "classification": "same-tool"
        if recovery["tool_name"] == occurrence["tool_name"]
        else "alternate-tool",
        "tool": recovery["tool_name"],
        "intervening_calls": intervening,
        "call_record_id": recovery["call_record_id"],
        "result_record_id": recovery["result_record_id"],
    }


def record_provenance(row):
    use_result = row["result_record_id"] is not None
    return {
        "record_id": row["result_record_id"] if use_result else row["call_record_id"],
        "archive_generation_id": row["result_generation_id"]
        if use_result
        else row["call_generation_id"],
        "source_path": row["source_path"],
        "session_id": row["session_id"],
        "source_byte_offset": row["result_offset"]
        if use_result
        else row["call_offset"],
        "source_byte_length": row["result_length"]
        if use_result
        else row["call_length"],
    }


def content_chunks(connection, generation_id):
    generation = connection.execute(
        "SELECT content_parent_generation_id FROM archive_generations WHERE id=?",
        (generation_id,),
    ).fetchone()
    chunks = []
    if generation["content_parent_generation_id"] is not None:
        chunks.extend(
            content_chunks(connection, generation["content_parent_generation_id"])
        )
    chunks.extend(
        connection.execute(
            """
      SELECT chunk_hash, source_offset, size_bytes
      FROM archive_generation_chunks WHERE generation_id=? ORDER BY ordinal
    """,
            (generation_id,),
        ).fetchall()
    )
    return chunks


def archive_matches(connection, archive, provenance):
    record = connection.execute(
        "SELECT raw_json FROM session_records WHERE id=?", (provenance["record_id"],)
    ).fetchone()
    if record is None:
        return False
    offset = provenance["source_byte_offset"]
    end = offset + provenance["source_byte_length"]
    pieces = []
    for chunk in content_chunks(connection, provenance["archive_generation_id"]):
        chunk_start = chunk["source_offset"]
        chunk_end = chunk_start + chunk["size_bytes"]
        if chunk_end <= offset or chunk_start >= end:
            continue
        path = archive / "chunks" / chunk["chunk_hash"][:2] / chunk["chunk_hash"]
        data = path.read_bytes()
        if (
            len(data) != chunk["size_bytes"]
            or hashlib.sha256(data).hexdigest() != chunk["chunk_hash"]
        ):
            return False
        pieces.append(
            data[
                max(offset, chunk_start) - chunk_start : min(end, chunk_end)
                - chunk_start
            ]
        )
    return b"".join(pieces) == record["raw_json"].encode()


def argument_excerpt(raw):
    value = re.sub(r"\s+", " ", raw or "{}")
    return value[:300]


def build_report(connection, archive, top, example_limit):
    occurrences = []
    for raw_row in candidate_rows(connection):
        row = dict(raw_row)
        classification = classify(row)
        if classification is None:
            continue
        category, subtype, evidence = classification
        row.update(
            {
                "category": category,
                "subtype": subtype,
                "evidence": evidence,
                "signature": normalized_signature(evidence),
            }
        )
        occurrences.append(row)

    calls_by_source, users_by_source = timeline(connection)
    for row in occurrences:
        row["inferred_recovery"] = infer_recovery(row, calls_by_source, users_by_source)

    breakdown_groups = defaultdict(list)
    groups = defaultdict(list)
    for row in occurrences:
        breakdown_groups[(row["category"], row["subtype"], row["tool_name"])].append(
            row
        )
        groups[
            (row["category"], row["subtype"], row["tool_name"], row["signature"])
        ].append(row)

    category_counts = Counter(row["category"] for row in occurrences)
    breakdown = []
    for (category, subtype, tool), rows in sorted(
        breakdown_groups.items(), key=lambda item: (-len(item[1]), item[0])
    ):
        recovery_counts = Counter(
            row["inferred_recovery"]["classification"] for row in rows
        )
        immediate_recovery_counts = Counter(
            row["inferred_recovery"]["classification"]
            for row in rows
            if row["inferred_recovery"]["classification"] != "unresolved"
            and row["inferred_recovery"]["intervening_calls"] == 0
        )
        recovery_tools = Counter(
            row["inferred_recovery"]["tool"]
            for row in rows
            if row["inferred_recovery"]["tool"] is not None
        )
        breakdown.append(
            {
                "category": category,
                "classification": "inferred"
                if category in {"empty-search", "empty-read"}
                else "recorded",
                "subtype": subtype,
                "tool": tool,
                "count": len(rows),
                "inferred_recovery_counts": dict(sorted(recovery_counts.items())),
                "immediate_recovery_counts": dict(
                    sorted(immediate_recovery_counts.items())
                ),
                "inferred_recovery_tools": dict(
                    sorted(recovery_tools.items(), key=lambda item: (-item[1], item[0]))
                ),
            }
        )

    clusters = []
    ordered = sorted(groups.items(), key=lambda item: (-len(item[1]), item[0]))[:top]
    for (category, subtype, tool, signature), rows in ordered:
        recovery_counts = Counter(
            row["inferred_recovery"]["classification"] for row in rows
        )
        examples = []
        for row in rows[:example_limit]:
            recovery = row["inferred_recovery"]
            provenance = record_provenance(row)
            examples.append(
                {
                    "provenance": provenance,
                    "archive_bytes_match": archive_matches(
                        connection, archive, provenance
                    ),
                    "call_record_id": row["call_record_id"],
                    "tool_call_id": row["tool_call_id"],
                    "arguments_excerpt": argument_excerpt(row["arguments_json"]),
                    "evidence_excerpt": re.sub(r"\s+", " ", row["evidence"])[:500],
                    "inferred_recovery": recovery,
                }
            )
        clusters.append(
            {
                "category": category,
                "classification": "inferred"
                if category in {"empty-search", "empty-read"}
                else "recorded",
                "subtype": subtype,
                "tool": tool,
                "count": len(rows),
                "signature": signature,
                "inferred_recovery_counts": dict(sorted(recovery_counts.items())),
                "examples": examples,
            }
        )

    return {
        "schema_version": 1,
        "kind": "pi-session-analytics/session-friction",
        "scope": ["search", "read", "anchor-errors", "incomplete-calls"],
        "total_friction_occurrences": len(occurrences),
        "category_counts": dict(sorted(category_counts.items())),
        "breakdown": breakdown,
        "cluster_count": len(groups),
        "shown_clusters": len(clusters),
        "clusters": clusters,
    }


def markdown(report):
    lines = [
        "# Pi session friction report",
        "",
        "> Recorded failures come from `is_error = 1`. Empty-result categories and recovery are inferred.",
        "",
        "## Totals",
        "",
        f"- Friction occurrences: {report['total_friction_occurrences']}",
        f"- Distinct clusters: {report['cluster_count']}",
    ]
    for category, count in report["category_counts"].items():
        lines.append(f"- `{category}`: {count}")
    lines.extend(
        [
            "",
            "## Breakdown",
            "",
            "| Category | Status | Subtype | Tool | Count | Inferred recovery | Immediate | Recovery tools |",
            "| --- | --- | --- | --- | ---: | --- | --- | --- |",
        ]
    )
    for row in report["breakdown"]:
        recoveries = (
            ", ".join(
                f"{key}={value}"
                for key, value in row["inferred_recovery_counts"].items()
            )
            or "none"
        )
        immediate = (
            ", ".join(
                f"{key}={value}"
                for key, value in row["immediate_recovery_counts"].items()
            )
            or "none"
        )
        recovery_tools = (
            ", ".join(
                f"{key}={value}"
                for key, value in list(row["inferred_recovery_tools"].items())[:5]
            )
            or "none"
        )
        lines.append(
            f"| {row['category']} | {row['classification']} | {row['subtype']} | {row['tool']} | {row['count']} | {recoveries} | {immediate} | {recovery_tools} |"
        )
    lines.extend(["", "## Top clusters", ""])
    for index, cluster in enumerate(report["clusters"], 1):
        recoveries = (
            ", ".join(
                f"{key}={value}"
                for key, value in cluster["inferred_recovery_counts"].items()
            )
            or "none"
        )
        lines.extend(
            [
                f"### {index}. {cluster['category']} / {cluster['subtype']} / {cluster['tool']} — {cluster['count']}",
                "",
                f"- Classification: **{cluster['classification']}**",
                f"- Signature: `{cluster['signature']}`",
                f"- Inferred recovery: {recoveries}",
                "- Examples:",
            ]
        )
        for example in cluster["examples"]:
            provenance = example["provenance"]
            recovery = example["inferred_recovery"]
            lines.extend(
                [
                    f"  - record `{provenance['record_id']}`, generation `{provenance['archive_generation_id']}`, bytes `{provenance['source_byte_offset']}+{provenance['source_byte_length']}`, archive match `{str(example['archive_bytes_match']).lower()}`",
                    f"    - Evidence: `{example['evidence_excerpt']}`",
                    f"    - Arguments: `{example['arguments_excerpt']}`",
                    f"    - Inferred recovery: `{recovery['classification']}` via `{recovery.get('tool') or '-'}` after {recovery['intervening_calls']} intervening call(s)",
                ]
            )
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def main():
    args = parse_args()
    connection = connect(args.db)
    try:
        report = build_report(
            connection, Path(args.archive).resolve(), args.top, args.examples
        )
    finally:
        connection.close()
    json_output = json.dumps(report, indent=2, sort_keys=True) + "\n"
    output = json_output if args.format == "json" else markdown(report)
    if args.output:
        path = Path(args.output)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(output)
    else:
        print(output, end="")
    if args.json_output:
        json_path = Path(args.json_output)
        json_path.parent.mkdir(parents=True, exist_ok=True)
        json_path.write_text(json_output)


if __name__ == "__main__":
    main()
