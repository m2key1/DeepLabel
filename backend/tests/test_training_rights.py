"""Rights and provenance (#42), training: material under a restrictive rights statement is
trained on only once its dataset's owner has confirmed that training is permitted, and a run
shows the rights of what it was trained on."""
import pytest
from fastapi.testclient import TestClient

from app import remote_training, rights, store, trainer
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'manager', 'X-Auth-Train-Local': '1'}
BOB = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'manager', 'X-Auth-Train-Local': '1'}
CARL = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'carl', 'X-Auth-Role': 'member'}
ROOT = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}
CC_BY = 'http://creativecommons.org/licenses/by/4.0/'
IN_COPYRIGHT = 'http://rightsstatements.org/vocab/InC/1.0/'
CONTRACTUAL = 'http://rightsstatements.org/vocab/NoC-CR/1.0/'
NOT_PERMITTED = ' - its owner has not yet confirmed that training on it is permitted'


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path / 'trainings')
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript("""
        INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'Council minutes', 'alice', 'done'),
                                                         ('j2', 'Name register', 'alice', 'done');
        INSERT INTO job_assignees (job_id, username) VALUES ('j1', 'bob'), ('j2', 'bob');
        INSERT INTO pages (id, job_id, idx, filename, source_file, content_hash, status)
            VALUES (1, 'j1', 0, 'p1.png', '/p1.png', 'hash-1', 'done'),
                   (2, 'j2', 0, 'p2.png', '/p2.png', 'hash-2', 'done'),
                   (3, 'j2', 1, 'p3.png', '/p3.png', 'hash-3', 'done');
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox)
            VALUES (1, 1, 0, 'Paragraph', '[]'), (2, 2, 0, 'Paragraph', '[]');
        INSERT INTO lines (element_id, order_idx, polygon, text, checked)
            VALUES (1, 0, '[]', 'x', 1), (2, 0, '[]', 'y', 1);
    """)
    connection.commit()
    yield connection
    connection.close()


@pytest.fixture
def client(conn, monkeypatch, training_backend):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()


def under(conn, job_id, status, page_id=None):
    if page_id is None:
        rights.write(conn, job_id, {'status': status}, 'alice')
    else:
        rights.write_pages(conn, job_id, [page_id], {'status': status}, 'alice')
    conn.commit()


def start(client, **overrides):
    body = {'task': 'ocr', 'name': 'A run', 'dataset_job_ids': ['j1'], **overrides}
    return client.post('/api/trainings', json=body, headers=BOB)


def permit(client, job_id='j1', headers=ALICE):
    return client.post(f'/api/jobs/{job_id}/rights/training-permitted', headers=headers)


class TestRestrictive:
    def test_the_in_copyright_statements_and_the_restricted_no_copyright_ones(self):
        assert rights.RESTRICTIVE == {
            'http://rightsstatements.org/vocab/InC/1.0/', 'http://rightsstatements.org/vocab/InC-EDU/1.0/',
            'http://rightsstatements.org/vocab/InC-NC/1.0/', 'http://rightsstatements.org/vocab/InC-OW-EU/1.0/',
            'http://rightsstatements.org/vocab/InC-RUU/1.0/', 'http://rightsstatements.org/vocab/NoC-CR/1.0/',
            'http://rightsstatements.org/vocab/NoC-OKLR/1.0/'}

    @pytest.mark.parametrize('status', [None, rights.NOT_EVALUATED, CC_BY,
                                        'http://creativecommons.org/licenses/by-nc-nd/4.0/'])
    def test_unknown_and_open_material_is_trained_on_without_asking(self, client, conn, status):
        if status:
            under(conn, 'j1', status)

        assert start(client).status_code == 200


class TestTheGate:
    def test_an_in_copyright_dataset_is_refused_until_its_owner_confirms(self, client, conn):
        under(conn, 'j1', IN_COPYRIGHT)

        response = start(client)

        assert (response.status_code, response.json()['detail']) == (
            403, f'"Council minutes" holds material under In Copyright{NOT_PERMITTED}')

    def test_so_is_a_dataset_with_one_restricted_page(self, client, conn):
        under(conn, 'j2', CONTRACTUAL, page_id=3)

        response = start(client, dataset_job_ids=['j2'])

        assert (response.status_code, response.json()['detail']) == (
            403, f'"Name register" holds material under No Copyright - Contractual Restrictions{NOT_PERMITTED}')

    def test_a_deleted_page_holds_nothing(self, client, conn):
        under(conn, 'j2', CONTRACTUAL, page_id=3)
        conn.execute('UPDATE pages SET deleted = 1 WHERE id = 3')
        conn.commit()

        assert start(client, dataset_job_ids=['j2']).status_code == 200

    def test_a_validation_set_is_held_to_it_too(self, client, conn):
        under(conn, 'j2', IN_COPYRIGHT)

        response = start(client, split_strategy='holdout', valid_job_ids=['j2'])

        assert (response.status_code, response.json()['detail']) == (
            403, f'"Name register" holds material under In Copyright{NOT_PERMITTED}')

    def test_a_test_set_is_scored_on_not_trained_on(self, client, conn):
        conn.execute('UPDATE pages SET is_test = 1 WHERE id = 2')
        under(conn, 'j2', IN_COPYRIGHT)

        assert start(client, test_job_ids=['j2']).status_code == 200

    def test_once_the_owner_confirms_the_run_goes_ahead(self, client, conn):
        under(conn, 'j1', IN_COPYRIGHT)

        response = permit(client)

        assert response.status_code == 200, response.text
        assert response.json()['training'] == {'restrictive': True,
                                               'permitted': {'by': 'alice', 'at': response.json()['history'][0]['at']}}
        latest = response.json()['history'][0]
        assert (latest['field'], latest['old'], latest['new'], latest['author']) == ('training', None, 'permitted', 'alice')
        assert start(client).status_code == 200

    def test_a_run_queued_before_the_rights_changed_stops_before_cutting_anything(self, conn):
        under(conn, 'j1', IN_COPYRIGHT)
        training = {'id': 7, 'task': 'ocr', 'dataset_job_ids': '["j1"]', 'valid_job_ids': '[]'}

        with pytest.raises(remote_training.CannotTrain, match='"Council minutes" holds material under In Copyright'):
            trainer.prepare_snapshot(conn, training)


class TestTheConfirmation:
    def test_only_the_owner_gives_it(self, client, conn):
        under(conn, 'j1', IN_COPYRIGHT)

        for someone in (BOB, ROOT):
            response = permit(client, headers=someone)
            assert (response.status_code, response.json()['detail']) == (
                403, 'Only the owner of "Council minutes" can confirm that training on it is permitted')
        assert client.get('/api/jobs/j1/rights', headers=ALICE).json()['training'] == {
            'restrictive': True, 'permitted': None}

    def test_there_is_nothing_to_confirm_for_open_material(self, client, conn):
        under(conn, 'j1', CC_BY)

        response = permit(client)

        assert (response.status_code, response.json()['detail']) == (
            409, 'No rights statement on "Council minutes" restricts training')
        assert client.get('/api/jobs/j1/rights', headers=ALICE).json()['training'] == {
            'restrictive': False, 'permitted': None}

    def test_it_is_given_once(self, client, conn):
        under(conn, 'j1', IN_COPYRIGHT)
        permit(client)

        assert permit(client).status_code == 200
        history = client.get('/api/jobs/j1/rights', headers=ALICE).json()['history']
        assert [h['field'] for h in history] == ['training', 'status']


class TestARunsMaterial:
    def test_a_run_shows_the_rights_of_what_it_trained_and_validated_on(self, client, conn):
        under(conn, 'j1', IN_COPYRIGHT)
        permit(client)
        under(conn, 'j2', CC_BY)
        under(conn, 'j2', CONTRACTUAL, page_id=3)
        conn.execute("INSERT INTO trainings (id, task, name, dataset_job_ids, valid_job_ids, test_job_ids) "
                     "VALUES (3, 'ocr', 'Minutes v2', '[\"j1\"]', '[\"j2\"]', '[\"j2\"]')")
        conn.commit()

        answer = client.get('/api/trainings/3/rights', headers=BOB).json()

        permitted_at = client.get('/api/jobs/j1/rights', headers=ALICE).json()['training']['permitted']['at']
        assert answer == {'datasets': [
            {'job_id': 'j1', 'name': 'Council minutes', 'role': 'train', 'status': IN_COPYRIGHT, 'pages': [],
             'permitted': {'by': 'alice', 'at': permitted_at}},
            {'job_id': 'j2', 'name': 'Name register', 'role': 'valid', 'status': CC_BY,
             'pages': [{'status': CONTRACTUAL, 'count': 1}], 'permitted': None}]}

    def test_a_dataset_its_reader_cannot_open_is_not_named_nor_who_confirmed(self, client, conn):
        under(conn, 'j1', IN_COPYRIGHT)
        permit(client)
        conn.execute("INSERT INTO trainings (id, task, name, dataset_job_ids) VALUES (3, 'ocr', 'Minutes v2', '[\"j1\"]')")
        conn.commit()

        answer = client.get('/api/trainings/3/rights', headers=CARL).json()

        permitted_at = client.get('/api/jobs/j1/rights', headers=ALICE).json()['training']['permitted']['at']
        assert answer == {'datasets': [{'job_id': 'j1', 'name': 'another dataset', 'role': 'train', 'status': IN_COPYRIGHT,
                                        'pages': [], 'permitted': {'by': None, 'at': permitted_at}}]}
