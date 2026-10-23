"""The pictures a model is shown before the page - a chart of the glyphs a corpus prints,
a specimen alphabet. Held per person and per dataset, the way the prompt is, and part of
what a reading was taken under: change the chart and the readings taken under the old one
are stale, exactly as if the wording had changed.
"""
import pytest
from fastapi.testclient import TestClient
from starlette.datastructures import UploadFile

from app import llm, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}
BOB = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member'}
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}

CHART = b'\x89PNG\r\n\x1a\n a chart of rings and crosses'
ALPHABET = b'\x89PNG\r\n\x1a\n a specimen alphabet'


@pytest.fixture
def conn(tmp_path):
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript("""
        INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'Volume I', 'alice', 'done');
        INSERT INTO jobs (id, name, owner, status) VALUES ('j2', 'Volume II', 'alice', 'done');
    """)
    connection.commit()
    yield connection
    connection.close()


def add(conn, owner='alice', job_id=None, data=CHART, filename='chart.png'):
    return llm.add_reference(conn, owner, job_id, filename, 'image/png', data)


def texts(rows):
    return [row['filename'] for row in rows]


class TestScope:
    def test_a_person_can_keep_a_default_set(self, conn):
        add(conn, filename='chart.png')
        add(conn, filename='alphabet.png', data=ALPHABET)

        assert texts(llm.references(conn, 'alice')) == ['chart.png', 'alphabet.png']

    def test_a_dataset_without_its_own_uses_the_persons(self, conn):
        add(conn, filename='chart.png')

        assert texts(llm.references(conn, 'alice', 'j1')) == ['chart.png']

    def test_a_dataset_with_its_own_replaces_the_persons_entirely(self, conn):
        """Replaced rather than added to, the same way the prompt is: a corpus that needs
        its own chart usually needs only that one."""
        add(conn, filename='chart.png')
        add(conn, job_id='j1', filename='corpus.png', data=ALPHABET)

        assert texts(llm.references(conn, 'alice', 'j1')) == ['corpus.png']
        assert texts(llm.references(conn, 'alice', 'j2')) == ['chart.png']

    def test_one_persons_charts_are_not_anothers(self, conn):
        add(conn, owner='alice')

        assert llm.references(conn, 'bob') == []
        assert texts(llm.references(conn, 'alice')) == ['chart.png']

    def test_reading_with_nothing_set_sends_no_pictures(self, conn):
        assert llm.references(conn, 'alice', 'j1') == []


class TestKeeping:
    def test_the_order_they_were_added_is_the_order_they_are_sent(self, conn):
        for name in ('first.png', 'second.png', 'third.png'):
            add(conn, filename=name, data=CHART + name.encode())

        assert texts(llm.references(conn, 'alice')) == ['first.png', 'second.png', 'third.png']

    def test_removing_one_leaves_the_rest_in_order(self, conn):
        first = add(conn, filename='first.png')
        add(conn, filename='second.png', data=ALPHABET)

        assert llm.delete_reference(conn, first) is True
        assert texts(llm.references(conn, 'alice')) == ['second.png']

    def test_the_same_picture_twice_is_kept_once(self, conn):
        add(conn, filename='chart.png')
        add(conn, filename='chart-again.png')

        assert texts(llm.references(conn, 'alice')) == ['chart.png']

    def test_more_than_the_limit_is_refused(self, conn):
        for i in range(llm.MAX_REFERENCES):
            add(conn, filename=f'{i}.png', data=CHART + bytes([i]))

        with pytest.raises(ValueError, match='at most'):
            add(conn, filename='one-too-many.png', data=ALPHABET)

    def test_a_datasets_limit_counts_every_picture_whoever_added_it(self, conn):
        """A dataset's set is the dataset's: an admin adding to someone else's volume
        fills the same four slots, and the same picture is still kept once."""
        for i in range(llm.MAX_REFERENCES):
            add(conn, job_id='j1', filename=f'{i}.png', data=CHART + bytes([i]))

        assert add(conn, owner='root', job_id='j1', data=CHART + bytes([0])) \
            == llm.references(conn, 'alice', 'j1')[0]['id']
        with pytest.raises(ValueError, match='at most'):
            add(conn, owner='root', job_id='j1', filename='one-too-many.png', data=ALPHABET)
        assert texts(llm.references(conn, 'alice', 'j1')) == ['0.png', '1.png', '2.png', '3.png']

    def test_a_datasets_set_does_not_count_against_a_persons_default(self, conn):
        for i in range(llm.MAX_REFERENCES):
            add(conn, job_id='j1', filename=f'{i}.png', data=CHART + bytes([i]))

        add(conn, filename='mine.png', data=ALPHABET)

        assert texts(llm.references(conn, 'alice')) == ['mine.png']

    def test_something_that_is_not_an_image_is_refused(self, conn):
        with pytest.raises(ValueError, match='image'):
            llm.add_reference(conn, 'alice', None, 'notes.pdf', 'application/pdf', CHART)

    def test_an_image_too_large_to_send_is_refused(self, conn):
        with pytest.raises(ValueError, match='too large'):
            add(conn, data=b'x' * (llm.MAX_REFERENCE_BYTES + 1))

    def test_an_empty_file_is_refused(self, conn):
        with pytest.raises(ValueError, match='empty'):
            add(conn, data=b'')


class TestWhatAReadingWasTakenUnder:
    def test_the_wording_alone_still_decides_it_when_no_picture_is_sent(self, conn):
        assert llm.ask_digest('Transcribe.', []) == llm.ask_digest('Transcribe.', [])
        assert llm.ask_digest('Transcribe.', []) != llm.ask_digest('Transcribe it.', [])

    def test_adding_a_picture_changes_it(self, conn):
        add(conn)

        assert llm.ask_digest('Transcribe.', llm.references(conn, 'alice')) \
            != llm.ask_digest('Transcribe.', [])

    def test_a_different_picture_under_the_same_name_changes_it(self, conn):
        """Keyed on the bytes, not the filename - replacing the chart with a better one is
        exactly the case where the old readings must count as stale."""
        first = add(conn, filename='chart.png')
        before = llm.ask_digest('Transcribe.', llm.references(conn, 'alice'))
        llm.delete_reference(conn, first)
        add(conn, filename='chart.png', data=ALPHABET)

        assert llm.ask_digest('Transcribe.', llm.references(conn, 'alice')) != before

    def test_the_order_of_the_pictures_is_part_of_it(self, conn):
        add(conn, filename='a.png', data=CHART)
        add(conn, filename='b.png', data=ALPHABET)
        forwards = llm.ask_digest('Transcribe.', llm.references(conn, 'alice'))

        assert forwards != llm.ask_digest(
            'Transcribe.', list(reversed(llm.references(conn, 'alice'))))


@pytest.fixture
def client(conn, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.ENABLE_LLM_OCR', True)
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()


def upload(client, headers=ALICE, job_id=None, data=CHART, filename='chart.png',
           mime='image/png'):
    return client.post('/api/llm/references', headers=headers,
                       files={'file': (filename, data, mime)},
                       data={'job_id': job_id} if job_id else {})


def listed(client, headers=ALICE, job_id=None):
    query = f'?job_id={job_id}' if job_id else ''
    response = client.get(f'/api/llm/references{query}', headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


class TestOverTheWire:
    def test_uploading_says_what_was_kept_without_the_bytes(self, client):
        response = upload(client)

        assert response.status_code == 200, response.text
        body = response.json()
        assert (body['filename'], body['mime'], body['bytes']) == ('chart.png', 'image/png', len(CHART))
        assert 'bytes_data' not in body and isinstance(body['digest'], str)

    def test_the_picture_itself_comes_back_as_an_image(self, client):
        reference_id = upload(client).json()['id']

        response = client.get(f'/api/llm/references/{reference_id}/image', headers=ALICE)

        assert response.status_code == 200
        assert response.headers['content-type'].startswith('image/png')
        assert response.content == CHART

    def test_a_dataset_says_whether_the_set_is_its_own_or_inherited(self, client):
        upload(client)
        assert listed(client, job_id='j1')['inherited'] is True

        upload(client, job_id='j1', data=ALPHABET, filename='corpus.png')

        listing = listed(client, job_id='j1')
        assert listing['inherited'] is False
        assert [r['filename'] for r in listing['references']] == ['corpus.png']

    def test_removing_one_leaves_the_dataset_on_its_own_set(self, client):
        upload(client, job_id='j1')
        reference_id = listed(client, job_id='j1')['references'][0]['id']

        assert client.delete(f'/api/llm/references/{reference_id}', headers=ALICE).status_code == 200
        assert listed(client, job_id='j1')['references'] == []

    def test_an_oversized_upload_is_refused_without_reading_all_of_it(self, client, monkeypatch):
        reads = []
        read = UploadFile.read

        async def recorded(self, size=-1):
            data = await read(self, size)
            reads.append(len(data))
            return data
        monkeypatch.setattr(UploadFile, 'read', recorded)

        response = upload(client, data=CHART + b'x' * llm.MAX_REFERENCE_BYTES)

        assert response.status_code == 400
        assert 'too large' in response.json()['detail']
        assert reads == [llm.MAX_REFERENCE_BYTES + 1]

    def test_a_file_that_is_not_an_image_is_refused_with_a_reason(self, client):
        response = upload(client, filename='notes.pdf', mime='application/pdf')

        assert response.status_code == 400
        assert 'image' in response.json()['detail']


class TestWhoMaySeeAndChange:
    def test_a_persons_own_set_is_nobody_elses_business(self, client):
        reference_id = upload(client, ALICE).json()['id']

        assert client.get(f'/api/llm/references/{reference_id}/image',
                          headers=BOB).status_code == 404
        assert listed(client, BOB)['references'] == []
        assert listed(client, ALICE)['references'] != []

    def test_a_stranger_is_not_told_the_dataset_exists(self, client):
        assert client.get('/api/llm/references?job_id=j1', headers=BOB).status_code == 404

    def test_someone_a_dataset_is_shared_with_may_look_but_not_change_it(self, client, conn):
        conn.execute("INSERT INTO job_assignees (job_id, username) VALUES ('j1', 'bob')")
        conn.commit()

        assert client.get('/api/llm/references?job_id=j1', headers=BOB).status_code == 200
        assert upload(client, BOB, job_id='j1').status_code == 403

    def test_an_admin_may_change_any_datasets(self, client):
        assert upload(client, ADMIN, job_id='j1').status_code == 200

    def test_a_deployment_with_the_feature_off_refuses_to_change_anything(self, client, monkeypatch):
        reference_id = upload(client).json()['id']
        monkeypatch.setattr('app.config.ENABLE_LLM_OCR', False)

        assert upload(client, data=ALPHABET, filename='another.png').status_code == 403
        assert client.delete(f'/api/llm/references/{reference_id}',
                             headers=ALICE).status_code == 403
        # Reading stays open, so the page can still explain what is set.
        assert listed(client)['references'] != []
