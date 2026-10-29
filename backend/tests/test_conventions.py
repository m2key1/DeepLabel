import json

import pytest

from app import conventions, registry, store


def test_only_the_flags_the_model_knows_are_honoured_in_its_order():
    asked = {'typographic_punctuation': True, 'long_s': True, 'ligatures': True, 'oblique_hyphen': False}
    known = ['long_s', 'oblique_hyphen', 'typographic_punctuation']

    assert conventions.honoured(asked, known) == ['long_s', 'typographic_punctuation']
    assert conventions.model_row(asked, known) == [1.0, 0.0, 1.0]


def test_a_model_without_conditioning_honours_nothing():
    assert conventions.honoured({'long_s': True}, []) == []
    assert conventions.model_row({'long_s': True}, []) == []


def test_more_flags_than_any_model_has_are_refused():
    with pytest.raises(ValueError, match='at most 32'):
        conventions.validate({f'flag_{i}': True for i in range(33)})


def test_the_model_flags_are_recorded_once(tmp_path):
    conn = store.connect(tmp_path / 'app.db')
    conn.execute("INSERT INTO models (id, task, name, checkpoint) VALUES (1, 'ocr', 'OCR', '/m.ckpt')")

    registry.note_model_facts(conn, 1, {}, ['long_s', 'oblique_hyphen'])
    registry.note_model_facts(conn, 1, {}, ['something_else'])

    row = conn.execute('SELECT * FROM models WHERE id = 1').fetchone()
    assert registry.model_payload(row)['conventions'] == ['long_s', 'oblique_hyphen']
    conn.close()


def test_a_model_not_yet_loaded_has_unknown_flags(tmp_path):
    conn = store.connect(tmp_path / 'app.db')
    conn.execute("INSERT INTO models (id, task, name, checkpoint) VALUES (1, 'ocr', 'OCR', '/m.ckpt')")

    row = conn.execute('SELECT * FROM models WHERE id = 1').fetchone()
    assert registry.model_payload(row)['conventions'] is None
    conn.close()


class TestCatalog:
    """The flags people read about: named as models declare them, described by an admin."""

    SECRET = 'test-secret'

    @staticmethod
    def headers(user: str, role: str) -> dict:
        return {'X-Frontend-Secret': TestCatalog.SECRET, 'X-Auth-User': user, 'X-Auth-Role': role}

    @pytest.fixture
    def conn(self, tmp_path, monkeypatch):
        monkeypatch.setattr('app.config.FRONTEND_SECRET', self.SECRET)
        conn = store.connect(tmp_path / 'app.db')
        yield conn
        conn.close()

    @pytest.fixture
    def client(self, conn):
        from fastapi.testclient import TestClient
        from app.deps import get_db
        from app.main import app
        app.dependency_overrides[get_db] = lambda: conn
        yield TestClient(app)
        app.dependency_overrides.clear()

    def flags(self, client) -> dict:
        r = client.get('/api/convention-flags', headers=self.headers('bob', 'member'))
        assert r.status_code == 200
        return {f['name']: f for f in r.json()['flags']}

    def test_a_flag_a_model_declares_joins_the_catalog_under_its_own_name(self, conn, client):
        conn.execute("INSERT INTO models (id, task, name, checkpoint) VALUES (1, 'ocr', 'Kurrent v4', '/m.ckpt')")
        registry.note_model_facts(conn, 1, {}, ['long_s', 'superscript_e'])

        flags = self.flags(client)
        assert {name: (f['label'], f['description'], f['added_from'], f['models'])
                for name, f in flags.items()} == {
            'long_s': ('long_s', '', 'Kurrent v4', 1), 'superscript_e': ('superscript_e', '', 'Kurrent v4', 1)}

    def test_a_flag_a_dataset_asks_for_joins_it_too_and_is_counted(self, conn, client):
        conn.execute("INSERT INTO jobs (id, name, owner) VALUES ('j1', 'Briefe', 'bob')")
        conn.commit()
        r = client.patch('/api/jobs/j1', json={'ocr_convention': {'keep_hyphens': True, 'long_s': False}},
                         headers=self.headers('bob', 'member'))
        assert r.status_code == 200

        flags = self.flags(client)
        assert list(flags) == ['keep_hyphens']
        assert (flags['keep_hyphens']['datasets'], flags['keep_hyphens']['models']) == (1, 0)

    def test_an_admin_describes_a_flag_and_adds_one_no_model_has_yet(self, conn, client):
        conventions.note(conn, ['long_s'])
        conn.commit()
        root = self.headers('root', 'admin')

        r = client.patch('/api/convention-flags/long_s', headers=root,
                         json={'label': 'Keep long s', 'description': 'ſ is transcribed as ſ, not s.'})
        assert r.status_code == 200
        r = client.post('/api/convention-flags', headers=root,
                        json={'name': 'keep_abbreviations', 'label': 'Keep abbreviations'})
        assert r.status_code == 200

        flags = self.flags(client)
        assert {name: (f['label'], f['description']) for name, f in flags.items()} == {
            'long_s': ('Keep long s', 'ſ is transcribed as ſ, not s.'),
            'keep_abbreviations': ('Keep abbreviations', '')}

    def test_a_model_load_leaves_a_described_flag_as_it_was(self, conn, client):
        conventions.note(conn, ['long_s'])
        conn.execute("UPDATE convention_flags SET label = 'Keep long s' WHERE name = 'long_s'")
        conn.execute("INSERT INTO models (id, task, name, checkpoint) VALUES (1, 'ocr', 'Kurrent v4', '/m.ckpt')")
        registry.note_model_facts(conn, 1, {}, ['long_s'])

        assert self.flags(client)['long_s']['label'] == 'Keep long s'

    def test_only_an_admin_changes_the_catalog(self, conn, client):
        conventions.note(conn, ['long_s'])
        conn.commit()
        bob = self.headers('bob', 'member')

        assert client.patch('/api/convention-flags/long_s', headers=bob, json={'label': 'x'}).status_code == 403
        assert client.post('/api/convention-flags', headers=bob,
                           json={'name': 'new_flag', 'label': 'x'}).status_code == 403
        assert self.flags(client)['long_s']['label'] == 'long_s'
        assert 'new_flag' not in self.flags(client)

    def test_a_name_must_be_a_flag_name_and_new(self, conn, client):
        conventions.note(conn, ['long_s'])
        conn.commit()
        root = self.headers('root', 'admin')

        assert client.post('/api/convention-flags', headers=root,
                           json={'name': 'Long S', 'label': 'x'}).status_code == 400
        assert client.post('/api/convention-flags', headers=root,
                           json={'name': 'long_s', 'label': 'x'}).status_code == 409
        assert client.patch('/api/convention-flags/nope', headers=root, json={'label': 'x'}).status_code == 404


def test_an_existing_database_starts_its_catalog_from_its_models_and_datasets(tmp_path):
    db = tmp_path / 'app.db'
    conn = store.connect(db)
    conn.execute("INSERT INTO models (task, name, checkpoint, conventions) VALUES ('ocr', 'Kurrent v3', '/m', '[\"long_s\"]')")
    conn.execute("INSERT INTO jobs (id, name, ocr_convention) VALUES ('j1', 'Briefe', '{\"keep_hyphens\": true}')")
    conn.execute('DELETE FROM convention_flags')
    conn.execute(f'PRAGMA user_version = {store.CONVENTION_CATALOG - 1}')
    conn.commit()
    conn.close()

    conn = store.connect(db)
    store.connect(db).close()

    assert [tuple(row) for row in conn.execute('SELECT name, label, added_from FROM convention_flags ORDER BY name')] == [
        ('keep_hyphens', 'keep_hyphens', None), ('long_s', 'long_s', 'Kurrent v3')]
    conn.close()


class TestConventionAtCreation:
    """A dataset can start with its convention, picked on the New job page, rather than
    getting one from the model picker after its first read."""

    SECRET = 'test-secret'
    ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'admin'}
    PNG = b'\x89PNG\r\n\x1a\n'

    @pytest.fixture
    def api(self, tmp_path, monkeypatch):
        from fastapi.testclient import TestClient
        from app.deps import get_db
        from app.main import app
        monkeypatch.setattr('app.config.FRONTEND_SECRET', self.SECRET)
        monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
        conn = store.connect(tmp_path / 'app.db')
        app.dependency_overrides[get_db] = lambda: conn
        yield TestClient(app), conn
        app.dependency_overrides.clear()
        conn.close()

    def stored(self, conn, job_id) -> tuple:
        row = conn.execute('SELECT ocr_convention FROM jobs WHERE id = ?', (job_id,)).fetchone()
        names = [r[0] for r in conn.execute('SELECT name FROM convention_flags ORDER BY name')]
        return conventions.parse(row[0]), names

    def test_an_upload_starts_with_the_flags_it_was_given(self, api):
        client, conn = api
        r = client.post('/api/jobs', headers=self.ADMIN, files=[('files', ('a.png', self.PNG, 'image/png'))],
                        data={'name': 'Briefe', 'run_layout': 'false',
                              'ocr_convention': '{"long_s": true, "keep_hyphens": false}'})
        assert r.status_code == 200, r.text

        assert self.stored(conn, r.json()['job_id']) == ({'long_s': True, 'keep_hyphens': False}, ['long_s'])

    def test_a_server_path_does_too(self, api, tmp_path):
        client, conn = api
        (tmp_path / 'scans').mkdir()
        (tmp_path / 'scans' / 'a.png').write_bytes(self.PNG)
        r = client.post('/api/jobs/path', headers=self.ADMIN, json={
            'name': 'Briefe', 'server_path': str(tmp_path / 'scans'), 'run_layout': False,
            'ocr_convention': {'keep_hyphens': True}})
        assert r.status_code == 200, r.text

        assert self.stored(conn, r.json()['job_id']) == ({'keep_hyphens': True}, ['keep_hyphens'])

    def test_without_one_it_starts_normalized(self, api):
        client, conn = api
        r = client.post('/api/jobs', headers=self.ADMIN, files=[('files', ('a.png', self.PNG, 'image/png'))],
                        data={'name': 'Briefe', 'run_layout': 'false'})

        assert self.stored(conn, r.json()['job_id']) == ({}, [])

    @pytest.mark.parametrize('convention', ['{"Long S": true}', 'not json', '["long_s"]'])
    def test_a_convention_that_is_none_is_refused_before_anything_is_written(self, api, convention):
        client, conn = api
        r = client.post('/api/jobs', headers=self.ADMIN, files=[('files', ('a.png', self.PNG, 'image/png'))],
                        data={'name': 'Briefe', 'ocr_convention': convention})

        assert r.status_code == 400
        assert conn.execute('SELECT COUNT(*) FROM jobs').fetchone()[0] == 0


class TestForTraining:
    """What an OCR run conditions on: its base model's flags first, then the ones its
    datasets set that the base does not know."""

    @pytest.fixture
    def conn(self, tmp_path):
        conn = store.connect(tmp_path / 'app.db')
        conn.execute("INSERT INTO models (id, task, name, checkpoint, conventions) "
                     "VALUES (1, 'ocr', 'Kurrent v3', '/m', '[\"oblique_hyphen\", \"long_s\"]')")
        conn.execute("INSERT INTO models (id, task, name, checkpoint) VALUES (2, 'ocr', 'Unread', '/n')")
        for job_id, flags in (('j1', '{"long_s": true, "keep_hyphens": true}'), ('j2', '{"long_s": false}'),
                              ('j3', '{}')):
            conn.execute('INSERT INTO jobs (id, name, ocr_convention) VALUES (?, ?, ?)', (job_id, job_id, flags))
        yield conn
        conn.close()

    def test_the_base_keeps_its_order_and_a_new_flag_follows(self, conn):
        plan = conventions.for_training(conn, 1, ['j1', 'j2'])
        assert plan == {'names': ['oblique_hyphen', 'long_s', 'keep_hyphens'], 'base': ['oblique_hyphen', 'long_s'],
                        'new': ['keep_hyphens'],
                        'by_dataset': {'j1': [0.0, 1.0, 1.0], 'j2': [0.0, 0.0, 0.0]}}

    def test_a_base_whose_flags_are_not_known_yet_teaches_whatever_the_datasets_set(self, conn):
        plan = conventions.for_training(conn, 2, ['j1'])
        assert (plan['names'], plan['new']) == (['keep_hyphens', 'long_s'], ['keep_hyphens', 'long_s'])

    def test_nothing_to_condition_on_is_no_plan(self, conn):
        assert conventions.for_training(conn, 2, ['j2', 'j3']) is None
        assert conventions.for_training(conn, None, ['j3']) is None


class TestSnapshotConventions:
    @pytest.fixture
    def conn(self, tmp_path, monkeypatch):
        monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path / 'trainings')
        conn = store.connect(tmp_path / 'app.db')
        conn.execute("INSERT INTO jobs (id, name, ocr_convention) VALUES ('j1', 'Briefe', '{\"long_s\": true}')")
        (tmp_path / 'trainings' / '7' / 'snapshot').mkdir(parents=True)
        yield conn
        conn.close()

    TRAINING = {'id': 7, 'task': 'ocr', 'base_model_id': None, 'dataset_job_ids': '["j1"]', 'valid_job_ids': '[]'}

    def test_a_backend_that_learns_flags_gets_each_datasets_row_beside_the_snapshot(self, conn, monkeypatch):
        from app import config, remote_training, trainer
        monkeypatch.setattr(trainer, 'trains_conventions', lambda conn, task, base: True)
        trainer._write_conventions(conn, self.TRAINING)

        written = config.training_dir(7) / 'snapshot' / remote_training.CONVENTIONS_NAME
        assert json.loads(written.read_text()) == {'names': ['long_s'], 'by_dataset': {'j1': [1.0]}}

    def test_one_that_cannot_gets_nothing(self, conn, monkeypatch):
        from app import config, remote_training, trainer
        monkeypatch.setattr(trainer, 'trains_conventions', lambda conn, task, base: False)
        trainer._write_conventions(conn, self.TRAINING)

        assert not (config.training_dir(7) / 'snapshot' / remote_training.CONVENTIONS_NAME).exists()
