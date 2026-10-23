"""Settings arrive through compose, which passes an unset variable as an empty string
rather than leaving it out. `os.environ.get(name, default)` only falls back when the key is
absent, so an empty one reached float() and ended the process at import - a deployment
crash-looped on 2026-09-11 because one variable was declared and not set.
"""
import importlib
import re
from pathlib import Path

import pytest

from app import config

NUMBERS = sorted(set(re.findall(r"_number\('([A-Z0-9_]+)'", Path(config.__file__).read_text())))
FLAGS = sorted(set(re.findall(r"_flag\('([A-Z0-9_]+)'", Path(config.__file__).read_text())))


def test_the_settings_were_actually_found():
    """A regex that matched nothing would make every test below vacuous."""
    assert len(NUMBERS) > 10 and len(FLAGS) > 3


@pytest.mark.parametrize('name', NUMBERS)
def test_an_empty_number_falls_back_instead_of_ending_the_process(name, monkeypatch):
    monkeypatch.setenv(name, '')

    reloaded = importlib.reload(config)

    try:
        assert getattr(reloaded, name) == getattr(config, name)
    finally:
        monkeypatch.undo()
        importlib.reload(config)


@pytest.mark.parametrize('name', FLAGS)
def test_an_empty_flag_falls_back_too(name, monkeypatch):
    monkeypatch.setenv(name, '')

    reloaded = importlib.reload(config)

    try:
        # Its own declared default, whichever way that points: a flag that is off by
        # default must not come up on because compose passed an empty string.
        assert getattr(reloaded, name) is getattr(config, name)
    finally:
        monkeypatch.undo()
        importlib.reload(config)


def test_every_number_is_still_read_from_its_variable(monkeypatch):
    monkeypatch.setenv('OCR_CHUNK_LINES', '7')
    monkeypatch.setenv('LLM_TIMEOUT', '12.5')

    reloaded = importlib.reload(config)

    try:
        assert (reloaded.OCR_CHUNK_LINES, reloaded.LLM_TIMEOUT) == (7, 12.5)
    finally:
        monkeypatch.undo()
        importlib.reload(config)


def test_whitespace_counts_as_unset(monkeypatch):
    monkeypatch.setenv('OCR_CHUNK_LINES', '  ')

    reloaded = importlib.reload(config)

    try:
        assert reloaded.OCR_CHUNK_LINES == 512
    finally:
        monkeypatch.undo()
        importlib.reload(config)
