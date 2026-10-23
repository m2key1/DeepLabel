"""Nothing a page has been read as is thrown away, and what comes back onto a re-detected
line is offered rather than asserted: only geometry all but identical to what a person
approved carries their correction, and their check, across.
"""
import json

import pytest

from app import candidates, store

# The line a person corrected, and boxes a re-detection might come back with.
ORIGINAL = [[0.1, 0.2], [0.9, 0.2], [0.9, 0.3], [0.1, 0.3]]
BARELY_MOVED = [[0.1, 0.2], [0.88, 0.2], [0.88, 0.3], [0.1, 0.3]]   # IoU 0.975
RESHAPED = [[0.1, 0.2], [0.55, 0.2], [0.55, 0.3], [0.1, 0.3]]       # IoU 0.5625
ELSEWHERE = [[0.1, 0.7], [0.9, 0.7], [0.9, 0.8], [0.1, 0.8]]        # IoU 0


@pytest.fixture
def conn(tmp_path):
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript("""
        INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'Data', 'alice', 'done');
        INSERT INTO pages (id, job_id, idx, filename, source_file, status, width, height)
            VALUES (1, 'j1', 0, 'p1.png', '/p1.png', 'done', 1000, 1000);
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind)
            VALUES (1, 1, 0, 'Paragraph', '[0,0,1,1]', 'content');
    """)
    connection.commit()
    yield connection
    connection.close()


def add_line(conn, polygon, text=None, corrected=None, checked=0, order_idx=0):
    cur = conn.execute(
        'INSERT INTO lines (element_id, order_idx, polygon, text, corrected_text, checked) '
        'VALUES (1,?,?,?,?,?)', (order_idx, json.dumps(polygon), text, corrected, checked))
    conn.commit()
    return cur.lastrowid


def redetect_as(conn, line_id, polygon, text=None):
    """What a re-detection does: keep what the old line carried, drop it, put a fresh one
    where the detector now says the line is - read again, if the pass got that far."""
    candidates.capture_line(conn, line_id)
    conn.execute('DELETE FROM lines WHERE id = ?', (line_id,))
    new_id = add_line(conn, polygon, text=text)
    candidates.rematch_page(conn, 1)
    return new_id


def line(conn, line_id):
    return conn.execute('SELECT * FROM lines WHERE id = ?', (line_id,)).fetchone()


class TestCapture:
    def test_the_machine_read_and_the_human_correction_are_kept_apart(self, conn):
        line_id = add_line(conn, ORIGINAL, text='Sarnple Header', corrected='Sample Header', checked=1)
        store.log_line(conn, line_id, 'model:ocr@best_model.pt', 'update')
        store.log_line(conn, line_id, 'alice', 'update')

        assert candidates.capture_line(conn, line_id) == 2

        rows = conn.execute('SELECT * FROM candidates ORDER BY source').fetchall()
        assert [(r['source'], r['author'], r['text'], r['checked']) for r in rows] == [
            ('human', 'alice', 'Sample Header', 1),
            ('ocr', 'model:ocr@best_model.pt', 'Sarnple Header', 0),
        ]
        assert json.loads(rows[0]['polygon']) == ORIGINAL

    def test_a_check_is_kept_even_when_the_person_changed_nothing(self, conn):
        """Approving what the machine read is a transcription of record too - and the only
        record anywhere that a person approved it."""
        line_id = add_line(conn, ORIGINAL, text='Sample Header', corrected='Sample Header',
                           checked=1)
        store.log_line(conn, line_id, 'model:ocr@best_model.pt', 'update')
        store.log_line(conn, line_id, 'alice', 'check')

        assert candidates.capture_line(conn, line_id) == 2

        rows = conn.execute('SELECT source, author, text, checked FROM candidates '
                            'ORDER BY source').fetchall()
        assert [tuple(r) for r in rows] == [
            ('human', 'alice', 'Sample Header', 1),
            ('ocr', 'model:ocr@best_model.pt', 'Sample Header', 0),
        ]

    def test_a_line_checked_by_agreement_is_not_kept_as_a_persons_word(self, conn):
        """Consensus re-derives itself from the readings it is made of. Keeping its result
        as a transcription of record would let one page-level read check a line twice."""
        line_id = add_line(conn, ORIGINAL, text='Sample Header', corrected='Sample Header',
                           checked=1)
        store.log_line(conn, line_id, 'llm:consensus@1', 'check')

        candidates.capture_line(conn, line_id)

        assert conn.execute("SELECT COUNT(*) c FROM candidates "
                            "WHERE source IN ('human', 'align')").fetchone()['c'] == 0
        assert conn.execute("SELECT COUNT(*) c FROM candidates "
                            "WHERE source = 'ocr'").fetchone()['c'] == 1

    def test_capturing_twice_keeps_one_copy(self, conn):
        """Re-running a phase must not fill the pool with duplicates of the same text."""
        line_id = add_line(conn, ORIGINAL, text='Sample Header')
        candidates.capture_line(conn, line_id)
        candidates.capture_line(conn, line_id)
        assert conn.execute('SELECT COUNT(*) c FROM candidates').fetchone()['c'] == 1

    def test_a_line_that_says_nothing_is_not_worth_keeping(self, conn):
        assert candidates.capture_line(conn, add_line(conn, ORIGINAL)) == 0
        assert candidates.capture_line(conn, add_line(conn, ORIGINAL, text='   ')) == 0
        assert conn.execute('SELECT COUNT(*) c FROM candidates').fetchone()['c'] == 0

    def test_the_same_words_on_two_lines_are_two_readings(self, conn):
        """A page-level reading is one entry per line, and a heading recurs down a page -
        "Direktor." under every department. Collapsing them into the first leaves every
        later line it stands on with nothing."""
        first = candidates.add(conn, 1, 'llm:reader', 'Direktor.', order_idx=3, llm_model_id=1)
        second = candidates.add(conn, 1, 'llm:reader', 'Direktor.', order_idx=9, llm_model_id=1)

        assert second != first
        assert conn.execute('SELECT COUNT(*) c FROM candidates').fetchone()['c'] == 2

    def test_the_same_words_in_the_same_place_are_one_reading(self, conn):
        """Which is what lets an answer be handed out again without duplicating it."""
        first = candidates.add(conn, 1, 'llm:reader', 'Direktor.', order_idx=3, llm_model_id=1)

        assert candidates.add(conn, 1, 'llm:reader', 'Direktor.', order_idx=3, llm_model_id=1) == first
        assert conn.execute('SELECT COUNT(*) c FROM candidates').fetchone()['c'] == 1


class TestTheLatestWordWins:
    def test_the_newer_of_two_kept_corrections_comes_back(self, conn):
        """A line corrected, captured, then corrected again holds both. What comes back
        is what the person last said - the earlier one is history."""
        old = add_line(conn, ORIGINAL, text='Sample Header', corrected='First try', checked=1)
        store.log_line(conn, old, 'alice', 'update')
        candidates.capture_line(conn, old)
        conn.execute("UPDATE lines SET corrected_text = 'Second try' WHERE id = ?", (old,))
        conn.commit()
        candidates.capture_line(conn, old)

        new = redetect_as(conn, old, BARELY_MOVED, text='Sample Header')

        assert line(conn, new)['corrected_text'] == 'Second try'

    def test_a_persons_word_still_beats_an_aligned_transcription(self, conn):
        """Newest within a kind, but a correction outranks an alignment however old."""
        old = add_line(conn, ORIGINAL, text='Sample Header', corrected='Typed by hand', checked=1)
        store.log_line(conn, old, 'alice', 'update')
        candidates.capture_line(conn, old)
        conn.execute("UPDATE lines SET corrected_text = 'From the transcript' WHERE id = ?", (old,))
        conn.commit()
        store.log_line(conn, old, 'align:gt', 'update')
        candidates.capture_line(conn, old)

        new = redetect_as(conn, old, BARELY_MOVED, text='Sample Header')

        assert line(conn, new)['corrected_text'] == 'Typed by hand'


class TestSetAside:
    def test_a_reading_set_aside_is_not_matched_onto_the_next_line(self, conn):
        """What a detection pass that starts the page clean asks of the pool: the readings
        taken off the old lines must not ride the next rematch onto the new ones."""
        line_id = add_line(conn, ORIGINAL, text='Sarnple Header', corrected='Sample Header', checked=1)
        candidates.capture_line(conn, line_id)
        conn.execute('DELETE FROM lines WHERE id = ?', (line_id,))

        assert candidates.set_aside(conn, 1) == 2

        new_id = add_line(conn, ORIGINAL)
        candidates.rematch_page(conn, 1)
        fresh = line(conn, new_id)
        assert (fresh['corrected_text'], fresh['checked']) == (None, 0)
        assert conn.execute('SELECT COUNT(*) c FROM candidates WHERE line_id IS NOT NULL'
                            ).fetchone()['c'] == 0

    def test_it_is_set_aside_rather_than_thrown_away(self, conn):
        """Said again - the same reader, the same words, the same place - it counts once
        more, which is what keeps a later careful re-run from duplicating it."""
        line_id = add_line(conn, ORIGINAL, text='Sample Header')
        candidates.capture_line(conn, line_id)
        candidates.set_aside(conn, 1)

        assert candidates.capture_line(conn, line_id) == 1
        assert [r['dismissed'] for r in conn.execute('SELECT dismissed FROM candidates')] == [0]


class TestRematch:
    def test_a_correction_comes_back_verified_when_the_line_barely_moved(self, conn):
        old = add_line(conn, ORIGINAL, text='Sarnple Header', corrected='Sample Header', checked=1)
        store.log_line(conn, old, 'alice', 'update')

        new = redetect_as(conn, old, BARELY_MOVED)

        assert line(conn, new)['corrected_text'] == 'Sample Header'
        assert line(conn, new)['checked'] == 1
        # And the log says who really put it there.
        authors = [r['author'] for r in conn.execute(
            "SELECT author FROM revisions WHERE target_type = 'line' AND target_id = ?", (new,))]
        assert authors == ['realign:geom@0.97', 'realign:geom@0.97']

    def test_a_reshaped_line_is_offered_but_never_verified(self, conn):
        old = add_line(conn, ORIGINAL, text='Sarnple Header', corrected='Sample Header', checked=1)
        store.log_line(conn, old, 'alice', 'update')

        new = redetect_as(conn, old, RESHAPED)

        assert line(conn, new)['corrected_text'] is None
        assert line(conn, new)['checked'] == 0
        # Nothing was lost though: the text is on that line, waiting to be accepted.
        human = conn.execute("SELECT * FROM candidates WHERE source = 'human'").fetchone()
        assert (human['line_id'], human['text'], round(human['similarity'], 4)) == (new, 'Sample Header', 0.5625)

    def test_a_line_detected_somewhere_else_entirely_takes_nothing(self, conn):
        old = add_line(conn, ORIGINAL, text='Sarnple Header', corrected='Sample Header', checked=1)

        new = redetect_as(conn, old, ELSEWHERE)

        assert line(conn, new)['corrected_text'] is None
        # The text stays in the pool, homeless rather than misattached.
        human = conn.execute("SELECT * FROM candidates WHERE source = 'human'").fetchone()
        assert human['line_id'] is None

    def test_a_grown_box_that_covers_the_old_line_does_not_inherit_its_check(self, conn):
        """The case IoU is chosen for: the new box contains the old one completely, which
        every coverage measure would call a perfect match."""
        old = add_line(conn, ORIGINAL, text='Sarnple Header', corrected='Sample Header', checked=1)
        grown = [[0.05, 0.15], [0.95, 0.15], [0.95, 0.35], [0.05, 0.35]]

        new = redetect_as(conn, old, grown)

        assert line(conn, new)['checked'] == 0
        assert line(conn, new)['corrected_text'] is None

    def test_an_unverified_correction_comes_back_unverified(self, conn):
        old = add_line(conn, ORIGINAL, text='Sarnple Header', corrected='Sample Header', checked=0)
        store.log_line(conn, old, 'alice', 'update')

        new = redetect_as(conn, old, BARELY_MOVED)

        assert line(conn, new)['corrected_text'] == 'Sample Header'
        assert line(conn, new)['checked'] == 0
        # Carried over, the correction is still alice's typing, not the re-alignment's.
        assert line(conn, new)['corrected_by'] == 'alice'

    def test_a_correction_already_on_the_line_is_never_overwritten(self, conn):
        old = add_line(conn, ORIGINAL, corrected='From the pool', checked=1)
        store.log_line(conn, old, 'alice', 'update')
        candidates.capture_line(conn, old)
        conn.execute('DELETE FROM lines WHERE id = ?', (old,))
        new = add_line(conn, BARELY_MOVED, corrected='Someone typed this since')

        candidates.rematch_page(conn, 1)

        assert line(conn, new)['corrected_text'] == 'Someone typed this since'

    def test_a_machine_read_alone_is_offered_but_never_written_back(self, conn):
        """OCR text is regenerated by the next pass, so it has no business writing itself
        into a correction."""
        old = add_line(conn, ORIGINAL, text='Sarnple Header')
        store.log_line(conn, old, 'model:ocr@best_model.pt', 'update')

        new = redetect_as(conn, old, BARELY_MOVED)

        assert line(conn, new)['corrected_text'] is None
        assert conn.execute('SELECT line_id FROM candidates').fetchone()['line_id'] == new

    def test_each_kept_line_lands_on_one_new_line_best_overlap_first(self, conn):
        first = add_line(conn, ORIGINAL, corrected='First line', checked=1, order_idx=0)
        second = add_line(conn, ELSEWHERE, corrected='Second line', checked=1, order_idx=1)
        for line_id in (first, second):
            store.log_line(conn, line_id, 'alice', 'update')
            candidates.capture_line(conn, line_id)
        conn.execute('DELETE FROM lines')
        new_first = add_line(conn, BARELY_MOVED, order_idx=0)
        new_second = add_line(conn, ELSEWHERE, order_idx=1)

        counts = candidates.rematch_page(conn, 1)

        assert line(conn, new_first)['corrected_text'] == 'First line'
        assert line(conn, new_second)['corrected_text'] == 'Second line'
        # No language model has read this page, so nothing was settled by agreement.
        assert counts == {'attached': 2, 'restored': 2, 'rechecked': 2, 'orphaned': 0,
                          'agreed': 0, 'filled': 0, 'cleared': 0, 'checked': 0}


    def test_a_page_with_nothing_homeless_leaves_no_write_open(self, conn):
        add_line(conn, ORIGINAL, text='Sample Header')

        assert candidates.rematch_page(conn, 1)['attached'] == 0
        assert conn.in_transaction is False


class TestWhoSettledTheLine:
    """check_source names who settled a line, NULL for a person. A check carried back onto
    a re-detected line must keep naming the same one, or a machine's approval reaches
    person-only training and the header CER as a person's."""

    def test_an_aligned_transcriptions_check_comes_back_as_aligned(self, conn):
        old = add_line(conn, ORIGINAL, text='Sarnple Header', corrected='Sample Header', checked=1)
        conn.execute("UPDATE lines SET check_source = 'align' WHERE id = ?", (old,))
        store.log_line(conn, old, 'align:gt@0.95', 'update')
        store.log_line(conn, old, 'align:gt@0.95', 'check')

        new = redetect_as(conn, old, BARELY_MOVED)

        assert (line(conn, new)['checked'], line(conn, new)['check_source']) == (1, 'align')
        assert line(conn, new)['corrected_by'] == 'align:gt@0.95'

    def test_it_still_comes_back_as_aligned_after_a_second_redetection(self, conn):
        old = add_line(conn, ORIGINAL, text='Sarnple Header', corrected='Sample Header', checked=1)
        conn.execute("UPDATE lines SET check_source = 'align' WHERE id = ?", (old,))
        store.log_line(conn, old, 'align:gt@0.95', 'check')
        middle = redetect_as(conn, old, BARELY_MOVED)

        new = redetect_as(conn, middle, ORIGINAL)

        assert (line(conn, new)['checked'], line(conn, new)['check_source']) == (1, 'align')

    def test_a_persons_check_comes_back_as_a_persons(self, conn):
        old = add_line(conn, ORIGINAL, text='Sarnple Header', corrected='Sample Header', checked=1)
        store.log_line(conn, old, 'alice', 'check')

        new = redetect_as(conn, old, BARELY_MOVED)

        assert (line(conn, new)['checked'], line(conn, new)['check_source']) == (1, None)

    def test_an_agreement_comes_back_as_an_agreement(self, conn):
        """Consensus is not restored from the pool - it settles the new line again from the
        page-level readings it was made of - and still names itself."""
        conn.execute('UPDATE jobs SET llm_consensus_min = 2, llm_autocheck = 1')
        for model_id in (1, 2):
            candidates.add(conn, 1, f'llm:reader{model_id}', 'Sample Header',
                           llm_model_id=model_id)
        old = add_line(conn, ORIGINAL, text='Sarnple Header')
        candidates.rematch_page(conn, 1)
        assert (line(conn, old)['checked'], line(conn, old)['check_source']) == (1, 'llm')

        new = redetect_as(conn, old, BARELY_MOVED, text='Sarnple Header')

        settled = line(conn, new)
        assert (settled['corrected_text'], settled['checked'], settled['check_source'],
                settled['llm_agree_count']) == ('Sample Header', 1, 'llm', 2)


class TestTextMatching:
    def test_a_page_level_reading_finds_its_lines_by_text(self, conn):
        """What a language model returns has no geometry, so it is matched the way a
        dropped-in transcription is."""
        first = add_line(conn, ORIGINAL, text='Sample Header line 1', order_idx=0)
        second = add_line(conn, ELSEWHERE, text='Sample Header line 2', order_idx=1)
        for idx, text in enumerate(['Sample Header line 1', 'Sample Header line 2', 'A line nobody found']):
            candidates.add(conn, 1, 'llm:Careful reader', text, order_idx=idx)
        conn.commit()

        counts = candidates.rematch_page(conn, 1)

        rows = conn.execute('SELECT text, line_id FROM candidates ORDER BY order_idx').fetchall()
        assert [(r['text'], r['line_id']) for r in rows] == [
            ('Sample Header line 1', first),
            ('Sample Header line 2', second),
            ('A line nobody found', None),
        ]
        # The unmatched one stays in the pool - the segmentation missing a line is not a
        # reason to lose what was read there.
        assert counts['orphaned'] == 1

    def test_two_readings_of_the_same_page_both_land_on_the_lines(self, conn):
        first = add_line(conn, ORIGINAL, text='Sample Header line 1', order_idx=0)
        for author in ('llm:First reader', 'llm:Second reader'):
            candidates.add(conn, 1, author, 'Sample Header line 1', order_idx=0)
        conn.commit()

        candidates.rematch_page(conn, 1)

        assert [r['line_id'] for r in conn.execute('SELECT line_id FROM candidates ORDER BY id')] \
            == [first, first]


class TestOneReadingPerLinePerReader:
    def test_a_second_reading_goes_to_a_line_its_reader_is_not_already_on(self, conn):
        """A page repeats itself, so one reader's answer holds the same words twice. The
        later one belongs on the other line, not stacked on the first - which is what
        happens when the alignment is offered lines that reader has already spoken for."""
        first = add_line(conn, ORIGINAL, text='Direktor.', order_idx=0)
        second = add_line(conn, ELSEWHERE, text='Direktor.', order_idx=1)
        candidates.add(conn, 1, 'llm:reader', 'Direktor.', order_idx=0, llm_model_id=1)
        conn.commit()
        candidates.rematch_page(conn, 1)

        candidates.add(conn, 1, 'llm:reader', 'Direktor.', order_idx=7, llm_model_id=1)
        conn.commit()
        candidates.rematch_page(conn, 1)

        placed = conn.execute(
            "SELECT order_idx, line_id FROM candidates WHERE source = 'llm' ORDER BY order_idx"
        ).fetchall()
        assert [(r['order_idx'], r['line_id']) for r in placed] == [(0, first), (7, second)]

    def test_a_reader_found_twice_on_one_line_is_spread_over_the_page(self, conn):
        """However it got there - an older pass, a re-read landing on what it said before -
        the pool heals itself rather than depending on the path that made it."""
        first = add_line(conn, ORIGINAL, text='Direktor.', order_idx=0)
        second = add_line(conn, ELSEWHERE, text='Direktor.', order_idx=1)
        for order_idx in (0, 7):
            conn.execute(
                'INSERT INTO candidates (page_id, line_id, source, author, text, order_idx, '
                "similarity, llm_model_id) VALUES (1, ?, 'llm', 'llm:reader', 'Direktor.', ?, 1.0, 1)",
                (first, order_idx))
        conn.commit()

        candidates.rematch_page(conn, 1)

        placed = conn.execute(
            "SELECT order_idx, line_id FROM candidates WHERE source = 'llm' ORDER BY order_idx"
        ).fetchall()
        assert sorted(r['line_id'] for r in placed) == sorted([first, second])

    def test_a_reading_with_nowhere_left_to_go_stays_homeless(self, conn):
        """Rather than doubling up: a line already carrying this reader's word is not a
        home for another of its readings, however well the text matches."""
        only = add_line(conn, ORIGINAL, text='Direktor.', order_idx=0)
        candidates.add(conn, 1, 'llm:reader', 'Direktor.', order_idx=0, llm_model_id=1)
        conn.commit()
        candidates.rematch_page(conn, 1)

        candidates.add(conn, 1, 'llm:reader', 'Direktor.', order_idx=7, llm_model_id=1)
        conn.commit()
        candidates.rematch_page(conn, 1)

        placed = conn.execute(
            "SELECT order_idx, line_id FROM candidates WHERE source = 'llm' ORDER BY order_idx"
        ).fetchall()
        assert [(r['order_idx'], r['line_id']) for r in placed] == [(0, only), (7, None)]


class TestJobWideRematch:
    def test_a_dataset_with_homeless_readings_is_rematched_without_crashing(self, conn):
        """rematch_job sums what rematch_page reports, and that grew a consensus section -
        a fixed set of keys made the runner die at the end of every affected job."""
        conn.execute("INSERT INTO llm_connections (id, owner, name, base_url) "
                     "VALUES (1, 'alice', 'Stub', 'http://llm:8000/v1')")
        conn.execute("INSERT INTO llm_models (id, connection_id, model, label) "
                     "VALUES (1, 1, 'stub', 'Reader')")
        conn.commit()
        line_id = add_line(conn, ORIGINAL, text='Sample Header line 1')
        candidates.add(conn, 1, 'llm:Reader', 'Sample Header line 1', llm_model_id=1)
        candidates.add(conn, 1, 'llm:Reader', 'A line nobody found', order_idx=1, llm_model_id=1)
        conn.commit()

        totals = candidates.rematch_job(conn, 'j1')

        assert totals['attached'] == 1
        assert totals['orphaned'] == 1
        assert totals['agreed'] == 0
        assert conn.execute('SELECT line_id FROM candidates ORDER BY order_idx').fetchone()['line_id'] \
            == line_id

    def test_a_dataset_with_nothing_homeless_reports_the_same_shape(self, conn):
        assert set(candidates.rematch_job(conn, 'j1')) == \
            set(candidates.rematch_page(conn, 1))


class TestTheSameWordsComeBack:
    """Geometry all but identical is one reason to trust a kept correction. Text identical
    to what the line now reads is another, and a better one: there is nothing left for a
    person to verify, however far the box moved.
    """

    def approved(self, conn, text='Sample Header'):
        line_id = add_line(conn, ORIGINAL, text=text, corrected=text, checked=1)
        store.log_line(conn, line_id, 'model:ocr@best_model.pt', 'update')
        store.log_line(conn, line_id, 'alice', 'check')
        return line_id

    def test_a_reshaped_line_reading_the_same_words_is_checked_again(self, conn):
        old = self.approved(conn)

        new = redetect_as(conn, old, RESHAPED, text='Sample Header')

        assert line(conn, new)['checked'] == 1
        assert line(conn, new)['corrected_text'] == 'Sample Header'
        # The log says why it was trusted: the words, not the box.
        authors = [r['author'] for r in conn.execute(
            "SELECT author FROM revisions WHERE target_type = 'line' AND target_id = ?", (new,))]
        assert authors == ['realign:text@0.56', 'realign:text@0.56']

    def test_a_reshaped_line_reading_something_else_is_still_only_offered(self, conn):
        old = self.approved(conn)

        new = redetect_as(conn, old, RESHAPED, text='Somethlng else entirely')

        assert line(conn, new)['checked'] == 0
        assert line(conn, new)['corrected_text'] is None

    def test_spacing_and_typography_do_not_count_against_it(self, conn):
        """The same comparison agreement is settled by, so a curly quote cannot make two
        readings of the same words disagree."""
        old = self.approved(conn, text='Sample \u2014 \u201cHeader\u201d')

        new = redetect_as(conn, old, RESHAPED, text='Sample - "Header"')

        assert line(conn, new)['checked'] == 1
        # Stored as the person approved it, not as the detector re-read it.
        assert line(conn, new)['corrected_text'] == 'Sample \u2014 \u201cHeader\u201d'

    def test_a_line_detected_elsewhere_takes_nothing_however_it_reads(self, conn):
        """Reading the same words is a reason to trust a correction on the line it landed
        on, never a reason to land it somewhere it does not overlap at all."""
        old = self.approved(conn)

        new = redetect_as(conn, old, ELSEWHERE, text='Sample Header')

        assert line(conn, new)['checked'] == 0
        assert conn.execute("SELECT line_id FROM candidates "
                            "WHERE source = 'human'").fetchone()['line_id'] is None

    def test_a_machine_reading_the_same_words_checks_nothing(self, conn):
        """Two machines agreeing is what consensus is for, and it counts models. A kept
        OCR read must not check a line by agreeing with the next OCR read of it."""
        old = add_line(conn, ORIGINAL, text='Sample Header')
        store.log_line(conn, old, 'model:ocr@best_model.pt', 'update')

        new = redetect_as(conn, old, RESHAPED, text='Sample Header')

        assert line(conn, new)['checked'] == 0
        assert line(conn, new)['corrected_text'] is None

    def test_a_line_someone_has_since_corrected_is_left_alone(self, conn):
        old = self.approved(conn)
        candidates.capture_line(conn, old)
        conn.execute('DELETE FROM lines WHERE id = ?', (old,))
        new = add_line(conn, RESHAPED, text='Sample Header', corrected='Typed since')

        candidates.rematch_page(conn, 1)

        assert line(conn, new)['corrected_text'] == 'Typed since'
        assert line(conn, new)['checked'] == 0


class TestWhatIsStillOnOffer:
    """A line's own text is the OCR model's latest word on it, so a reading kept from
    before it was read again is history rather than a rival reading."""

    def offered(self, conn, line_id):
        return [c['text'] for c in candidates.for_page(conn, 1) if c['line_id'] == line_id]

    def kept(self, conn, line_id, text='Colurnn 1, entry 4'):
        """A line read once, then re-detected: what it said is kept and comes back onto
        whichever line now covers its box."""
        old = add_line(conn, ORIGINAL, text=text)
        store.log_line(conn, old, 'model:ocr@old_model.pt', 'update')
        return old

    def test_a_kept_reading_stands_while_the_new_line_has_none_of_its_own(self, conn):
        old = self.kept(conn, ORIGINAL)

        new = redetect_as(conn, old, BARELY_MOVED)

        assert self.offered(conn, new) == ['Colurnn 1, entry 4']

    def test_reading_the_line_again_retires_the_machines_earlier_word(self, conn):
        old = self.kept(conn, ORIGINAL)

        new = redetect_as(conn, old, BARELY_MOVED, text='Mitgl. der Staats-Haupt-Kassen-Pruf.')

        assert self.offered(conn, new) == []

    def test_the_retired_reading_is_still_in_the_pool(self, conn):
        """Held, not deleted: it is what a re-read has to be judged against, and clearing
        the line for another run puts it back on offer."""
        old = self.kept(conn, ORIGINAL)
        new = redetect_as(conn, old, BARELY_MOVED, text='Mitgl. der Staats-Haupt-Kassen-Pruf.')

        conn.execute('UPDATE lines SET text = NULL WHERE id = ?', (new,))

        assert self.offered(conn, new) == ['Colurnn 1, entry 4']

    def test_a_line_the_new_run_could_not_read_keeps_what_it_said_before(self, conn):
        """An empty read is the runner reporting nothing, not a better transcription."""
        old = self.kept(conn, ORIGINAL)

        new = redetect_as(conn, old, BARELY_MOVED, text='')

        assert self.offered(conn, new) == ['Colurnn 1, entry 4']

    def test_a_persons_correction_outlives_the_re_read(self, conn):
        """Only the machine's word is replaced by the machine reading again."""
        old = add_line(conn, ORIGINAL, text='Colurnn 1, entry 4',
                       corrected='Mitgl. der Staats-Haupt-Kassen-Pruf.', checked=1)
        store.log_line(conn, old, 'model:ocr@old_model.pt', 'update')
        store.log_line(conn, old, 'alice', 'update')

        new = redetect_as(conn, old, RESHAPED, text='Mitgl. der Staats-Haupt-Kassen-Pruef.')

        assert self.offered(conn, new) == ['Mitgl. der Staats-Haupt-Kassen-Pruf.']

    def test_a_reading_that_found_no_line_is_untouched_by_any_of_this(self, conn):
        old = self.kept(conn, ORIGINAL)

        redetect_as(conn, old, ELSEWHERE, text='Something else entirely')

        assert self.offered(conn, None) == ['Colurnn 1, entry 4']


class TestSayingWhereAReadingBelongs:
    """A language model transcribes the whole page and its lines are matched by text. Where
    the segmentation found something else, a reading matches nothing and there is nothing
    automatic left to try - so a person says which line it is."""

    @pytest.fixture
    def unmatched(self, conn):
        """One line, and a reading of it the matcher could not place."""
        line_id = add_line(conn, ORIGINAL, text='Joh. Bapt. Mayr')
        candidate_id = candidates.add(conn, 1, 'llm:GLM', 'Johann Baptist Mayr', llm_model_id=7)
        conn.commit()
        return line_id, candidate_id

    def candidate(self, conn, candidate_id):
        return conn.execute('SELECT * FROM candidates WHERE id = ?', (candidate_id,)).fetchone()

    def test_it_lands_on_the_line_with_no_similarity_of_its_own(self, conn, unmatched):
        line_id, candidate_id = unmatched

        candidates.assign(conn, self.candidate(conn, candidate_id), line_id)

        held = self.candidate(conn, candidate_id)
        assert held['line_id'] == line_id
        # A person's pairing is not a score; a made-up one would be ranked against the
        # matcher's own by _release_doubled.
        assert held['similarity'] is None

    def test_releasing_it_puts_it_back_in_the_pool(self, conn, unmatched):
        line_id, candidate_id = unmatched
        candidates.assign(conn, self.candidate(conn, candidate_id), line_id)

        candidates.assign(conn, self.candidate(conn, candidate_id), None)

        assert self.candidate(conn, candidate_id)['line_id'] is None
        assert [c['id'] for c in candidates._orphans(conn, 1)] == [candidate_id]

    def test_the_same_reader_cannot_end_up_saying_two_things_about_one_line(self, conn, unmatched):
        line_id, candidate_id = unmatched
        already = candidates.add(conn, 1, 'llm:GLM', 'Joh. Bapt. Mayr', line_id=line_id,
                                 similarity=0.9, llm_model_id=7)
        conn.commit()

        candidates.assign(conn, self.candidate(conn, candidate_id), line_id)

        assert self.candidate(conn, candidate_id)['line_id'] == line_id
        assert self.candidate(conn, already)['line_id'] is None

    def test_another_readers_word_on_that_line_is_left_alone(self, conn, unmatched):
        line_id, candidate_id = unmatched
        other = candidates.add(conn, 1, 'llm:DeepSeek', 'Joh. Bapt. Mayr', line_id=line_id,
                               similarity=0.9, llm_model_id=8)
        conn.commit()

        candidates.assign(conn, self.candidate(conn, candidate_id), line_id)

        assert self.candidate(conn, other)['line_id'] == line_id

    def test_the_line_settles_straight_away_when_that_makes_two_agree(self, conn, unmatched):
        line_id, candidate_id = unmatched
        candidates.add(conn, 1, 'llm:DeepSeek', 'Johann Baptist Mayr', line_id=line_id,
                       similarity=0.8, llm_model_id=8)
        conn.commit()

        candidates.assign(conn, self.candidate(conn, candidate_id), line_id)

        assert line(conn, line_id)['llm_agree_count'] == 2
        assert line(conn, line_id)['corrected_text'] == 'Johann Baptist Mayr'

    def test_a_pairing_a_person_made_survives_the_next_rematch(self, conn, unmatched):
        """The matcher gives each reader one reading per line, so a line that reader is
        already on is not a home for another of its words - hand-placed or not."""
        line_id, candidate_id = unmatched
        candidates.assign(conn, self.candidate(conn, candidate_id), line_id)
        candidates.add(conn, 1, 'llm:GLM', 'Something else entirely', order_idx=1, llm_model_id=7)
        conn.commit()

        candidates.rematch_page(conn, 1)

        assert self.candidate(conn, candidate_id)['line_id'] == line_id


class TestEditingLinesKeepsThePoolHonest:
    """Drawing or throwing away a line changes which readings have a home. The pool is put
    right as part of the edit, so what the panel offers is never a page behind."""

    def _reading(self, conn, text, polygon, line_id=None, model=7):
        cur = conn.execute(
            'INSERT INTO candidates (page_id, line_id, source, author, llm_model_id, text, '
            'order_idx, polygon, similarity) VALUES (1,?,?,?,?,?,0,?,?)',
            (line_id, 'llm', 'Reader', model, text, json.dumps(polygon) if polygon else None,
             1.0 if line_id else None))
        conn.commit()
        return cur.lastrowid

    def test_a_reading_comes_home_when_its_line_goes(self, conn):
        line = add_line(conn, ORIGINAL, text='Pfarre Wien')
        held = self._reading(conn, 'Pfarre Wien', None, line_id=line)

        conn.execute('UPDATE lines SET deleted = 1 WHERE id = ?', (line,))
        conn.commit()
        candidates.rematch_page(conn, 1)

        # Back in the pool rather than pointing at a line nobody can see.
        assert conn.execute('SELECT line_id FROM candidates WHERE id = ?',
                            (held,)).fetchone()['line_id'] is None

    def test_a_reading_finds_the_line_drawn_over_it(self, conn):
        # A reading the matcher could place nowhere, carrying the geometry it was read from.
        held = self._reading(conn, 'Kaplan Huber', ELSEWHERE)
        assert conn.execute('SELECT line_id FROM candidates WHERE id = ?',
                            (held,)).fetchone()['line_id'] is None

        drawn = add_line(conn, ELSEWHERE)
        candidates.rematch_page(conn, 1)

        assert conn.execute('SELECT line_id FROM candidates WHERE id = ?',
                            (held,)).fetchone()['line_id'] == drawn


class TestSettingReadingsAside:
    """A merge takes the language models' readings off the lines it destroys without
    forgetting them. They are set aside under the edit's revision, so
    taking that edit back offers them again - and what a re-read superseded, which no
    edit did, stays superseded."""

    def _reading(self, conn, text, line_id):
        return candidates.add(conn, 1, 'llm:Reader', text, line_id=line_id, llm_model_id=7)

    def _standing(self, conn, candidate_id):
        row = conn.execute('SELECT line_id, dismissed, set_aside_at FROM candidates WHERE id = ?',
                           (candidate_id,)).fetchone()
        return tuple(row)

    def test_the_readings_on_the_lines_come_off_and_are_hidden(self, conn):
        line = add_line(conn, ORIGINAL, text='Pfarre Wien')
        other = add_line(conn, ELSEWHERE, text='Kaplan Huber', order_idx=1)
        reading, elsewhere = self._reading(conn, 'Pfarre Wien', line), self._reading(conn, 'Kaplan Huber', other)
        # A correction remembers the box it was read from and finds its own way back.
        correction = candidates.add(conn, 1, 'alice', 'Pfarre Wien.', line_id=line,
                                    polygon=json.dumps(ORIGINAL))

        assert candidates.set_aside_readings(conn, [line], revision=9) == 1

        assert self._standing(conn, reading) == (None, 1, 9)
        assert self._standing(conn, elsewhere) == (other, 0, None)
        assert self._standing(conn, correction) == (line, 0, None)

    def test_undoing_the_edit_offers_them_again_and_redoing_sets_them_aside(self, conn):
        line = add_line(conn, ORIGINAL, text='Pfarre Wien')
        reading = self._reading(conn, 'Pfarre Wien', line)
        candidates.set_aside_readings(conn, [line], revision=9)

        assert candidates.revert_set_aside(conn, 1, 8, 9, 'undo') == 1
        assert self._standing(conn, reading) == (None, 0, 9)
        candidates.rematch_page(conn, 1)
        assert self._standing(conn, reading)[:2] == (line, 0)

        assert candidates.revert_set_aside(conn, 1, 8, 9, 'redo') == 1
        assert self._standing(conn, reading) == (None, 1, 9)

    def test_only_the_edit_in_the_span_is_taken_back(self, conn):
        line = add_line(conn, ORIGINAL, text='Pfarre Wien')
        earlier = self._reading(conn, 'Pfarre Wien', line)
        candidates.set_aside_readings(conn, [line], revision=3)
        superseded = self._reading(conn, 'Pfarre Wlen', line)
        conn.execute('UPDATE candidates SET dismissed = 1 WHERE id = ?', (superseded,))
        conn.commit()

        assert candidates.revert_set_aside(conn, 1, 8, 9, 'undo') == 0

        assert self._standing(conn, earlier) == (None, 1, 3)
        assert self._standing(conn, superseded) == (line, 1, None)
