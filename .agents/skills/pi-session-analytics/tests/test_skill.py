import json
import re
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
        for trigger in ("tool use", "token", "sync", "migration", "verification"):
            self.assertIn(trigger, description)

    def test_every_cli_command_is_routed(self):
        commands = set(re.findall(r"export const (\w+) = defineCommand", self.cli))
        commands.discard("main")
        missing = sorted(
            command for command in commands if command not in self.skill_text
        )
        self.assertEqual([], missing)

    def test_evidence_rules_preserve_uncertainty(self):
        self.assertIn(
            "Treat `is_error = 1` as a recorded hard failure", self.skill_text
        )
        self.assertIn("A missing result is incomplete", self.skill_text)
        self.assertIn("Always label recovery as inferred", self.skill_text)
        self.assertIn("Never assign assistant-turn cost", self.skill_text)
        self.assertIn("Never change native Pi JSONL sessions", self.skill_text)

    def test_migration_keeps_the_old_store_until_verified(self):
        self.assertIn("creates a separate compact candidate", self.skill_text)
        self.assertIn("--legacy <old.db> --deep", self.skill_text)
        self.assertIn(
            "only then ask for the exact destructive cutover", self.skill_text
        )
        self.assertIn("Before deletion, show separate sizes", self.skill_text)

    def test_npm_package_exposes_both_agent_skills(self):
        package = json.loads((REPO_ROOT / "package.json").read_text())
        expected = {
            "./.agents/skills/pi-session-analytics",
            "./.agents/skills/session-friction-insights",
        }
        self.assertEqual(expected, set(package["pi"]["skills"]))
        files = set(package["files"])
        self.assertIn(".agents/skills/pi-session-analytics/SKILL.md", files)
        self.assertIn(".agents/skills/session-friction-insights/SKILL.md", files)
        self.assertIn(
            ".agents/skills/session-friction-insights/scripts/analyze.py", files
        )

    def test_friction_analysis_routes_to_the_focused_skill(self):
        self.assertIn("../session-friction-insights/SKILL.md", self.skill)
        self.assertIn("verified compact database", self.skill_text)


if __name__ == "__main__":
    unittest.main()
