import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from python_analyzer import analyze_code, analyze_result


class AnalyzerTests(unittest.TestCase):
    def assert_issue_count(self, code, expected):
        result = analyze_result(code)
        self.assertEqual(result["totalIssues"], expected)
        self.assertEqual(len(result["diagnostics"]), expected)
        return result["diagnostics"]

    def test_syntax_error_has_line_and_no_guessed_fix(self):
        diagnostics = self.assert_issue_count("if True print('missing colon')", 1)
        self.assertEqual(diagnostics[0]["type"], "syntax_error")
        self.assertIsNotNone(diagnostics[0]["line"])
        self.assertIsNone(diagnostics[0]["suggestedFix"])

    def test_literal_zero_divisor_is_reported(self):
        diagnostics = self.assert_issue_count("answer = 10 / 0", 1)
        self.assertEqual(diagnostics[0]["type"], "division_by_zero")
        self.assertEqual(diagnostics[0]["severity"], "error")
        self.assertEqual(diagnostics[0]["line"], 1)
        self.assertTrue(diagnostics[0]["suggestedFix"])

    def test_student_result_example_reports_typo_and_potential_empty_list(self):
        code = """\
def calculate_average(scores):
    return sum(scores) / len(scores)

def get_grade(score):
    return "A"

result = get_grdae(95)
"""
        diagnostics = self.assert_issue_count(code, 2)
        self.assertEqual(
            {diagnostic["type"] for diagnostic in diagnostics},
            {"undefined_name", "potential_division_by_zero"},
        )
        undefined = next(item for item in diagnostics if item["type"] == "undefined_name")
        potential = next(item for item in diagnostics if item["type"] == "potential_division_by_zero")
        self.assertIn("get_grdae", undefined["explanation"])
        self.assertEqual(undefined["line"], 7)
        self.assertEqual(potential["line"], 2)
        self.assertIn("could be zero", potential["explanation"])
        self.assertTrue(potential["suggestedFix"])

    def test_undefined_function_call_is_reported_once(self):
        diagnostics = self.assert_issue_count("def run():\n    missing_helper()\n", 1)
        self.assertEqual(diagnostics[0]["type"], "undefined_name")
        self.assertEqual(diagnostics[0]["line"], 2)

    def test_defined_functions_and_parameters_are_valid_names(self):
        code = """\
def helper(value):
    return value

def run(argument):
    return helper(argument)
"""
        self.assertEqual(self.assert_issue_count(code, 0), [])

    def test_imported_names_are_valid(self):
        code = """\
from math import sqrt as square_root
import statistics
result = square_root(9) + statistics.mean([1, 2])
"""
        self.assertEqual(self.assert_issue_count(code, 0), [])

    def test_builtins_are_valid_names(self):
        code = "values = list(range(3))\nprint(sum(values), len(values))"
        self.assertEqual(self.assert_issue_count(code, 0), [])

    def test_literal_empty_len_is_a_proven_zero_divisor(self):
        diagnostics = self.assert_issue_count("average = total / len([])", 1)
        self.assertEqual(diagnostics[0]["type"], "division_by_zero")
        self.assertEqual(diagnostics[0]["severity"], "error")

    def test_nonempty_literal_len_is_safe(self):
        self.assertEqual(self.assert_issue_count("average = total / len([1])", 0), [])

    def test_shadowed_len_is_not_assumed_to_be_builtin(self):
        code = """\
def len(items):
    return 1

average = total / len(items)
"""
        self.assertEqual(self.assert_issue_count(code, 0), [])

    def test_clean_code_has_no_diagnostics(self):
        self.assertEqual(self.assert_issue_count("answer = 10 / 2", 0), [])
        self.assertEqual(analyze_code("answer = 10 / 2"), [])


if __name__ == "__main__":
    unittest.main()
