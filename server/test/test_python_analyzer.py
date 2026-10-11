import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from python_analyzer import analyze_code


class AnalyzerTests(unittest.TestCase):
    def test_syntax_error_has_line_and_no_guessed_fix(self):
        diagnostics = analyze_code("if True print('missing colon')")
        self.assertEqual(diagnostics[0]["type"], "syntax_error")
        self.assertIsNotNone(diagnostics[0]["line"])
        self.assertIsNone(diagnostics[0]["suggestedFix"])

    def test_literal_zero_divisor_is_reported(self):
        diagnostics = analyze_code("answer = 10 / 0")
        self.assertEqual(len(diagnostics), 1)
        self.assertEqual(diagnostics[0]["type"], "division_by_zero")
        self.assertEqual(diagnostics[0]["severity"], "error")
        self.assertEqual(diagnostics[0]["line"], 1)
        self.assertTrue(diagnostics[0]["suggestedFix"])

    def test_clean_code_has_no_diagnostics(self):
        self.assertEqual(analyze_code("answer = 10 / 2"), [])


if __name__ == "__main__":
    unittest.main()
