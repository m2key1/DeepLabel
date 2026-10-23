"""The map runner is spawned under the mapseg venv - torch and the model repo, no web
stack - so everything it imports, directly or through an app module, has to hold to that.

Checked statically rather than by importing: the test suite runs in the app venv, where
fastapi is present and a bad import would sail through.
"""
import ast
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
RUNNER = BACKEND / 'runner'
APP = BACKEND / 'app'

# The web stack, which a model venv has no reason to carry. python-dotenv is deliberately
# not here: app.config reads it, the runner loads app.config, and the model venv has it.
WEB_ONLY = {'fastapi', 'starlette', 'uvicorn', 'httpx', 'cryptography', 'pydantic'}



def top_level_imports(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding='utf-8'))
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            names.add(node.module.split('.')[0])
        elif isinstance(node, ast.Import):
            names |= {alias.name.split('.')[0] for alias in node.names}
    return names


def app_modules(path: Path) -> set[str]:
    """The app.* modules this file pulls in, by name."""
    tree = ast.parse(path.read_text(encoding='utf-8'))
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module == 'app':
            names |= {alias.name for alias in node.names}
        elif isinstance(node, ast.ImportFrom) and (node.module or '').startswith('app.'):
            names.add(node.module.split('.')[1])
        elif isinstance(node, ast.Import):
            names |= {alias.name.split('.')[1] for alias in node.names
                      if alias.name.startswith('app.')}
    return names


def reachable(start: Path) -> set[str]:
    """Every app module the file loads, transitively."""
    seen: set[str] = set()
    queue = list(app_modules(start))
    while queue:
        name = queue.pop()
        if name in seen:
            continue
        seen.add(name)
        module = APP / f'{name}.py'
        if module.is_file():
            queue += list(app_modules(module))
    return seen


RUNNER_MODULES = sorted(p.name for p in RUNNER.glob('*.py') if p.name != '__init__.py')


@pytest.mark.parametrize('name', RUNNER_MODULES)
def test_no_runner_reaches_the_web_stack(name):
    """The failure this guards: app.geometry raised HTTPException, app.candidates imported
    it for the overlap maths, and the text job runner imported candidates - so every text job died at
    `ModuleNotFoundError: fastapi` before reading a page."""
    runner = RUNNER / name
    offenders = {}
    for source in [runner, *(APP / f'{m}.py' for m in reachable(runner))]:
        if not source.is_file():
            continue
        hits = top_level_imports(source) & WEB_ONLY
        if hits:
            offenders[source.relative_to(BACKEND).as_posix()] = sorted(hits)
    assert offenders == {}, f'{name} would fail to import in a model venv: {offenders}'
