"""Readings are paid for once and kept for good: keyed by the scan rather than the page,
never re-fetched for a dataset that already has them, and turned into candidates that
survive whatever happens to the lines afterwards.
"""
import dataclasses
import json
import threading

import pytest
from PIL import Image

from app import candidates, llm, llm_client, llm_ocr, llm_queue, store


def _claimable(conn, free):
    """The line-reading queue on its own, as it was before it shared a worker."""
    return llm_queue.claimable(conn, llm_ocr.QUEUE, [llm_ocr.QUEUE.table], free)


SCAN = 'hash-of-the-scan'
OTHER_SCAN = 'hash-of-another-scan'


@pytest.fixture
def secret(monkeypatch):
    monkeypatch.setattr('app.config.LLM_SECRET_KEY', 'passphrase-for-tests')
    monkeypatch.setattr('app.llm._fernet', None)
    yield
    monkeypatch.setattr('app.llm._fernet', None)


@pytest.fixture
def conn(tmp_path, monkeypatch, secret):
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    scan = tmp_path / 'scan.png'
    Image.new('RGB', (40, 20), 'white').save(scan)
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript(f"""
        INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'First', 'alice', 'done');
        INSERT INTO jobs (id, name, owner, status) VALUES ('j2', 'Second', 'alice', 'done');
        INSERT INTO pages (id, job_id, idx, filename, source_file, content_hash, status, width, height)
            VALUES (1, 'j1', 0, 'p1.png', '{scan}', '{SCAN}', 'done', 40, 20);
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind)
            VALUES (1, 1, 0, 'Paragraph', '[0,0,1,1]', 'content');
        INSERT INTO lines (id, element_id, order_idx, polygon, text)
            VALUES (1, 1, 0, '[[0,0],[1,0],[1,0.5],[0,0.5]]', 'Frst line'),
                   (2, 1, 1, '[[0,0.5],[1,0.5],[1,1],[0,1]]', 'Second line');
        INSERT INTO llm_connections (id, owner, name, base_url)
            VALUES (1, 'alice', 'Stub', 'http://llm:8000/v1');
        INSERT INTO llm_models (id, connection_id, model, label, prompt)
            VALUES (1, 1, 'stub-perfect', 'First reader', 'transcribe'),
                   (2, 1, 'stub-second', 'Second reader', 'transcribe');
    """)
    connection.commit()
    yield connection
    connection.close()


ALICE = {'username': 'alice', 'role': 'member'}


def add_second_dataset_page(conn, content_hash=SCAN):
    """A second dataset holding the same scan - the reuse case."""
    conn.execute(
        'INSERT INTO pages (id, job_id, idx, filename, source_file, content_hash, status) '
        "VALUES (2, 'j2', 0, 'p1.png', ?, ?, 'done')",
        (conn.execute('SELECT source_file FROM pages WHERE id = 1').fetchone()['source_file'],
         content_hash))
    conn.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) "
                 "VALUES (2, 2, 0, 'Paragraph', '[0,0,1,1]', 'content')")
    conn.execute("INSERT INTO lines (id, element_id, order_idx, polygon, text) "
                 "VALUES (3, 2, 0, '[[0,0],[1,0],[1,0.5],[0,0.5]]', 'Frst line')")
    conn.commit()


def fake_provider(monkeypatch, lines, calls: list):
    def transcribe(base_url, api_key, model, prompt, image, temperature=0.0, *args, **kwargs):
        calls.append(model)
        return {'text': json.dumps(lines), 'prompt_tokens': 100, 'completion_tokens': 20}
    monkeypatch.setattr(llm_client, 'transcribe', transcribe)


class TestPreviewAndQueue:
    def test_a_preview_counts_the_calls_a_run_would_make(self, conn):
        assert llm_ocr.preview(conn, 'j1', [1, 2], ALICE) == {
            'pages': 1, 'calls': 2, 'stale_prompt': 0, 'stale_pages': 0,
            'models': [
                {'id': 1, 'label': 'First reader', 'calls': 1, 'reused': 0, 'stale_prompt': 0},
                {'id': 2, 'label': 'Second reader', 'calls': 1, 'reused': 0, 'stale_prompt': 0},
            ],
        }

    def test_queueing_twice_does_not_queue_twice(self, conn):
        first = llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        second = llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        assert (first['queued'], second['queued']) == (1, 1)
        assert conn.execute('SELECT COUNT(*) c FROM llm_reads').fetchone()['c'] == 1

    def test_the_chosen_models_become_the_datasets_own(self, conn):
        llm_ocr.enqueue(conn, 'j1', [2], ALICE)
        assert llm_ocr.selected_models(conn, 'j1') == [2]

    def test_a_model_someone_else_owns_privately_cannot_be_spent(self, conn):
        conn.execute("INSERT INTO llm_connections (id, owner, name, base_url) "
                     "VALUES (2, 'bob', 'His', 'http://llm:8000/v1')")
        conn.execute("INSERT INTO llm_models (id, connection_id, model, label) "
                     "VALUES (3, 2, 'stub-perfect', 'His reader')")
        conn.commit()
        assert llm_ocr.enqueue(conn, 'j1', [3], ALICE)['models'] == []
        assert conn.execute('SELECT COUNT(*) c FROM llm_reads').fetchone()['c'] == 0

    def test_cancelling_drops_what_was_not_sent(self, conn):
        llm_ocr.enqueue(conn, 'j1', [1, 2], ALICE)
        conn.execute("UPDATE llm_reads SET status = 'running' WHERE llm_model_id = 1")
        conn.commit()

        assert llm_ocr.cancel(conn, 'j1') == 1
        # The one in flight is already paid for, so it is left to finish.
        assert [r['status'] for r in conn.execute('SELECT status FROM llm_reads')] == ['running']

    def test_a_failed_reading_is_retried_but_a_finished_one_is_not(self, conn):
        llm_ocr.enqueue(conn, 'j1', [1, 2], ALICE)
        conn.execute("UPDATE llm_reads SET status = 'error', error = 'timeout' WHERE llm_model_id = 1")
        conn.execute("UPDATE llm_reads SET status = 'done', raw_text = '[]' WHERE llm_model_id = 2")
        conn.commit()

        llm_ocr.enqueue(conn, 'j1', [1, 2], ALICE)

        rows = dict(conn.execute('SELECT llm_model_id, status FROM llm_reads').fetchall())
        assert rows == {1: 'pending', 2: 'done'}


class TestReadingAPage:
    def test_a_reading_becomes_candidates_on_the_lines(self, conn, monkeypatch):
        calls = []
        fake_provider(monkeypatch, ['First line', 'Second line'], calls)
        llm_ocr.enqueue(conn, 'j1', [1], ALICE)

        assert llm_ocr.drain_once(conn) == 1

        assert calls == ['stub-perfect']
        rows = conn.execute('SELECT * FROM candidates ORDER BY order_idx').fetchall()
        assert [(r['source'], r['author'], r['text'], r['line_id'], r['llm_model_id']) for r in rows] == [
            ('llm', 'llm:First reader', 'First line', 1, 1),
            ('llm', 'llm:First reader', 'Second line', 2, 1),
        ]
        read = conn.execute('SELECT * FROM llm_reads').fetchone()
        assert (read['status'], read['prompt_tokens'], read['completion_tokens']) == ('done', 100, 20)

    def test_a_heading_that_recurs_is_read_onto_every_line_it_stands_on(self, conn, monkeypatch):
        """Repeated wording is the norm on a schematism page - "Direktor.", "Kontrollore."
        under one department after another - and each occurrence is its own line."""
        conn.execute("UPDATE lines SET text = 'Direktor.' WHERE id = 1")
        conn.execute("INSERT INTO lines (id, element_id, order_idx, polygon, text) "
                     "VALUES (3, 1, 2, '[[0,0],[1,0],[1,0.3],[0,0.3]]', 'Direktor.')")
        conn.commit()
        fake_provider(monkeypatch, ['Direktor.', 'Second line', 'Direktor.'], [])
        llm_ocr.enqueue(conn, 'j1', [1], ALICE)

        llm_ocr.drain_once(conn)

        rows = conn.execute(
            "SELECT line_id, text FROM candidates WHERE source = 'llm' ORDER BY line_id").fetchall()
        assert [(r['line_id'], r['text']) for r in rows] == [
            (1, 'Direktor.'), (2, 'Second line'), (3, 'Direktor.')]

    def test_the_raw_answer_is_kept_so_re_matching_is_free(self, conn, monkeypatch):
        calls = []
        fake_provider(monkeypatch, ['First line', 'Second line'], calls)
        llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        llm_ocr.drain_once(conn)

        # The lines are thrown away and detected afresh, the way a re-detection does it.
        candidates.capture_page(conn, 1)
        conn.execute('DELETE FROM lines')
        conn.execute("INSERT INTO lines (id, element_id, order_idx, polygon, text) "
                     "VALUES (9, 1, 0, '[[0,0],[1,0],[1,0.5],[0,0.5]]', 'First line')")
        conn.commit()
        candidates.rematch_page(conn, 1)

        assert calls == ['stub-perfect'], 'a second call would mean paying twice'
        attached = conn.execute(
            "SELECT text FROM candidates WHERE source = 'llm' AND line_id = 9").fetchall()
        assert [r['text'] for r in attached] == ['First line']

    def test_a_failure_is_recorded_in_words_a_person_can_act_on(self, conn, monkeypatch):
        def transcribe(*args, **kwargs):
            raise llm_client.LlmError('the endpoint rejected the API key (401)')
        monkeypatch.setattr(llm_client, 'transcribe', transcribe)
        llm_ocr.enqueue(conn, 'j1', [1], ALICE)

        llm_ocr.drain_once(conn)

        read = conn.execute('SELECT status, error FROM llm_reads').fetchone()
        assert (read['status'], read['error']) == ('error', 'the endpoint rejected the API key (401)')
        assert llm_ocr.status(conn, 'j1')['errors'] == [
            {'label': 'First reader', 'error': 'the endpoint rejected the API key (401)', 'c': 1}]

    def test_a_key_that_cannot_be_decrypted_fails_before_any_call(self, conn, monkeypatch):
        conn.execute('UPDATE llm_connections SET api_key = ? WHERE id = 1', (llm.encrypt_key('sk-x'),))
        conn.commit()
        monkeypatch.setattr('app.config.LLM_SECRET_KEY', 'a-different-passphrase')
        monkeypatch.setattr('app.llm._fernet', None)
        calls = []
        fake_provider(monkeypatch, ['First line'], calls)
        llm_ocr.enqueue(conn, 'j1', [1], ALICE)

        llm_ocr.drain_once(conn)

        assert calls == []
        assert 'LLM_SECRET_KEY has changed' in conn.execute('SELECT error FROM llm_reads').fetchone()['error']


class TestReadingASelection:
    """Reading is billed per page, so a run has to be able to cover fewer than all of them:
    trying a model on five pages of five hundred, or sending the one page whose OCR is
    hopeless."""

    def second_page(self, conn, content_hash=OTHER_SCAN):
        """A second page of the same dataset, holding a different scan."""
        conn.execute(
            'INSERT INTO pages (id, job_id, idx, filename, source_file, content_hash, status) '
            "VALUES (7, 'j1', 1, 'p2.png', ?, ?, 'done')",
            (conn.execute('SELECT source_file FROM pages WHERE id = 1').fetchone()['source_file'],
             content_hash))
        conn.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) "
                     "VALUES (7, 7, 0, 'Paragraph', '[0,0,1,1]', 'content')")
        conn.execute("INSERT INTO lines (id, element_id, order_idx, polygon, text) "
                     "VALUES (7, 7, 0, '[[0,0],[1,0],[1,0.5],[0,0.5]]', 'Frst line')")
        conn.commit()
        return 7

    def test_a_preview_prices_only_the_pages_asked_for(self, conn):
        self.second_page(conn)

        assert llm_ocr.preview(conn, 'j1', [1], ALICE)['pages'] == 2
        one = llm_ocr.preview(conn, 'j1', [1], ALICE, page_ids=[1])
        assert (one['pages'], one['calls']) == (1, 1)

    def test_only_the_pages_asked_for_are_read(self, conn, monkeypatch):
        other = self.second_page(conn)
        calls = []
        fake_provider(monkeypatch, ['First line', 'Second line'], calls)

        llm_ocr.enqueue(conn, 'j1', [1], ALICE, page_ids=[other])
        llm_ocr.drain_once(conn)

        read = conn.execute('SELECT content_hash, status FROM llm_reads').fetchall()
        assert [(r['content_hash'], r['status']) for r in read] == [(OTHER_SCAN, 'done')]
        assert calls == ['stub-perfect'], 'one page, one call'

    def test_the_rest_of_the_dataset_is_left_for_later(self, conn, monkeypatch):
        '''A second run covering everything reads only what the first one left.'''
        other = self.second_page(conn)
        calls = []
        fake_provider(monkeypatch, ['First line', 'Second line'], calls)
        llm_ocr.enqueue(conn, 'j1', [1], ALICE, page_ids=[other])
        llm_ocr.drain_once(conn)

        result = llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        llm_ocr.drain_once(conn)

        assert (result['queued'], result['reused']) == (1, 1)
        assert calls == ['stub-perfect', 'stub-perfect'], 'the read page was not paid for twice'

    def test_a_selection_of_nothing_reads_nothing(self, conn, monkeypatch):
        calls = []
        fake_provider(monkeypatch, ['First line'], calls)

        result = llm_ocr.enqueue(conn, 'j1', [1], ALICE, page_ids=[])
        llm_ocr.drain_once(conn)

        assert (result['queued'], result['reused'], calls) == (0, 0, [])

    def test_a_page_still_being_ingested_is_skipped_rather_than_failing_the_run(
            self, conn, monkeypatch):
        '''It has no scan to send yet. Asking for it explicitly changes nothing.'''
        waiting = self.second_page(conn, content_hash=None)
        calls = []
        fake_provider(monkeypatch, ['First line'], calls)

        result = llm_ocr.enqueue(conn, 'j1', [1], ALICE, page_ids=[1, waiting])
        llm_ocr.drain_once(conn)

        assert result['queued'] == 1
        assert calls == ['stub-perfect']

    def test_what_is_already_on_file_still_reaches_every_page_holding_that_scan(
            self, conn, monkeypatch):
        '''Reading one page does not stop a reading it already has from landing on the
        others - that costs nothing and is the whole point of keying reads by the scan.'''
        calls = []
        fake_provider(monkeypatch, ['Frst line'], calls)
        llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        llm_ocr.drain_once(conn)
        twin = self.second_page(conn, content_hash=SCAN)

        llm_ocr.enqueue(conn, 'j1', [1], ALICE, page_ids=[1])

        on_twin = conn.execute(
            "SELECT text FROM candidates WHERE page_id = ? AND source = 'llm'", (twin,)).fetchall()
        assert [r['text'] for r in on_twin] == ['Frst line']
        assert calls == ['stub-perfect'], 'and still no second call'


class TestAReadingThatNeverComesBack:
    """On 2026-09-10 four answers were fetched, billed by the provider and never written:
    the batch was recorded only after its slowest member, and one member returned from
    neither the call nor its own timeout. Each reading is now written as it lands."""

    def hangs_on(self, monkeypatch, model_name: str, stuck: threading.Event):
        def transcribe(base_url, api_key, model, *args, **kwargs):
            if model == model_name:
                stuck.wait(30)
            return {'text': json.dumps(['First line', 'Second line']),
                    'prompt_tokens': 10, 'completion_tokens': 20}
        monkeypatch.setattr(llm_client, 'transcribe', transcribe)

    def test_the_answers_beside_it_are_still_written(self, conn, monkeypatch):
        monkeypatch.setattr('app.config.LLM_TIMEOUT', 0.2)
        monkeypatch.setattr(llm_queue, 'WATCHDOG_GRACE', 0.3)
        stuck = threading.Event()
        self.hangs_on(monkeypatch, 'stub-second', stuck)
        llm_ocr.enqueue(conn, 'j1', [1, 2], ALICE)

        try:
            llm_ocr.drain_once(conn)

            rows = {r['label']: r for r in conn.execute('SELECT * FROM llm_reads')}
            assert rows['First reader']['status'] == 'done'
            assert 'First line' in rows['First reader']['raw_text']
            # ...and its reading reached the lines, which is what was paid for.
            assert conn.execute(
                "SELECT COUNT(*) c FROM candidates WHERE source = 'llm'").fetchone()['c'] == 2
        finally:
            stuck.set()

    def test_the_one_that_hangs_is_marked_rather_than_left_running(self, conn, monkeypatch):
        """A row left 'running' is indistinguishable from one in flight, and a restart
        would fetch it again - paying twice for the answer nobody recorded."""
        monkeypatch.setattr('app.config.LLM_TIMEOUT', 0.2)
        monkeypatch.setattr(llm_queue, 'WATCHDOG_GRACE', 0.3)
        stuck = threading.Event()
        self.hangs_on(monkeypatch, 'stub-second', stuck)
        llm_ocr.enqueue(conn, 'j1', [1, 2], ALICE)

        try:
            llm_ocr.drain_once(conn)

            hung = conn.execute(
                "SELECT status, error FROM llm_reads WHERE label = 'Second reader'").fetchone()
            assert hung['status'] == 'error'
            assert 'no answer' in hung['error']
        finally:
            stuck.set()

    def test_a_call_that_raises_something_unexpected_is_recorded_too(self, conn, monkeypatch):
        """Anything but LlmError used to travel up through the batch and into the worker
        loop, which slept it off - leaving the row running and the reason in a log line."""
        def transcribe(*args, **kwargs):
            raise RuntimeError('the socket said something unrepeatable')
        monkeypatch.setattr(llm_client, 'transcribe', transcribe)
        llm_ocr.enqueue(conn, 'j1', [1], ALICE)

        llm_ocr.drain_once(conn)

        row = conn.execute('SELECT status, error FROM llm_reads').fetchone()
        assert row['status'] == 'error'
        assert 'unrepeatable' in row['error']


class TestReuse:
    def test_the_same_scan_in_another_dataset_is_never_paid_for_twice(self, conn, monkeypatch):
        calls = []
        fake_provider(monkeypatch, ['First line', 'Second line'], calls)
        llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        llm_ocr.drain_once(conn)
        add_second_dataset_page(conn)

        result = llm_ocr.enqueue(conn, 'j2', [1], ALICE)

        assert (result['queued'], result['reused']) == (0, 1)
        assert llm_ocr.drain_once(conn) == 0
        assert calls == ['stub-perfect']
        # ...and the second dataset has the reading anyway.
        assert [r['text'] for r in conn.execute(
            'SELECT text FROM candidates WHERE page_id = 2 ORDER BY order_idx')] == \
            ['First line', 'Second line']

    def test_a_different_scan_still_costs_a_call(self, conn, monkeypatch):
        calls = []
        fake_provider(monkeypatch, ['First line'], calls)
        llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        llm_ocr.drain_once(conn)
        add_second_dataset_page(conn, content_hash=OTHER_SCAN)

        assert llm_ocr.enqueue(conn, 'j2', [1], ALICE)['queued'] == 1
        llm_ocr.drain_once(conn)
        assert calls == ['stub-perfect', 'stub-perfect']

    def test_the_preview_says_which_pages_are_already_paid_for(self, conn, monkeypatch):
        fake_provider(monkeypatch, ['First line'], [])
        llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        llm_ocr.drain_once(conn)
        add_second_dataset_page(conn)

        preview = llm_ocr.preview(conn, 'j2', [1], ALICE)
        assert preview['models'] == [
            {'id': 1, 'label': 'First reader', 'calls': 0, 'reused': 1, 'stale_prompt': 0}]
        assert preview['calls'] == 0


class TestProgress:
    def test_status_reports_each_model_separately(self, conn, monkeypatch):
        fake_provider(monkeypatch, ['First line'], [])
        llm_ocr.enqueue(conn, 'j1', [1, 2], ALICE)
        llm_ocr.drain_once(conn)

        state = llm_ocr.status(conn, 'j1')
        assert state['pages'] == 1
        assert state['done'] == 2
        assert state['active'] is False
        assert [(m['label'], m['done']) for m in state['models']] == \
            [('First reader', 1), ('Second reader', 1)]


class TestRestart:
    def test_an_answer_that_arrived_is_finished_rather_than_fetched_again(self, conn, monkeypatch):
        """A restart between storing the text and placing it must not cost a second call."""
        calls = []
        fake_provider(monkeypatch, ['First line', 'Second line'], calls)
        llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        conn.execute("UPDATE llm_reads SET status = 'running', raw_text = ?",
                     (json.dumps(['First line', 'Second line']),))
        conn.commit()

        llm_ocr.recover(conn)

        assert calls == []
        assert conn.execute('SELECT status FROM llm_reads').fetchone()['status'] == 'done'
        assert [r['text'] for r in conn.execute(
            'SELECT text FROM candidates ORDER BY order_idx')] == ['First line', 'Second line']

    def test_an_answer_that_cannot_be_finished_is_an_error_on_its_row(self, conn, monkeypatch):
        """Escaping, it would end the worker thread before its loop began, and no reading
        would ever be taken again until the next restart."""
        fake_provider(monkeypatch, ['First line', 'Second line'], [])
        llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        answer = json.dumps(['First line', 'Second line'])
        conn.execute("UPDATE llm_reads SET status = 'running', raw_text = ?", (answer,))
        conn.commit()

        def unplaceable(*args):
            raise ValueError('the page is gone')
        monkeypatch.setattr(llm_ocr, 'QUEUE', dataclasses.replace(llm_ocr.QUEUE, resume=unplaceable))

        llm_ocr.recover(conn)

        row = conn.execute('SELECT status, error, raw_text FROM llm_reads').fetchone()
        assert dict(row) == {'status': 'error', 'error': 'ValueError: the page is gone', 'raw_text': answer}
        assert conn.execute('SELECT COUNT(*) c FROM candidates').fetchone()['c'] == 0

    def test_a_reading_that_never_answered_goes_back_in_the_queue(self, conn, monkeypatch):
        calls = []
        fake_provider(monkeypatch, ['First line'], calls)
        llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        conn.execute("UPDATE llm_reads SET status = 'running'")
        conn.commit()

        llm_ocr.recover(conn)

        assert conn.execute('SELECT status FROM llm_reads').fetchone()['status'] == 'pending'
        assert llm_ocr.drain_once(conn) == 1
        assert calls == ['stub-perfect']

    def test_a_re_read_cut_off_before_it_answered_is_asked_again(self, conn, monkeypatch):
        """A re-read still carries the answer it is replacing. Taken for the new one after a
        restart, the old wording's answer would be called current and never asked again."""
        calls = []
        fake_provider(monkeypatch, ['First line'], calls)
        llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        llm_ocr.drain_once(conn)
        conn.execute("UPDATE jobs SET llm_prompt = 'Different wording now.' WHERE id = 'j1'")
        conn.commit()
        llm_ocr.enqueue(conn, 'j1', [1], ALICE, refresh=True)

        def worker_dies(*args):
            raise RuntimeError('the backend restarted')
        with monkeypatch.context() as patch:
            patch.setattr(llm_queue._Slots, 'start', worker_dies)
            with pytest.raises(RuntimeError):
                llm_ocr.drain_once(conn)
        assert conn.execute('SELECT status FROM llm_reads').fetchone()['status'] == 'running'

        llm_ocr.recover(conn)

        assert conn.execute('SELECT status FROM llm_reads').fetchone()['status'] == 'pending'
        fake_provider(monkeypatch, ['First line, read again'], calls)
        assert llm_ocr.drain_once(conn) == 1
        assert calls == ['stub-perfect', 'stub-perfect']
        assert conn.execute('SELECT raw_text FROM llm_reads').fetchone()['raw_text'] \
            == '["First line, read again"]'
        assert llm_ocr.preview(conn, 'j1', [1], ALICE)['stale_prompt'] == 0

    def test_a_re_read_cut_off_and_then_withdrawn_goes_back_to_the_answer_on_file(
            self, conn, monkeypatch):
        """The worker cleared the text when the call went out and died before an answer.
        Withdrawn after the restart, the re-read has to fall back to the reading already
        paid for, not delete it."""
        fake_provider(monkeypatch, ['First line'], [])
        llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        llm_ocr.drain_once(conn)
        conn.execute("UPDATE jobs SET llm_prompt = 'Different wording now.' WHERE id = 'j1'")
        conn.commit()
        llm_ocr.enqueue(conn, 'j1', [1], ALICE, refresh=True)

        def worker_dies(*args):
            raise RuntimeError('the backend restarted')
        with monkeypatch.context() as patch:
            patch.setattr(llm_queue._Slots, 'start', worker_dies)
            with pytest.raises(RuntimeError):
                llm_ocr.drain_once(conn)
        llm_ocr.recover(conn)

        assert llm_ocr.cancel(conn, 'j1') == 1
        rows = [dict(row) for row in conn.execute('SELECT status, raw_text FROM llm_reads')]
        assert rows == [{'status': 'done', 'raw_text': '["First line"]'}]

    def test_a_re_read_that_fails_keeps_the_answer_it_was_replacing(self, conn, monkeypatch):
        fake_provider(monkeypatch, ['First line'], [])
        llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        llm_ocr.drain_once(conn)
        conn.execute("UPDATE jobs SET llm_prompt = 'Different wording now.' WHERE id = 'j1'")
        conn.commit()
        llm_ocr.enqueue(conn, 'j1', [1], ALICE, refresh=True)

        def provider_down(*args, **kwargs):
            raise llm_client.LlmError('provider unavailable')
        monkeypatch.setattr(llm_client, 'transcribe', provider_down)
        llm_ocr.drain_once(conn)

        row = conn.execute('SELECT status, error, raw_text FROM llm_reads').fetchone()
        assert dict(row) == {'status': 'error', 'error': 'provider unavailable',
                             'raw_text': '["First line"]'}


class TestPrompts:
    def test_a_dataset_prompt_replaces_the_models_and_is_recorded(self, conn, monkeypatch):
        seen = []

        def transcribe(base_url, api_key, model, prompt, image, temperature=0.0, *args, **kwargs):
            seen.append(prompt)
            return {'text': json.dumps(['First line']), 'prompt_tokens': 1, 'completion_tokens': 1}
        monkeypatch.setattr(llm_client, 'transcribe', transcribe)
        conn.execute("UPDATE jobs SET llm_prompt = 'Kurrent script, 1750s.' WHERE id = 'j1'")
        conn.commit()

        llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        llm_ocr.drain_once(conn)

        assert seen == ['Kurrent script, 1750s.']
        read = conn.execute('SELECT prompt_hash, job_id FROM llm_reads').fetchone()
        assert read['job_id'] == 'j1'
        assert read['prompt_hash'] == llm.prompt_digest('Kurrent script, 1750s.')

    def test_changing_the_prompt_costs_nothing_until_it_is_asked_for(self, conn, monkeypatch):
        calls = []
        fake_provider(monkeypatch, ['First line'], calls)
        llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        llm_ocr.drain_once(conn)

        conn.execute("UPDATE jobs SET llm_prompt = 'Different wording now.' WHERE id = 'j1'")
        conn.commit()

        # The dataset can see it, and asking again without saying so changes nothing.
        preview = llm_ocr.preview(conn, 'j1', [1], ALICE)
        assert (preview['stale_prompt'], preview['calls']) == (1, 0)
        llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        assert llm_ocr.drain_once(conn) == 0
        assert calls == ['stub-perfect']

    def test_the_stale_offer_counts_pages_once_however_many_models_read_them(self, conn, monkeypatch):
        """One page read by two models under the old wording is one page to take again, at
        the price of two calls - the offer needs both numbers."""
        fake_provider(monkeypatch, ['First line'], [])
        llm_ocr.enqueue(conn, 'j1', [1, 2], ALICE)
        llm_ocr.drain_once(conn)
        conn.execute("UPDATE jobs SET llm_prompt = 'Different wording now.' WHERE id = 'j1'")
        conn.commit()

        preview = llm_ocr.preview(conn, 'j1', [1, 2], ALICE)
        assert (preview['stale_pages'], preview['stale_prompt']) == (1, 2)
        assert [m['stale_prompt'] for m in preview['models']] == [1, 1]

    def test_asking_for_them_again_re_reads_exactly_the_stale_ones(self, conn, monkeypatch):
        calls = []
        fake_provider(monkeypatch, ['First line', 'Second line'], calls)
        llm_ocr.enqueue(conn, 'j1', [1, 2], ALICE)
        llm_ocr.drain_once(conn)
        # Only the second model is given wording of its own, so only its reading goes stale.
        conn.execute("UPDATE llm_models SET prompt = 'Read this one differently.' WHERE id = 2")
        conn.commit()

        result = llm_ocr.enqueue(conn, 'j1', [1, 2], ALICE, refresh=True)

        assert result['refreshed'] == 1
        assert llm_ocr.drain_once(conn) == 1
        assert calls == ['stub-perfect', 'stub-second', 'stub-second']
        assert llm_ocr.preview(conn, 'j1', [1, 2], ALICE)['stale_prompt'] == 0

    def test_asking_again_for_what_has_not_changed_leaves_the_page_alone(self, conn, monkeypatch):
        """Same scan, same model, same wording: nothing to call and nothing to redo. The
        reading that is already on the lines stays the reading that is on the lines."""
        fake_provider(monkeypatch, ['First line', 'Second line'], [])
        llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        llm_ocr.drain_once(conn)
        before = [tuple(r) for r in conn.execute(
            'SELECT id, text, line_id, dismissed, order_idx FROM candidates ORDER BY id')]
        assert len(before) == 2

        llm_ocr.enqueue(conn, 'j1', [1], ALICE)

        after = [tuple(r) for r in conn.execute(
            'SELECT id, text, line_id, dismissed, order_idx FROM candidates ORDER BY id')]
        assert after == before, 'no row set aside, none added, none moved'

    def test_a_person_s_own_matching_survives_asking_again(self, conn, monkeypatch):
        """The click that changes nothing must not undo what someone did by hand."""
        fake_provider(monkeypatch, ['First line', 'Second line'], [])
        llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        llm_ocr.drain_once(conn)
        moved = conn.execute(
            "SELECT id FROM candidates WHERE text = 'Second line'").fetchone()['id']
        conn.execute('UPDATE candidates SET line_id = 1, similarity = NULL WHERE id = ?', (moved,))
        conn.commit()

        llm_ocr.enqueue(conn, 'j1', [1], ALICE)

        assert conn.execute(
            'SELECT line_id FROM candidates WHERE id = ?', (moved,)).fetchone()['line_id'] == 1
        assert conn.execute('SELECT COUNT(*) c FROM candidates').fetchone()['c'] == 2

    def test_a_re_read_supersedes_what_the_model_said_before(self, conn, monkeypatch):
        fake_provider(monkeypatch, ['First line', 'Second line'], [])
        llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        llm_ocr.drain_once(conn)

        conn.execute("UPDATE jobs SET llm_prompt = 'Try again.' WHERE id = 'j1'")
        conn.commit()
        fake_provider(monkeypatch, ['First line', 'A different second line'], [])
        llm_ocr.enqueue(conn, 'j1', [1], ALICE, refresh=True)
        llm_ocr.drain_once(conn)

        rows = conn.execute(
            'SELECT text, dismissed, line_id FROM candidates ORDER BY id').fetchall()
        held = {r['text']: (bool(r['dismissed']), r['line_id']) for r in rows}
        # What it still says is current and on its line; what it no longer says is kept,
        # set aside, and off the line so it cannot count towards agreement.
        assert held['First line'][0] is False
        assert held['A different second line'][0] is False
        assert held['Second line'][0] is True

    def test_a_superseded_reading_stops_counting_towards_agreement(self, conn, monkeypatch):
        fake_provider(monkeypatch, ['Agreed line'], [])
        llm_ocr.enqueue(conn, 'j1', [1, 2], ALICE)
        llm_ocr.drain_once(conn)
        assert conn.execute('SELECT llm_agree_count FROM lines WHERE id = 1').fetchone()[0] == 2

        conn.execute("UPDATE llm_models SET prompt = 'Say something else.' WHERE id = 2")
        conn.commit()
        fake_provider(monkeypatch, ['A lone dissent'], [])
        llm_ocr.enqueue(conn, 'j1', [1, 2], ALICE, refresh=True)
        llm_ocr.drain_once(conn)

        assert conn.execute('SELECT llm_agree_count FROM lines WHERE id = 1').fetchone()[0] == 1


CHART = b'\x89PNG\r\n\x1a\n a chart of the rings this corpus prints'


class TestWhatTheModelIsShown:
    """A chart of the glyphs a corpus prints, sent before the page. It is part of what a
    reading was taken under, so replacing it makes the old readings stale the way new
    wording does - and a dataset that shows nothing keeps the digest it always had.
    """

    def shown_by(self, monkeypatch) -> list:
        seen = []

        def transcribe(base_url, api_key, model, prompt, image, temperature=0.0,
                       max_tokens=None, extra=None, references=()):
            seen.append(list(references))
            return {'text': json.dumps(['First line']), 'prompt_tokens': 1, 'completion_tokens': 1}
        monkeypatch.setattr(llm_client, 'transcribe', transcribe)
        return seen

    def test_a_datasets_own_chart_is_sent_with_the_page(self, conn, monkeypatch):
        seen = self.shown_by(monkeypatch)
        llm.add_reference(conn, 'alice', 'j1', 'chart.png', 'image/png', CHART)

        llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        llm_ocr.drain_once(conn)

        assert seen == [[('image/png', CHART)]]

    def test_the_persons_own_is_used_where_the_dataset_has_none(self, conn, monkeypatch):
        seen = self.shown_by(monkeypatch)
        llm.add_reference(conn, 'alice', None, 'mine.png', 'image/png', CHART)

        llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        llm_ocr.drain_once(conn)

        assert seen == [[('image/png', CHART)]]

    def test_a_dataset_showing_nothing_sends_nothing(self, conn, monkeypatch):
        seen = self.shown_by(monkeypatch)

        llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        llm_ocr.drain_once(conn)

        assert seen == [[]]

    def prompts_by(self, monkeypatch) -> list:
        seen = []

        def transcribe(base_url, api_key, model, prompt, image, temperature=0.0,
                       max_tokens=None, extra=None, references=()):
            seen.append(prompt)
            return {'text': json.dumps(['First line']), 'prompt_tokens': 1, 'completion_tokens': 1}
        monkeypatch.setattr(llm_client, 'transcribe', transcribe)
        return seen

    def test_the_wording_says_which_of_the_pictures_is_the_page(self, conn, monkeypatch):
        """Two pictures and no explanation is how a model comes to transcribe the chart."""
        seen = self.prompts_by(monkeypatch)
        llm.add_reference(conn, 'alice', 'j1', 'chart.png', 'image/png', CHART)

        llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        llm_ocr.drain_once(conn)

        assert seen == ['transcribe\n\nBefore the page you are shown 1 reference image. '
                        'The last image is the page to transcribe; everything before it is '
                        'reference material and is never transcribed.']

    def test_two_charts_are_counted_as_two(self, conn, monkeypatch):
        seen = self.prompts_by(monkeypatch)
        llm.add_reference(conn, 'alice', 'j1', 'chart.png', 'image/png', CHART)
        llm.add_reference(conn, 'alice', 'j1', 'alphabet.png', 'image/png', CHART + b'x')

        llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        llm_ocr.drain_once(conn)

        assert seen[0].startswith('transcribe\n\nBefore the page you are shown 2 reference '
                                  'images.')

    def test_nothing_is_said_about_pictures_when_none_are_sent(self, conn, monkeypatch):
        seen = self.prompts_by(monkeypatch)

        llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        llm_ocr.drain_once(conn)

        assert seen == ['transcribe']

    def test_a_dataset_showing_nothing_keeps_the_digest_it_always_had(self, conn):
        """Otherwise adding this feature would have made every reading ever taken stale."""
        model = dict(conn.execute('SELECT * FROM llm_models WHERE id = 1').fetchone())

        assert llm_ocr.expected_digest(conn, model, 'alice', 'j1') \
            == llm.prompt_digest(llm.effective_prompt(conn, model, 'alice'))

    def test_a_reading_taken_before_the_chart_counts_as_stale(self, conn, monkeypatch):
        calls = []
        fake_provider(monkeypatch, ['First line'], calls)
        llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        llm_ocr.drain_once(conn)
        assert llm_ocr.preview(conn, 'j1', [1], ALICE)['stale_prompt'] == 0

        llm.add_reference(conn, 'alice', 'j1', 'chart.png', 'image/png', CHART)

        assert llm_ocr.preview(conn, 'j1', [1], ALICE)['stale_prompt'] == 1
        # Stale, but not re-fetched behind anyone's back: showing a chart costs nothing
        # until the reading is asked for again.
        assert llm_ocr.preview(conn, 'j1', [1], ALICE)['calls'] == 0


class TestHowManyAtOnce:
    """A model's own ceiling is the provider's patience; the global one is the machine's."""

    def _queue(self, conn, model_id: int, how_many: int) -> None:
        for n in range(how_many):
            conn.execute(
                'INSERT INTO llm_reads (content_hash, llm_model_id, model, label, job_id, '
                "requested_by) VALUES (?,?,'m','L','j1','alice')",
                (f'hash-{model_id}-{n}', model_id))
        conn.commit()

    def _by_model(self, rows) -> dict:
        counted: dict = {}
        for row in rows:
            counted[row['llm_model_id']] = counted.get(row['llm_model_id'], 0) + 1
        return counted

    def test_a_model_takes_no_more_at_once_than_it_allows(self, conn, monkeypatch):
        monkeypatch.setattr('app.config.LLM_MAX_CONCURRENCY', 4)
        conn.execute('UPDATE llm_models SET max_concurrency = 1 WHERE id = 1')
        self._queue(conn, 1, 5)
        self._queue(conn, 2, 5)

        # One slot for the limited model and the rest for the one that said nothing -
        # rather than the four oldest, which are all the limited one's.
        assert self._by_model(_claimable(conn, 4)) == {1: 1, 2: 3}

    def test_what_a_model_already_has_out_counts_against_it(self, conn, monkeypatch):
        """Its hold is read off the queue rather than remembered, so a worker that restarts
        mid-volume does not hand a rate-limited endpoint a second helping."""
        monkeypatch.setattr('app.config.LLM_MAX_CONCURRENCY', 4)
        conn.execute('UPDATE llm_models SET max_concurrency = 2 WHERE id = 1')
        self._queue(conn, 1, 5)
        conn.execute("UPDATE llm_reads SET status = 'running' "
                     'WHERE id = (SELECT MIN(id) FROM llm_reads)')
        conn.commit()

        assert len(_claimable(conn, 4)) == 1

    def test_a_model_that_says_nothing_runs_under_the_global_ceiling(self, conn, monkeypatch):
        monkeypatch.setattr('app.config.LLM_MAX_CONCURRENCY', 2)
        self._queue(conn, 1, 5)

        # Offered four slots, it still takes only the two the machine allows.
        assert len(_claimable(conn, 4)) == 2

    def test_the_queue_is_drained_without_being_asked_again(self, conn, monkeypatch):
        """The slot a finished reading leaves is filled straight away. Waiting for a whole
        batch left the rest idle for as long as its slowest reading."""
        monkeypatch.setattr('app.config.LLM_MAX_CONCURRENCY', 2)
        add_second_dataset_page(conn)
        self._queue(conn, 1, 5)
        fake_provider(monkeypatch, ['a'], [])

        # Five readings, two slots, one pass: under batches this stopped after two.
        assert llm_ocr.drain_once(conn) == 5
        assert conn.execute(
            "SELECT COUNT(*) FROM llm_reads WHERE status = 'pending'").fetchone()[0] == 0


class TestAReadingStaysWithTheDatasetThatAskedForIt:
    """A reading is bought once per scan and model, but it is not published to whoever
    happens to hold the same scan: a dataset sees it because it asked, not because a
    stranger paid for it."""

    def _llm_candidates(self, conn, page_id: int) -> int:
        return conn.execute(
            "SELECT COUNT(*) FROM candidates WHERE page_id = ? AND source = 'llm'",
            (page_id,)).fetchone()[0]

    def test_another_dataset_holding_the_same_scan_is_not_given_it(self, conn, monkeypatch):
        add_second_dataset_page(conn)
        fake_provider(monkeypatch, ['First line', 'Second line'], [])

        llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        llm_ocr.drain_once(conn)

        assert self._llm_candidates(conn, 1) > 0
        assert self._llm_candidates(conn, 2) == 0

    def test_it_is_handed_over_free_when_that_dataset_does_ask(self, conn, monkeypatch):
        add_second_dataset_page(conn)
        calls: list = []
        fake_provider(monkeypatch, ['First line', 'Second line'], calls)

        llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        llm_ocr.drain_once(conn)
        spent = len(calls)

        llm_ocr.enqueue(conn, 'j2', [1], ALICE)

        # The same reading, on the second dataset's page, without asking the provider again.
        assert self._llm_candidates(conn, 2) > 0
        assert len(calls) == spent

    def test_a_dataset_that_asked_while_it_was_running_still_gets_it(self, conn, monkeypatch):
        """Both asked before the answer came back, so both are owed it. The read itself is
        one row, and whoever asked is what says where the answer lands."""
        add_second_dataset_page(conn)
        calls: list = []
        fake_provider(monkeypatch, ['First line', 'Second line'], calls)

        llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        llm_ocr.enqueue(conn, 'j2', [1], ALICE)
        llm_ocr.drain_once(conn)

        assert self._llm_candidates(conn, 1) > 0
        assert self._llm_candidates(conn, 2) > 0
        assert len(calls) == 1


class TestCancelling:
    """A reading is shared by every dataset holding the scan, so cancelling withdraws only
    what this dataset asked for - never another's request, and never an answer on file."""

    def _reads(self, conn) -> list:
        return [dict(row) for row in conn.execute(
            'SELECT llm_model_id, status, raw_text FROM llm_reads ORDER BY id')]

    def _askers(self, conn) -> list:
        return [row['job_id'] for row in conn.execute(
            'SELECT job_id FROM llm_read_jobs ORDER BY job_id')]

    def test_a_dataset_that_asked_for_nothing_cancels_nothing(self, conn):
        add_second_dataset_page(conn)
        llm_ocr.enqueue(conn, 'j1', [1], ALICE)

        assert llm_ocr.cancel(conn, 'j2') == 0
        assert self._reads(conn) == [{'llm_model_id': 1, 'status': 'pending', 'raw_text': None}]
        assert self._askers(conn) == ['j1']

    def test_a_reading_another_dataset_still_wants_stays_queued_for_it(self, conn, monkeypatch):
        add_second_dataset_page(conn)
        fake_provider(monkeypatch, ['First line'], [])
        llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        llm_ocr.enqueue(conn, 'j2', [1], ALICE)

        assert llm_ocr.cancel(conn, 'j1') == 1
        assert self._reads(conn) == [{'llm_model_id': 1, 'status': 'pending', 'raw_text': None}]
        assert self._askers(conn) == ['j2']

        llm_ocr.drain_once(conn)
        on_page = {row['page_id']: row['c'] for row in conn.execute(
            "SELECT page_id, COUNT(*) c FROM candidates WHERE source = 'llm' GROUP BY page_id")}
        assert on_page == {2: 1}

    @staticmethod
    def _send(conn) -> dict:
        """What the worker does as it sends a reading: running, the old answer set aside."""
        conn.execute("UPDATE llm_reads SET status = 'running', previous_text = raw_text, raw_text = NULL")
        conn.commit()
        return dict(conn.execute('SELECT * FROM llm_reads').fetchone())

    def test_a_page_cancelled_from_its_chip_drops_the_reading_in_flight_too(self, conn):
        llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        in_flight = self._send(conn)

        assert llm_ocr.cancel(conn, 'j1', page_ids=[1], in_flight=True) == 1
        assert self._reads(conn) == []
        assert not llm_ocr.status(conn, 'j1', [1])['active']
        # The answer arrives after all, and is thrown away rather than put on the page.
        llm_ocr._finish(conn, in_flight, {'text': '["First line"]'})
        assert self._reads(conn) == []
        assert conn.execute("SELECT COUNT(*) c FROM candidates WHERE source = 'llm'").fetchone()['c'] == 0

    def test_a_re_read_dropped_in_flight_keeps_the_answer_it_was_replacing(self, conn, monkeypatch):
        fake_provider(monkeypatch, ['First line'], [])
        llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        llm_ocr.drain_once(conn)
        conn.execute("UPDATE jobs SET llm_prompt = 'Different wording now.' WHERE id = 'j1'")
        conn.commit()
        llm_ocr.enqueue(conn, 'j1', [1], ALICE, refresh=True)
        in_flight = self._send(conn)

        assert llm_ocr.cancel(conn, 'j1', page_ids=[1], in_flight=True) == 1
        llm_ocr._finish(conn, in_flight, {'text': '["Second wording"]'})
        assert self._reads(conn) == [{'llm_model_id': 1, 'status': 'done', 'raw_text': '["First line"]'}]

    def test_a_reading_in_flight_that_another_dataset_wants_still_reaches_it(self, conn):
        add_second_dataset_page(conn)
        llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        llm_ocr.enqueue(conn, 'j2', [1], ALICE)
        in_flight = self._send(conn)

        assert llm_ocr.cancel(conn, 'j1', page_ids=[1], in_flight=True) == 1
        llm_ocr._finish(conn, in_flight, {'text': '["First line"]'})
        on_page = {row['page_id']: row['c'] for row in conn.execute(
            "SELECT page_id, COUNT(*) c FROM candidates WHERE source = 'llm' GROUP BY page_id")}
        assert on_page == {2: 1}

    def test_cancelling_other_pages_leaves_this_one_reading(self, conn):
        llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        assert llm_ocr.cancel(conn, 'j1', page_ids=[99], in_flight=True) == 0
        assert [r['status'] for r in self._reads(conn)] == ['pending']

    def test_cancelling_a_re_read_keeps_the_answer_already_paid_for(self, conn, monkeypatch):
        fake_provider(monkeypatch, ['First line'], [])
        llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        llm_ocr.drain_once(conn)
        before = dict(conn.execute('SELECT raw_text, prompt_hash FROM llm_reads').fetchone())
        conn.execute("UPDATE jobs SET llm_prompt = 'Different wording now.' WHERE id = 'j1'")
        conn.commit()
        assert llm_ocr.enqueue(conn, 'j1', [1], ALICE, refresh=True)['refreshed'] == 1

        assert llm_ocr.cancel(conn, 'j1') == 1
        after = conn.execute('SELECT status, raw_text, prompt_hash FROM llm_reads').fetchone()
        assert dict(after) == {'status': 'done', **before}
        assert before['raw_text'] == '["First line"]'
        assert llm_ocr.preview(conn, 'j1', [1], ALICE)['stale_prompt'] == 1

    def test_a_dataset_that_did_not_ask_for_the_re_read_cannot_cancel_it(self, conn, monkeypatch):
        add_second_dataset_page(conn)
        fake_provider(monkeypatch, ['First line'], [])
        llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        llm_ocr.enqueue(conn, 'j2', [1], ALICE)
        llm_ocr.drain_once(conn)
        conn.execute("UPDATE jobs SET llm_prompt = 'Different wording now.' WHERE id = 'j1'")
        conn.commit()
        llm_ocr.enqueue(conn, 'j1', [1], ALICE, refresh=True)

        assert llm_ocr.cancel(conn, 'j2') == 0
        assert conn.execute('SELECT status FROM llm_reads').fetchone()['status'] == 'pending'

    def test_a_reading_queued_before_askers_were_recorded_belongs_to_its_dataset(self, conn):
        add_second_dataset_page(conn)
        conn.execute('INSERT INTO llm_reads (content_hash, llm_model_id, job_id) VALUES (?, 1, ?)',
                     (SCAN, 'j1'))
        conn.commit()

        assert llm_ocr.cancel(conn, 'j2') == 0
        assert llm_ocr.cancel(conn, 'j1') == 1
        assert self._reads(conn) == []


class TestRemoving:
    """Removing readings deletes the answers for the dataset's scans everywhere, so asking
    again pays again - but a checked line keeps its text, its tick and the reading behind it."""

    @pytest.fixture
    def read(self, conn, monkeypatch):
        add_second_dataset_page(conn)
        fake_provider(monkeypatch, ['First line', 'Second line'], [])
        llm_ocr.enqueue(conn, 'j1', [1, 2], ALICE)
        llm_ocr.enqueue(conn, 'j2', [1], ALICE)
        llm_ocr.drain_once(conn)
        # Both models agree, so the agreement filled both lines in; a person checked the second.
        conn.execute("UPDATE lines SET checked = 1, check_source = 'human' WHERE id = 2")
        conn.commit()
        return conn

    def _lines(self, conn) -> dict:
        return {row['id']: (row['corrected_text'], bool(row['checked'])) for row in conn.execute(
            'SELECT id, corrected_text, checked FROM lines WHERE id IN (1, 2)')}

    def _candidates(self, conn) -> list:
        return sorted((row['page_id'], row['llm_model_id'], row['line_id'] or 0) for row in conn.execute(
            "SELECT page_id, llm_model_id, line_id FROM candidates WHERE source = 'llm' AND dismissed = 0"))

    def _reads(self, conn) -> list:
        return [row['llm_model_id'] for row in conn.execute('SELECT llm_model_id FROM llm_reads ORDER BY llm_model_id')]

    def test_the_agreement_filled_both_lines_before_anything_is_removed(self, read):
        assert self._lines(read) == {1: ('First line', False), 2: ('Second line', True)}
        assert self._reads(read) == [1, 2]

    def test_one_models_readings_leave_every_dataset_holding_the_scan(self, read):
        assert llm_ocr.remove(read, 'j1', model_id=1) == {'readings': 1}

        assert self._reads(read) == [2]
        # Model 1's reading stays only behind the checked line; the other dataset loses its own.
        assert self._candidates(read) == [(1, 1, 2), (1, 2, 1), (1, 2, 2)]
        # One model is no longer two that agree: the unchecked line goes back to its OCR text.
        assert self._lines(read) == {1: (None, False), 2: ('Second line', True)}
        # The answer is gone, so asking that model again is a new call.
        assert llm_ocr.enqueue(read, 'j1', [1], ALICE)['queued'] == 1

    def test_every_reading_can_go_at_once(self, read):
        assert llm_ocr.remove(read, 'j1') == {'readings': 2}

        assert self._reads(read) == []
        assert self._candidates(read) == [(1, 1, 2), (1, 2, 2)]
        assert self._lines(read) == {1: (None, False), 2: ('Second line', True)}

    def test_a_line_the_agreement_checked_by_itself_is_kept_too(self, conn, monkeypatch):
        conn.execute("UPDATE jobs SET llm_autocheck = 1 WHERE id = 'j1'")
        conn.commit()
        fake_provider(monkeypatch, ['First line', 'Second line'], [])
        llm_ocr.enqueue(conn, 'j1', [1, 2], ALICE)
        llm_ocr.drain_once(conn)
        assert self._lines(conn) == {1: ('First line', True), 2: ('Second line', True)}

        llm_ocr.remove(conn, 'j1')

        assert self._lines(conn) == {1: ('First line', True), 2: ('Second line', True)}
        assert len(self._candidates(conn)) == 4

    def test_a_reading_still_out_is_dropped_with_the_rest(self, conn):
        llm_ocr.enqueue(conn, 'j1', [1], ALICE)
        conn.execute("UPDATE llm_reads SET status = 'running'")
        conn.commit()
        in_flight = dict(conn.execute('SELECT * FROM llm_reads').fetchone())

        llm_ocr.remove(conn, 'j1')
        llm_ocr._finish(conn, in_flight, {'text': '["First line"]'})

        assert self._reads(conn) == []
        assert self._candidates(conn) == []

    def test_what_can_be_removed_is_counted_per_model(self, read):
        assert llm_ocr.removable(read, 'j1') == [
            {'id': 1, 'label': 'First reader', 'readings': 1, 'other_datasets': 1},
            {'id': 2, 'label': 'Second reader', 'readings': 1, 'other_datasets': 0},
        ]

    def test_one_page_s_readings_go_and_the_dataset_s_other_pages_keep_theirs(self, read, monkeypatch):
        read.execute(
            'INSERT INTO pages (id, job_id, idx, filename, source_file, content_hash, status) '
            "SELECT 3, 'j1', 1, 'p2.png', source_file, 'other-scan', 'done' FROM pages WHERE id = 1")
        read.commit()
        fake_provider(monkeypatch, ['Another page'], [])
        llm_ocr.enqueue(read, 'j1', [1, 2], ALICE)
        llm_ocr.drain_once(read)
        assert llm_ocr.removable(read, 'j1', page_id=1) == [
            {'id': 1, 'label': 'First reader', 'readings': 1, 'other_datasets': 1},
            {'id': 2, 'label': 'Second reader', 'readings': 1, 'other_datasets': 0},
        ]

        assert llm_ocr.remove(read, 'j1', model_id=2, page_id=1) == {'readings': 1}

        assert sorted((r['content_hash'], r['llm_model_id']) for r in read.execute(
            'SELECT content_hash, llm_model_id FROM llm_reads')) == sorted([
            ('other-scan', 1), ('other-scan', 2), (SCAN, 1)])
        # The page keeps the other model's reading and the one behind its checked line.
        assert [c for c in self._candidates(read) if c[0] == 1] == [(1, 1, 1), (1, 1, 2), (1, 2, 2)]
        assert self._lines(read) == {1: (None, False), 2: ('Second line', True)}

    def test_one_lines_reading_can_be_removed_but_not_one_a_checked_line_rests_on(self, read):
        on_first = read.execute("SELECT id FROM candidates WHERE source = 'llm' AND line_id = 1 "
                                'AND llm_model_id = 1').fetchone()['id']
        on_checked = read.execute("SELECT id FROM candidates WHERE source = 'llm' AND line_id = 2 "
                                  'AND llm_model_id = 1').fetchone()['id']

        llm_ocr.remove_candidate(read, on_first)
        assert (1, 1, 1) not in self._candidates(read)
        assert self._lines(read)[1] == (None, False)
        with pytest.raises(llm_ocr.CannotRemove, match='checked'):
            llm_ocr.remove_candidate(read, on_checked)
        assert (1, 1, 2) in self._candidates(read)
