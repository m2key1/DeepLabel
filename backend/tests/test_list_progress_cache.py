"""The dataset list's progress bars. Counting them walks every line in the deployment, and
every open tab asks for the list every few seconds, so the answer is held between requests -
but it has to come back right the moment somebody reviews a line.
"""
import time

import pytest

from app import caches, store


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    monkeypatch.setattr('app.config.BLOBS_DIR', tmp_path / 'blobs')
    caches.forget_progress()
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript("""
        INSERT INTO jobs (id, name, owner, status, task) VALUES
            ('j1', 'Volume I', 'alice', 'done', 'text'),
            ('j2', 'Volume II', 'alice', 'done', 'text');
        INSERT INTO pages (id, job_id, idx, filename, source_file, layout_checked, deleted) VALUES
            (1, 'j1', 0, 'a.png', 'a.png', 1, 0),
            (2, 'j1', 1, 'b.png', 'b.png', 0, 0),
            (3, 'j1', 2, 'gone.png', 'gone.png', 1, 1),
            (4, 'j2', 0, 'c.png', 'c.png', 0, 0);
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox, deleted) VALUES
            (1, 1, 0, 'text', '[]', 0),
            (2, 2, 0, 'text', '[]', 0),
            (3, 4, 0, 'text', '[]', 0),
            (4, 2, 1, 'text', '[]', 1);
        INSERT INTO lines (id, element_id, order_idx, polygon, text, checked, deleted) VALUES
            (1, 1, 0, '[]', 'one', 1, 0),
            (2, 1, 1, '[]', 'two', 0, 0),
            (3, 2, 0, '[]', 'three', 1, 0),
            (4, 2, 1, '[]', 'dropped', 1, 1),
            (5, 4, 0, '[]', 'orphaned by its element', 1, 0),
            (6, 3, 0, '[]', 'four', 0, 0);
    """)
    connection.commit()
    yield connection
    connection.close()
    caches.forget_progress()


def test_counts_exclude_deleted_pages_elements_and_lines(conn):
    rollup = caches.job_progress(conn)

    # j1 keeps pages 1 and 2; page 3 is deleted. Layout is checked on page 1 alone.
    assert rollup['j1'] == {
        'pages_total': 2, 'layout_checked_pages': 1, 'test_pages': 0,
        # lines 1, 2, 3 survive. Line 4 is deleted and line 5 hangs off a deleted element.
        'lines_total': 3, 'lines_done': 2,
    }
    assert rollup['j2'] == {
        'pages_total': 1, 'layout_checked_pages': 0, 'test_pages': 0,
        'lines_total': 1, 'lines_done': 0,
    }


def test_a_dataset_without_pages_is_absent_rather_than_zeroed(conn):
    conn.execute("INSERT INTO jobs (id, name, owner, status, task) "
                 "VALUES ('j3', 'Empty', 'alice', 'queued', 'text')")
    conn.commit()

    assert 'j3' not in caches.job_progress(conn)


def test_reviewing_a_line_is_visible_on_the_next_call(conn):
    assert caches.job_progress(conn)['j1']['lines_done'] == 2

    conn.execute('UPDATE lines SET checked = 1 WHERE id = 2')
    # Checking a line through the API writes a revision; that is what moves the stamp.
    conn.execute("INSERT INTO revisions (target_type, target_id, job_id, author, action, snapshot) "
                 "VALUES ('line', 2, 'j1', 'alice', 'check', '{}')")
    conn.commit()

    assert caches.job_progress(conn)['j1']['lines_done'] == 3


def test_recognising_more_lines_is_visible_on_the_next_call(conn):
    assert caches.job_progress(conn)['j1']['lines_total'] == 3

    # The pipeline adds lines without writing a revision for each one.
    conn.execute("INSERT INTO lines (id, element_id, order_idx, polygon, text, checked, deleted) "
                 "VALUES (99, 1, 2, '[]', 'newly read', 0, 0)")
    conn.commit()

    assert caches.job_progress(conn)['j1']['lines_total'] == 4


COUNTING = 'FROM lines l JOIN elements'


def statements_of(conn, call):
    seen = []
    conn.set_trace_callback(seen.append)
    try:
        call()
    finally:
        conn.set_trace_callback(None)
    return seen


def test_an_unchanged_database_is_not_counted_twice(conn):
    caches.job_progress(conn)

    seen = statements_of(conn, lambda: caches.job_progress(conn))

    assert not any(COUNTING in sql for sql in seen), 'held answer should need no count'
    assert any('MAX(id) FROM lines' in sql for sql in seen), 'but the stamp is still read'


def test_a_changed_database_is_counted_again(conn):
    """The other half of the test above: if this did not run, the assertion that the
    counting query is absent would pass just as well against a typo in COUNTING."""
    caches.job_progress(conn)
    conn.execute("INSERT INTO lines (id, element_id, order_idx, polygon, text, checked, deleted) "
                 "VALUES (98, 1, 3, '[]', 'newly read', 0, 0)")
    conn.commit()

    seen = statements_of(conn, lambda: caches.job_progress(conn))

    assert any(COUNTING in sql for sql in seen)


def test_two_databases_do_not_share_an_answer(conn, tmp_path):
    """The stamp is three small integers, so a second database reaches the same three
    easily - every test fixture in this suite does. Held per database, a different one is
    a miss rather than somebody else's numbers."""
    assert caches.job_progress(conn)['j1']['lines_total'] == 3

    # Deliberately the same highest ids as the fixture above - 6 lines, 4 pages, no
    # revisions - so the stamp matches and only the database itself tells them apart.
    other = store.connect(tmp_path / 'other.db')
    other.executescript("""
        INSERT INTO jobs (id, name, owner, status, task) VALUES
            ('j1', 'Same id, other database', 'bob', 'done', 'text');
        INSERT INTO pages (id, job_id, idx, filename, source_file, layout_checked, deleted) VALUES
            (1, 'j1', 0, 'w.png', 'w.png', 0, 1),
            (2, 'j1', 1, 'x.png', 'x.png', 0, 1),
            (3, 'j1', 2, 'y.png', 'y.png', 0, 1),
            (4, 'j1', 3, 'z.png', 'z.png', 0, 0);
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox, deleted) VALUES
            (1, 4, 0, 'text', '[]', 0);
        INSERT INTO lines (id, element_id, order_idx, polygon, text, checked, deleted) VALUES
            (1, 1, 0, '[]', 'gone', 0, 1),
            (2, 1, 1, '[]', 'gone', 0, 1),
            (3, 1, 2, '[]', 'gone', 0, 1),
            (4, 1, 3, '[]', 'gone', 0, 1),
            (5, 1, 4, '[]', 'gone', 0, 1),
            (6, 1, 5, '[]', 'only one', 0, 0);
    """)
    other.commit()
    assert caches.change_stamp(other) == caches.change_stamp(conn), (
        'the two databases must reach the same stamp or this proves nothing')
    try:
        assert caches.job_progress(other)['j1']['lines_total'] == 1
        # And the first database still answers for itself.
        assert caches.job_progress(conn)['j1']['lines_total'] == 3
    finally:
        other.close()


def test_a_write_the_stamp_cannot_see_is_caught_by_the_ttl(conn, monkeypatch):
    """Deleting a page updates a row without adding one anywhere, so nothing the stamp
    watches moves. The held answer has to expire rather than stand indefinitely."""
    assert caches.job_progress(conn)['j1']['pages_total'] == 2

    conn.execute('UPDATE pages SET deleted = 1 WHERE id = 2')
    conn.commit()
    assert caches.job_progress(conn)['j1']['pages_total'] == 2, 'still held, as designed'

    now = [0.0]
    monkeypatch.setattr('app.caches.time.time', lambda: now[0])
    caches.forget_progress()
    caches.job_progress(conn)
    now[0] = caches.PROGRESS_TTL + 1

    assert caches.job_progress(conn)['j1']['pages_total'] == 1


def test_last_activity_is_when_a_person_last_touched_it(conn):
    """The sidebar's Recent list is people working, not the pipeline running. Every pass
    the pipeline makes writes revisions authored `model:...`, and a dataset nobody has
    opened since it was ingested would otherwise sit at the top of Recent for ever."""
    conn.executescript("""
        INSERT INTO revisions (target_type, target_id, job_id, author, action, snapshot,
                               created_at) VALUES
            ('line', 1, 'j1', 'alice',        'edit', '{}', '2026-09-01 10:00:00'),
            ('line', 2, 'j1', 'model:deepocr','ocr',  '{}', '2026-09-20 10:00:00'),
            ('line', 3, 'j2', 'model:deepocr','ocr',  '{}', '2026-09-19 10:00:00');
    """)
    conn.commit()
    caches.forget_progress()

    rollup = caches.job_progress(conn)

    assert rollup['j1']['last_activity'] == '2026-09-01 10:00:00'
    # j2 has only the pipeline's own passes, so it has no activity to report at all.
    assert 'last_activity' not in rollup['j2']


def test_no_machine_author_counts_as_somebody_working(conn):
    """Alignment, the LLM, a re-alignment and the system write revisions too - checking a
    line the transcription matched, for one - and none of those is a person either."""
    conn.executescript("""
        INSERT INTO revisions (target_type, target_id, job_id, author, action, snapshot,
                               created_at) VALUES
            ('line', 1, 'j1', 'alice',          'edit',  '{}', '2026-09-01 10:00:00'),
            ('line', 2, 'j1', 'align:gt',       'check', '{}', '2026-09-20 10:00:00'),
            ('line', 2, 'j1', 'realign:gt',     'check', '{}', '2026-09-21 10:00:00'),
            ('line', 2, 'j1', 'llm:gpt',        'edit',  '{}', '2026-09-22 10:00:00'),
            ('line', 2, 'j1', 'system:restore', 'edit',  '{}', '2026-09-23 10:00:00'),
            ('line', 6, 'j2', 'align:gt',       'check', '{}', '2026-09-19 10:00:00');
    """)
    conn.commit()
    caches.forget_progress()

    rollup = caches.job_progress(conn)

    assert rollup['j1']['last_activity'] == '2026-09-01 10:00:00'
    assert 'last_activity' not in rollup['j2']


def test_a_duplicate_page_is_not_one_to_review(conn):
    """A duplicate is never rendered and marking it reviewed is refused, so counting it
    would hold the list's bar short of full for ever - the dataset's own page says 2/2."""
    conn.executescript("""
        INSERT INTO pages (id, job_id, idx, filename, source_file, layout_checked, deleted, status)
            VALUES (5, 'j2', 1, 'c_again.png', 'c_again.png', 0, 0, 'duplicate');
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox, deleted)
            VALUES (5, 5, 0, 'text', '[]', 0);
        INSERT INTO lines (id, element_id, order_idx, polygon, text, checked, deleted)
            VALUES (7, 5, 0, '[]', 'copied', 0, 0);
    """)
    conn.commit()

    rollup = caches.job_progress(conn)

    assert rollup['j2'] == {
        'pages_total': 1, 'layout_checked_pages': 0, 'test_pages': 0,
        'lines_total': 1, 'lines_done': 0,
    }


def test_lines_inside_a_container_are_not_lines_to_review(conn):
    """A box reclassed to a container (a Table, say) takes its lines out of the reading,
    as the page table and the review queue already count them."""
    conn.executescript("""
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox, deleted, kind)
            VALUES (6, 1, 1, 'Table', '[]', 0, 'container');
        INSERT INTO lines (id, element_id, order_idx, polygon, text, checked, deleted) VALUES
            (8, 6, 0, '[]', 'cell', 0, 0),
            (9, 6, 1, '[]', 'cell', 1, 0);
    """)
    conn.commit()

    rollup = caches.job_progress(conn)

    assert (rollup['j1']['lines_total'], rollup['j1']['lines_done']) == (3, 2)


def test_a_change_to_one_dataset_recounts_only_that_one(conn):
    """Every open tab asks for the list every few seconds, and somebody is always reviewing
    something - a change anywhere recounting everything would be a recount on almost every
    call. A write the stamp cannot see on j1 shows whether j1 was counted again."""
    assert caches.job_progress(conn)['j1']['pages_total'] == 2
    conn.execute('UPDATE pages SET deleted = 1 WHERE id = 2')
    conn.execute("INSERT INTO lines (id, element_id, order_idx, polygon, text, checked, deleted) "
                 "VALUES (97, 3, 1, '[]', 'read in j2', 0, 0)")
    conn.commit()

    rollup = caches.job_progress(conn)

    assert rollup['j2']['lines_total'] == 2, 'the dataset that moved is counted again'
    assert rollup['j1']['pages_total'] == 2, 'the one that did not keeps its held answer'


def test_a_revision_names_the_dataset_it_moved(conn):
    assert caches.job_progress(conn)['j1']['lines_done'] == 2
    conn.execute('UPDATE lines SET checked = 1 WHERE id = 6')
    conn.execute('UPDATE lines SET checked = 1 WHERE id = 2')
    conn.execute("INSERT INTO revisions (target_type, target_id, job_id, author, action, snapshot) "
                 "VALUES ('line', 6, 'j2', 'alice', 'check', '{}')")
    conn.commit()

    rollup = caches.job_progress(conn)

    assert rollup['j2']['lines_done'] == 1
    assert rollup['j1']['lines_done'] == 2


def test_an_id_that_went_backwards_recounts_everything(conn):
    """Deleting a dataset deletes its revisions, so the highest id can fall; what moved
    since can then not be told from the ids, and nothing held is trusted."""
    conn.execute("INSERT INTO revisions (target_type, target_id, job_id, author, action, snapshot) "
                 "VALUES ('line', 6, 'j2', 'alice', 'check', '{}')")
    conn.commit()
    assert caches.job_progress(conn)['j1']['pages_total'] == 2
    conn.execute("DELETE FROM revisions WHERE job_id = 'j2'")
    conn.execute('UPDATE pages SET deleted = 1 WHERE id = 2')
    conn.commit()

    assert caches.job_progress(conn)['j1']['pages_total'] == 1


def test_an_expired_answer_is_served_at_once_and_counted_again_aside(conn, monkeypatch):
    """A full count is seconds on a real deployment. Run inside the request, every visit
    after a quiet spell waited for it before showing a single dataset."""
    assert caches.job_progress(conn)['j1']['lines_done'] == 2
    # Behind the stamp's back, which only the backstop recount can catch.
    conn.execute('UPDATE lines SET checked = 0 WHERE id = 1')
    conn.commit()
    monkeypatch.setattr(caches, 'PROGRESS_TTL', 0)

    answers = []
    seen = statements_of(conn, lambda: answers.append(caches.job_progress(conn)))

    assert answers[0]['j1']['lines_done'] == 2
    assert not any(COUNTING in sql for sql in seen), 'the request should not wait for the count'
    deadline = time.monotonic() + 5
    while caches.job_progress(conn)['j1']['lines_done'] != 1:
        assert time.monotonic() < deadline, 'the count aside never landed'
        time.sleep(0.01)


def test_a_fresh_start_counts_before_anyone_asks(conn):
    caches.warm_progress(conn)
    deadline = time.monotonic() + 5
    while caches.db_key(conn) not in caches._progress:
        assert time.monotonic() < deadline, 'the warm-up never counted'
        time.sleep(0.01)

    seen = statements_of(conn, lambda: caches.job_progress(conn))
    assert not any(COUNTING in sql for sql in seen)
