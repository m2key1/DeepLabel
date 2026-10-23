"""The span an edit hands back is what Undo takes back. A machine writing to the same page
at the same moment - the runner, a language model's reading - must never land inside it,
or undoing the person's edit would undo the machine's too."""
import json
import threading

import pytest
from fastapi.testclient import TestClient

from app import store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}
BOX = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.2], [0.1, 0.2]]
NEXT_BOX = [[0.1, 0.3], [0.9, 0.3], [0.9, 0.4], [0.1, 0.4]]
RING = [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2]]


@pytest.fixture
def db_path(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    monkeypatch.setattr('app.config.SAVE_OCR_DATA', False)
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    return tmp_path / 'app.db'


@pytest.fixture
def conn(db_path):
    connection = store.connect(db_path)
    connection.executescript(f"""
        INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'Volume', 'alice', 'done');
        INSERT INTO pages (id, job_id, idx, filename, source_file, status, width, height)
            VALUES (1, 'j1', 0, 'p1.png', '/p1.png', 'done', 400, 200);
        INSERT INTO elements (id, page_id, order_idx, class_name, raw_class_name, bbox, kind)
            VALUES (1, 1, 0, 'Paragraph', 'Paragraph', '[0.0,0.0,1.0,0.5]', 'content');
        INSERT INTO lines (id, element_id, order_idx, polygon, text) VALUES
            (1, 1, 0, '{json.dumps(BOX)}', 'Frst line'),
            (2, 1, 1, '{json.dumps(NEXT_BOX)}', 'Secnd line');
        INSERT INTO jobs (id, name, owner, status, task) VALUES
            ('m1', 'Map', 'alice', 'done', 'map_segmentation');
        INSERT INTO pages (id, job_id, idx, filename, source_file, status, width, height)
            VALUES (2, 'm1', 0, 't.png', '/t.png', 'done', 512, 512);
        INSERT INTO regions (id, page_id, order_idx, class_id, points, holes, kind) VALUES
            (1, 2, 0, 1, '{json.dumps(RING)}', '[]', 'polygon');
    """)
    store.seed_job_classes(connection, 'm1', [
        {'id': 0, 'name': 'background', 'color': [0, 0, 0], 'priority': 1},
        {'id': 1, 'name': 'buildings', 'color': [255, 0, 195], 'priority': 0},
    ])
    connection.commit()
    yield connection
    connection.close()


@pytest.fixture
def client(conn, db_path):
    def per_request():
        request_conn = store.connect(db_path)
        try:
            yield request_conn
        finally:
            request_conn.close()

    app.dependency_overrides[get_db] = per_request
    yield TestClient(app)
    app.dependency_overrides.clear()


EDITS = {
    'correct a line': ('patch', '/api/lines/1', {'corrected_text': 'First line'}),
    'delete a line': ('delete', '/api/lines/1', None),
    'draw a line': ('post', '/api/pages/1/lines', {'polygon': BOX}),
    'reclassify a region': ('patch', '/api/elements/1', {'class_name': 'Header'}),
    'draw a region': ('post', '/api/pages/1/elements',
                      {'class_name': 'Paragraph', 'bbox': [0.0, 0.6, 1.0, 0.9]}),
    'delete a region': ('delete', '/api/elements/1', None),
    'split a region': ('post', '/api/elements/1/split', {'cut_y': 0.25}),
    'check a page': ('patch', '/api/pages/1', {'layout_checked': True}),
    'merge lines': ('post', '/api/lines/merge', {'ids': [1, 2]}),
    'draw a map region': ('post', '/api/pages/2/regions', {'class_id': 1, 'points': RING}),
    'reshape a map region': ('patch', '/api/regions/1', {'points': [[0.3, 0.3], [0.4, 0.3], [0.4, 0.4]]}),
    'delete a map region': ('delete', '/api/regions/1', None),
}


def _seed_origins(conn):
    for target_type, target_id in (('line', 1), ('line', 2), ('element', 1), ('region', 1)):
        store.ensure_origin(conn, target_type, target_id, 'model:ocr')
    conn.commit()


def _race_the_next_mark(db_path, monkeypatch) -> threading.Thread:
    """The machine writes the moment the edit reads where its span starts."""
    original = store.revision_mark
    machine = threading.Thread(target=_machine_reads_line_1, args=(db_path,))

    def racing_mark(mark_conn):
        mark = original(mark_conn)
        if not machine.is_alive() and machine.ident is None:
            machine.start()
            machine.join(timeout=1)
        return mark

    monkeypatch.setattr(store, 'revision_mark', racing_mark)
    return machine


def _assert_only_alice_inside(conn, span):
    inside = conn.execute('SELECT author FROM revisions WHERE id > ? AND id <= ?',
                          (span['from'], span['to'])).fetchall()
    assert inside and {r['author'] for r in inside} == {'alice'}
    machine_ids = [r['id'] for r in conn.execute(
        "SELECT id FROM revisions WHERE author = 'model:ocr' AND action = 'update'")]
    assert len(machine_ids) == 1 and machine_ids[0] > span['to']


@pytest.mark.parametrize('edit', list(EDITS))
def test_a_machine_revision_written_meanwhile_lands_outside_the_span(edit, client, conn,
                                                                    db_path, monkeypatch):
    _seed_origins(conn)
    machine = _race_the_next_mark(db_path, monkeypatch)
    method, url, body = EDITS[edit]
    response = client.request(method, url, json=body, headers=ALICE)
    machine.join(timeout=10)

    assert response.status_code == 200, response.text
    _assert_only_alice_inside(conn, response.json()['span'])


def test_an_undo_s_own_span_leaves_out_a_machine_writing_meanwhile(client, conn, db_path,
                                                                   monkeypatch):
    _seed_origins(conn)
    edit = client.patch('/api/lines/1', json={'corrected_text': 'First line'}, headers=ALICE)
    assert edit.status_code == 200, edit.text
    edited = edit.json()['span']

    machine = _race_the_next_mark(db_path, monkeypatch)
    response = client.post('/api/pages/1/revert', headers=ALICE, json={
        'from_revision': edited['from'], 'to_revision': edited['to'], 'direction': 'undo'})
    machine.join(timeout=10)

    assert response.status_code == 200, response.text
    _assert_only_alice_inside(conn, response.json()['span'])


def _machine_reads_line_1(db_path):
    other = store.connect(db_path)
    try:
        other.execute(
            "INSERT INTO revisions (target_type, target_id, job_id, author, action, snapshot) "
            "VALUES ('line', 1, 'j1', 'model:ocr', 'update', '{}')")
        other.commit()
    finally:
        other.close()
