"""The evaluation page's backend: the evaluator's per-line records imported per
evaluation, read back paged, sorted and filtered, summarised, and sent to review."""
import json

import pytest
from fastapi.testclient import TestClient

from app import eval_lines, eval_metrics, evaluator, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}
BOB = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member'}
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}
BOX = '[[0,0],[1,0],[1,1],[0,1]]'

# line_id, page_id, job, truth, read, confidence
SCORED = [
    (1, 1, 'j1', 'Wels', 'Wels', 0.99),
    (2, 1, 'j1', 'Wien 1850', 'Wien 1860', 0.95),
    (3, 1, 'j1', 'Graz', 'graz', 0.85),
    (4, 2, 'j1', 'Linz.', 'Linz', 0.91),
    (5, 3, 'j2', 'a b', 'ab', 0.40),
]


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.EVALS_DIR', tmp_path / 'evaluations')
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript("""
        INSERT INTO jobs (id, name, owner, status) VALUES
            ('j1', 'Volume', 'alice', 'done'), ('j2', 'Private', 'bob', 'done');
        INSERT INTO pages (id, job_id, idx, filename, source_file, status) VALUES
            (1, 'j1', 0, 'p1.png', '/p1.png', 'done'),
            (2, 'j1', 1, 'p2.png', '/p2.png', 'done'),
            (3, 'j2', 0, 'q1.png', '/q1.png', 'done');
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) VALUES
            (1, 1, 0, 'Paragraph', '[0,0,1,1]', 'content'),
            (2, 2, 0, 'Paragraph', '[0,0,1,1]', 'content'),
            (3, 3, 0, 'Paragraph', '[0,0,1,1]', 'content');
        INSERT INTO models (id, task, name, checkpoint) VALUES (9, 'ocr', 'Kurrent', '/k.pt');
        INSERT INTO evaluations (id, model_id, source, decode, status, owner, cer, line_count) VALUES
            (7, 9, '{"jobs": ["j1", "j2"]}', 'beam', 'done', 'alice', 0.2, 5),
            (8, 9, '{"jobs": ["j1", "j2"]}', 'greedy', 'done', 'alice', 0.3, 5),
            (6, 9, '{"jobs": ["j1"]}', 'greedy', 'done', 'alice', 0.3, 4);
    """)
    for line_id, page_id, _, truth, _, conf in SCORED:
        connection.execute(
            'INSERT INTO lines (id, element_id, order_idx, polygon, text, confidence, checked) '
            'VALUES (?, ?, ?, ?, ?, ?, 1)', (line_id, page_id, line_id, BOX, truth, conf))
    connection.commit()
    yield connection
    connection.close()


def records(decode='beam', page_known=True):
    return [eval_metrics.line_record(line_id, job, page if page_known else None, decode,
                                     truth, read, conf)
            for line_id, page, job, truth, read, conf in SCORED]


def write_jsonl(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(''.join(json.dumps(r) + '\n' for r in rows), encoding='utf-8')
    return path


@pytest.fixture
def imported(conn):
    eval_lines.import_file(conn, 7, write_jsonl(evaluator.lines_path(7), records()))
    eval_lines.import_file(conn, 8, write_jsonl(evaluator.lines_path(8), records('greedy')))
    return conn


@pytest.fixture
def client(imported):
    app.dependency_overrides[get_db] = lambda: imported
    yield TestClient(app)
    app.dependency_overrides.clear()


def stored(conn, eval_id):
    return [dict(r) for r in conn.execute(
        'SELECT * FROM eval_lines WHERE evaluation_id = ? ORDER BY line_id', (eval_id,))]


class TestImport:
    def test_every_record_becomes_a_row_with_its_diff(self, imported):
        rows = stored(imported, 7)
        assert [r['line_id'] for r in rows] == [1, 2, 3, 4, 5]
        second = rows[1]
        assert (second['job_id'], second['page_id'], second['decode']) == ('j1', 1, 'beam')
        assert (second['ground_truth'], second['prediction']) == ('Wien 1850', 'Wien 1860')
        assert second['cer'] == pytest.approx(1 / 9)
        assert (second['distance'], second['length'], second['confidence']) == (1, 9, 0.95)
        assert json.loads(second['ops']) == [['=', 'Wien 18', 'Wien 18'], ['s', '5', '6'],
                                             ['=', '0', '0']]

    def test_importing_again_replaces_rather_than_doubles(self, imported):
        assert eval_lines.import_file(imported, 7, evaluator.lines_path(7)) == 5
        assert len(stored(imported, 7)) == 5

    def test_a_snapshot_record_finds_its_page_and_dataset_from_the_line(self, conn):
        bare = [{**r, 'page_id': None, 'job_id': None} for r in records()]
        eval_lines.import_file(conn, 7, write_jsonl(evaluator.lines_path(7), bare))
        assert [(r['job_id'], r['page_id']) for r in stored(conn, 7)] == [
            ('j1', 1), ('j1', 1), ('j1', 1), ('j1', 2), ('j2', 3)]

    def test_the_placements_are_looked_up_in_one_query(self, conn):
        bare = [{**r, 'page_id': None, 'job_id': None} for r in records()]
        statements = []
        conn.set_trace_callback(statements.append)
        try:
            eval_lines.import_records(conn, 7, bare)
        finally:
            conn.set_trace_callback(None)
        assert len([s for s in statements if 'FROM lines l' in s]) == 1
        assert [(r['job_id'], r['page_id']) for r in stored(conn, 7)][-1] == ('j2', 3)

    def test_no_file_is_no_rows(self, conn):
        assert eval_lines.import_file(conn, 7, evaluator.lines_path(7)) == 0
        assert stored(conn, 7) == []

    def test_a_finished_run_is_imported_by_the_worker(self, conn, monkeypatch):
        conn.execute("UPDATE evaluations SET status = 'queued' WHERE id = 7")
        conn.commit()

        class Finished:
            pid, returncode = 1234, 0

            def wait(self, timeout=None):
                write_jsonl(evaluator.lines_path(7), records())
                evaluator.set_state(conn, 7, status='done')
                return 0

        monkeypatch.setattr(evaluator, '_spawn', lambda *a: Finished())
        monkeypatch.setattr(evaluator, 'memory_ceiling', lambda: None)

        evaluator.run_local(conn, 7)

        assert evaluator.get_evaluation(conn, 7)['status'] == 'done'
        assert [r['line_id'] for r in stored(conn, 7)] == [1, 2, 3, 4, 5]

    def test_a_score_copied_from_identical_data_brings_its_lines(self, imported, tmp_path,
                                                                 monkeypatch):
        monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path / 'trainings')
        valid = tmp_path / 'trainings' / '1' / 'snapshot' / 'valid'
        valid.mkdir(parents=True)
        (valid / 'line_1.txt').write_text('Wels')
        (valid / 'line_1.png').write_bytes(b'PNG')
        imported.execute("INSERT INTO trainings (id, name, task, status, owner, base_model_id) "
                         "VALUES (1, 'Run', 'ocr', 'done', 'alice', 9)")
        imported.execute('UPDATE evaluations SET fingerprint = ? WHERE id = 7',
                         (evaluator.split_fingerprint(1),))
        imported.commit()
        training = dict(imported.execute('SELECT * FROM trainings WHERE id = 1').fetchone())

        evaluator.create_baseline(imported, training)

        copy = imported.execute("SELECT id FROM evaluations WHERE training_id = 1 AND decode = 'beam'"
                                ).fetchone()['id']
        assert [r['line_id'] for r in stored(imported, copy)] == [1, 2, 3, 4, 5]


def lines(client, headers=ADMIN, **params):
    response = client.get('/api/evaluations/7/lines', params=params, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


class TestLinesApi:
    def test_a_page_is_sorted_worst_first_and_counts_the_whole(self, client):
        body = lines(client, sort='cer', order='desc', limit=2)
        assert body['total'] == 5
        assert [l['line_id'] for l in body['lines']] == [5, 3]

    def test_the_next_page_carries_on(self, client):
        body = lines(client, sort='cer', order='desc', limit=2, offset=2)
        assert [l['line_id'] for l in body['lines']] == [4, 2]

    def test_sorted_by_confidence_and_by_length(self, client):
        assert [l['line_id'] for l in lines(client, sort='confidence', order='asc')['lines']] == [
            5, 3, 4, 2, 1]
        assert [l['line_id'] for l in lines(client, sort='length', order='desc')['lines']] == [
            2, 4, 1, 3, 5]

    def test_a_row_is_keyed_by_line_with_its_reading_beside_the_truth(self, client):
        row = next(l for l in lines(client)['lines'] if l['line_id'] == 2)
        assert row == {
            'line_id': 2, 'job_id': 'j1', 'page_id': 1, 'ground_truth': 'Wien 1850', 'length': 9,
            'reading': {'evaluation_id': 7, 'decode': 'beam', 'prediction': 'Wien 1860',
                        'cer': pytest.approx(1 / 9), 'distance': 1, 'confidence': 0.95,
                        'ops': [['=', 'Wien 18', 'Wien 18'], ['s', '5', '6'], ['=', '0', '0']]}}

    def test_filtered_by_cer_range(self, client):
        body = lines(client, cer_min=0.2, cer_max=0.3, sort='cer', order='asc')
        assert [l['line_id'] for l in body['lines']] == [4, 3]
        assert body['total'] == 2

    def test_filtered_by_dataset(self, client):
        body = lines(client, job_id='j2')
        assert [l['line_id'] for l in body['lines']] == [5]

    def test_searched_in_the_truth_and_the_reading(self, client):
        assert [l['line_id'] for l in lines(client, q='graz')['lines']] == [3]
        assert [l['line_id'] for l in lines(client, q='1860')['lines']] == [2]

    def test_a_sort_nobody_offers_is_refused(self, client):
        response = client.get('/api/evaluations/7/lines', params={'sort': 'id; DROP'},
                              headers=ALICE)
        assert response.status_code == 422

    def test_lines_of_a_dataset_the_viewer_cannot_open_are_left_out(self, client):
        body = lines(client, headers=ALICE, sort='line', order='asc')
        detail = client.get('/api/evaluations/7', headers=ALICE).json()
        assert detail['hidden_lines'] == 1
        assert detail['line_rows'] == 4
        assert [l['line_id'] for l in body['lines']] == [1, 2, 3, 4]
        bob = lines(client, headers=BOB)
        assert [l['line_id'] for l in bob['lines']] == [5]



class TestDetail:
    def test_the_detail_names_the_model_material_and_sibling_decodes(self, client):
        body = client.get('/api/evaluations/7', headers=ADMIN).json()
        assert body['model_name'] == 'Kurrent'
        assert body['source_label'] == 'Volume, Private'
        assert body['line_rows'] == 5
        assert body['hidden_lines'] == 0
        assert body['decodes'] == [{'decode': 'beam', 'evaluation_id': 7},
                                   {'decode': 'greedy', 'evaluation_id': 8}]
        assert body['datasets'] == [{'job_id': 'j1', 'name': 'Volume'},
                                    {'job_id': 'j2', 'name': 'Private'}]

    def test_an_unknown_evaluation_is_404(self, client):
        assert client.get('/api/evaluations/999', headers=ADMIN).status_code == 404


class TestSummary:
    def test_the_headline_is_computed_from_the_lines(self, client):
        body = client.get('/api/evaluations/7/summary', headers=ADMIN).json()
        head = body['headline']
        assert head['lines'] == 5
        assert head['chars'] == 25
        assert head['cer'] == pytest.approx(4 / 25)
        assert head['wer'] == pytest.approx(5 / 7)
        assert head['edits']['substitutions'] == 2
        assert head['edits']['deletions'] == 2
        assert head['case_errors'] == {'count': 1, 'share': 0.5}

    def test_confusions_carry_an_example_line(self, client):
        body = client.get('/api/evaluations/7/summary', headers=ADMIN).json()
        subs = body['confusions']['substitutions']
        assert [(c['ref'], c['hyp'], c['count'], c['example']['line_id']) for c in subs] == [
            ('5', '6', 1, 2), ('G', 'g', 1, 3)]
        assert [(c['ref'], c['example']['line_id']) for c in body['confusions']['deletions']] == [
            (' ', 5), ('.', 4)]

    def test_context_names_datasets_and_pages(self, client):
        body = client.get('/api/evaluations/7/summary', headers=ADMIN).json()
        by_dataset = {d['key']: d for d in body['by_dataset']}
        assert by_dataset['j2']['name'] == 'Private'
        assert by_dataset['j2']['cer'] == pytest.approx(1 / 3)
        by_page = {p['key']: p for p in body['by_page']}
        assert (by_page[2]['filename'], by_page[2]['job_id'], by_page[2]['cer']) == (
            'p2.png', 'j1', pytest.approx(1 / 5))
        assert [b['bin'] for b in body['calibration']] == [0.4, 0.8, 0.9]

    def test_without_a_training_pre_flight_the_train_frequency_is_unknown(self, client):
        body = client.get('/api/evaluations/7/summary', headers=ADMIN).json()
        assert body['train_known'] is False
        assert all(row['train'] is None for row in body['frequency'])

    def test_the_training_data_comes_from_the_run_that_made_the_model(self, client, imported):
        result = {'text': {'characters': [{'char': 'W', 'train': 6}, {'char': 'a', 'train': 4}]}}
        imported.execute("INSERT INTO training_preflights (id, owner, task, request, status, result) "
                         "VALUES (3, 'alice', 'ocr', '{}', 'done', ?)", (json.dumps(result),))
        imported.execute("INSERT INTO trainings (id, name, task, status, owner, model_id, preflight_id) "
                         "VALUES (1, 'Run', 'ocr', 'done', 'alice', 9, 3)")
        imported.commit()
        body = client.get('/api/evaluations/7/summary', headers=ADMIN).json()
        table = {row['char']: row for row in body['frequency']}
        assert body['train_known'] is True
        assert (table['W']['test'], table['W']['train']) == (2, 6)
        assert table['W']['train_share'] == pytest.approx(0.6)


class TestSummaryCache:
    def summary(self, client, headers=ADMIN):
        response = client.get('/api/evaluations/7/summary', headers=headers)
        assert response.status_code == 200, response.text
        return response.json()

    def counting(self, monkeypatch, module, name):
        calls = []
        original = getattr(module, name)

        def counted(*args, **kwargs):
            calls.append(1)
            return original(*args, **kwargs)

        monkeypatch.setattr(module, name, counted)
        return calls

    def test_a_second_request_reads_no_lines_and_recomputes_nothing(self, client, monkeypatch):
        reads = self.counting(monkeypatch, eval_lines, 'scored_rows')
        frequencies = self.counting(monkeypatch, eval_metrics, 'frequency')

        first = self.summary(client)
        second = self.summary(client)

        assert second == first
        assert (len(reads), len(frequencies)) == (1, 1)

    def test_two_viewers_taking_turns_each_keep_their_figures(self, client, monkeypatch):
        headlines = self.counting(monkeypatch, eval_metrics, 'headline')

        seen = [self.summary(client, headers)['headline']['lines']
                for headers in (ADMIN, ALICE, ADMIN, ALICE)]

        assert seen == [5, 4, 5, 4]
        assert len(headlines) == 2

    def test_re_imported_lines_are_a_miss(self, client, imported):
        assert self.summary(client)['headline']['lines'] == 5

        eval_lines.import_file(imported, 7, write_jsonl(evaluator.lines_path(7), records()[:4]))

        assert self.summary(client)['headline']['lines'] == 4

    def test_a_re_import_of_as_many_lines_with_other_readings_is_a_miss(self, client, imported):
        eval_lines.import_file(imported, 7, write_jsonl(evaluator.lines_path(7), records()))
        before = self.summary(client)['headline']
        assert (before['lines'], before['cer']) == (5, pytest.approx(4 / 25))

        perfect = [eval_metrics.line_record(line_id, job, page, 'beam', truth, truth, conf)
                   for line_id, page, job, truth, _, conf in SCORED]
        eval_lines.import_file(imported, 7, write_jsonl(evaluator.lines_path(7), perfect))

        after = self.summary(client)['headline']
        assert (after['lines'], after['cer']) == (5, 0)


class TestADeletedDataset:
    @pytest.fixture
    def deleted(self, imported):
        imported.execute("DELETE FROM jobs WHERE id = 'j2'")
        imported.commit()
        return imported

    def test_an_admin_still_sees_every_line(self, client, deleted):
        detail = client.get('/api/evaluations/7', headers=ADMIN).json()
        assert (detail['line_rows'], detail['hidden_lines']) == (5, 0)
        assert detail['datasets'] == [{'job_id': 'j1', 'name': 'Volume'}]
        assert [l['line_id'] for l in lines(client, sort='line', order='asc')['lines']] == [
            1, 2, 3, 4, 5]
        summary = client.get('/api/evaluations/7/summary', headers=ADMIN).json()
        assert summary['headline']['lines'] == 5

    def test_for_anyone_else_its_lines_stay_hidden(self, client, deleted):
        detail = client.get('/api/evaluations/7', headers=ALICE).json()
        assert (detail['line_rows'], detail['hidden_lines']) == (4, 1)


class TestSendToReview:
    def queue(self, client, job_id='j1'):
        response = client.get(f'/api/jobs/{job_id}/review', headers=ALICE)
        assert response.status_code == 200, response.text
        return response.json()['lines']

    def test_the_lines_in_the_filter_join_their_review_queue_though_checked(self, client, imported):
        assert self.queue(client) == []
        response = client.post('/api/evaluations/7/review', headers=ALICE,
                               json={'cer_min': 0.2})
        assert response.status_code == 200, response.text
        assert response.json() == {'flagged': 2, 'jobs': [
            {'job_id': 'j1', 'name': 'Volume', 'lines': 2, 'page_id': 1}]}
        assert [r['line_id'] for r in imported.execute(
            'SELECT line_id FROM review_flags ORDER BY line_id')] == [3, 4]
        queued = self.queue(client)
        assert [l['id'] for l in queued] == [3, 4]
        assert all(l['flagged'] for l in queued)

    def test_a_dataset_the_sender_cannot_open_is_not_touched(self, client, imported):
        client.post('/api/evaluations/7/review', headers=ALICE, json={'cer_min': 0.3})
        assert [r['line_id'] for r in imported.execute('SELECT line_id FROM review_flags')] == []

    def test_a_persons_check_takes_the_flag_off(self, client, imported):
        client.post('/api/evaluations/7/review', headers=ALICE, json={'q': 'Graz'})
        assert [l['id'] for l in self.queue(client)] == [3]
        patched = client.patch('/api/lines/3', headers=ALICE, json={'checked': True})
        assert patched.status_code == 200, patched.text
        assert self.queue(client) == []

    def test_unticking_a_flagged_line_keeps_its_flag(self, client, imported):
        client.post('/api/evaluations/7/review', headers=ALICE, json={'q': 'Graz'})
        patched = client.patch('/api/lines/3', headers=ALICE, json={'checked': False})
        assert patched.status_code == 200, patched.text
        assert [r['line_id'] for r in imported.execute('SELECT line_id FROM review_flags')] == [3]
        assert [(l['id'], l['flagged']) for l in self.queue(client) if l['id'] == 3] == [(3, True)]

    def test_a_viewer_may_not_send_lines_to_review(self, client):
        viewer = {**ALICE, 'X-Auth-Role': 'viewer'}
        assert client.post('/api/evaluations/7/review', headers=viewer, json={}).status_code == 403
