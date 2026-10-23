import pytest

from app import config


def test_each_card_names_its_largest_node_count_and_maybe_its_own_partition():
    assert config.slurm_gpus('h200:8, rtx6000bb:7,l40s:4:inference') == {
        'h200': (8, None), 'rtx6000bb': (7, None), 'l40s': (4, 'inference')}


def test_no_cards_configured_offers_no_card_choice():
    assert config.slurm_gpus('') == {}


@pytest.mark.parametrize('raw', ['h200', 'h200:eight', 'h200:0', 'h200:2:a:b'])
def test_a_malformed_card_is_refused_at_startup_naming_it(raw):
    with pytest.raises(ValueError, match='SLURM_GPUS'):
        config.slurm_gpus(raw)
