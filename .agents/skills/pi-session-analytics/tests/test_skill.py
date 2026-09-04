import re
import json
import unittest
from pathlib import Path

SKILL_PATH = Path(__file__).parents[1] / "SKILL.md"
REPO_ROOT = Path(__file__).parents[4]
CLI_PATH = REPO_ROOT / "src" / "cli.ts"


class PiSessionAnalyticsSkillTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.skill = SKILL_PATH.read_text()
        cls.skill_text = " ".join(cls.skill.split())
        cls.cli = CLI_PATH.read_text()

    def test_frontmatter_names_the_general_skill(self):
        self.assertRegex(self.skill, r"(?m)^name: pi-session-analytics$")
        description = self.skill.split("---", 2)[1]
        for trigger in ("past Pi work", "token", "tool calls", "sync", "verify"):
            self.assertIn(trigger, description)

    def test_every_cli_command_is_routed(self):
        commands = set(re.findall(r"export const (\w+) = defineCommand", self.cli))
        commands.discard("main")
        missing = sorted(
            command for command in commands if f"`{command}" not in self.skill
        )
        self.assertEqual([], missing)

    def test_isolated_sync_keeps_database_and_archive_together(self):
        snapshot_section = self.skill.split("### Fixed, reproducible corpus", 1)[1]
        self.assertIn("--sessions .agents/tmp/<task>/corpus", snapshot_section)
        self.assertIn("--db .agents/tmp/<task>/sessions.db", snapshot_section)
        self.assertIn("--archive .agents/tmp/<task>/archive", snapshot_section)
        self.assertIn("not hard links", snapshot_section)

    def test_evidence_rules_preserve_uncertainty(self):
        self.assertIn(
            "Treat `is_error = 1` as a recorded tool failure", self.skill_text
        )
        self.assertIn(
            "A missing tool result is incomplete, not a failure", self.skill_text
        )
        self.assertIn("Always label recovery as inferred", self.skill_text)
        self.assertIn("Do not invent missing prices", self.skill_text)
        self.assertIn("Deep verification proves", self.skill_text)

    def test_mutating_cleanup_requires_user_approval(self):
        self.assertIn("compact --older-than 30 --dry-run --json", self.skill)
        self.assertIn(
            "only after the user approves that exact mutation", self.skill_text
        )
        self.assertIn("Before any deletion, show separate sizes", self.skill_text)

    def test_npm_package_exposes_both_agent_skills(self):
        package = json.loads((REPO_ROOT / "package.json").read_text())
        expected = {
            "./.agents/skills/pi-session-analytics",
            "./.agents/skills/session-friction-insights",
        }
        self.assertEqual(expected, set(package["pi"]["skills"]))
        self.assertTrue(
            {path.removeprefix("./") for path in expected}.issubset(
                set(package["files"])
            )
        )

    def test_friction_analysis_routes_to_the_focused_skill(self):
        self.assertIn("../session-friction-insights/SKILL.md", self.skill)
        self.assertIn(
            "only after the selected database and archive pass verification",
            self.skill_text,
        )


if __name__ == "__main__":
    unittest.main()
