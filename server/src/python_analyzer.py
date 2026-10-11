"""Conservative AST checks for common Python mistakes; submitted code is never executed."""

import ast
import json
import sys


class DivisionByZeroVisitor(ast.NodeVisitor):
    """Report only literal zero divisors, avoiding guesses about runtime values."""

    def __init__(self):
        self.diagnostics = []

    def visit_BinOp(self, node):
        dividing_operators = (ast.Div, ast.FloorDiv, ast.Mod)
        divisor = node.right
        if (
            isinstance(node.op, dividing_operators)
            and isinstance(divisor, ast.Constant)
            and not isinstance(divisor.value, bool)
            and isinstance(divisor.value, (int, float, complex))
            and divisor.value == 0
        ):
            self.diagnostics.append(
                {
                    "type": "division_by_zero",
                    "severity": "error",
                    "line": node.lineno,
                    "explanation": "This operation will raise ZeroDivisionError because its divisor is zero.",
                    "suggestedFix": "Use a nonzero divisor or check the divisor before this operation.",
                }
            )
        self.generic_visit(node)


def analyze_code(code):
    try:
        tree = ast.parse(code)
    except SyntaxError as error:
        return [
            {
                "type": "syntax_error",
                "severity": "error",
                "line": error.lineno,
                "explanation": f"Python syntax error: {error.msg}.",
                "suggestedFix": None,
            }
        ]

    visitor = DivisionByZeroVisitor()
    visitor.visit(tree)
    return visitor.diagnostics


def main():
    try:
        request = json.load(sys.stdin)
        code = request["code"]
        if not isinstance(code, str):
            raise ValueError('The "code" field must be a string.')
    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
        print(json.dumps({"error": str(error)}))
        return 2

    print(json.dumps({"diagnostics": analyze_code(code)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
