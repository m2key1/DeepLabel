"""The knobs a training run may tune. A model backend declares them for its trainer (6.2):
a third-party trainer has knobs DeepLabel cannot know, so the backend names them, with the
defaults an untuned run there uses."""
from dataclasses import dataclass


@dataclass(frozen=True)
class Tunable:
    key: str
    label: str
    group: str
    kind: str
    help: str
    min: float | None = None
    max: float | None = None
    # A bound the value must stay strictly above - a zero learning rate trains nothing.
    above: float | None = None
    # The values a 'choice' knob accepts, in the order the dialog lists them.
    choices: tuple[str, ...] = ()

    def public(self) -> dict:
        return {'key': self.key, 'label': self.label, 'group': self.group, 'kind': self.kind,
                'help': self.help, 'min': self.min, 'max': self.max, 'above': self.above,
                'choices': list(self.choices)}


class TunableError(ValueError):
    """A value the declared knobs refuse; the message names the knob and the rule."""


def declared(train_info: dict) -> tuple[Tunable, ...]:
    """The knobs a model backend declares for its trainer (6.2), as this module's own:
    a third-party trainer has knobs DeepLabel cannot know, so the backend names them."""
    return tuple(Tunable(t['key'], t.get('label', t['key']), t.get('group', ''), t.get('kind', 'float'),
                         t.get('help', ''), t.get('min'), t.get('max'), t.get('above'),
                         tuple(t.get('choices') or ()))
                 for t in train_info.get('tunables') or [])


def declared_options(train_info: dict, backend: str) -> dict:
    """The dialog's view of a run trained on a model backend: its knobs with the defaults
    it declares, which are what an untuned run there uses."""
    defaults_by_key = {t['key']: t.get('default') for t in train_info.get('tunables') or []}
    return {'tunables': [{**t.public(), 'default': defaults_by_key.get(t.key)} for t in declared(train_info)],
            'columns': {'epochs': train_info['default_epochs']} if train_info.get('default_epochs') else {},
            'source': f'model backend "{backend}"'}


def validate(values: dict, knobs: tuple[Tunable, ...]) -> dict:
    """Checks every value against the knobs a model backend declares and returns them
    normalised: whole-number floats become ints, so a patience of 10.0 is stored and sent
    as 10, and keys in the declared order, so a run's record reads the same whatever order
    the client sent."""
    by_key = {t.key: t for t in knobs}
    for key in values:
        if key not in by_key:
            raise TunableError(f'unknown hyperparameter {key}')
    checked = {}
    for key, knob in by_key.items():
        if key not in values:
            continue
        value = values[key]
        if knob.kind == 'bool':
            if not isinstance(value, bool):
                raise TunableError(f'{key} must be true or false')
            checked[key] = value
            continue
        if knob.kind == 'choice':
            if value not in knob.choices:
                raise TunableError(f'{key} must be one of {", ".join(knob.choices)}')
            checked[key] = value
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise TunableError(f'{key} must be a number')
        if knob.kind == 'int':
            if value != int(value):
                raise TunableError(f'{key} must be a whole number')
            value = int(value)
        if knob.above is not None and value <= knob.above:
            raise TunableError(f'{key} must be greater than {knob.above:g}')
        if knob.min is not None and value < knob.min:
            raise TunableError(f'{key} must be at least {knob.min:g}')
        if knob.max is not None and value > knob.max:
            raise TunableError(f'{key} must be at most {knob.max:g}')
        checked[key] = value
    return checked
