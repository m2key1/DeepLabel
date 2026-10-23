"""Reading a page against the corpus span cut onto it.

What comes back is the page's transcription of record, so these tests pin the two things
that make it safe: the span really reaches the model, and the answer is filed as
machine-made - because alignment checks trusted ground truth off without a person, and a
model's reading must never be given that authority.
"""
import json

import pytest
from PIL import Image

from app import align, candidates, corpus, llm, llm_client, llm_gt, llm_ocr, llm_queue, store

ALICE = {'username': 'alice', 'role': 'member'}
SPAN_ONE = 'Mein lieber Freund, ich danke Dir\nfuer Deinen langen Brief'
SPAN_TWO = 'Das Wetter ist seit Tagen truebe\nund ich komme nicht hinaus'


@pytest.fixture
def secret(monkeypatch):
    monkeypatch.setattr('app.config.LLM_SECRET_KEY', 'passphrase-for-tests')
    monkeypatch.setattr('app.llm._fernet', None)
    yield
    monkeypatch.setattr('app.llm._fernet', None)


@pytest.fixture
def conn(tmp_path, monkeypatch, secret):
    """Two leaves of one letter, recognized, each carrying its own span."""
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    scan = tmp_path / 'scan.png'
    Image.new('RGB', (40, 20), 'white').save(scan)
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript(f"""
        INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'Letters', 'alice', 'done');
        INSERT INTO pages (id, job_id, idx, filename, source_file, content_hash, status,
                           width, height, reference_text, reference_document)
            VALUES (1, 'j1', 0, 'a.png', '{scan}', 'hash-a', 'done', 40, 20,
                    '{SPAN_ONE}', 'letter-01'),
                   (2, 'j1', 1, 'b.png', '{scan}', 'hash-b', 'done', 40, 20,
                    '{SPAN_TWO}', 'letter-01');
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind)
            VALUES (1, 1, 0, 'Paragraph', '[0,0,1,1]', 'content');
        INSERT INTO lines (id, element_id, order_idx, polygon, text)
            VALUES (1, 1, 0, '[[0,0],[1,0],[1,0.5],[0,0.5]]', 'Mein lieber Freund, ich danke Dir'),
                   (2, 1, 1, '[[0,0.5],[1,0.5],[1,1],[0,1]]', 'fuer Deinen langen Brief');
        INSERT INTO llm_connections (id, owner, name, base_url)
            VALUES (1, 'alice', 'Stub', 'http://llm:8000/v1');
        INSERT INTO llm_models (id, connection_id, model, label)
            VALUES (1, 1, 'stub-reader', 'Reader');
    """)
    connection.commit()
    yield connection
    connection.close()


def answers(monkeypatch, lines, seen: list | None = None):
    def transcribe(base_url, api_key, model, prompt, image, *args, **kwargs):
        if seen is not None:
            seen.append(prompt)
        return {'text': json.dumps(lines), 'prompt_tokens': 10, 'completion_tokens': 5}
    monkeypatch.setattr(llm_client, 'transcribe', transcribe)


class TestWhichPagesAreRead:
    def test_only_pages_carrying_a_span_are_read(self, conn):
        conn.execute('UPDATE pages SET reference_text = NULL WHERE id = 2')
        conn.commit()
        assert llm_gt.preview(conn, 'j1', [1], ALICE)['pages'] == 1

    def test_a_page_without_a_span_is_never_queued(self, conn):
        conn.execute('UPDATE pages SET reference_text = NULL WHERE id = 2')
        conn.commit()
        llm_gt.enqueue(conn, 'j1', [1], ALICE)
        assert [row['page_id'] for row in conn.execute(
            'SELECT page_id FROM gt_reads ORDER BY page_id')] == [1]

    def test_a_deleted_page_is_not_read(self, conn):
        conn.execute('UPDATE pages SET deleted = 1 WHERE id = 1')
        conn.commit()
        assert llm_gt.preview(conn, 'j1', [1], ALICE)['pages'] == 1

    def test_a_page_a_person_transcribed_is_skipped_unless_asked_for(self, conn):
        """A call costs money and the person's text wins anyway, so it is not sent unless
        someone asks to compare. A PDF text layer or an earlier model answer is no person's
        transcription and is read as usual."""
        conn.executescript("""
            UPDATE pages SET gt_text = 'by hand', gt_source = 'sidecar' WHERE id = 1;
            UPDATE pages SET gt_text = 'embedded', gt_source = 'pdf' WHERE id = 2;
        """)
        assert llm_gt.preview(conn, 'j1', [1], ALICE) == {
            'pages': 1, 'calls': 1, 'transcribed': 1,
            'models': [{'id': 1, 'label': 'Reader', 'calls': 1, 'reused': 0}]}
        assert llm_gt.enqueue(conn, 'j1', [1], ALICE) == {
            'queued': 1, 'reused': 0, 'pages': 1, 'skipped': 1}
        assert [row['page_id'] for row in conn.execute('SELECT page_id FROM gt_reads')] == [2]

    def test_a_page_a_person_transcribed_is_read_when_asked_for(self, conn):
        conn.execute("UPDATE pages SET gt_text = 'typed long ago', gt_source = NULL WHERE id = 1")
        conn.commit()
        assert llm_gt.preview(conn, 'j1', [1], ALICE, include_transcribed=True)['calls'] == 2
        assert llm_gt.enqueue(conn, 'j1', [1], ALICE, include_transcribed=True) == {
            'queued': 2, 'reused': 0, 'pages': 2, 'skipped': 0}


class TestTheSpanReachesTheModel:
    def test_the_prompt_carries_this_page_and_not_its_neighbour(self, conn, monkeypatch):
        seen = []
        answers(monkeypatch, ['a line'], seen)
        llm_gt.enqueue(conn, 'j1', [1], ALICE)
        llm_gt.drain_once(conn)
        first = next(p for p in seen if SPAN_ONE in p)
        assert SPAN_TWO not in first
        assert len(seen) == 2

    def test_a_dataset_supplies_its_own_wording(self, conn, monkeypatch):
        seen = []
        answers(monkeypatch, ['a line'], seen)
        conn.execute("UPDATE jobs SET gt_prompt = 'Read it. Here: {{reference}}' WHERE id = 'j1'")
        conn.commit()
        llm_gt.enqueue(conn, 'j1', [1], ALICE)
        llm_gt.drain_once(conn)
        assert any(p.startswith('Read it. Here: Mein lieber Freund') for p in seen)

    def test_the_shipped_wording_asks_for_the_reference(self, conn):
        page = conn.execute('SELECT * FROM pages WHERE id = 1').fetchone()
        assert SPAN_ONE in llm_gt.rendered_prompt(conn, 'j1', page)
        assert '{{reference}}' not in llm_gt.rendered_prompt(conn, 'j1', page)


class TestWhatBecomesOfTheAnswer:
    def test_the_answer_becomes_the_page_ground_truth(self, conn, monkeypatch):
        answers(monkeypatch, ['Mein lieber Freund, ich danke Dir', 'fuer Deinen langen Brief'])
        llm_gt.enqueue(conn, 'j1', [1], ALICE)
        llm_gt.drain_once(conn)
        row = conn.execute('SELECT gt_text, gt_source FROM pages WHERE id = 1').fetchone()
        assert row['gt_text'] == 'Mein lieber Freund, ich danke Dir\nfuer Deinen langen Brief'
        assert row['gt_source'] == 'llm'

    def test_ground_truth_from_a_model_is_never_trusted_to_check_a_line(self, conn):
        """Alignment hands these lines to the pages and leaves them for a person. Trusting
        them would file a machine's reading in the corpus under a human's authority."""
        assert align.gt_is_trusted('llm') is False
        assert align.gt_is_trusted('pdf') is False
        assert align.gt_is_trusted('sidecar') is True
        assert align.gt_is_trusted(None) is True

    def test_a_persons_transcription_is_never_overwritten(self, conn, monkeypatch):
        """A .txt uploaded beside the scan is the person's record of the page. The model's
        answer is kept on the reading and offered on the lines it matches instead."""
        conn.execute("UPDATE pages SET gt_text = 'Mein lieber Freund, ich dancke Dir', "
                     "gt_source = 'sidecar' WHERE id = 1")
        conn.commit()
        answers(monkeypatch, ['Mein lieber Freund, ich danke Dir', 'fuer Deinen langen Brief'])
        llm_gt.enqueue(conn, 'j1', [1], ALICE, include_transcribed=True)
        llm_gt.drain_once(conn)
        page = conn.execute('SELECT gt_text, gt_source FROM pages WHERE id = 1').fetchone()
        assert (page['gt_text'], page['gt_source']) == (
            'Mein lieber Freund, ich dancke Dir', 'sidecar')
        read = conn.execute('SELECT status, raw_text FROM gt_reads WHERE page_id = 1').fetchone()
        assert read['status'] == 'done'
        assert json.loads(read['raw_text']) == [
            'Mein lieber Freund, ich danke Dir', 'fuer Deinen langen Brief']
        offered = [tuple(row) for row in conn.execute(
            'SELECT line_id, source, author, text FROM candidates WHERE page_id = 1 '
            'AND dismissed = 0 ORDER BY line_id')]
        assert offered == [
            (1, 'align', 'align:llm:Reader', 'Mein lieber Freund, ich danke Dir'),
            (2, 'align', 'align:llm:Reader', 'fuer Deinen langen Brief')]

    def test_ground_truth_from_before_provenance_is_a_persons_too(self, conn, monkeypatch):
        conn.execute("UPDATE pages SET gt_text = 'typed long ago', gt_source = NULL WHERE id = 1")
        conn.commit()
        answers(monkeypatch, ['Mein lieber Freund, ich danke Dir'])
        llm_gt.enqueue(conn, 'j1', [1], ALICE, include_transcribed=True)
        llm_gt.drain_once(conn)
        page = conn.execute('SELECT gt_text, gt_source FROM pages WHERE id = 1').fetchone()
        assert (page['gt_text'], page['gt_source']) == ('typed long ago', None)

    def test_a_re_read_replaces_the_reading_it_offered(self, conn, monkeypatch):
        conn.execute("UPDATE pages SET gt_text = 'by hand', gt_source = 'sidecar' WHERE id = 1")
        conn.commit()
        answers(monkeypatch, ['Mein lieber Freund, ich danke Dir'])
        llm_gt.enqueue(conn, 'j1', [1], ALICE, include_transcribed=True)
        llm_gt.drain_once(conn)
        answers(monkeypatch, ['Mein lieber Freund, ich dancke Dir'])
        llm_gt.enqueue(conn, 'j1', [1], ALICE, refresh=True, include_transcribed=True)
        llm_gt.drain_once(conn)
        assert [tuple(row) for row in conn.execute(
            'SELECT line_id, text FROM candidates WHERE page_id = 1 AND dismissed = 0')] == [
            (1, 'Mein lieber Freund, ich dancke Dir')]

    def test_each_model_offers_its_own_reading_and_a_re_read_replaces_only_its_own(
            self, conn, monkeypatch):
        conn.executescript("""
            UPDATE pages SET gt_text = 'by hand', gt_source = 'sidecar' WHERE id = 1;
            INSERT INTO llm_models (id, connection_id, model, label)
                VALUES (2, 1, 'stub-checker', 'Checker');
        """)
        answers(monkeypatch, ['Mein lieber Freund, ich danke Dir'])
        llm_gt.enqueue(conn, 'j1', [1, 2], ALICE, include_transcribed=True)
        llm_gt.drain_once(conn)
        answers(monkeypatch, ['Mein lieber Freund, ich dancke Dir'])
        llm_gt.enqueue(conn, 'j1', [2], ALICE, refresh=True, include_transcribed=True)
        llm_gt.drain_once(conn)
        assert [tuple(row) for row in conn.execute(
            'SELECT line_id, author, text FROM candidates WHERE page_id = 1 AND dismissed = 0 '
            'ORDER BY author')] == [
            (1, 'align:llm:Checker', 'Mein lieber Freund, ich dancke Dir'),
            (1, 'align:llm:Reader', 'Mein lieber Freund, ich danke Dir')]

    def test_an_offered_reading_casts_no_vote(self, conn, monkeypatch):
        """Two models agreeing beside a person's transcription is a comparison, not a
        consensus: the person's text is what the page says."""
        conn.executescript("""
            UPDATE jobs SET llm_consensus_min = 1, llm_autocheck = 1 WHERE id = 'j1';
            UPDATE pages SET gt_text = 'by hand', gt_source = 'sidecar' WHERE id = 1;
            INSERT INTO llm_models (id, connection_id, model, label)
                VALUES (2, 1, 'stub-checker', 'Checker');
        """)
        answers(monkeypatch, ['Mein lieber Freund, ich dancke Dir'])
        llm_gt.enqueue(conn, 'j1', [1, 2], ALICE, include_transcribed=True)
        llm_gt.drain_once(conn)
        assert conn.execute('SELECT COUNT(*) c FROM candidates WHERE line_id = 1 '
                            'AND dismissed = 0').fetchone()['c'] == 2
        line = conn.execute('SELECT llm_agree_count, corrected_text, checked FROM lines '
                            'WHERE id = 1').fetchone()
        assert tuple(line) == (0, None, 0)

    def test_an_offer_from_before_models_were_named_stays_on_offer(self, conn, monkeypatch):
        conn.execute("UPDATE pages SET gt_text = 'by hand', gt_source = 'sidecar' WHERE id = 1")
        candidates.add(conn, 1, 'align:llm', 'fuer Deinen langen Brief', order_idx=1)
        conn.commit()
        answers(monkeypatch, ['Mein lieber Freund, ich danke Dir'])
        llm_gt.enqueue(conn, 'j1', [1], ALICE, include_transcribed=True)
        llm_gt.drain_once(conn)
        assert [tuple(row) for row in conn.execute(
            'SELECT line_id, author FROM candidates WHERE page_id = 1 AND dismissed = 0 '
            'ORDER BY line_id')] == [(1, 'align:llm:Reader'), (2, 'align:llm')]

    def test_a_pdf_text_layer_is_replaced_by_the_reading(self, conn, monkeypatch):
        conn.execute("UPDATE pages SET gt_text = 'embedded', gt_source = 'pdf' WHERE id = 1")
        conn.commit()
        answers(monkeypatch, ['Mein lieber Freund, ich danke Dir'])
        llm_gt.enqueue(conn, 'j1', [1], ALICE)
        llm_gt.drain_once(conn)
        page = conn.execute('SELECT gt_text, gt_source FROM pages WHERE id = 1').fetchone()
        assert (page['gt_text'], page['gt_source']) == ('Mein lieber Freund, ich danke Dir', 'llm')

    def test_an_empty_answer_leaves_the_page_as_it_was(self, conn, monkeypatch):
        answers(monkeypatch, [])
        llm_gt.enqueue(conn, 'j1', [1], ALICE)
        llm_gt.drain_once(conn)
        assert conn.execute(
            'SELECT gt_text FROM pages WHERE id = 1').fetchone()['gt_text'] is None

    def test_the_last_answer_queues_the_dataset_for_alignment(self, conn, monkeypatch):
        answers(monkeypatch, ['a line'])
        llm_gt.enqueue(conn, 'j1', [1], ALICE)
        llm_gt.drain_once(conn)
        assert store.get_job(conn, 'j1')['status'] == 'queued'
        assert conn.execute(
            "SELECT COUNT(*) c FROM pages WHERE status = 'done'").fetchone()['c'] == 2

    def test_a_failure_is_recorded_against_the_page(self, conn, monkeypatch):
        def transcribe(*args, **kwargs):
            raise llm_client.LlmError('the endpoint said no')
        monkeypatch.setattr(llm_client, 'transcribe', transcribe)
        llm_gt.enqueue(conn, 'j1', [1], ALICE)
        llm_gt.drain_once(conn)
        assert llm_gt.status(conn, 'j1')['error'] == 2
        assert 'the endpoint said no' in llm_gt.status(conn, 'j1')['errors'][0]['error']


class TestPayingForItOnce:
    def test_a_page_read_under_the_same_question_is_not_read_again(self, conn, monkeypatch):
        answers(monkeypatch, ['a line'])
        llm_gt.enqueue(conn, 'j1', [1], ALICE)
        llm_gt.drain_once(conn)
        assert llm_gt.enqueue(conn, 'j1', [1], ALICE) == {
            'queued': 0, 'reused': 2, 'pages': 2, 'skipped': 0}

    def test_a_moved_span_is_a_different_question_and_is_read_again(self, conn, monkeypatch):
        answers(monkeypatch, ['a line'])
        llm_gt.enqueue(conn, 'j1', [1], ALICE)
        llm_gt.drain_once(conn)
        conn.execute("UPDATE pages SET reference_text = 'a different span' WHERE id = 1")
        conn.commit()
        assert llm_gt.enqueue(conn, 'j1', [1], ALICE) == {
            'queued': 1, 'reused': 1, 'pages': 2, 'skipped': 0}

    def test_refresh_asks_again_even_when_nothing_moved(self, conn, monkeypatch):
        answers(monkeypatch, ['a line'])
        llm_gt.enqueue(conn, 'j1', [1], ALICE)
        llm_gt.drain_once(conn)
        assert llm_gt.enqueue(conn, 'j1', [1], ALICE, refresh=True)['queued'] == 2

    def test_a_reading_already_in_flight_is_not_queued_twice(self, conn):
        llm_gt.enqueue(conn, 'j1', [1], ALICE)
        assert llm_gt.enqueue(conn, 'j1', [1], ALICE) == {
            'queued': 0, 'reused': 0, 'pages': 2, 'skipped': 0}

    def test_a_preview_counts_what_a_run_would_cost(self, conn, monkeypatch):
        assert llm_gt.preview(conn, 'j1', [1], ALICE) == {
            'pages': 2, 'calls': 2, 'transcribed': 0,
            'models': [{'id': 1, 'label': 'Reader', 'calls': 2, 'reused': 0}]}
        answers(monkeypatch, ['a line'])
        llm_gt.enqueue(conn, 'j1', [1], ALICE)
        llm_gt.drain_once(conn)
        assert llm_gt.preview(conn, 'j1', [1], ALICE)['calls'] == 0


def statements(conn, work) -> list[str]:
    seen: list[str] = []
    conn.set_trace_callback(seen.append)
    try:
        work()
    finally:
        conn.set_trace_callback(None)
    return seen


class TestWhatAskingCosts:
    """The preview and the status poll run over every page of a dataset, so what they read
    once per dataset is read once - not again for every page."""

    def test_a_preview_reads_the_wording_pictures_and_readings_once(self, conn, monkeypatch):
        answers(monkeypatch, ['a line'])
        llm_gt.enqueue(conn, 'j1', [1], ALICE)
        llm_gt.drain_once(conn)

        seen = statements(conn, lambda: llm_gt.preview(conn, 'j1', [1], ALICE))

        assert llm_gt.preview(conn, 'j1', [1], ALICE)['models'] == [
            {'id': 1, 'label': 'Reader', 'calls': 0, 'reused': 2}]
        assert len([s for s in seen if 'FROM llm_references' in s]) == 2
        assert len([s for s in seen if 'FROM gt_reads' in s]) == 1
        assert len([s for s in seen if 'SELECT gt_prompt' in s]) == 1

    def test_queueing_reads_the_wording_pictures_and_readings_once(self, conn):
        seen = statements(conn, lambda: llm_gt.enqueue(conn, 'j1', [1], ALICE))

        assert conn.execute('SELECT COUNT(*) c FROM gt_reads').fetchone()['c'] == 2
        assert len([s for s in seen if 'FROM llm_references' in s]) == 2
        assert len([s for s in seen if s.startswith('SELECT') and 'FROM gt_reads' in s]) == 1
        assert len([s for s in seen if 'SELECT gt_prompt' in s]) == 1

    def test_the_status_poll_counts_pages_without_reading_them(self, conn):
        seen = statements(conn, lambda: llm_gt.status(conn, 'j1'))

        assert llm_gt.status(conn, 'j1')['pages'] == 2
        page_reads = [s for s in seen if 'FROM pages' in s]
        assert len(page_reads) == 1
        assert page_reads[0].startswith('SELECT COUNT(*)')


class TestTheQueueItShares:
    def test_pending_readings_can_be_dropped(self, conn):
        llm_gt.enqueue(conn, 'j1', [1], ALICE)
        assert llm_gt.cancel(conn, 'j1') == 2
        assert llm_gt.status(conn, 'j1')['pending'] == 0

    def test_cancelling_a_re_read_keeps_the_answer_already_paid_for(self, conn, monkeypatch):
        """Asked again and withdrawn before it was sent, a page goes back to the reading it
        had - still done, and still free to ask for under the same question."""
        answers(monkeypatch, ['a line'])
        llm_gt.enqueue(conn, 'j1', [1], ALICE)
        llm_gt.drain_once(conn)
        before = [dict(row) for row in conn.execute('SELECT * FROM gt_reads ORDER BY page_id')]
        assert llm_gt.enqueue(conn, 'j1', [1], ALICE, refresh=True)['queued'] == 2

        assert llm_gt.cancel(conn, 'j1') == 2
        after = [dict(row) for row in conn.execute('SELECT * FROM gt_reads ORDER BY page_id')]
        assert after == before
        assert before[0]['raw_text'] == '["a line"]'
        assert llm_gt.status(conn, 'j1')['done'] == 2
        assert llm_gt.preview(conn, 'j1', [1], ALICE)['calls'] == 0

    def test_a_re_read_that_fails_keeps_the_answer_it_was_replacing(self, conn, monkeypatch):
        """The worker clears the text when the call goes out; a failure has to put it back,
        or the page is left with ground truth taken from an answer no longer on file."""
        answers(monkeypatch, ['a line'])
        llm_gt.enqueue(conn, 'j1', [1], ALICE)
        llm_gt.drain_once(conn)
        llm_gt.enqueue(conn, 'j1', [1], ALICE, refresh=True)

        def provider_down(*args, **kwargs):
            raise llm_client.LlmError('provider unavailable')
        monkeypatch.setattr(llm_client, 'transcribe', provider_down)
        llm_gt.drain_once(conn)

        rows = [dict(row) for row in conn.execute(
            'SELECT status, error, raw_text FROM gt_reads ORDER BY page_id')]
        assert rows == [{'status': 'error', 'error': 'provider unavailable',
                         'raw_text': '["a line"]'}] * 2

    def test_a_re_read_cut_off_and_then_withdrawn_goes_back_to_the_answer_on_file(
            self, conn, monkeypatch):
        answers(monkeypatch, ['a line'])
        llm_gt.enqueue(conn, 'j1', [1], ALICE, page_ids=[1])
        llm_gt.drain_once(conn)
        llm_gt.enqueue(conn, 'j1', [1], ALICE, refresh=True, page_ids=[1])

        def worker_dies(*args):
            raise RuntimeError('the backend restarted')
        with monkeypatch.context() as patch:
            patch.setattr(llm_queue._Slots, 'start', worker_dies)
            with pytest.raises(RuntimeError):
                llm_gt.drain_once(conn)
        llm_gt.recover(conn)

        assert llm_gt.cancel(conn, 'j1') == 1
        rows = [dict(row) for row in conn.execute('SELECT status, raw_text FROM gt_reads')]
        assert rows == [{'status': 'done', 'raw_text': '["a line"]'}]

    def test_a_model_ceiling_is_one_ceiling_across_both_queues(self, conn, monkeypatch):
        """Counted per table, a model would be handed its whole allowance twice over -
        once for line readings and once for diplomatic ones. That is a bill, not a race."""
        monkeypatch.setattr('app.config.LLM_MAX_CONCURRENCY', 4)
        conn.execute('UPDATE llm_models SET max_concurrency = 2 WHERE id = 1')
        conn.execute("INSERT INTO llm_reads (content_hash, llm_model_id, model, label, status, job_id) "
                     "VALUES ('hash-a', 1, 'stub-reader', 'Reader', 'running', 'j1')")
        conn.commit()
        llm_gt.enqueue(conn, 'j1', [1], ALICE)
        tables = [llm_ocr.QUEUE.table, llm_gt.QUEUE.table]
        assert len(llm_queue.claimable(conn, llm_gt.QUEUE, tables, 4)) == 1

    def test_an_answer_for_a_dataset_deleted_meanwhile_is_dropped_quietly(self, conn, monkeypatch):
        """The dataset went while the call was out, taking its reading rows with it. The
        answer has nowhere to go, and saying so must not take the worker down."""
        llm_gt.enqueue(conn, 'j1', [1], ALICE)
        read = conn.execute('SELECT * FROM gt_reads WHERE page_id = 1').fetchone()
        conn.execute("DELETE FROM jobs WHERE id = 'j1'")
        conn.commit()

        llm_gt._finish(conn, read, {'text': json.dumps(['a line'])})

        assert conn.execute('SELECT COUNT(*) c FROM gt_reads').fetchone()['c'] == 0

    def test_one_reading_that_cannot_be_written_down_costs_only_itself(self, conn, monkeypatch):
        """An answer that fails on its way to the page is that page's failure. Escaping the
        worker, it would strand every other reading still out - running for good, holding a
        slot of the model's ceiling, its paid-for answer never written."""
        answers(monkeypatch, ['a line'])
        llm_gt.enqueue(conn, 'j1', [1], ALICE)

        def finish(conn, read, result):
            if read['page_id'] == 1:
                raise RuntimeError('the page refused the answer')
            llm_gt._finish(conn, read, result)
        queue = llm_queue.Queue('gt_reads', llm_gt._prepare, finish, llm_gt.apply_answer)

        assert llm_queue.drain_once(conn, [queue]) == 2

        rows = [tuple(row) for row in conn.execute(
            'SELECT page_id, status, error, raw_text FROM gt_reads ORDER BY page_id')]
        assert rows == [
            (1, 'error', 'RuntimeError: the page refused the answer', None),
            (2, 'done', None, '["a line"]')]

    def test_one_reading_that_cannot_be_prepared_costs_only_itself(self, conn, monkeypatch):
        answers(monkeypatch, ['a line'])
        llm_gt.enqueue(conn, 'j1', [1], ALICE)

        def prepare(conn, read):
            if read['page_id'] == 1:
                raise RuntimeError('the scan could not be gathered')
            return llm_gt._prepare(conn, read)
        queue = llm_queue.Queue('gt_reads', prepare, llm_gt._finish, llm_gt.apply_answer)

        assert llm_queue.drain_once(conn, [queue]) == 2

        rows = [tuple(row) for row in conn.execute(
            'SELECT page_id, status, error FROM gt_reads ORDER BY page_id')]
        assert rows == [(1, 'error', 'RuntimeError: the scan could not be gathered'),
                        (2, 'done', None)]

    def test_an_interrupted_reading_is_finished_from_what_it_holds(self, conn):
        """Its text was already paid for, so a restart files it rather than fetching it
        again - which is the whole reason the row is written before it is called done."""
        conn.execute(
            "INSERT INTO gt_reads (page_id, job_id, llm_model_id, model, label, status, raw_text) "
            "VALUES (1, 'j1', 1, 'stub-reader', 'Reader', 'running', ?)",
            (json.dumps(['recovered line']),))
        conn.commit()
        llm_gt.recover(conn)
        assert conn.execute(
            'SELECT gt_text FROM pages WHERE id = 1').fetchone()['gt_text'] == 'recovered line'
        assert conn.execute(
            'SELECT status FROM gt_reads').fetchone()['status'] == 'done'


class TestWordingThatCannotBeFilled:
    def test_a_placeholder_nothing_supplies_is_reported(self):
        assert llm.unknown_placeholders('read {{reference}} then {{weather}}') == ['weather']
        assert llm.unknown_placeholders(llm.DEFAULT_GT_PROMPT) == []

    def test_braces_in_ordinary_prose_survive_untouched(self):
        assert llm.render('write {a} and {{b}}', {'reference': 'x'}) == 'write {a} and {{b}}'

    def test_an_empty_span_renders_to_nothing_rather_than_a_placeholder(self, conn):
        conn.execute("UPDATE pages SET reference_text = '' WHERE id = 1")
        conn.commit()
        page = conn.execute('SELECT * FROM pages WHERE id = 1').fetchone()
        assert '{{reference}}' not in llm_gt.rendered_prompt(conn, 'j1', page)


class TestTheCutAndTheReadingTogether:
    def test_a_recut_page_is_read_again_and_its_ground_truth_replaced(self, conn, monkeypatch):
        """The end-to-end promise: cut, read, and the page carries a diplomatic
        transcription attributed to the model rather than to a person."""
        corpus.store_documents(conn, 'j1', {'letter-01': SPAN_ONE + '\n' + SPAN_TWO})
        corpus.apply_cut(conn, 'j1', overlap=0)
        answers(monkeypatch, ['Mein lieber Freund, ich danke Dir', 'fuer Deinen langen Brief'])
        llm_gt.enqueue(conn, 'j1', [1], ALICE)
        llm_gt.drain_once(conn)
        rows = conn.execute('SELECT gt_text, gt_source, reference_document FROM pages '
                            'ORDER BY idx').fetchall()
        assert [row['reference_document'] for row in rows] == ['letter-01', 'letter-01']
        assert all(row['gt_source'] == 'llm' for row in rows)
        assert rows[0]['gt_text'] == 'Mein lieber Freund, ich danke Dir\nfuer Deinen langen Brief'


class TestTheModelsAreRemembered:
    """The Corpus page starts from the models the last diplomatic run used, for anyone who
    opens it, the way the line-reading dialog does."""

    def test_a_run_records_the_models_it_read_with_on_the_dataset(self, conn):
        llm_gt.enqueue(conn, 'j1', [1], ALICE)

        assert store.get_job(conn, 'j1')['gt_model_ids'] == [1]
        assert store.get_job(conn, 'j1')['llm_model_ids'] == [], 'the line reading keeps its own'

    def test_a_model_the_reader_may_not_use_is_not_remembered(self, conn):
        conn.executescript("""
            INSERT INTO llm_connections (id, owner, name, base_url)
                VALUES (2, 'bob', 'Bobs', 'http://llm:8000/v1');
            INSERT INTO llm_models (id, connection_id, model, label)
                VALUES (2, 2, 'stub-reader', 'Bobs reader');
        """)
        llm_gt.enqueue(conn, 'j1', [1, 2], ALICE)

        assert store.get_job(conn, 'j1')['gt_model_ids'] == [1]

    def test_the_default_is_the_last_diplomatic_pick(self, conn):
        conn.execute("UPDATE jobs SET llm_model_ids = '[7]', gt_model_ids = '[1]' WHERE id = 'j1'")

        assert llm_gt.default_models(conn, 'j1') == [1]

    def test_without_one_the_default_is_the_line_reading_models(self, conn):
        conn.execute("UPDATE jobs SET llm_model_ids = '[7]' WHERE id = 'j1'")

        assert llm_gt.default_models(conn, 'j1') == [7]
