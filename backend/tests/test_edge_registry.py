"""The edge-method registry decides what the area-detect dropdown offers. A malformed
entry must drop out rather than reach the UI or the CLI, and a missing file must read as
"no methods" — edge detection is optional, and a line job without it still works by hand.
"""
import json

import pytest

from app import edge_registry

CENTRELINE = {'id': 'centreline', 'label': 'Ink centreline',
              'params': {'block_size': {'type': 'number', 'default': 21}}}


@pytest.fixture
def registry(tmp_path, monkeypatch):
    """Write a registry file and point config at it."""
    path = tmp_path / 'edge' / 'registry.json'
    path.parent.mkdir()
    monkeypatch.setattr('app.config.EDGE_REGISTRY', path)

    def write(payload):
        path.write_text(json.dumps(payload), encoding='utf-8')
        return path

    return write


def test_a_valid_entry_is_listed(registry):
    registry({'methods': [CENTRELINE]})
    assert edge_registry.list_methods() == [
        {'id': 'centreline', 'label': 'Ink centreline', 'params': CENTRELINE['params'], 'available': True}]


def test_defaults_are_extracted_for_the_cli(registry):
    registry({'methods': [CENTRELINE]})
    assert edge_registry.default_params(edge_registry.get_method('centreline')) == {'block_size': 21}


@pytest.mark.parametrize('entry', [
    {'label': 'No id', 'params': {}},
    {'id': 'x', 'params': {}},
    {'id': 'x', 'label': '', 'params': {}},
    {'id': 'x', 'label': 'Bad params', 'params': []},
    {'id': 'x', 'label': 'Param without a default', 'params': {'p': {'type': 'number'}}},
    {'id': 'x', 'label': 'Empty checkpoint', 'params': {}, 'checkpoint': ''},
    'not even a dict',
])
def test_malformed_entries_are_dropped(registry, entry):
    registry({'methods': [entry]})
    assert edge_registry.list_methods() == []


def test_a_bad_entry_does_not_hide_the_good_ones(registry):
    registry({'methods': [{'id': 'broken'}, CENTRELINE]})
    assert [m['id'] for m in edge_registry.list_methods()] == ['centreline']


def test_a_missing_file_reads_as_no_methods(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.EDGE_REGISTRY', tmp_path / 'absent.json')
    assert edge_registry.list_methods() == []


def test_malformed_json_reads_as_no_methods(registry, tmp_path, monkeypatch):
    path = tmp_path / 'edge' / 'registry.json'
    path.parent.mkdir(exist_ok=True)
    path.write_text('{not json', encoding='utf-8')
    monkeypatch.setattr('app.config.EDGE_REGISTRY', path)
    assert edge_registry.list_methods() == []


def test_a_method_without_a_checkpoint_needs_none(registry):
    registry({'methods': [CENTRELINE]})
    method = edge_registry.get_method('centreline')
    assert edge_registry.checkpoint_path(method) is None
    assert edge_registry.available(method) is True


def test_a_relative_checkpoint_resolves_against_the_registry_dir(registry, tmp_path):
    path = registry({'methods': [dict(CENTRELINE, id='teed', checkpoint='teed.pt')]})
    method = edge_registry.get_method('teed')
    assert edge_registry.checkpoint_path(method) == path.parent / 'teed.pt'
    assert edge_registry.available(method) is False  # not written yet
    (path.parent / 'teed.pt').write_bytes(b'weights')
    assert edge_registry.available(edge_registry.get_method('teed')) is True


def test_an_absolute_checkpoint_is_left_alone(registry, tmp_path):
    ckpt = tmp_path / 'elsewhere' / 'pidinet.pt'
    registry({'methods': [dict(CENTRELINE, id='pidinet', checkpoint=str(ckpt))]})
    assert edge_registry.checkpoint_path(edge_registry.get_method('pidinet')) == ckpt


def test_unknown_ids_are_absent(registry):
    registry({'methods': [CENTRELINE]})
    assert edge_registry.get_method('nope') is None
