import importlib.util
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).parents[1] / "scripts" / "analyze.py"
SPEC = importlib.util.spec_from_file_location("session_friction_analyze", MODULE_PATH)
ANALYZE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(ANALYZE)


def row(tool, content="", is_error=0, result_record_id=1):
    return {
        "tool_name": tool,
        "content": content,
        "is_error": is_error,
        "result_record_id": result_record_id,
    }


class ClassificationTests(unittest.TestCase):
    def test_stale_edit_anchor_is_a_recorded_anchor_error(self):
        self.assertEqual(
            ANALYZE.classify(
                row("replace", "start anchor LINE#A123 is stale", is_error=1)
            )[:2],
            ("anchor-error", "stale"),
        )

    def test_empty_search_is_inferred_friction(self):
        self.assertEqual(
            ANALYZE.classify(row("search", "No matches found"))[:2],
            ("empty-search", "no matches found"),
        )

    def test_read_not_found_is_a_recorded_read_error(self):
        self.assertEqual(
            ANALYZE.classify(row("read", "READ_FAILED: file not found", is_error=1))[
                :2
            ],
            ("read-error", "not-found"),
        )

    def test_successful_read_content_is_not_reported(self):
        self.assertIsNone(ANALYZE.classify(row("read", "useful file contents")))

    def test_incomplete_target_call_is_separate(self):
        self.assertEqual(
            ANALYZE.classify(row("search", result_record_id=None))[:2],
            ("incomplete-call", "search"),
        )

    def test_dynamic_anchor_values_share_a_signature(self):
        first = ANALYZE.normalized_signature("start anchor LINE#A123 is stale at 42")
        second = ANALYZE.normalized_signature("start anchor LINE#B456 is stale at 99")
        self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
