"""The map-segmentation registry: which pre-trained checkpoints exist and what vocabulary
each was trained on, read from a JSON file that is dropped in beside the models.

Nothing here may raise. A malformed or missing file has to read as "no models" so an
annotation-only map dataset keeps working, rather than taking the page down with it.
"""
import json

import pytest

from app import model_registry

MODEL = {
    'id': 'cadastre-v2',
    'label': 'Cadastre v2',
    'checkpoint': 'cadastre_v2.pt',
    'classes': [
        {'id': 0, 'name': 'background', 'color': [0, 0, 0]},
        {'id': 1, 'name': 'Building', 'color': [255, 0, 0]},
        {'id': 2, 'name': 'Water', 'color': [0, 0, 255]},
    ],
    'class_priority': ['Water', 'Building'],
}


@pytest.fixture
def registry(tmp_path, monkeypatch):
    path = tmp_path / 'registry.json'
    monkeypatch.setattr('app.config.MAPSEG_REGISTRY', path)

    def write(payload):
        path.write_text(json.dumps(payload) if not isinstance(payload, str) else payload,
                        encoding='utf-8')
        return path

    write({'models': [MODEL]})
    return write


class TestReading:
    def test_a_registered_model_is_listed_with_its_classes(self, registry):
        listed = model_registry.list_models()

        assert [m['id'] for m in listed] == ['cadastre-v2']
        assert [c['name'] for c in listed[0]['classes']] == ['background', 'Building', 'Water']

    def test_it_says_whether_the_checkpoint_is_actually_there(self, registry, tmp_path):
        assert model_registry.list_models()[0]['checkpoint_available'] is False

        (tmp_path / 'cadastre_v2.pt').write_bytes(b'weights')

        assert model_registry.list_models()[0]['checkpoint_available'] is True

    def test_a_model_can_be_looked_up_by_id(self, registry):
        assert model_registry.get_model('cadastre-v2')['label'] == 'Cadastre v2'
        assert model_registry.get_model('nothing-like-it') is None

    def test_a_model_dropped_in_is_visible_without_a_restart(self, registry):
        """The file is read fresh each call, which is what makes that true."""
        assert len(model_registry.list_models()) == 1

        registry({'models': [MODEL, {**MODEL, 'id': 'cadastre-v3'}]})

        assert len(model_registry.list_models()) == 2


class TestWhereTheCheckpointIs:
    def test_a_relative_path_is_resolved_against_the_registry(self, registry, tmp_path):
        assert model_registry.checkpoint_path(MODEL) == tmp_path / 'cadastre_v2.pt'

    def test_an_absolute_path_is_left_alone(self, registry):
        model = {**MODEL, 'checkpoint': '/models/elsewhere.pt'}

        assert str(model_registry.checkpoint_path(model)) == '/models/elsewhere.pt'


class TestPriority:
    def test_the_priority_list_decides_which_class_wins(self, registry):
        payload = {c['name']: c['priority'] for c in model_registry.classes_payload(MODEL)}

        assert payload['Water'] == 0
        assert payload['Building'] == 1

    def test_a_class_nobody_ranked_sorts_last(self, registry):
        payload = {c['name']: c['priority'] for c in model_registry.classes_payload(MODEL)}

        assert payload['background'] == 2, 'after both ranked names'

    def test_a_model_with_no_priority_list_ranks_everything_equally(self, registry):
        model = {k: v for k, v in MODEL.items() if k != 'class_priority'}

        assert {c['priority'] for c in model_registry.classes_payload(model)} == {0}


class TestARegistryThatCannotBeTrusted:
    def test_a_file_that_is_not_there_reads_as_no_models(self, tmp_path, monkeypatch):
        monkeypatch.setattr('app.config.MAPSEG_REGISTRY', tmp_path / 'absent.json')

        assert model_registry.list_models() == []

    def test_a_file_that_is_not_json_reads_as_no_models(self, registry):
        registry('{not json at all')

        assert model_registry.list_models() == []

    def test_a_file_with_no_models_key_reads_as_no_models(self, registry):
        registry({'something': 'else'})

        assert model_registry.list_models() == []

    @pytest.mark.parametrize('broken, why', [
        ({'label': 'No id', 'checkpoint': 'a.pt', 'classes': MODEL['classes']}, 'no id'),
        ({**MODEL, 'checkpoint': ''}, 'empty checkpoint'),
        ({**MODEL, 'classes': []}, 'no classes'),
        ({**MODEL, 'classes': [{'id': 1, 'name': 'Building', 'color': [255, 0, 0]}]},
         'no background class'),
        ({**MODEL, 'classes': [{'id': 0, 'name': 'bg', 'color': [0, 0, 0]},
                               {'id': 0, 'name': 'clash', 'color': [1, 1, 1]}]}, 'duplicate ids'),
        ({**MODEL, 'classes': [{'id': 0, 'name': 'bg', 'color': 'red'}]}, 'colour is not rgb'),
        ({**MODEL, 'classes': [{'id': 0, 'name': 'bg', 'color': [0, 0, 300]}]}, 'colour out of range'),
        ({**MODEL, 'class_priority': 'Water'}, 'priority is not a list'),
        ('a model as a bare string', 'the entry is not an object'),
        ({**MODEL, 'classes': ['Building']}, 'a class is not an object'),
        ({**MODEL, 'classes': [{'id': 'nought', 'name': 'bg', 'color': [0, 0, 0]}]},
         'a class id is not a number'),
        ({**MODEL, 'classes': [*MODEL['classes'], {'id': 256, 'name': 'Wide', 'color': [1, 1, 1]}]},
         'a class id an 8-bit mask cannot hold'),
        ({**MODEL, 'classes': [*MODEL['classes'], {'id': -1, 'name': 'Below', 'color': [1, 1, 1]}]},
         'a negative class id'),
    ])
    def test_an_entry_that_does_not_hold_together_is_dropped(self, registry, broken, why):
        registry({'models': [broken]})

        assert model_registry.list_models() == [], why

    def test_one_broken_entry_does_not_hide_the_good_ones(self, registry):
        registry({'models': [{'id': 'broken'}, MODEL]})

        assert [m['id'] for m in model_registry.list_models()] == ['cadastre-v2']
