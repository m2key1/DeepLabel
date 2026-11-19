"""A release names one version everywhere it is written, and the changelog has its notes."""
import json
import re
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def versions() -> dict[str, str]:
    lock = json.loads((ROOT / 'frontend' / 'package-lock.json').read_text())
    return {
        'backend/pyproject.toml': tomllib.loads((ROOT / 'backend' / 'pyproject.toml').read_text())['project']['version'],
        'frontend/package.json': json.loads((ROOT / 'frontend' / 'package.json').read_text())['version'],
        'frontend/package-lock.json': lock['version'],
        'frontend/package-lock.json packages': lock['packages']['']['version'],
    }


def test_the_backend_and_the_frontend_carry_the_same_version():
    found = versions()
    assert len(set(found.values())) == 1, found


def test_the_changelog_has_notes_for_the_running_version_and_a_place_for_the_next():
    version = versions()['backend/pyproject.toml']
    changelog = (ROOT / 'CHANGELOG.md').read_text()
    assert re.search(rf'^## \[{re.escape(version)}\] - \d{{4}}-\d{{2}}-\d{{2}}$', changelog, re.M), version
    assert re.search(r'^## \[Unreleased\]$', changelog, re.M)
    # Every release heading links to its GitHub release; Unreleased to what has come since.
    assert f'[{version}]: https://github.com/m2key1/DeepLabel/releases/tag/v{version}' in changelog
    assert f'[Unreleased]: https://github.com/m2key1/DeepLabel/compare/v{version}...HEAD' in changelog
