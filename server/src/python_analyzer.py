"""Conservative AST checks for common Python mistakes; submitted code is never executed."""

import ast
import builtins
import json
import sys


_BUILTIN_NAMES = set(dir(builtins))
_DIVISION_OPERATORS = (ast.Div, ast.FloorDiv, ast.Mod)


class Scope:
    """Names bound in one Python scope, collected before checking calls."""

    def __init__(self, kind, parent=None, bindings=None, globals_=None, nonlocals=None, wildcard_import=False):
        self.kind = kind
        self.parent = parent
        self.bindings = bindings or set()
        self.globals = globals_ or set()
        self.nonlocals = nonlocals or set()
        self.wildcard_import = wildcard_import


class BindingCollector(ast.NodeVisitor):
    """Collect local bindings without entering nested lexical scopes."""

    def __init__(self):
        self.bindings = set()
        self.globals = set()
        self.nonlocals = set()
        self.wildcard_import = False

    def visit_Name(self, node):
        if isinstance(node.ctx, (ast.Store, ast.Param)):
            self.bindings.add(node.id)

    def visit_Import(self, node):
        for alias in node.names:
            self.bindings.add(alias.asname or alias.name.split(".")[0])

    def visit_ImportFrom(self, node):
        for alias in node.names:
            if alias.name == "*":
                self.wildcard_import = True
            else:
                self.bindings.add(alias.asname or alias.name)

    def visit_Global(self, node):
        self.globals.update(node.names)

    def visit_Nonlocal(self, node):
        self.nonlocals.update(node.names)

    def visit_ExceptHandler(self, node):
        if node.name:
            self.bindings.add(node.name)
        if node.type:
            self.visit(node.type)
        for statement in node.body:
            self.visit(statement)

    def visit_FunctionDef(self, node):
        self.bindings.add(node.name)

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node):
        self.bindings.add(node.name)

    def visit_Lambda(self, _node):
        return


def _scope_for(kind, statements, parent=None, parameters=()):
    collector = BindingCollector()
    for statement in statements:
        collector.visit(statement)
    collector.bindings.update(parameters)
    return Scope(
        kind,
        parent,
        collector.bindings,
        collector.globals,
        collector.nonlocals,
        collector.wildcard_import,
    )


def _argument_names(arguments):
    all_arguments = (
        list(arguments.posonlyargs)
        + list(arguments.args)
        + list(arguments.kwonlyargs)
    )
    if arguments.vararg:
        all_arguments.append(arguments.vararg)
    if arguments.kwarg:
        all_arguments.append(arguments.kwarg)
    return {argument.arg for argument in all_arguments}


def _function_parent(scope):
    # Methods do not close over the containing class namespace.
    parent = scope
    while parent is not None and parent.kind == "class":
        parent = parent.parent
    return parent


class ScopeAnalyzer(ast.NodeVisitor):
    def __init__(self, diagnostics, root_scope):
        self.diagnostics = diagnostics
        self.scope = root_scope
        self.seen = set()

    def _resolve(self, name):
        current = self.scope
        if name in current.globals:
            while current.parent is not None:
                current = current.parent
            return name in current.bindings or (current.wildcard_import and name not in _BUILTIN_NAMES)
        if name in current.nonlocals:
            current = current.parent
            while current is not None and current.kind == "class":
                current = current.parent
            while current is not None and current.kind != "module":
                if name in current.bindings:
                    return True
                current = current.parent
            return False

        current = self.scope
        while current is not None:
            if name in current.bindings:
                return True
            if current.wildcard_import:
                return True
            current = current.parent
        return name in _BUILTIN_NAMES

    def _add(self, diagnostic, unique_key):
        if unique_key not in self.seen:
            self.seen.add(unique_key)
            self.diagnostics.append(diagnostic)

    def _check_call_name(self, node):
        if not isinstance(node.func, ast.Name) or self._resolve(node.func.id):
            return
        name = node.func.id
        self._add(
            {
                "type": "undefined_name",
                "severity": "error",
                "line": node.lineno,
                "explanation": f"'{name}' is called here but is not defined or imported in this scope.",
                "suggestedFix": f"Define or import '{name}' before calling it, or correct the spelling.",
            },
            ("undefined_name", node.lineno, node.col_offset, name),
        )

    def _is_builtin_len(self, node):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "len"):
            return False
        current = self.scope
        while current is not None:
            if "len" in current.globals:
                while current.parent is not None:
                    current = current.parent
                return "len" not in current.bindings and not current.wildcard_import
            if "len" in current.nonlocals or "len" in current.bindings or current.wildcard_import:
                return False
            current = current.parent
        return True

    @staticmethod
    def _known_empty_length_argument(node):
        if isinstance(node, (ast.List, ast.Tuple, ast.Set, ast.Dict)):
            return len(node.elts if hasattr(node, "elts") else node.keys) == 0
        return isinstance(node, ast.Constant) and isinstance(node.value, (str, bytes)) and len(node.value) == 0

    @staticmethod
    def _known_nonempty_length_argument(node):
        if isinstance(node, (ast.List, ast.Tuple, ast.Set, ast.Dict)):
            return len(node.elts if hasattr(node, "elts") else node.keys) > 0
        return isinstance(node, ast.Constant) and isinstance(node.value, (str, bytes)) and len(node.value) > 0

    def visit_BinOp(self, node):
        if isinstance(node.op, _DIVISION_OPERATORS):
            divisor = node.right
            if (
                isinstance(divisor, ast.Constant)
                and not isinstance(divisor.value, bool)
                and isinstance(divisor.value, (int, float, complex))
                and divisor.value == 0
            ):
                self._add(
                    {
                        "type": "division_by_zero",
                        "severity": "error",
                        "line": node.lineno,
                        "explanation": "This operation will raise ZeroDivisionError because its divisor is zero.",
                        "suggestedFix": "Use a nonzero divisor or check the divisor before this operation.",
                    },
                    ("division_by_zero", node.lineno, node.col_offset),
                )
            elif self._is_builtin_len(divisor) and len(divisor.args) == 1 and not divisor.keywords:
                collection = divisor.args[0]
                if self._known_empty_length_argument(collection):
                    self._add(
                        {
                            "type": "division_by_zero",
                            "severity": "error",
                            "line": node.lineno,
                            "explanation": "This operation divides by the length of an empty collection, so the divisor is zero.",
                            "suggestedFix": "Check that the collection is nonempty before dividing by its length.",
                        },
                        ("division_by_zero", node.lineno, node.col_offset),
                    )
                elif not self._known_nonempty_length_argument(collection):
                    self._add(
                        {
                            "type": "potential_division_by_zero",
                            "severity": "warning",
                            "line": node.lineno,
                            "explanation": "This divisor is len(collection), which could be zero if the collection is empty.",
                            "suggestedFix": "Check that the collection is nonempty before dividing by its length.",
                        },
                        ("potential_division_by_zero", node.lineno, node.col_offset),
                    )
        self.generic_visit(node)

    def visit_Call(self, node):
        self._check_call_name(node)
        self.generic_visit(node)

    def visit_FunctionDef(self, node):
        # Defaults, decorators, and annotations are evaluated in the outer scope.
        for expression in list(node.decorator_list) + list(node.args.defaults) + list(node.args.kw_defaults):
            if expression is not None:
                self.visit(expression)
        parent = _function_parent(self.scope)
        nested_scope = _scope_for("function", node.body, parent, _argument_names(node.args))
        nested_analyzer = ScopeAnalyzer(self.diagnostics, nested_scope)
        for statement in node.body:
            nested_analyzer.visit(statement)
        self.seen.update(nested_analyzer.seen)

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node):
        for expression in list(node.decorator_list) + list(node.bases):
            self.visit(expression)
        class_scope = _scope_for("class", node.body, self.scope)
        nested_analyzer = ScopeAnalyzer(self.diagnostics, class_scope)
        for statement in node.body:
            nested_analyzer.visit(statement)
        self.seen.update(nested_analyzer.seen)

    def visit_Lambda(self, node):
        # The lambda's body has its own parameters and scope.
        lambda_scope = Scope("function", _function_parent(self.scope), _argument_names(node.args))
        nested_analyzer = ScopeAnalyzer(self.diagnostics, lambda_scope)
        nested_analyzer.visit(node.body)
        self.seen.update(nested_analyzer.seen)


def analyze_code(code):
    """Return distinct diagnostics as a list, retaining the original helper contract."""
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

    root_scope = _scope_for("module", tree.body)
    analyzer = ScopeAnalyzer([], root_scope)
    for statement in tree.body:
        analyzer.visit(statement)
    return sorted(analyzer.diagnostics, key=lambda item: (item["line"] or 0, item["type"], item["explanation"]))


def analyze_result(code):
    diagnostics = analyze_code(code)
    return {"diagnostics": diagnostics, "totalIssues": len(diagnostics)}


def main():
    try:
        request = json.load(sys.stdin)
        code = request["code"]
        if not isinstance(code, str):
            raise ValueError('The "code" field must be a string.')
    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
        print(json.dumps({"error": str(error)}))
        return 2

    print(json.dumps(analyze_result(code)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
