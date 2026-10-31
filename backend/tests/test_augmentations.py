"""Augmentation pipelines: private per user with one admin-owned default per task, specs
checked by the training backend before they are stored, and a preview that cuts real
checked lines the way the snapshot does. The backend's trainer is faked here.
"""
import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import augmentations, config, store, trainer
from app.backend_client import BackendError
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'


def headers(user: str, role: str) -> dict:
    return {'X-Frontend-Secret': SECRET, 'X-Auth-User': user, 'X-Auth-Role': role}


ADMIN = headers('root', 'admin')
MEMBER = headers('mia', 'member')
OTHER = headers('oskar', 'member')
VIEWER = headers('vera', 'viewer')

# Captured before any test patches it, for the tests that want the real one back.
REAL_CHECK_SPEC = augmentations.check_spec

SPEC = {'transform': {'__class_fullname__': 'Compose', 'p': 1.0, 'transforms': [
    {'__class_fullname__': 'GaussNoise', 'p': 0.3, 'std_range': [0.2, 0.44]},
    {'__class_fullname__': 'OneOf', 'p': 0.3, 'transforms': [
        {'__class_fullname__': 'Morphological', 'p': 1.0, 'operation': 'erosion', 'scale': [3, 7]},
    ]},
]}}


@pytest.fixture
def fresh_catalog():
    augmentations._catalogs.clear()
    yield
    augmentations._catalogs.clear()


class FakeTrainer:
    """A model backend's trainer, as the catalog and builtin_spec ask it."""

    def __init__(self, answer: dict | BackendError):
        self.answer = answer

    def _call(self, method: str, path: str):
        assert (method, path) == ('GET', '/v1/train/augmentations')
        if isinstance(self.answer, BackendError):
            raise self.answer
        return self.answer


def trains_with(monkeypatch, answer: dict | BackendError):
    monkeypatch.setattr(augmentations, 'trainer_backend', lambda task: FakeTrainer(answer))


def draws_with(monkeypatch, draw):
    """The backend's preview, played by `draw(spec, images, seed, draws)`."""
    monkeypatch.setattr(augmentations.backend_client, 'preview_augmentations',
                        lambda client, spec, images, seed, draws=1: draw(spec, images, seed, draws))


def never_drawn(spec, images, seed, draws):
    pytest.fail('the backend was asked')


def compose(*steps) -> dict:
    return {'transform': {'__class_fullname__': 'Compose', 'p': 1.0, 'transforms': list(steps)}}


class TestSpecErrors:
    def test_a_sound_spec_passes(self):
        assert augmentations.spec_errors(SPEC) is None

    @pytest.mark.parametrize('spec, message', [
        ({'transform': {'__class_fullname__': 'OneOf', 'transforms': []}}, 'root of a pipeline must be a Compose'),
        (compose({'__class_fullname__': 'OneOf', 'p': 0.5, 'transforms': []}), 'OneOf: a group needs at least one step'),
        (compose({'__class_fullname__': 'GaussNoise', 'p': 1.5}), 'GaussNoise: p must be between 0 and 1'),
        (compose({'__class_fullname__': 'SomeOf', 'p': 1.0, 'n': 0,
                  'transforms': [{'__class_fullname__': 'GaussNoise'}]}), 'SomeOf: n must be a whole number'),
        (compose({'__class_fullname__': 'Normalize', 'p': 1.0}), 'the trainer applies Normalize itself'),
        (compose({'p': 1.0}), 'every step names its transform'),
        ({'nope': 1}, 'object with a "transform" root'),
        ({'transform': {'__class_fullname__': 'Compose', 'p': 1.0, 'transforms': None}},
         'Compose: a group holds a list of steps'),
        (compose({'__class_fullname__': 'OneOf', 'p': 1.0, 'transforms': 3}), 'OneOf: a group holds a list of steps'),
        (compose('GaussNoise'), 'Compose[0]: a step is an object'),
    ])
    def test_refuses_shapes_albumentations_would_choke_on(self, spec, message):
        assert message in augmentations.spec_errors(spec)

    def test_refuses_a_pipeline_beyond_the_step_cap(self):
        many = compose(*[{'__class_fullname__': 'InvertImg', 'p': 0.5}] * (augmentations.MAX_NODES + 1))
        assert 'at most' in augmentations.spec_errors(many)

    def test_only_groups_are_walked_for_steps(self):
        stray = compose({'__class_fullname__': 'GaussNoise', 'p': 0.3, 'transforms': 5})
        assert augmentations.spec_errors(stray) is None

    def test_strip_trainer_tail_drops_what_the_trainer_appends_itself(self):
        spec = compose({'__class_fullname__': 'GaussNoise', 'p': 0.3}, {'__class_fullname__': 'Normalize', 'p': 1.0},
                       {'__class_fullname__': 'ToTensorV2', 'p': 1.0})
        stripped = augmentations.strip_trainer_tail(spec)
        assert [t['__class_fullname__'] for t in stripped['transform']['transforms']] == ['GaussNoise']


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    # The backend's verdict is stubbed per test.
    monkeypatch.setattr(augmentations, 'check_spec', lambda spec, task='ocr': None)
    trains_with(monkeypatch, {'transforms': []})
    conn = store.connect(tmp_path / 'app.db')
    scan = tmp_path / 'p1.png'
    Image.new('RGB', (200, 60), 'white').save(scan)
    conn.execute("INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'Letters', 'mia', 'done')")
    conn.execute("INSERT INTO pages (id, job_id, idx, filename, source_file, status) "
                 "VALUES (1, 'j1', 0, 'p1.png', ?, 'done')", (str(scan),))
    conn.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) "
                 "VALUES (1, 1, 0, 'Paragraph', '[0,0,1,1]', 'content')")
    for index in range(6):
        top, bottom = index / 6, (index + 1) / 6
        conn.execute(
            'INSERT INTO lines (id, element_id, order_idx, polygon, text, checked) VALUES (?, 1, ?, ?, ?, 1)',
            (index + 1, index, json.dumps([[0, top], [1, top], [1, bottom], [0, bottom]]), f'line {index + 1}'))
    conn.commit()
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()
    conn.close()


def create(client, who, name='Mine', spec=SPEC, task='ocr'):
    return client.post('/api/augmentations/pipelines', headers=who, json={'task': task, 'name': name, 'spec': spec})


def listed(client, who, task='ocr'):
    return client.get(f'/api/augmentations/pipelines?task={task}', headers=who).json()['pipelines']


class TestPipelines:
    def test_a_viewer_cannot_save_pipelines(self, client):
        assert create(client, VIEWER).status_code == 403

    def test_a_pipeline_is_private_to_whoever_saved_it(self, client):
        created = create(client, MEMBER).json()
        assert created['owner'] == 'mia' and created['editable'] is True and created['is_default'] is False
        assert created['spec'] == SPEC
        assert [p['id'] for p in listed(client, MEMBER)] == [created['id']]
        assert listed(client, OTHER) == []
        assert listed(client, ADMIN) == []
        assert client.patch(f'/api/augmentations/pipelines/{created["id"]}', headers=OTHER,
                            json={'name': 'Taken'}).status_code == 404

    def test_names_are_unique_per_person_and_task_ignoring_case(self, client):
        assert create(client, MEMBER, 'Heavy').status_code == 200
        assert create(client, MEMBER, 'heavy').status_code == 409
        # Another person, or another task, may reuse it.
        assert create(client, OTHER, 'Heavy').status_code == 200
        assert create(client, MEMBER, 'Heavy', task='layout').status_code == 200

    def test_a_spec_the_backend_refuses_is_not_stored(self, client, monkeypatch):
        monkeypatch.setattr(augmentations, 'check_spec', lambda spec, task='ocr':
                            'Compose[0].GaussNoise: std_range: the low end must not exceed the high end')
        res = create(client, MEMBER)
        assert res.status_code == 400
        assert 'GaussNoise: std_range' in res.json()['detail']
        assert listed(client, MEMBER) == []

    def test_a_spec_the_app_can_refuse_itself_never_reaches_the_backend(self, client, monkeypatch):
        monkeypatch.setattr(augmentations, 'check_spec', REAL_CHECK_SPEC)
        draws_with(monkeypatch, never_drawn)
        res = create(client, MEMBER, spec=compose({'__class_fullname__': 'Normalize', 'p': 1.0}))
        assert res.status_code == 400
        assert 'the trainer applies Normalize itself' in res.json()['detail']

    def test_a_transform_the_catalog_does_not_offer_is_refused(self, client, monkeypatch, fresh_catalog):
        monkeypatch.setattr(augmentations, 'check_spec', REAL_CHECK_SPEC)
        trains_with(monkeypatch, {'version': 'x', 'transforms': [{'name': 'GaussNoise'}]})
        draws_with(monkeypatch, lambda spec, images, seed, draws: ['data:,'] * len(images))
        # TextImage reads a font off disk; the builder never offers it, so neither does the API.
        res = create(client, MEMBER, spec=compose({'__class_fullname__': 'TextImage', 'p': 1.0}))
        assert res.status_code == 400
        assert 'TextImage: not a transform this deployment offers' in res.json()['detail']
        assert create(client, MEMBER, spec=compose(
            {'__class_fullname__': 'OneOf', 'p': 1.0,
             'transforms': [{'__class_fullname__': 'GaussNoise', 'p': 1.0}]})).status_code == 200

    def test_the_catalog_being_unreadable_does_not_block_saving(self, client, monkeypatch, fresh_catalog):
        monkeypatch.setattr(augmentations, 'check_spec', REAL_CHECK_SPEC)
        trains_with(monkeypatch, BackendError('unavailable', 'catalog down'))
        draws_with(monkeypatch, lambda spec, images, seed, draws: ['data:,'] * len(images))
        assert create(client, MEMBER).status_code == 200

    def test_a_step_the_backend_cannot_build_is_refused_by_name(self, client, monkeypatch, fresh_catalog):
        monkeypatch.setattr(augmentations, 'check_spec', REAL_CHECK_SPEC)
        trains_with(monkeypatch, {'transforms': [{'name': 'GaussNoise'}, {'name': 'Morphological'}]})

        def refused(spec, images, seed, draws):
            raise BackendError('invalid_spec', 'Compose[0].GaussNoise: std_range: the low end must not exceed the high end')
        draws_with(monkeypatch, refused)
        res = create(client, MEMBER)
        assert res.status_code == 400
        assert res.json()['detail'] == 'Compose[0].GaussNoise: std_range: the low end must not exceed the high end'
        assert listed(client, MEMBER) == []

    def test_no_backend_to_check_with_is_a_503_not_a_bad_request(self, client, monkeypatch):
        monkeypatch.setattr(augmentations, 'check_spec', REAL_CHECK_SPEC)
        monkeypatch.setattr(augmentations, 'trainer_backend', lambda task: None)
        res = create(client, MEMBER)
        assert res.status_code == 503
        assert res.json()['detail'] == 'the pipeline could not be checked: no configured model backend trains ocr'

    def test_the_owner_renames_and_reshapes_it(self, client):
        created = create(client, MEMBER).json()
        new_spec = compose({'__class_fullname__': 'InvertImg', 'p': 0.2})
        res = client.patch(f'/api/augmentations/pipelines/{created["id"]}', headers=MEMBER,
                           json={'name': 'Renamed', 'spec': new_spec})
        assert res.status_code == 200, res.text
        assert res.json()['name'] == 'Renamed' and res.json()['spec'] == new_spec
        assert client.delete(f'/api/augmentations/pipelines/{created["id"]}', headers=MEMBER).json() == {'ok': True}
        assert listed(client, MEMBER) == []

    def test_an_admin_marks_one_of_their_own_as_the_task_default(self, client):
        first = create(client, ADMIN, 'Light').json()
        second = create(client, ADMIN, 'Heavy').json()
        marked = client.post(f'/api/augmentations/pipelines/{first["id"]}/default', headers=ADMIN,
                             json={'default': True})
        assert marked.status_code == 200 and marked.json()['is_default'] is True
        # Everyone sees the default, read-only; nothing else of the admin's.
        seen = listed(client, MEMBER)
        assert [(p['name'], p['editable'], p['is_default']) for p in seen] == [('Light', False, True)]
        assert client.patch(f'/api/augmentations/pipelines/{first["id"]}', headers=MEMBER,
                            json={'name': 'Mine now'}).status_code == 403
        assert client.delete(f'/api/augmentations/pipelines/{first["id"]}', headers=MEMBER).status_code == 403
        # One default per task: marking another replaces it.
        client.post(f'/api/augmentations/pipelines/{second["id"]}/default', headers=ADMIN, json={'default': True})
        assert [p['name'] for p in listed(client, MEMBER)] == ['Heavy']
        assert augmentations.task_default(app.dependency_overrides[get_db](), 'ocr')['id'] == second['id']
        # Unmarking leaves the task on the built-in stack.
        client.post(f'/api/augmentations/pipelines/{second["id"]}/default', headers=ADMIN, json={'default': False})
        assert listed(client, MEMBER) == []

    def test_only_an_admin_and_only_their_own_can_be_the_default(self, client):
        mine = create(client, MEMBER).json()
        assert client.post(f'/api/augmentations/pipelines/{mine["id"]}/default', headers=MEMBER,
                           json={'default': True}).status_code == 403
        # A member's private pipeline does not exist for the admin either.
        assert client.post(f'/api/augmentations/pipelines/{mine["id"]}/default', headers=ADMIN,
                           json={'default': True}).status_code == 404

    def test_anyone_duplicates_the_default_into_their_own_list(self, client):
        default = create(client, ADMIN, 'Light').json()
        client.post(f'/api/augmentations/pipelines/{default["id"]}/default', headers=ADMIN, json={'default': True})
        copy = client.post(f'/api/augmentations/pipelines/{default["id"]}/duplicate', headers=MEMBER)
        assert copy.status_code == 200, copy.text
        assert copy.json()['owner'] == 'mia' and copy.json()['name'] == 'Light (copy)'
        assert copy.json()['editable'] is True and copy.json()['is_default'] is False
        again = client.post(f'/api/augmentations/pipelines/{default["id"]}/duplicate', headers=MEMBER).json()
        assert again['name'] == 'Light (copy 2)'
        # Someone else's private pipeline cannot be copied - it is not there to copy.
        assert client.post(f'/api/augmentations/pipelines/{copy.json()["id"]}/duplicate',
                           headers=OTHER).status_code == 404

    def test_copies_of_a_name_that_fills_the_field_stay_distinct_and_within_it(self, client):
        full = 'A' * augmentations.MAX_NAME_LENGTH
        original = create(client, MEMBER, full).json()
        copies = [client.post(f'/api/augmentations/pipelines/{original["id"]}/duplicate', headers=MEMBER).json()
                  for _ in range(2)]
        assert [c['name'] for c in copies] == ['A' * 73 + ' (copy)', 'A' * 71 + ' (copy 2)']

    def test_deleting_the_default_clears_it(self, client):
        default = create(client, ADMIN, 'Light').json()
        client.post(f'/api/augmentations/pipelines/{default["id"]}/default', headers=ADMIN, json={'default': True})
        client.delete(f'/api/augmentations/pipelines/{default["id"]}', headers=ADMIN)
        assert augmentations.task_default(app.dependency_overrides[get_db](), 'ocr') is None

    def test_the_builtin_stack_comes_from_the_backend_without_its_tail(self, client, monkeypatch):
        stack = compose({'__class_fullname__': 'GaussNoise', 'p': 0.3}, {'__class_fullname__': 'Normalize', 'p': 1.0})
        trains_with(monkeypatch, {'transforms': [], 'default': stack})
        body = client.get('/api/augmentations/pipelines?task=ocr', headers=MEMBER).json()
        assert body['builtin'] == {'spec': compose({'__class_fullname__': 'GaussNoise', 'p': 0.3}), 'error': None}
        monkeypatch.setattr(augmentations, 'trainer_backend', lambda task: None)
        body = client.get('/api/augmentations/pipelines?task=ocr', headers=MEMBER).json()
        assert body['builtin'] == {'spec': None, 'error': 'no configured model backend trains ocr'}


class TestPreview:
    def test_the_sample_is_seeded_and_spans_the_datasets(self, client):
        conn = app.dependency_overrides[get_db]()
        assert len(augmentations.sample_lines(conn, ['j1'], seed=1)) == 1, 'one line, so the preview stays one look'
        first = [s['id'] for s in augmentations.sample_lines(conn, ['j1'], seed=1, count=4)]
        assert len(first) == 4
        assert first == [s['id'] for s in augmentations.sample_lines(conn, ['j1'], seed=1, count=4)]
        assert first != [s['id'] for s in augmentations.sample_lines(conn, ['j1'], seed=2, count=4)]
        assert augmentations.sample_lines(conn, [], seed=1) == []

    def test_each_next_seed_shows_a_line_not_yet_seen(self, client):
        """Change lines steps the seed by one: every checked line comes up once before any
        comes back, so a click never shows the same line again."""
        conn = app.dependency_overrides[get_db]()
        checked = {row[0] for row in conn.execute(
            "SELECT l.id FROM lines l JOIN elements e ON l.element_id = e.id JOIN pages p ON e.page_id = p.id "
            "WHERE p.job_id = 'j1' AND l.checked = 1 AND l.deleted = 0")}
        shown = [augmentations.sample_lines(conn, ['j1'], seed=seed)[0]['id'] for seed in range(1, len(checked) + 2)]
        assert len(checked) > 1
        assert set(shown[:-1]) == checked
        assert shown[-1] == shown[0]

    def test_renders_each_sampled_line_before_and_after_at_the_models_height(self, client, monkeypatch):
        conn = app.dependency_overrides[get_db]()
        conn.execute("INSERT INTO models (task, name, checkpoint, is_default, target_height) VALUES ('ocr', 'OCR', '', 1, 64)")
        conn.commit()
        calls = []

        def draw(spec, images, seed, draws):
            calls.append((spec, [image.height for image in images], seed, draws))
            return [f'data:image/png;base64,draws-{draws}'] * len(images)
        draws_with(monkeypatch, draw)
        res = client.post('/api/augmentations/preview', headers=MEMBER,
                          json={'task': 'ocr', 'spec': SPEC, 'job_ids': ['j1'],
                                'line_seed': 5, 'render_seed': 3})
        assert res.status_code == 200, res.text
        body = res.json()
        assert body['ok'] is True and body['height'] == 64
        assert (body['line_seed'], body['render_seed']) == (5, 3)
        assert len(body['samples']) == 1
        sample = body['samples'][0]
        assert sample['dataset'] == 'Letters' and sample['text'].startswith('line ')
        assert sample['original'].startswith('data:image/png;base64,')
        assert sample['augmented'] == 'data:image/png;base64,draws-1'
        # The harshest of the run's draws travels beside the first one.
        assert sample['harshest'] == f'data:image/png;base64,draws-{augmentations.HARSHEST_DRAWS}'
        assert body['draws'] == augmentations.HARSHEST_DRAWS
        # Only the render seed reaches the backend; the line seed chose the crops here.
        assert calls == [(SPEC, [64], 3, 1), (SPEC, [64], 3, augmentations.HARSHEST_DRAWS)]

    def test_a_spec_the_backend_refuses_names_the_step(self, client, monkeypatch):
        def refused(spec, images, seed, draws):
            raise BackendError('invalid_spec', 'Compose[0].GaussNoise: std_range: the low end must not exceed the high end')
        draws_with(monkeypatch, refused)
        body = client.post('/api/augmentations/preview', headers=MEMBER,
                           json={'task': 'ocr', 'spec': SPEC, 'job_ids': ['j1']}).json()
        assert body['ok'] is False and 'GaussNoise: std_range' in body['error'] and body['samples'] == []

    def test_a_shape_error_is_caught_before_any_crop_is_cut(self, client, monkeypatch):
        draws_with(monkeypatch, never_drawn)
        body = client.post('/api/augmentations/preview', headers=MEMBER, json={
            'task': 'ocr', 'spec': compose({'__class_fullname__': 'GaussNoise', 'p': 2}), 'job_ids': ['j1']}).json()
        assert body['ok'] is False and 'p must be between 0 and 1' in body['error']

    def test_no_checked_lines_is_a_message_not_a_crash(self, client, monkeypatch):
        conn = app.dependency_overrides[get_db]()
        conn.execute('UPDATE lines SET checked = 0')
        conn.commit()
        body = client.post('/api/augmentations/preview', headers=MEMBER,
                           json={'task': 'ocr', 'spec': SPEC, 'job_ids': ['j1']}).json()
        assert body['ok'] is False and 'no checked lines' in body['error']

    def test_a_scan_that_is_not_there_is_named_in_the_message(self, client, monkeypatch):
        conn = app.dependency_overrides[get_db]()
        conn.execute("UPDATE pages SET source_file = '/gone/scan.png'")
        conn.commit()
        draws_with(monkeypatch, never_drawn)
        body = client.post('/api/augmentations/preview', headers=MEMBER,
                           json={'task': 'ocr', 'spec': SPEC, 'job_ids': ['j1']}).json()
        assert body['ok'] is False
        assert body['error'] == 'none of the sampled lines could be cut: the scan /gone/scan.png is not on this machine'

    def test_the_two_seeds_move_independently(self, client, monkeypatch):
        seen = []

        def draw(spec, images, seed, draws):
            seen.append(seed)
            return ['data:,'] * len(images)
        draws_with(monkeypatch, draw)

        def lines_of(body):
            return [s['line_id'] for s in body['samples']]
        first = client.post('/api/augmentations/preview', headers=MEMBER, json={
            'task': 'ocr', 'spec': SPEC, 'job_ids': ['j1'], 'line_seed': 1, 'render_seed': 1}).json()
        # A different render seed keeps the same lines and only re-rolls the stack.
        reapplied = client.post('/api/augmentations/preview', headers=MEMBER, json={
            'task': 'ocr', 'spec': SPEC, 'job_ids': ['j1'], 'line_seed': 1, 'render_seed': 2}).json()
        assert lines_of(reapplied) == lines_of(first) and seen[2:4] == [2, 2]
        # A different line seed draws other lines from the same datasets.
        others = client.post('/api/augmentations/preview', headers=MEMBER, json={
            'task': 'ocr', 'spec': SPEC, 'job_ids': ['j1'], 'line_seed': 9, 'render_seed': 1}).json()
        assert lines_of(others) != lines_of(first)

    def test_previews_respect_dataset_access(self, client):
        assert client.post('/api/augmentations/preview', headers=OTHER,
                           json={'task': 'ocr', 'spec': SPEC, 'job_ids': ['j1']}).status_code == 404

    def test_no_backend_to_draw_with_is_a_503(self, client, monkeypatch):
        monkeypatch.setattr(augmentations, 'trainer_backend', lambda task: None)
        res = client.post('/api/augmentations/preview', headers=MEMBER,
                          json={'task': 'ocr', 'spec': SPEC, 'job_ids': ['j1']})
        assert res.status_code == 503 and res.json()['detail'] == 'no configured model backend trains ocr'


class TestPagePreview:
    """A layout or line trainer is handed pages with their boxes or line outlines, so that is
    what its preview shows."""

    @staticmethod
    def _layout_checked(conn, tmp_path):
        scan = tmp_path / 'page2.png'
        Image.new('RGB', (400, 200), 'white').save(scan)
        conn.execute("INSERT INTO pages (id, job_id, idx, filename, source_file, status, layout_checked) "
                     "VALUES (2, 'j1', 1, 'page2.png', ?, 'done', 1)", (str(scan),))
        conn.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) "
                     "VALUES (2, 2, 0, 'Heading', '[0.1,0.2,0.4,0.6]', 'content')")
        conn.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind, deleted) "
                     "VALUES (3, 2, 1, 'Paragraph', '[0,0,1,1]', 'content', 1)")
        conn.commit()

    @staticmethod
    def _lines_checked(conn, tmp_path):
        scan = tmp_path / 'page3.png'
        Image.new('RGB', (400, 200), 'white').save(scan)
        conn.execute("INSERT INTO pages (id, job_id, idx, filename, source_file, status, lines_checked) "
                     "VALUES (3, 'j1', 2, 'page3.png', ?, 'done', 1)", (str(scan),))
        conn.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) "
                     "VALUES (4, 3, 0, 'Paragraph', '[0,0,1,1]', 'content')")
        for line_id, order, polygon, deleted in ((10, 1, '[[0.1,0.6],[0.4,0.6],[0.4,0.7],[0.1,0.7]]', 0),
                                                 (11, 0, '[[0.1,0.2],[0.4,0.2],[0.4,0.3],[0.1,0.3]]', 0),
                                                 (12, 2, '[[0,0],[1,0],[1,1],[0,1]]', 1)):
            conn.execute('INSERT INTO lines (id, element_id, order_idx, polygon, deleted) VALUES (?, 4, ?, ?, ?)',
                         (line_id, order, polygon, deleted))
        conn.commit()

    def test_only_pages_with_checked_layout_are_sampled_with_their_live_boxes(self, client, tmp_path):
        conn = app.dependency_overrides[get_db]()
        assert augmentations.sample_pages(conn, 'layout', ['j1'], seed=1) == []
        self._layout_checked(conn, tmp_path)
        self._lines_checked(conn, tmp_path)
        [sample] = augmentations.sample_pages(conn, 'layout', ['j1'], seed=1)
        assert (sample['id'], sample['filename'], sample['dataset']) == (2, 'page2.png', 'Letters')
        assert sample['shapes'] == [[0.1, 0.2, 0.4, 0.6]]

    def test_only_pages_with_checked_lines_are_sampled_with_their_live_outlines_in_order(self, client, tmp_path):
        conn = app.dependency_overrides[get_db]()
        self._layout_checked(conn, tmp_path)
        assert augmentations.sample_pages(conn, 'lines', ['j1'], seed=1) == []
        self._lines_checked(conn, tmp_path)
        [sample] = augmentations.sample_pages(conn, 'lines', ['j1'], seed=1)
        assert (sample['id'], sample['filename']) == (3, 'page3.png')
        assert sample['shapes'] == [[[0.1, 0.2], [0.4, 0.2], [0.4, 0.3], [0.1, 0.3]],
                                    [[0.1, 0.6], [0.4, 0.6], [0.4, 0.7], [0.1, 0.7]]]

    def test_a_layout_preview_draws_each_box_where_the_draw_put_it(self, client, monkeypatch, tmp_path):
        conn = app.dependency_overrides[get_db]()
        self._layout_checked(conn, tmp_path)
        asked = []

        def mirrored(client_, spec, images, boxes, seed, draws=1, kind='boxes'):
            asked.append(([image.size for image in images], boxes, draws, kind))
            width = images[0].width
            flipped = [[[width - x1, y0, width - x0, y1] for x0, y0, x1, y1 in page] for page in boxes]
            return [augmentations.outlined(Image.new('RGB', image.size, 'white'), []) for image in images], flipped
        monkeypatch.setattr(augmentations.backend_client, 'preview_page_augmentations', mirrored)
        res = client.post('/api/augmentations/preview', headers=MEMBER,
                          json={'task': 'layout', 'spec': SPEC, 'job_ids': ['j1'], 'line_seed': 1, 'render_seed': 1})
        assert res.status_code == 200, res.text
        body = res.json()
        assert (body['ok'], body['unit'], body['draws']) == (True, 'page', augmentations.HARSHEST_DRAWS)
        assert asked == [([(400, 200)], [[[40.0, 40.0, 160.0, 120.0]]], 1, 'boxes'),
                         ([(400, 200)], [[[40.0, 40.0, 160.0, 120.0]]], augmentations.HARSHEST_DRAWS, 'boxes')]
        [sample] = body['samples']
        assert (sample['page_id'], sample['text']) == (2, 'page2.png')
        before = augmentations.from_data_url(sample['original']).convert('RGB')
        after = augmentations.from_data_url(sample['augmented']).convert('RGB')
        # The box's left edge before, and the mirrored box's right edge after.
        assert before.getpixel((40, 80)) == augmentations.BOX_COLOUR
        assert after.getpixel((40, 80)) == (255, 255, 255)
        assert after.getpixel((359, 80)) == augmentations.BOX_COLOUR

    def test_a_lines_preview_draws_each_outline_where_the_draw_put_it(self, client, monkeypatch, tmp_path):
        conn = app.dependency_overrides[get_db]()
        self._lines_checked(conn, tmp_path)
        asked = []

        def mirrored(client_, spec, images, outlines, seed, draws=1, kind='boxes'):
            asked.append((outlines, kind))
            width = images[0].width
            flipped = [[[[width - x, y] for x, y in line] for line in page] for page in outlines]
            return [augmentations.outlined(Image.new('RGB', image.size, 'white'), []) for image in images], flipped
        monkeypatch.setattr(augmentations.backend_client, 'preview_page_augmentations', mirrored)
        body = client.post('/api/augmentations/preview', headers=MEMBER, json={
            'task': 'lines', 'spec': SPEC, 'job_ids': ['j1'], 'line_seed': 1, 'render_seed': 1}).json()
        assert (body['ok'], body['unit']) == (True, 'page')
        first = [[40.0, 40.0], [160.0, 40.0], [160.0, 60.0], [40.0, 60.0]]
        assert asked[0] == ([[first, [[40.0, 120.0], [160.0, 120.0], [160.0, 140.0], [40.0, 140.0]]]], 'polygons')
        [sample] = body['samples']
        before = augmentations.from_data_url(sample['original']).convert('RGB')
        after = augmentations.from_data_url(sample['augmented']).convert('RGB')
        # The first line's left edge before, and the mirrored line's right edge after.
        assert before.getpixel((40, 50)) == augmentations.BOX_COLOUR
        assert after.getpixel((40, 50)) == (255, 255, 255)
        assert after.getpixel((360, 50)) == augmentations.BOX_COLOUR

    def test_a_lines_preview_without_checked_lines_says_so(self, client, monkeypatch, tmp_path):
        self._layout_checked(app.dependency_overrides[get_db](), tmp_path)
        res = client.post('/api/augmentations/preview', headers=MEMBER,
                          json={'task': 'lines', 'spec': SPEC, 'job_ids': ['j1'], 'line_seed': 1, 'render_seed': 1})
        assert res.json() == {'ok': False, 'samples': [],
                              'error': 'the chosen datasets have no pages with checked lines to preview on'}

    def test_a_layout_preview_without_checked_layout_says_so(self, client, monkeypatch):
        monkeypatch.setattr(augmentations.backend_client, 'preview_page_augmentations',
                            lambda *args, **kwargs: pytest.fail('the backend was asked'))
        res = client.post('/api/augmentations/preview', headers=MEMBER,
                          json={'task': 'layout', 'spec': SPEC, 'job_ids': ['j1'], 'line_seed': 1, 'render_seed': 1})
        assert res.json() == {'ok': False, 'samples': [],
                              'error': 'the chosen datasets have no pages with checked layout to preview on'}

    def test_a_layout_stack_is_checked_on_a_page_with_a_box(self, client, monkeypatch):
        monkeypatch.setattr(augmentations, 'unknown_steps', lambda spec, task: None)
        asked = []

        def checked(client_, spec, images, boxes, seed, draws=1, kind='boxes'):
            asked.append((images[0].size, boxes, kind))
            raise BackendError('bad_request', 'Compose[0].Rotate: RF-DETR would move the page '
                                          'but not its boxes with it')
        monkeypatch.setattr(augmentations.backend_client, 'preview_page_augmentations', checked)
        assert REAL_CHECK_SPEC(SPEC, 'layout') == ('Compose[0].Rotate: RF-DETR would move the page '
                                          'but not its boxes with it')
        assert asked == [((600, 800), [[[60, 80, 540, 240]]], 'boxes')]

    def test_a_lines_stack_is_checked_on_a_page_with_a_line(self, client, monkeypatch):
        monkeypatch.setattr(augmentations, 'unknown_steps', lambda spec, task: None)
        asked = []

        def checked(client_, spec, images, outlines, seed, draws=1, kind='boxes'):
            asked.append((images[0].size, outlines, kind))
        monkeypatch.setattr(augmentations.backend_client, 'preview_page_augmentations', checked)
        assert REAL_CHECK_SPEC(SPEC, 'lines') is None
        assert asked == [((600, 800), [[[[60, 80], [540, 80], [540, 120], [60, 120]]]], 'polygons')]


class TestCatalog:
    def test_is_kept_between_reads(self, fresh_catalog, monkeypatch):
        trains_with(monkeypatch, {'version': '2.3.1', 'transforms': [{'name': 'Affine'}]})
        first = augmentations.catalog()
        assert first.error is None and first.version == '2.3.1' and first.transforms == [{'name': 'Affine'}]
        assert first.groups == augmentations.GROUP_TYPES
        trains_with(monkeypatch, BackendError('unavailable', 're-read'))
        assert augmentations.catalog() is first

    def test_an_updated_backend_is_read_again_after_a_pause(self, fresh_catalog, monkeypatch):
        trains_with(monkeypatch, {'version': '2.3.1', 'transforms': []})
        first = augmentations.catalog()
        trains_with(monkeypatch, {'version': '2.3.1', 'transforms': [{'name': 'Affine'}]})
        first.checked_at -= augmentations.CATALOG_REFRESH_SECONDS + 1
        assert augmentations.catalog().transforms == [{'name': 'Affine'}]

    def test_a_failure_is_reported_and_retried_after_a_pause(self, fresh_catalog, monkeypatch):
        monkeypatch.setattr(augmentations, 'trainer_backend', lambda task: None)
        failed = augmentations.catalog()
        assert failed.transforms == [] and failed.error == 'no configured model backend trains ocr'
        assert augmentations.catalog().payload()['error'] == failed.error
        trains_with(monkeypatch, {'version': 'x', 'transforms': []})
        failed.checked_at -= augmentations.CATALOG_REFRESH_SECONDS + 1
        assert augmentations.catalog().error is None

    def test_the_route_serves_it(self, client, fresh_catalog, monkeypatch):
        trains_with(monkeypatch, {'version': 'x', 'transforms': []})
        body = client.get('/api/augmentations/catalog', headers=VIEWER).json()
        assert body == {'version': 'x', 'transforms': [], 'groups': augmentations.GROUP_TYPES, 'error': None}
        assert client.get('/api/augmentations/catalog?task=maps', headers=VIEWER).status_code == 400

    def test_each_task_has_the_catalog_of_the_backend_that_trains_it(self, client, fresh_catalog, monkeypatch):
        offered = {'ocr': [{'name': 'Affine'}], 'lines': [{'name': 'Affine'}, {'name': 'utils.augment.RandomBlobs'}]}
        monkeypatch.setattr(augmentations, 'trainer_backend', lambda task: FakeTrainer(
            {'version': task, 'transforms': offered[task]}))
        lines = client.get('/api/augmentations/catalog?task=lines', headers=VIEWER).json()
        assert [t['name'] for t in lines['transforms']] == ['Affine', 'utils.augment.RandomBlobs']
        assert augmentations.catalog('ocr').transforms == [{'name': 'Affine'}]

    def test_a_step_is_known_by_the_catalog_of_the_task_it_is_saved_for(self, fresh_catalog, monkeypatch):
        offered = {'ocr': [{'name': 'Affine'}], 'lines': [{'name': 'utils.augment.RandomBlobs'}]}
        monkeypatch.setattr(augmentations, 'trainer_backend', lambda task: FakeTrainer(
            {'version': task, 'transforms': offered[task]}))
        blobs = compose({'__class_fullname__': 'utils.augment.RandomBlobs', 'p': 0.2})
        assert augmentations.unknown_steps(blobs, 'lines') is None
        assert augmentations.unknown_steps(blobs, 'ocr') == ('Compose[0].utils.augment.RandomBlobs: '
                                                             'not a transform this deployment offers')


class TestTrainingStack:
    @pytest.fixture(autouse=True)
    def trains(self, training_backend):
        return training_backend

    def _train(self, client, who=ADMIN, name='Run', **extra):
        return client.post('/api/trainings', headers=who,
                           json={'task': 'ocr', 'name': name, 'dataset_job_ids': ['j1'], **extra})

    def test_a_run_without_a_choice_leaves_the_trainer_on_its_own_stack(self, client):
        body = self._train(client).json()
        assert body['augmentation'] is None and body['augmentation_name'] == ''
        assert trainer.write_augmentation(
            {'id': body['id'], 'augmentation': None}) is None

    def test_a_named_pipeline_is_frozen_into_the_run(self, client):
        pipeline = create(client, ADMIN, 'Heavy').json()
        run = self._train(client, augmentation_pipeline_id=pipeline['id']).json()
        assert run['augmentation'] == SPEC and run['augmentation_name'] == 'Heavy'
        # Editing the pipeline afterwards does not reach back into the finished run.
        client.patch(f'/api/augmentations/pipelines/{pipeline["id"]}', headers=ADMIN,
                     json={'spec': compose({'__class_fullname__': 'InvertImg', 'p': 1.0})})
        after = next(t for t in client.get('/api/trainings', headers=ADMIN).json()['trainings']
                     if t['id'] == run['id'])
        assert after['augmentation'] == SPEC
        # And so does deleting it.
        client.delete(f'/api/augmentations/pipelines/{pipeline["id"]}', headers=ADMIN)
        after = next(t for t in client.get('/api/trainings', headers=ADMIN).json()['trainings']
                     if t['id'] == run['id'])
        assert after['augmentation'] == SPEC and after['augmentation_name'] == 'Heavy'

    def test_a_stack_built_for_one_run_is_checked_and_unnamed(self, client):
        run = self._train(client, augmentation=SPEC).json()
        assert run['augmentation'] == SPEC and run['augmentation_name'] == ''

    def test_an_empty_stack_means_train_on_clean_crops(self, client):
        empty = compose()
        run = self._train(client, augmentation=empty).json()
        assert run['augmentation'] == empty

    def test_a_stack_whose_steps_are_not_a_list_is_a_bad_request(self, client, monkeypatch):
        monkeypatch.setattr(augmentations, 'check_spec', REAL_CHECK_SPEC)
        malformed = {'transform': {'__class_fullname__': 'Compose', 'p': 1.0, 'transforms': None}}
        res = self._train(client, augmentation=malformed)
        assert res.status_code == 400
        assert res.json()['detail'] == 'Compose: a group holds a list of steps'

    def test_a_stack_the_check_refuses_stops_the_run(self, client, monkeypatch):
        monkeypatch.setattr(augmentations, 'check_spec', lambda spec, task='ocr': 'Compose[0].GaussNoise: nope')
        res = self._train(client, augmentation=SPEC)
        assert res.status_code == 400 and 'GaussNoise' in res.json()['detail']
        assert client.get('/api/trainings', headers=ADMIN).json()['trainings'] == []

    def test_a_pipeline_the_caller_cannot_see_is_not_found(self, client):
        private = create(client, MEMBER, 'Mine').json()
        assert self._train(client, augmentation_pipeline_id=private['id']).status_code == 404
        assert self._train(client, augmentation_pipeline_id=9999).status_code == 404

    def test_naming_a_pipeline_and_a_stack_at_once_is_refused(self, client):
        pipeline = create(client, ADMIN).json()
        res = self._train(client, augmentation_pipeline_id=pipeline['id'], augmentation=SPEC)
        assert res.status_code == 400 and 'not both' in res.json()['detail']

    def test_the_stack_travels_to_the_trainer_as_a_file_it_names(self, client, tmp_path, monkeypatch):
        monkeypatch.setattr(config, 'TRAININGS_DIR', tmp_path / 'trainings')
        run = self._train(client, augmentation=SPEC).json()
        row = {'id': run['id'], 'augmentation': json.dumps(SPEC)}
        written = trainer.write_augmentation(row)
        assert json.loads(written.read_text(encoding='utf-8')) == SPEC
        assert written.name == trainer.AUGMENT_NAME

STACK = {'__version__': '2.0', 'transform': {'__class_fullname__': 'Compose', 'p': 1.0, 'transforms': [
    {'__class_fullname__': 'GaussNoise', 'p': 0.3},
    {'__class_fullname__': 'Normalize', 'p': 1.0},
    {'__class_fullname__': 'ToTensorV2', 'p': 1.0},
]}}


def test_a_trainer_on_a_backend_names_its_own_stack(monkeypatch):
    monkeypatch.setattr(augmentations, 'trainer_backend', lambda task: FakeTrainer({'transforms': [], 'default': STACK}))
    built = augmentations.builtin_spec('ocr')
    assert built['error'] is None
    assert [s['__class_fullname__'] for s in built['spec']['transform']['transforms']] == ['GaussNoise']


def test_a_trainer_on_a_backend_that_declares_no_stack_says_so(monkeypatch):
    monkeypatch.setattr(augmentations, 'trainer_backend', lambda task: FakeTrainer({'transforms': []}))
    assert augmentations.builtin_spec('ocr') == {'spec': None, 'error': 'the model backend declares no default stack'}


def test_a_backend_preview_shows_one_draw_and_the_harshest_of_many(monkeypatch, tmp_path):
    asked = []

    def drawn(client, spec, images, seed, draws=1):
        asked.append(draws)
        return [f'data:image/png;base64,draws-{draws}' for _ in images]

    monkeypatch.setattr(augmentations.backend_client, 'preview_augmentations', drawn)
    crop = tmp_path / 'crop.png'
    Image.new('RGB', (80, 20), 'white').save(crop)
    sample = {'id': 7, 'dataset': 'j1', 'page_id': 1, 'text': 'Anno', 'corrected_text': None}

    result = augmentations._backend_preview(object(), {'transform': {}}, [(sample, crop)], 32, 1, 2)

    assert asked == [1, augmentations.HARSHEST_DRAWS]
    assert result['draws'] == augmentations.HARSHEST_DRAWS
    [shown] = result['samples']
    assert (shown['augmented'], shown['harshest']) == (
        'data:image/png;base64,draws-1', f'data:image/png;base64,draws-{augmentations.HARSHEST_DRAWS}')
