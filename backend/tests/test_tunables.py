"""A training run's knobs are the ones its model backend declares (6.2): the route
validates against them and the dialog shows the defaults the backend declares."""
import pytest

from app import tunables

TRAIN_INFO = {
    'default_epochs': 20,
    'tunables': [
        {'key': 'learning_rate', 'label': 'Learning rate', 'group': 'Schedule', 'kind': 'float',
         'above': 0, 'default': 1e-4},
        {'key': 'warmup_epochs', 'label': 'Warmup epochs', 'group': 'Schedule', 'kind': 'float', 'min': 0},
        {'key': 'patience', 'label': 'Patience', 'group': 'Schedule', 'kind': 'int', 'min': 1},
        {'key': 'ema_decay', 'label': 'EMA decay', 'group': 'Model', 'kind': 'float', 'min': 0, 'max': 1},
        {'key': 'freeze_backbone', 'label': 'Freeze backbone', 'group': 'Model', 'kind': 'bool',
         'default': False},
        {'key': 'variant', 'label': 'Variant', 'group': 'Model', 'kind': 'choice',
         'choices': ['tiny', 'small', 'medium'], 'default': 'medium'},
    ],
}
KNOBS = tunables.declared(TRAIN_INFO)


class TestValidate:
    def test_normalises_whole_floats_to_ints_and_keeps_bools(self):
        checked = tunables.validate({'patience': 10.0, 'warmup_epochs': 2.5, 'freeze_backbone': True}, KNOBS)
        assert checked == {'warmup_epochs': 2.5, 'patience': 10, 'freeze_backbone': True}
        assert isinstance(checked['patience'], int)

    @pytest.mark.parametrize('values, message', [
        ({'bogus': 1}, 'unknown hyperparameter bogus'),
        ({'freeze_backbone': 1}, 'freeze_backbone must be true or false'),
        ({'warmup_epochs': True}, 'warmup_epochs must be a number'),
        ({'warmup_epochs': 'two'}, 'warmup_epochs must be a number'),
        ({'patience': 2.5}, 'patience must be a whole number'),
        ({'patience': 0}, 'patience must be at least 1'),
        ({'learning_rate': 0}, 'learning_rate must be greater than 0'),
        ({'ema_decay': 1.5}, 'ema_decay must be at most 1'),
        ({'variant': 'huge'}, 'variant must be one of tiny, small, medium'),
        ({'variant': 2}, 'variant must be one of tiny, small, medium'),
    ])
    def test_refuses_what_the_declared_knobs_forbid(self, values, message):
        with pytest.raises(tunables.TunableError, match=message):
            tunables.validate(values, KNOBS)

    def test_keeps_a_choice_a_string(self):
        assert tunables.validate({'variant': 'small'}, KNOBS) == {'variant': 'small'}

    def test_keeps_the_declared_order_whatever_the_client_sent(self):
        checked = tunables.validate({'freeze_backbone': True, 'patience': 5, 'learning_rate': 1e-5}, KNOBS)
        assert list(checked) == ['learning_rate', 'patience', 'freeze_backbone']


def test_the_dialog_is_shown_each_knob_with_the_default_the_backend_declares():
    options = tunables.declared_options(TRAIN_INFO, 'ocr')

    assert [(t['key'], t['default']) for t in options['tunables']] == [
        ('learning_rate', 1e-4), ('warmup_epochs', None), ('patience', None), ('ema_decay', None),
        ('freeze_backbone', False), ('variant', 'medium')]
    assert options['tunables'][5]['choices'] == ['tiny', 'small', 'medium']
    assert options['columns'] == {'epochs': 20}
    assert options['source'] == 'model backend "ocr"'
