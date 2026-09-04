#!/usr/bin/env python3
"""Extract focused, reproducible tool-friction evidence from compact SQLite."""

import argparse
import json
import re
import sqlite3
import zlib
from collections import Counter, defaultdict
from pathlib import Path

TARGET_TOOLS = ("search", "read", "replace", "insert", "delete", "copy", "move")
EDIT_TOOLS = {"replace", "insert", "delete", "copy", "move"}
EMPTY_SEARCH_MARKERS = ("no matches found", "no results found", "no files found")
EMPTY_OUTPUT_MARKERS = {"", "(no output)", "(no tool output)", "no output"}


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, help="verified compact database")
    parser.add_argument("--output", help="write Markdown report")
    parser.add_argument("--json-output", help="write JSON report")
    parser.add_argument("--format", choices=("markdown", "json"), default="markdown")
    parser.add_argument("--top", type=int, default=20, help="maximum clusters")
    parser.add_argument("--examples", type=int, default=3, help="examples per cluster")
    return parser.parse_args()


def connect(path):
    connection = sqlite3.connect(f"file:{Path(path).resolve()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def decode_payload(blob):
    return zlib.decompress(blob, -zlib.MAX_WBITS).decode("utf-8")


def result_text(blob):
    try:
        payload = json.loads(decode_payload(blob))
        return payload.get("content_text") or payload.get("content_json") or ""
    except (ValueError, TypeError, zlib.error, UnicodeDecodeError):
        return ""


def candidate_rows(connection):
    placeholders = ",".join("?" for _ in TARGET_TOOLS)
    rows = connection.execute(
        f"""
        SELECT calls.session_id, calls.tool_call_id, calls.tool_name,
               calls.turn_index, calls.event_index AS call_event_index,
               calls.timestamp AS call_timestamp, calls.source_path,
               calls.source_byte_offset AS call_offset,
               results.id AS result_record_id,
               results.event_index AS result_event_index,
               results.timestamp AS result_timestamp, results.is_error,
               results.payload_blob
        FROM tool_calls calls
        LEFT JOIN tool_results results
          ON results.session_id = calls.session_id
         AND results.tool_call_id = calls.tool_call_id
        WHERE calls.tool_name IN ({placeholders})
        ORDER BY calls.session_id, calls.event_index, calls.id
        """,
        TARGET_TOOLS,
    )
    for source in rows:
        row = dict(source)
        row["content"] = (
            result_text(row.pop("payload_blob")) if row["result_record_id"] else ""
        )
        classification = classify(row)
        if classification is not None:
            yield row, classification


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


def infer_recovery(connection, occurrence):
    boundary = occurrence["result_event_index"] or occurrence["call_event_index"]
    row = connection.execute(
        """
        SELECT calls.tool_call_id, calls.tool_name, calls.event_index
        FROM tool_calls calls
        JOIN tool_results results
          ON results.session_id = calls.session_id
         AND results.tool_call_id = calls.tool_call_id
        WHERE calls.session_id = ? AND calls.turn_index = ?
          AND calls.event_index > ? AND results.is_error = 0
        ORDER BY (calls.tool_name = ?) DESC, calls.event_index, calls.id
        LIMIT 1
        """,
        (
            occurrence["session_id"],
            occurrence["turn_index"],
            boundary,
            occurrence["tool_name"],
        ),
    ).fetchone()
    if row is None:
        return {
            "status": "inferred_unresolved",
            "tool_call_id": None,
            "tool_name": None,
        }
    status = (
        "inferred_same_tool"
        if row["tool_name"] == occurrence["tool_name"]
        else "inferred_alternate_tool"
    )
    return {
        "status": status,
        "tool_call_id": row["tool_call_id"],
        "tool_name": row["tool_name"],
    }


def build_report(connection, top, examples):
    clusters = defaultdict(list)
    category_counts = Counter()
    for row, classification in candidate_rows(connection):
        category, subtype, evidence = classification
        signature = normalized_signature(evidence)
        occurrence = dict(row)
        occurrence.update(
            {
                "category": category,
                "subtype": subtype,
                "signature": signature,
                "evidence_status": "recorded" if row["is_error"] == 1 else "inferred",
            }
        )
        occurrence["recovery"] = infer_recovery(connection, occurrence)
        key = (category, subtype, row["tool_name"], signature)
        clusters[key].append(occurrence)
        category_counts[category] += 1

    ordered = sorted(clusters.items(), key=lambda item: (-len(item[1]), item[0]))[:top]
    output_clusters = []
    for (category, subtype, tool, signature), occurrences in ordered:
        recoveries = Counter(item["recovery"]["status"] for item in occurrences)
        output_clusters.append(
            {
                "category": category,
                "subtype": subtype,
                "tool_name": tool,
                "signature": signature,
                "count": len(occurrences),
                "evidence_status": "recorded"
                if category.endswith("error")
                else "inferred",
                "recovery_counts": dict(sorted(recoveries.items())),
                "examples": [example(item) for item in occurrences[:examples]],
            }
        )
    return {
        "schema_version": 2,
        "kind": "pi-session-analytics/session-friction",
        "occurrences": sum(category_counts.values()),
        "category_counts": dict(sorted(category_counts.items())),
        "clusters": output_clusters,
    }


def example(item):
    return {
        "session_id": item["session_id"],
        "tool_call_id": item["tool_call_id"],
        "tool_name": item["tool_name"],
        "source_path": item["source_path"],
        "source_byte_offset": item["call_offset"],
        "call_event_index": item["call_event_index"],
        "result_event_index": item["result_event_index"],
        "evidence_status": item["evidence_status"],
        "recovery": item["recovery"],
    }


def markdown(report):
    lines = [
        "# Session friction",
        "",
        f"Occurrences: {report['occurrences']}",
        "",
        "Empty results and recovery are inferred. Hard errors come from recorded `is_error` values.",
        "",
    ]
    for index, cluster in enumerate(report["clusters"], 1):
        lines.extend(
            [
                f"## {index}. {cluster['category']} / {cluster['subtype']}",
                "",
                f"- Tool: `{cluster['tool_name']}`",
                f"- Count: {cluster['count']}",
                f"- Evidence: {cluster['evidence_status']}",
                f"- Signature: `{cluster['signature']}`",
                f"- Inferred recovery: `{json.dumps(cluster['recovery_counts'], sort_keys=True)}`",
                "- Examples:",
            ]
        )
        for item in cluster["examples"]:
            lines.append(
                f"  - session `{item['session_id']}`, call `{item['tool_call_id']}`, "
                f"event `{item['call_event_index']}`, source offset `{item['source_byte_offset']}`"
            )
        lines.append("")
    return "\n".join(lines)


def main():
    args = parse_args()
    connection = connect(args.db)
    try:
        report = build_report(connection, args.top, args.examples)
    finally:
        connection.close()
    json_text = json.dumps(report, indent=2, sort_keys=True) + "\n"
    markdown_text = markdown(report) + "\n"
    if args.output:
        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        Path(args.output).write_text(markdown_text)
    if args.json_output:
        Path(args.json_output).parent.mkdir(parents=True, exist_ok=True)
        Path(args.json_output).write_text(json_text)
    print(json_text if args.format == "json" else markdown_text, end="")


if __name__ == "__main__":
    main()
