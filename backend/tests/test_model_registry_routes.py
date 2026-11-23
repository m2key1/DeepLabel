"""The model registry as the UI drives it: renaming, notes, archiving, promoting a default,
and pointing an OCR model at a beam LM. The default silently decides what every new dataset
runs, so who may set it is part of the behaviour rather than a detail around it.
"""
import pytest
from fastapi.testclient import TestClient

from app import store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}
BOB = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member'}


@pytest.fixture
def conn(tmp_path):
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript("""
        INSERT INTO models (id, task, name, checkpoint, is_default, archived) VALUES
            (1, 'ocr', 'Shipped OCR', '/models/ocr.pt', 1, 0),
            (2, 'ocr', 'Alice run', '/models/alice.pt', 0, 0),
            (3, 'layout', 'Shipped layout', '/models/layout.pt', 1, 0),
            (4, 'ocr', 'Retired', '/models/old.pt', 0, 1);
        INSERT INTO trainings (id, name, task, status, owner, model_id, created_at)
            VALUES (1, 'Alice run', 'ocr', 'done', 'alice', 2, '2026-01-01 00:00:00');
    """)
    connection.commit()
    yield connection
    connection.close()


@pytest.fixture
def client(conn, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()


def listed(client, include_archived=False, headers=ADMIN):
    response = client.get('/api/models', params={'include_archived': include_archived},
                          headers=headers)
    assert response.status_code == 200, response.text
    return {m['name']: m for m in response.json()['models']}


def patch(client, model_id, body, headers=ADMIN):
    return client.patch(f'/api/models/{model_id}', json=body, headers=headers)


class TestListing:
    def test_archived_models_are_out_of_the_way_unless_asked_for(self, client):
        assert 'Retired' not in listed(client)
        assert 'Retired' in listed(client, include_archived=True)

    def test_a_model_says_which_task_it_is_for_and_whether_it_is_the_default(self, client):
        shipped = listed(client)['Shipped OCR']

        assert (shipped['task'], shipped['is_default']) == ('ocr', True)

    def test_a_trained_model_carries_who_produced_it(self, client):
        assert listed(client)['Alice run']['owner'] == 'alice'
        assert listed(client)['Shipped OCR']['owner'] is None


class TestEditing:
    def test_renaming_it_sticks(self, client):
        assert patch(client, 2, {'name': 'Alice OCR v2'}).status_code == 200
        assert 'Alice OCR v2' in listed(client)

    def test_a_name_of_nothing_is_refused(self, client):
        assert patch(client, 2, {'name': '   '}).status_code == 400

    def test_another_models_name_is_refused_whatever_the_case(self, client):
        response = patch(client, 2, {'name': '  shipped ocr '})

        assert response.status_code == 409
        assert response.json()['detail'] == 'a ocr model named "shipped ocr" already exists'
        assert 'Alice run' in listed(client)

    def test_an_archived_models_name_is_still_taken(self, client):
        assert patch(client, 2, {'name': 'Retired'}).status_code == 409

    def test_the_name_a_queued_run_will_register_under_is_taken(self, client, conn):
        conn.execute("INSERT INTO trainings (name, task, status, owner) "
                     "VALUES ('Next one', 'ocr', 'queued', 'alice')")
        conn.commit()

        response = patch(client, 2, {'name': 'Next one'})

        assert response.status_code == 409
        assert response.json()['detail'] == ('a ocr training run named "Next one" is already '
                                             'queued or running')

    def test_another_tasks_model_may_share_the_name(self, client):
        assert patch(client, 2, {'name': 'Shipped layout'}).status_code == 200
        assert listed(client)['Shipped layout']['task'] == 'ocr'

    def test_keeping_its_own_name_in_another_case_is_not_a_clash(self, client):
        assert patch(client, 2, {'name': 'ALICE RUN'}).status_code == 200
        assert 'ALICE RUN' in listed(client)

    def test_notes_can_be_written_and_cleared(self, client):
        patch(client, 2, {'notes': '  best CER so far  '})
        assert listed(client)['Alice run']['notes'] == 'best CER so far'

        patch(client, 2, {'notes': ''})
        assert listed(client)['Alice run']['notes'] is None

    def test_a_model_that_does_not_exist_is_a_404(self, client):
        assert patch(client, 99, {'name': 'Ghost'}).status_code == 404


class TestTheDefault:
    def test_promoting_one_demotes_the_previous_default_of_that_task(self, client):
        patch(client, 2, {'is_default': True})

        models = listed(client)
        assert (models['Alice run']['is_default'], models['Shipped OCR']['is_default']) == (True, False)

    def test_another_tasks_default_is_left_alone(self, client):
        patch(client, 2, {'is_default': True})

        assert listed(client)['Shipped layout']['is_default'] is True

    def test_an_archived_model_cannot_be_promoted(self, client):
        response = patch(client, 4, {'is_default': True})

        assert response.status_code == 409
        assert 'archived' in response.json()['detail']

    def test_the_default_cannot_be_archived_out_from_under_a_task(self, client):
        response = patch(client, 1, {'archived': True})

        assert response.status_code == 409
        assert 'promote another first' in response.json()['detail']

    def test_one_request_cannot_promote_a_model_and_archive_it(self, client):
        response = patch(client, 2, {'is_default': True, 'archived': True, 'name': 'Renamed'})

        assert response.status_code == 409
        models = listed(client, include_archived=True)
        assert (models['Shipped OCR']['is_default'], models['Alice run']['is_default'],
                models['Alice run']['archived']) == (True, False, False)
        assert 'Renamed' not in models

    def test_the_default_cannot_be_archived_by_promoting_it_again(self, client):
        response = patch(client, 1, {'is_default': True, 'archived': True})

        assert response.status_code == 409
        shipped = listed(client)['Shipped OCR']
        assert (shipped['is_default'], shipped['archived']) == (True, False)

    def test_an_archived_model_can_be_brought_back_as_the_default(self, client):
        assert patch(client, 4, {'is_default': True, 'archived': False}).status_code == 200

        models = listed(client)
        assert (models['Retired']['is_default'], models['Retired']['archived'],
                models['Shipped OCR']['is_default']) == (True, False, False)

    def test_a_model_nobody_relies_on_can_be_archived_and_brought_back(self, client):
        assert patch(client, 2, {'archived': True}).status_code == 200
        assert 'Alice run' not in listed(client)

        assert patch(client, 2, {'archived': False}).status_code == 200
        assert 'Alice run' in listed(client)


class TestTheBeamLanguageModel:
    def test_an_ocr_model_can_be_pointed_at_one_that_exists(self, client, tmp_path):
        lm = tmp_path / 'union.bin'
        lm.write_bytes(b'arpa')

        assert patch(client, 1, {'lm_path': str(lm)}).status_code == 200
        assert listed(client)['Shipped OCR']['lm_path'] == str(lm)

    def test_a_path_that_is_not_on_the_backend_is_refused_with_the_path(self, client):
        response = patch(client, 1, {'lm_path': '/models/not-there.bin'})

        assert response.status_code == 400
        assert '/models/not-there.bin' in response.json()['detail']

    def test_clearing_it_is_allowed_even_though_no_such_file_exists(self, client, tmp_path):
        lm = tmp_path / 'union.bin'
        lm.write_bytes(b'arpa')
        patch(client, 1, {'lm_path': str(lm)})

        assert patch(client, 1, {'lm_path': ''}).status_code == 200
        assert listed(client)['Shipped OCR']['lm_path'] is None

    def test_only_ocr_models_carry_one(self, client):
        response = patch(client, 3, {'lm_path': '/models/union.bin'})

        assert response.status_code == 400
        assert 'only OCR models' in response.json()['detail']

    def test_setting_it_to_what_it_already_is_costs_nothing(self, client):
        assert patch(client, 1, {'lm_dict_path': None}).status_code == 200


class TestWhoMayChangeWhat:
    def test_whoever_trained_it_may_rename_their_own(self, client):
        assert patch(client, 2, {'name': 'Mine, renamed'}, headers=ALICE).status_code == 200

    def test_but_not_promote_it_to_the_default(self, client):
        """The default decides what every new dataset runs, so it is part of managing
        the registry rather than of owning one model in it."""
        assert patch(client, 2, {'is_default': True}, headers=ALICE).status_code == 403
        assert listed(client)['Alice run']['is_default'] is False

    def test_nor_point_it_at_a_file_on_the_backend(self, client, tmp_path):
        lm = tmp_path / 'union.bin'
        lm.write_bytes(b'arpa')

        assert patch(client, 2, {'lm_path': str(lm)}, headers=ALICE).status_code == 403

    def test_somebody_elses_model_is_not_theirs_to_rename(self, client):
        assert patch(client, 2, {'name': 'Mine now'}, headers=BOB).status_code == 403

    def test_a_shipped_model_nobody_trained_is_admin_only(self, client):
        assert patch(client, 1, {'name': 'Renamed'}, headers=ALICE).status_code == 403
        assert patch(client, 1, {'name': 'Renamed'}, headers=ADMIN).status_code == 200


class TestManagingTheRegistry:
    """`models.manage` is what an admin grants a member from the permission matrix: the
    whole registry, not just the models their own trainings produced."""

    MANAGER = {**BOB, 'X-Auth-Caps': 'models.manage'}

    def test_a_manager_may_rename_and_retire_a_model_somebody_else_trained(self, client):
        assert patch(client, 2, {'name': 'Tidied'}, headers=self.MANAGER).status_code == 200
        assert patch(client, 2, {'archived': True}, headers=self.MANAGER).status_code == 200
        assert listed(client, include_archived=True)['Tidied']['archived'] is True

    def test_a_manager_may_choose_the_default(self, client):
        assert patch(client, 2, {'is_default': True}, headers=self.MANAGER).status_code == 200
        assert (listed(client)['Alice run']['is_default'],
                listed(client)['Shipped OCR']['is_default']) == (True, False)

    def test_pointing_a_model_at_a_file_on_the_backend_stays_with_admins(self, client, tmp_path):
        lm = tmp_path / 'union.bin'
        lm.write_bytes(b'arpa')

        assert patch(client, 2, {'lm_path': str(lm)}, headers=self.MANAGER).status_code == 403
        assert patch(client, 2, {'lm_path': str(lm)}, headers=ADMIN).status_code == 200


class TestDeleting:
    """A second, deliberate step after archiving (#152). A trained model goes with its run
    and the checkpoint that lives in the run's directory; one nobody trained is admin only."""

    @pytest.fixture(autouse=True)
    def trainings_dir(self, tmp_path, monkeypatch):
        monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path / 'trainings')
        monkeypatch.setattr('app.config.SLURM_HOST', '')
        return tmp_path / 'trainings'

    @staticmethod
    def delete(client, model_id, headers=ADMIN):
        return client.delete(f'/api/models/{model_id}', headers=headers)

    def test_a_model_in_use_is_archived_first(self, client):
        response = self.delete(client, 2, headers=ALICE)

        assert (response.status_code, response.json()['detail']) == (409, 'archive the model before deleting it')
        assert 'Alice run' in listed(client)

    def test_whoever_trained_it_deletes_it_with_its_run_and_checkpoint(self, client, conn, trainings_dir):
        checkpoint = trainings_dir / '1' / 'output' / 'best_model.pt'
        checkpoint.parent.mkdir(parents=True)
        checkpoint.write_bytes(b'weights')
        assert patch(client, 2, {'archived': True}, headers=ALICE).status_code == 200

        assert self.delete(client, 2, headers=ALICE).status_code == 200

        assert 'Alice run' not in listed(client, include_archived=True)
        assert conn.execute('SELECT COUNT(*) FROM trainings').fetchone()[0] == 0
        assert not (trainings_dir / '1').exists()

    def test_an_admin_may_delete_a_model_somebody_else_trained(self, client):
        patch(client, 2, {'archived': True})

        assert self.delete(client, 2).status_code == 200
        assert 'Alice run' not in listed(client, include_archived=True)

    def test_somebody_else_may_not(self, client):
        patch(client, 2, {'archived': True})

        assert self.delete(client, 2, headers=BOB).status_code == 403
        assert 'Alice run' in listed(client, include_archived=True)

    def test_nor_may_a_manager_who_did_not_train_it(self, client):
        """Managing the registry tidies it; deleting takes a checkpoint away for good."""
        patch(client, 2, {'archived': True})

        assert self.delete(client, 2, headers=TestManagingTheRegistry.MANAGER).status_code == 403

    def test_a_model_nobody_trained_is_deleted_by_admins_only(self, client, conn):
        conn.execute("INSERT INTO model_files (model_id, role, filename, sha256, size) VALUES (4, 'weights', 'old.pt', 'ab12', 7)")
        conn.execute("INSERT INTO jobs (id, name, owner, status, model_ocr_id) VALUES ('j1', 'Volume', 'alice', 'done', 4)")
        conn.commit()

        assert self.delete(client, 4, headers=ALICE).status_code == 403
        assert self.delete(client, 4).status_code == 200

        assert 'Retired' not in listed(client, include_archived=True)
        assert conn.execute('SELECT COUNT(*) FROM model_files').fetchone()[0] == 0
        # Set to it, the dataset now reads with its task's default.
        assert conn.execute("SELECT model_ocr_id FROM jobs WHERE id = 'j1'").fetchone()[0] is None

    def test_the_default_cannot_be_deleted(self, client):
        response = self.delete(client, 1)

        assert (response.status_code, response.json()['detail']) == \
            (409, 'the default model cannot be deleted - promote another first')

    def test_a_model_shipped_with_its_backend_is_kept_archived(self, client, conn):
        """Its backend offers it again every time it starts, so deleting it would not last."""
        conn.execute("INSERT INTO models (id, task, name, source, checkpoint, backend, archived) "
                     "VALUES (5, 'lines', 'kraken (builtin)', 'backend', '', 'lines', 1)")
        conn.commit()

        response = self.delete(client, 5)

        assert (response.status_code, response.json()['detail']) == \
            (409, 'its backend adds it again every time it starts - leave it archived instead')
        assert 'kraken (builtin)' in listed(client, include_archived=True)

    def test_a_run_still_to_start_from_it_keeps_it(self, client, conn):
        """It would quietly start from another model instead."""
        conn.execute("INSERT INTO trainings (id, name, task, status, owner, base_model_id, created_at) "
                     "VALUES (2, 'Next', 'ocr', 'queued', 'alice', 4, '2026-02-01 00:00:00')")
        conn.commit()

        response = self.delete(client, 4)

        assert (response.status_code, response.json()['detail']) == \
            (409, 'run "Next" starts from this model - wait for it to finish or cancel it')

    def test_a_dataset_being_read_with_it_keeps_it(self, client, conn):
        """Its run holds the model's id from the start, and writes it onto every page it reads."""
        conn.execute("INSERT INTO jobs (id, name, owner, status, model_ocr_id) VALUES ('j1', 'Volume', 'alice', 'running', 4)")
        conn.commit()

        response = self.delete(client, 4)

        assert (response.status_code, response.json()['detail']) == \
            (409, 'dataset "Volume" is being read with this model - wait for it to finish or cancel it')

    def test_an_evaluation_running_on_it_keeps_it(self, client, conn):
        conn.execute("INSERT INTO evaluations (model_id, decode, owner, status) VALUES (4, 'greedy', 'root', 'running')")
        conn.commit()

        response = self.delete(client, 4)

        assert (response.status_code, response.json()['detail']) == \
            (409, 'an evaluation of this model is running - wait for it to finish or cancel it')

    def test_a_model_that_does_not_exist_is_a_404(self, client):
        assert self.delete(client, 99).status_code == 404


class TestFamilies:
    """A family takes its root's name, and whoever manages models may give it
    one of its own - on the root, the one model every member descends from."""

    def test_the_root_carries_the_family_name(self, client, conn):
        conn.execute('UPDATE models SET trained_from = 1 WHERE id = 2')
        conn.commit()

        assert patch(client, 1, {'family_name': '  DeepOCR  '}).status_code == 200
        assert listed(client)['Shipped OCR']['family_name'] == 'DeepOCR'
        assert patch(client, 1, {'family_name': ''}).status_code == 200
        assert listed(client)['Shipped OCR']['family_name'] is None

    def test_a_fine_tune_cannot_name_the_family(self, client, conn):
        conn.execute('UPDATE models SET trained_from = 1 WHERE id = 2')
        conn.commit()

        response = patch(client, 2, {'family_name': 'Mine'})

        assert response.status_code == 400
        assert 'root' in response.json()['detail']

    def test_naming_a_family_is_managing_the_registry(self, client):
        assert patch(client, 2, {'family_name': 'Alice family'}, headers=ALICE).status_code == 403


class TestUsage:
    def test_the_default_counts_the_datasets_that_follow_it(self, client, conn):
        conn.executescript("""
            INSERT INTO jobs (id, name, task, model_ocr_id) VALUES
                ('a', 'A', 'text', NULL), ('b', 'B', 'text', NULL), ('c', 'C', 'text', 2),
                ('d', 'D', 'text', 1), ('m', 'Map', 'map_segmentation', NULL);
        """)
        conn.commit()

        assert client.get('/api/models/1/usage', headers=ADMIN).json() == {
            'datasets': 3, 'pinned': 1, 'by_default': 2}
        assert client.get('/api/models/2/usage', headers=ADMIN).json() == {
            'datasets': 1, 'pinned': 1, 'by_default': 0}

    def test_an_unknown_model_has_no_usage(self, client):
        assert client.get('/api/models/99/usage', headers=ADMIN).status_code == 404


class TestServingBackend:
    """Which model backend serves a model decides where its weights go, so it is an admin's
    call; a model reads on it only while that backend is configured with a URL."""

    @pytest.fixture(autouse=True)
    def backends(self, monkeypatch):
        from app import config
        monkeypatch.setattr(config, 'MODEL_BACKENDS', {
            'stub': config.ModelBackend('stub', 'http://model-stub:9100', 's', 'default'),
            'ocr': config.ModelBackend('ocr', '', 's', 'default')})

    def test_an_admin_points_a_model_at_a_configured_backend(self, client):
        assert listed(client)['Alice run']['runs_on'] is None

        response = patch(client, 2, {'backend': 'stub'})

        assert response.status_code == 200
        assert response.json()['runs_on'] == 'stub'
        assert listed(client)['Alice run']['backend'] == 'stub'
        assert patch(client, 2, {'backend': None}).json()['runs_on'] is None

    def test_a_backend_nobody_configured_is_refused(self, client):
        response = patch(client, 2, {'backend': 'yolo'})
        assert response.status_code == 400
        assert 'yolo' in response.json()['detail']

    def test_a_member_cannot_move_even_their_own_model(self, client):
        assert patch(client, 2, {'backend': 'stub'}, headers=ALICE).status_code == 403
