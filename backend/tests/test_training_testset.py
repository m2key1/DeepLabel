"""A run's test set is the test pages of the datasets it names: they never train and never
steer early stopping - they are scored once with the base model and once with the new
model when the training finishes, so "did it help?" has an untouched answer.
"""
import json

import pytest
from fastapi.testclient import TestClient

from app import store, trainer
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}


@pytest.fixture
def client(tmp_path, monkeypatch, training_backend):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    conn = store.connect(tmp_path / 'app.db')
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app), conn
    app.dependency_overrides.clear()
    conn.close()


def seed_checked_lines(conn, job_id: str, count: int, content_hash: str | None = None,
                       is_test: bool = False):
    if conn.execute('SELECT 1 FROM jobs WHERE id = ?', (job_id,)).fetchone() is None:
        conn.execute("INSERT INTO jobs (id, name, owner, status) VALUES (?, ?, 'root', 'done')",
                     (job_id, f'Set {job_id}'))
    page = conn.execute("INSERT INTO pages (job_id, idx, filename, source_file, content_hash, is_test) "
                        "VALUES (?, 0, 'p.png', '/p.png', ?, ?)", (job_id, content_hash, int(is_test))).lastrowid
    el = conn.execute("INSERT INTO elements (page_id, order_idx, class_name, bbox) "
                      "VALUES (?, 0, 'Paragraph', '[]')", (page,)).lastrowid
    for i in range(count):
        conn.execute("INSERT INTO lines (element_id, order_idx, polygon, text, checked) "
                     "VALUES (?, ?, '[]', 'x', 1)", (el, i))
    conn.commit()


def create(api, **overrides):
    body = {'task': 'ocr', 'name': 'run', 'dataset_job_ids': ['j-train'], **overrides}
    return api.post('/api/trainings', json=body, headers=ADMIN)


def test_test_datasets_are_stored_and_returned(client):
    api, conn = client
    seed_checked_lines(conn, 'j-train', 3)
    seed_checked_lines(conn, 'j-test', 2, is_test=True)
    res = create(api, test_job_ids=['j-test'])
    assert res.status_code == 200, res.text
    assert res.json()['test_job_ids'] == ['j-test']
    assert res.json()['split_strategy'] == 'uniform'


def test_a_dataset_may_train_on_some_pages_and_hold_the_test_set_on_others(client):
    api, conn = client
    seed_checked_lines(conn, 'j-train', 3)
    seed_checked_lines(conn, 'j-train', 2, is_test=True)
    res = create(api, test_job_ids=['j-train'])
    assert res.status_code == 200, res.text


def test_a_test_dataset_without_test_pages_is_refused(client):
    api, conn = client
    seed_checked_lines(conn, 'j-train', 3)
    seed_checked_lines(conn, 'j-test', 2)
    res = create(api, test_job_ids=['j-test'])
    assert res.status_code == 400
    assert res.json()['detail'] == 'Set j-test has no test pages'


def test_test_pages_without_checked_material_are_refused(client):
    api, conn = client
    seed_checked_lines(conn, 'j-train', 3)
    seed_checked_lines(conn, 'j-test', 0, is_test=True)
    res = create(api, test_job_ids=['j-test'])
    assert res.status_code == 400
    assert res.json()['detail'] == 'the test pages contain no checked material for this task'


def test_a_run_of_nothing_but_test_data_is_refused(client):
    api, conn = client
    seed_checked_lines(conn, 'j-train', 3, is_test=True)
    res = create(api)
    assert res.status_code == 400
    assert res.json()['detail'] == 'the selected datasets contain no checked material for this task'


def test_preview_counts_only_what_can_train_and_says_what_is_left_out(client):
    """A page that is test data, or shares its scan with test data, is no training material;
    the dialog says how many such pages it leaves out, and where their test pages are."""
    api, conn = client
    seed_checked_lines(conn, 'j-train', 3, content_hash='shared-scan')
    seed_checked_lines(conn, 'j-train', 4, content_hash='own-scan')
    seed_checked_lines(conn, 'j-train', 5, content_hash='marked', is_test=True)
    seed_checked_lines(conn, 'j-test', 2, content_hash='shared-scan', is_test=True)

    res = api.post('/api/trainings/preview', headers=ADMIN, json={'task': 'ocr', 'job_ids': ['j-train']})
    assert res.status_code == 200
    assert res.json() == {'counts': {'j-train': 4}, 'pages': {'j-train': 1},
                          'machine_settled': {'j-train': 0}, 'human_checked_pages': {'j-train': 1},
                          'left_out': [{'job_id': 'j-test', 'name': 'Set j-test', 'pages': 1}]}


def test_preview_takes_its_datasets_in_the_body(client):
    """The dialog previews every dataset at once, so the selection must not ride in the
    URL: past 626 datasets the request line outgrew the proxy's 8k limit, the preview
    answered 414, and with no counts the picker disabled every checkbox."""
    api, conn = client
    seed_checked_lines(conn, 'j-train', 3)

    res = api.post('/api/trainings/preview', headers=ADMIN,
                   json={'task': 'ocr', 'job_ids': ['j-train']})
    assert res.status_code == 200, res.text
    assert res.json() == {'counts': {'j-train': 3}, 'pages': {'j-train': 1},
                          'machine_settled': {'j-train': 0}, 'human_checked_pages': {'j-train': 1},
                          'left_out': []}
    assert api.get('/api/trainings/preview?task=ocr&job_ids=j-train',
                   headers=ADMIN).status_code == 405


def test_preview_says_what_a_person_only_run_would_keep(client):
    """Leaving out what models settled can empty whole pages, and the split divides
    pages, so the dialog needs both the lines and the pages a person verified."""
    api, conn = client
    seed_checked_lines(conn, 'j-train', 3)
    seed_checked_lines(conn, 'j-settled', 2)
    conn.execute("UPDATE lines SET check_source = 'llm' WHERE element_id IN ("
                 "SELECT e.id FROM elements e JOIN pages p ON e.page_id = p.id "
                 "WHERE p.job_id = 'j-settled')")
    conn.execute("UPDATE lines SET check_source = 'llm' WHERE id = ("
                 "SELECT MIN(l.id) FROM lines l JOIN elements e ON l.element_id = e.id "
                 "JOIN pages p ON e.page_id = p.id WHERE p.job_id = 'j-train')")
    conn.commit()

    res = api.post('/api/trainings/preview', headers=ADMIN,
                   json={'task': 'ocr', 'job_ids': ['j-train', 'j-settled']})

    assert res.json() == {'counts': {'j-train': 3, 'j-settled': 2},
                          'pages': {'j-train': 1, 'j-settled': 1},
                          'machine_settled': {'j-train': 1, 'j-settled': 2},
                          'human_checked_pages': {'j-train': 1, 'j-settled': 0}, 'left_out': []}


def test_eval_breakdown_is_labeled_and_redacted(client):
    """Per-dataset scores come back with dataset names resolved server-side, and a
    dataset the caller cannot open stays redacted like everywhere else."""
    api, conn = client
    member = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member'}
    seed_checked_lines(conn, 'j-a', 1)
    conn.execute("UPDATE jobs SET owner = 'bob' WHERE id = 'j-a'")
    seed_checked_lines(conn, 'j-b', 1)
    conn.execute("INSERT INTO models (id, task, name, checkpoint) VALUES (1, 'ocr', 'M', '/c')")
    conn.execute("INSERT INTO evaluations (model_id, source, owner, status, breakdown) VALUES "
                 "(1, '{\"jobs\": [\"j-a\", \"j-b\"]}', 'root', 'done', "
                 "'{\"j-a\": {\"cer\": 0.1, \"wer\": 0.2, \"lines\": 3}, "
                 "\"j-b\": {\"cer\": 0.3, \"wer\": 0.4, \"lines\": 2}}')")
    conn.commit()

    res = api.get('/api/evaluations', headers=member)
    assert res.status_code == 200
    breakdown = res.json()['evaluations'][0]['breakdown']
    assert breakdown == [
        {'job_id': 'j-a', 'name': 'Set j-a', 'cer': 0.1, 'wer': 0.2, 'lines': 3},
        {'job_id': 'j-b', 'name': 'another dataset', 'cer': 0.3, 'wer': 0.4, 'lines': 2}]


def test_progress_passes_per_dataset_points_and_names_them(client, tmp_path, monkeypatch):
    """The trainer may attach cer_by_dataset (keyed by job id) and ts to a progress
    point; the endpoint passes both through and resolves the ids to names, redacted
    for datasets the caller cannot open."""
    api, conn = client
    monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path / 'trainings')
    member = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member'}
    seed_checked_lines(conn, 'j-a', 1)
    seed_checked_lines(conn, 'j-b', 1)
    conn.execute("UPDATE jobs SET owner = 'bob' WHERE id = 'j-b'")
    conn.execute("INSERT INTO trainings (id, task, name, owner, dataset_job_ids, valid_job_ids) "
                 "VALUES (1, 'ocr', 'run', 'root', '[\"j-a\", \"j-b\"]', '[]')")
    conn.commit()
    out = tmp_path / 'trainings' / '1' / 'output'
    out.mkdir(parents=True)
    (out / 'progress.jsonl').write_text(
        json.dumps({'epoch': 1, 'cer': 0.2, 'ts': 5.0,
                    'cer_by_dataset': {'j-a': 0.25, 'j-b': 0.15}}) + '\n')

    res = api.get('/api/trainings/1/progress', headers=member)
    assert res.status_code == 200
    body = res.json()
    assert body['points'] == [{'epoch': 1, 'cer': 0.2, 'ts': 5.0,
                               'cer_by_dataset': {'j-a': 0.25, 'j-b': 0.15}}]
    assert body['datasets'] == {'j-a': 'another dataset', 'j-b': 'Set j-b'}
    assert body['updated_at'] is not None


def test_finishing_queues_test_evals_for_base_and_new_model(client, tmp_path):
    api, conn = client
    seed_checked_lines(conn, 'j-test', 2)
    conn.execute("INSERT INTO models (id, task, name, checkpoint) VALUES (7, 'ocr', 'Base', '/b.ckpt')")
    conn.execute("INSERT INTO trainings (id, task, name, owner, base_model_id, dataset_job_ids, "
                 "test_job_ids) VALUES (1, 'ocr', 'run', 'root', 7, '[\"j-train\"]', '[\"j-test\"]')")
    conn.commit()
    out = tmp_path / 'output'
    out.mkdir()
    (out / 'model.ckpt').write_bytes(b'ckpt')
    (out / 'metrics.json').write_text('{"cer": 0.1}')

    model_id = trainer.register_result(conn, trainer.get_training(conn, 1), out)

    evals = conn.execute('SELECT model_id, source, training_id, status FROM evaluations '
                         'ORDER BY id').fetchall()
    test_evals = [(e['model_id'], json.loads(e['source'])) for e in evals
                  if 'jobs' in e['source']]
    assert test_evals == [(model_id, {'jobs': ['j-test'], 'test_pages': True}), (7, {'jobs': ['j-test'], 'test_pages': True})]
    assert all(e['status'] == 'queued' and e['training_id'] == 1 for e in evals
               if 'jobs' in e['source'])


def test_a_person_only_run_scores_its_test_set_on_person_verified_lines_only(client, tmp_path):
    api, conn = client
    seed_checked_lines(conn, 'j-test', 2)
    conn.execute("INSERT INTO models (id, task, name, checkpoint) VALUES (7, 'ocr', 'Base', '/b.ckpt')")
    conn.execute("INSERT INTO trainings (id, task, name, owner, base_model_id, dataset_job_ids, "
                 "test_job_ids, human_checked_only) "
                 "VALUES (1, 'ocr', 'run', 'root', 7, '[\"j-train\"]', '[\"j-test\"]', 1)")
    conn.commit()
    out = tmp_path / 'output'
    out.mkdir()
    (out / 'model.ckpt').write_bytes(b'ckpt')
    (out / 'metrics.json').write_text('{"cer": 0.1}')

    model_id = trainer.register_result(conn, trainer.get_training(conn, 1), out)

    test_evals = [(e['model_id'], json.loads(e['source'])) for e in conn.execute(
        "SELECT model_id, source FROM evaluations WHERE source LIKE '%jobs%' ORDER BY id")]
    assert test_evals == [(model_id, {'jobs': ['j-test'], 'test_pages': True, 'human_checked_only': True}),
                          (7, {'jobs': ['j-test'], 'test_pages': True, 'human_checked_only': True})]


def test_a_person_only_run_refuses_a_test_set_only_models_settled(client):
    api, conn = client
    seed_checked_lines(conn, 'j-train', 3)
    seed_checked_lines(conn, 'j-test', 2, is_test=True)
    conn.execute("UPDATE lines SET check_source = 'llm' WHERE element_id IN ("
                 "SELECT e.id FROM elements e JOIN pages p ON e.page_id = p.id "
                 "WHERE p.job_id = 'j-test')")
    conn.commit()

    assert create(api, name='mixed', test_job_ids=['j-test']).status_code == 200
    res = create(api, name='people', test_job_ids=['j-test'], human_checked_only=True)
    assert res.status_code == 400
    assert res.json()['detail'] == 'the test pages contain no checked material for this task'


def test_the_test_set_is_scored_in_the_same_mode_the_model_will_run(client, tmp_path):
    """One headline number on untouched data, in the decode the model actually runs.
    It was pinned to a mode name that later came to mean something else, so the test-set
    score compared against valid-split scores taken a different way."""
    from app import decode

    api, conn = client
    seed_checked_lines(conn, 'j-test', 2)
    conn.execute("INSERT INTO models (id, task, name, checkpoint) VALUES (7, 'ocr', 'Base', '/b.ckpt')")
    conn.execute("INSERT INTO trainings (id, task, name, owner, base_model_id, dataset_job_ids, "
                 "test_job_ids) VALUES (1, 'ocr', 'run', 'root', 7, '[\"j-train\"]', '[\"j-test\"]')")
    conn.commit()
    out = tmp_path / 'output'
    out.mkdir()
    (out / 'model.ckpt').write_bytes(b'ckpt')
    (out / 'metrics.json').write_text('{"cer": 0.1}')

    trainer.register_result(conn, trainer.get_training(conn, 1), out)

    modes = {row['decode'] for row in conn.execute(
        "SELECT decode FROM evaluations WHERE source LIKE '%jobs%'")}
    assert modes == {decode.DEFAULT_DECODE} == {'beam'}


@pytest.mark.parametrize('task', ['ocr', 'layout', 'lines'])
def test_preview_reads_every_dataset_in_one_query(client, task):
    """The dialog previews every dataset there is; per-dataset queries were thousands of
    statements for 626 of them. One query counts them, one more finds what is left out."""
    api, conn = client
    for n in range(6):
        seed_checked_lines(conn, f'j-{n}', n + 1)
    statements = []
    conn.set_trace_callback(statements.append)
    try:
        res = api.post('/api/trainings/preview', headers=ADMIN,
                       json={'task': task, 'job_ids': [f'j-{n}' for n in range(6)]})
    finally:
        conn.set_trace_callback(None)

    assert res.status_code == 200, res.text
    counting = [s for s in statements if 'FROM lines' in s or 'FROM pages' in s]
    assert len(counting) == 2, counting


def test_preview_counts_match_what_a_run_would_check(client):
    api, conn = client
    seed_checked_lines(conn, 'j-a', 3, content_hash='a')
    seed_checked_lines(conn, 'j-b', 2, content_hash='b')
    conn.execute("UPDATE pages SET layout_checked = 1, lines_checked = 1, width = 10, height = 10 "
                 "WHERE job_id = 'j-a'")
    conn.execute("UPDATE pages SET layout_checked = 1, lines_checked = 1 WHERE job_id = 'j-b'")
    duplicate = conn.execute("INSERT INTO pages (job_id, idx, filename, source_file, content_hash, "
                             "status, layout_checked, lines_checked, width, height) "
                             "VALUES ('j-a', 1, 'p.png', '/p.png', 'a', 'duplicate', 1, 1, 10, 10)"
                             ).lastrowid
    element = conn.execute("INSERT INTO elements (page_id, order_idx, class_name, bbox) "
                           "VALUES (?, 0, 'Paragraph', '[]')", (duplicate,)).lastrowid
    conn.execute("INSERT INTO lines (element_id, order_idx, polygon, text, checked, check_source) "
                 "VALUES (?, 0, '[]', 'x', 1, 'llm')", (element,))
    conn.execute("UPDATE lines SET check_source = 'llm' WHERE id = (SELECT MIN(l.id) FROM lines l "
                 "JOIN elements e ON l.element_id = e.id JOIN pages p ON e.page_id = p.id "
                 "WHERE p.job_id = 'j-b')")
    conn.commit()

    def preview(task):
        return api.post('/api/trainings/preview', headers=ADMIN,
                        json={'task': task, 'job_ids': ['j-a', 'j-b']}).json()

    assert preview('ocr') == {'counts': {'j-a': 3, 'j-b': 2}, 'pages': {'j-a': 1, 'j-b': 1},
                              'machine_settled': {'j-a': 0, 'j-b': 1},
                              'human_checked_pages': {'j-a': 1, 'j-b': 1}, 'left_out': []}
    assert preview('layout') == {'counts': {'j-a': 1, 'j-b': 1}, 'pages': {'j-a': 1, 'j-b': 0},
                                 'machine_settled': {'j-a': 0, 'j-b': 0},
                                 'human_checked_pages': {'j-a': 1, 'j-b': 0}, 'left_out': []}
    assert preview('lines') == {'counts': {'j-a': 1, 'j-b': 1}, 'pages': {'j-a': 1, 'j-b': 0},
                                'machine_settled': {'j-a': 0, 'j-b': 0},
                                'human_checked_pages': {'j-a': 1, 'j-b': 0}, 'left_out': []}


@pytest.mark.parametrize('pages, counted', [('train', 3), ('test', 2), ('all', 5)])
def test_preview_counts_the_pages_asked_for(client, pages, counted):
    """An evaluation of all pages, or of the test pages, counts what it would score."""
    api, conn = client
    seed_checked_lines(conn, 'j-a', 3)
    seed_checked_lines(conn, 'j-a', 2, is_test=True)

    res = api.post('/api/trainings/preview', headers=ADMIN,
                   json={'task': 'ocr', 'job_ids': ['j-a'], 'pages': pages})

    assert res.json()['counts'] == {'j-a': counted}
