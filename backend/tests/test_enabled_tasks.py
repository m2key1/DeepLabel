"""A deployment can switch job kinds off in its .env. The picker hides them, but the
refusal has to live in the backend - hiding a button is not a restriction.
"""
import pytest
from fastapi import HTTPException

from app import config, ingest

ALL = ['text', 'map_segmentation', 'map_lines']


@pytest.fixture
def only(monkeypatch):
    """Enable exactly the named tasks for one test."""
    def apply(*tasks: str):
        monkeypatch.setattr(config, 'ENABLE_TEXT', 'text' in tasks)
        monkeypatch.setattr(config, 'ENABLE_MAP_SEGMENTATION', 'map_segmentation' in tasks)
        monkeypatch.setattr(config, 'ENABLE_MAP_LINES', 'map_lines' in tasks)
    return apply


def test_all_tasks_are_enabled_by_default():
    # The defaults must not change behaviour for deployments that set nothing.
    assert config.enabled_tasks() == ALL


@pytest.mark.parametrize('task', ALL)
def test_an_enabled_task_is_accepted(only, task):
    only(*ALL)
    assert ingest.valid_task(task) == task


@pytest.mark.parametrize('task', ALL)
def test_a_disabled_task_is_refused(only, task):
    only(*[t for t in ALL if t != task])
    with pytest.raises(HTTPException) as e:
        ingest.valid_task(task)
    assert e.value.status_code == 400
    assert 'disabled' in e.value.detail


def test_a_text_only_deployment(only):
    """Text extraction on, both map tasks off."""
    only('text')
    assert config.enabled_tasks() == ['text']
    assert ingest.valid_task('text') == 'text'
    for task in ('map_segmentation', 'map_lines'):
        with pytest.raises(HTTPException):
            ingest.valid_task(task)


def test_an_unknown_task_is_still_rejected(only):
    only(*ALL)
    with pytest.raises(HTTPException) as e:
        ingest.valid_task('nonsense')
    assert e.value.status_code == 400


def test_disabling_everything_refuses_every_task(only):
    only()
    assert config.enabled_tasks() == []
    for task in ALL:
        with pytest.raises(HTTPException):
            ingest.valid_task(task)
