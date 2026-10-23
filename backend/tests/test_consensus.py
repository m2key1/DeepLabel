"""Agreement between language models is exact after normalisation, counts models rather
than answers, and is never allowed to overrule a person.
"""
import sqlite3
import unicodedata

import pytest

from app import candidates, consensus, store

LINE = [[0.1, 0.2], [0.9, 0.2], [0.9, 0.3], [0.1, 0.3]]


@pytest.fixture
def conn(tmp_path):
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript("""
        INSERT INTO jobs (id, name, owner, status, llm_consensus_min, llm_autocheck)
            VALUES ('j1', 'Data', 'alice', 'done', 2, 0);
        INSERT INTO pages (id, job_id, idx, filename, source_file, status)
            VALUES (1, 'j1', 0, 'p1.png', '/p1.png', 'done');
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind)
            VALUES (1, 1, 0, 'Paragraph', '[0,0,1,1]', 'content');
        INSERT INTO lines (id, element_id, order_idx, polygon, text)
            VALUES (1, 1, 0, '[[0.1,0.2],[0.9,0.2],[0.9,0.3],[0.1,0.3]]', 'Joh. Bapt. Mayr, Coop.');
    """)
    connection.commit()
    yield connection
    connection.close()


def read(conn, model_id: int, text: str, line_id: int = 1):
    """One language model's reading of the line, already matched to it."""
    candidates.add(conn, 1, f'llm:Model {model_id}', text, line_id=line_id, llm_model_id=model_id)
    conn.commit()


def settings(conn, minimum=2, autocheck=False):
    conn.execute('UPDATE jobs SET llm_consensus_min = ?, llm_autocheck = ?',
                 (minimum, int(autocheck)))
    conn.commit()


def line(conn, line_id=1):
    return conn.execute('SELECT * FROM lines WHERE id = ?', (line_id,)).fetchone()


class TestNormalisation:
    @pytest.mark.parametrize('other', [
        'Joh.  Bapt. Mayr',          # collapsed whitespace
        ' Joh. Bapt. Mayr ',         # trimmed
        'Joh. Bapt. Mayr\n',
    ])
    def test_spacing_is_not_a_disagreement(self, other):
        assert consensus.normalize('Joh. Bapt. Mayr') == consensus.normalize(other)

    def test_quote_and_dash_shapes_are_not_a_disagreement(self):
        assert consensus.normalize("Mayr's Hof-Buchdruckerei") == \
            consensus.normalize('Mayr’s Hof‐Buchdruckerei')

    def test_composed_and_decomposed_umlauts_are_the_same_word(self):
        # Built explicitly: the two forms are indistinguishable in a source file, and a
        # test that cannot fail is worse than none.
        decomposed = unicodedata.normalize('NFD', 'Müller')
        assert decomposed != 'Müller'
        assert consensus.normalize(decomposed) == consensus.normalize('Müller')

    def test_a_different_reading_stays_different(self):
        """The whole point: an expanded abbreviation is not the same transcription."""
        assert consensus.normalize('Joh. Bapt. Mayr, Coop.') != \
            consensus.normalize('Johann Baptist Mayr, Cooperator')


class TestAgreement:
    def test_two_models_reading_the_same_thing_settle_the_line(self, conn):
        read(conn, 1, 'Joh. Bapt. Mayr, Cooperator')
        read(conn, 2, 'Joh. Bapt. Mayr, Cooperator')

        counts = consensus.settle_page(conn, 1)

        assert counts == {'agreed': 1, 'filled': 1, 'cleared': 0, 'checked': 0}
        assert line(conn)['corrected_text'] == 'Joh. Bapt. Mayr, Cooperator'
        # Signed by the agreement, so nobody mistakes the fill-in for a person's typing.
        assert line(conn)['corrected_by'] == 'llm:consensus@2'
        assert line(conn)['llm_agree_count'] == 2
        # Filling in a reading is not verifying it - autocheck is off here.
        assert line(conn)['checked'] == 0
        assert line(conn)['check_source'] is None

    def test_one_model_alone_settles_nothing(self, conn):
        read(conn, 1, 'Joh. Bapt. Mayr, Cooperator')

        counts = consensus.settle_page(conn, 1)

        assert counts['agreed'] == 0
        assert line(conn)['corrected_text'] is None
        assert line(conn)['llm_agree_count'] == 1

    def test_models_that_disagree_settle_nothing_but_are_still_counted(self, conn):
        read(conn, 1, 'Joh. Bapt. Mayr, Coop.')
        read(conn, 2, 'Johann Baptist Mayr, Cooperator')

        consensus.settle_page(conn, 1)

        assert line(conn)['corrected_text'] is None
        assert line(conn)['llm_agree_count'] == 1

    def test_the_majority_reading_wins_when_three_models_split(self, conn):
        read(conn, 1, 'Joh. Bapt. Mayr, Coop.')
        read(conn, 2, 'Joh. Bapt. Mayr, Coop.')
        read(conn, 3, 'Johann Baptist Mayr')

        consensus.settle_page(conn, 1)

        assert line(conn)['corrected_text'] == 'Joh. Bapt. Mayr, Coop.'
        assert line(conn)['llm_agree_count'] == 2

    def test_one_model_repeating_itself_is_still_one_voice(self, conn):
        """Two readings from the same model must never look like two models agreeing."""
        candidates.add(conn, 1, 'llm:Model 1', 'Joh. Bapt. Mayr', line_id=1, llm_model_id=1)
        candidates.add(conn, 1, 'llm:Model 1', 'Joh.  Bapt.  Mayr', line_id=1, llm_model_id=1)
        conn.commit()

        consensus.settle_page(conn, 1)

        assert line(conn)['llm_agree_count'] == 1
        assert line(conn)['corrected_text'] is None

    def test_the_stored_text_is_a_models_own_not_the_normalised_form(self, conn):
        read(conn, 1, 'Mayr’s Hof-Buchdruckerei')
        read(conn, 2, "Mayr's  Hof-Buchdruckerei")

        consensus.settle_page(conn, 1)

        assert line(conn)['corrected_text'] in (
            'Mayr’s Hof-Buchdruckerei', "Mayr's  Hof-Buchdruckerei")

    def test_how_many_must_agree_is_the_datasets_own_setting(self, conn):
        settings(conn, minimum=3)
        read(conn, 1, 'Joh. Bapt. Mayr')
        read(conn, 2, 'Joh. Bapt. Mayr')

        assert consensus.settle_page(conn, 1)['agreed'] == 0

        read(conn, 3, 'Joh. Bapt. Mayr')
        assert consensus.settle_page(conn, 1)['agreed'] == 1
        assert line(conn)['corrected_text'] == 'Joh. Bapt. Mayr'


class TestAutocheck:
    def test_agreement_may_check_the_line_off_when_the_dataset_says_so(self, conn):
        settings(conn, minimum=2, autocheck=True)
        read(conn, 1, 'Joh. Bapt. Mayr, Cooperator')
        read(conn, 2, 'Joh. Bapt. Mayr, Cooperator')

        counts = consensus.settle_page(conn, 1)

        assert counts == {'agreed': 1, 'filled': 1, 'cleared': 0, 'checked': 1}
        assert line(conn)['checked'] == 1
        # Marked as settled by models, so training and evaluation can leave it out.
        assert line(conn)['check_source'] == 'llm'
        authors = [r['author'] for r in conn.execute(
            "SELECT author FROM revisions WHERE target_type = 'line' AND target_id = 1")]
        assert authors == ['llm:consensus@2', 'llm:consensus@2']

    def test_a_persons_correction_is_never_overwritten(self, conn):
        settings(conn, minimum=2, autocheck=True)
        conn.execute("UPDATE lines SET corrected_text = 'What alice typed' WHERE id = 1")
        conn.commit()
        read(conn, 1, 'Joh. Bapt. Mayr, Cooperator')
        read(conn, 2, 'Joh. Bapt. Mayr, Cooperator')

        counts = consensus.settle_page(conn, 1)

        assert counts == {'agreed': 1, 'filled': 0, 'cleared': 0, 'checked': 0}
        assert line(conn)['corrected_text'] == 'What alice typed'

    def test_a_checked_line_is_left_alone_even_with_no_correction_on_it(self, conn):
        """Checking the machine's read is a decision too, and agreement does not revisit it."""
        settings(conn, minimum=2, autocheck=True)
        conn.execute('UPDATE lines SET checked = 1 WHERE id = 1')
        conn.commit()
        read(conn, 1, 'Joh. Bapt. Mayr, Cooperator')
        read(conn, 2, 'Joh. Bapt. Mayr, Cooperator')

        consensus.settle_page(conn, 1)

        assert line(conn)['corrected_text'] is None
        assert line(conn)['check_source'] is None

    def test_the_local_ocr_read_is_not_a_voice(self, conn):
        """DeepOCR is the model being trained; letting it confirm its own targets would
        approve exactly the mistakes it already makes."""
        settings(conn, minimum=2, autocheck=True)
        candidates.add(conn, 1, 'model:ocr@best.pt', 'Joh. Bapt. Mayr, Coop.', line_id=1)
        read(conn, 1, 'Joh. Bapt. Mayr, Coop.')
        conn.commit()

        consensus.settle_page(conn, 1)

        assert line(conn)['llm_agree_count'] == 1
        assert line(conn)['checked'] == 0


class TestSummary:
    def test_the_page_reports_where_the_models_agree_and_the_local_model_differs(self, conn):
        settings(conn, minimum=2)
        read(conn, 1, 'Joh. Bapt. Mayr, Cooperator')
        read(conn, 2, 'Joh. Bapt. Mayr, Cooperator')
        consensus.settle_page(conn, 1)

        # The line's own OCR text is 'Joh. Bapt. Mayr, Coop.', which the models contradict.
        assert consensus.page_summary(conn, 1) == {'lines': 1, 'agreed': 1, 'disputed': 1}


class TestLettingTheLocalModelVote:
    """The OCR model is excluded by default, and the module says why: on a dataset that
    trains it, confirming its own targets approves exactly the mistakes it already makes.
    A dataset read with an unrelated checkpoint can switch that off, and then one language
    model agreeing with the recognition is two voices."""

    @pytest.fixture(autouse=True)
    def ocr_votes(self, conn):
        conn.execute('UPDATE jobs SET llm_consensus_with_ocr = 1')
        conn.commit()

    def test_one_model_agreeing_with_the_recognition_settles_the_line(self, conn):
        read(conn, 1, 'Joh. Bapt. Mayr, Coop.')    # the same words lines.text holds

        counts = consensus.settle_page(conn, 1)

        assert counts == {'agreed': 1, 'filled': 1, 'cleared': 0, 'checked': 0}
        assert line(conn)['llm_agree_count'] == 2
        assert line(conn)['corrected_text'] == 'Joh. Bapt. Mayr, Coop.'

    def test_one_model_disagreeing_with_it_still_settles_nothing(self, conn):
        read(conn, 1, 'Johann Baptist Mayr, Cooperator')

        consensus.settle_page(conn, 1)

        assert line(conn)['llm_agree_count'] == 1
        assert line(conn)['corrected_text'] is None

    def test_the_recognition_is_one_voice_however_many_models_repeat_it(self, conn):
        """Two models reading what the line already says is three voices, not four."""
        read(conn, 1, 'Joh. Bapt. Mayr, Coop.')
        read(conn, 2, 'Joh. Bapt. Mayr, Coop.')

        consensus.settle_page(conn, 1)

        assert line(conn)['llm_agree_count'] == 3

    def test_it_does_not_vote_where_no_model_has_read_at_all(self, conn):
        """It counts alongside the language models, not instead of them - otherwise a
        minimum of one would fill every line in the dataset with its own recognition."""
        settings(conn, minimum=1)

        counts = consensus.settle_page(conn, 1)

        assert counts['agreed'] == 0
        assert line(conn)['llm_agree_count'] == 0
        assert line(conn)['corrected_text'] is None

    def test_a_line_the_model_read_as_nothing_casts_no_vote(self, conn):
        conn.execute("UPDATE lines SET text = '' WHERE id = 1")
        conn.commit()
        read(conn, 1, 'Joh. Bapt. Mayr, Coop.')

        consensus.settle_page(conn, 1)

        assert line(conn)['llm_agree_count'] == 1

    def test_a_correction_already_there_is_still_the_last_word(self, conn):
        conn.execute("UPDATE lines SET corrected_text = 'What a person typed' WHERE id = 1")
        conn.commit()
        read(conn, 1, 'Joh. Bapt. Mayr, Coop.')

        counts = consensus.settle_page(conn, 1)

        assert counts == {'agreed': 1, 'filled': 0, 'cleared': 0, 'checked': 0}
        assert line(conn)['corrected_text'] == 'What a person typed'

    def test_left_off_it_changes_nothing(self, conn):
        conn.execute('UPDATE jobs SET llm_consensus_with_ocr = 0')
        conn.commit()
        read(conn, 1, 'Joh. Bapt. Mayr, Coop.')

        consensus.settle_page(conn, 1)

        assert line(conn)['llm_agree_count'] == 1
        assert line(conn)['corrected_text'] is None


def set_aside(conn, model_id: int) -> None:
    """A person releases one model's reading from its line - what the viewer's set-aside
    control does, without the matcher in between."""
    conn.execute('UPDATE candidates SET line_id = NULL WHERE llm_model_id = ?', (model_id,))
    conn.commit()


def revision_authors(conn, line_id=1) -> list[str]:
    return [r['author'] for r in conn.execute(
        "SELECT author FROM revisions WHERE target_type = 'line' AND target_id = ? ORDER BY id",
        (line_id,))]


class TestWithdrawingAgreement:
    """A settlement rests on its readings: set them aside and the line goes back to what
    the OCR model said - unless a person has checked or typed it since."""

    @pytest.fixture(autouse=True)
    def settled(self, conn):
        read(conn, 1, 'Joh. Bapt. Mayr, Cooperator')
        read(conn, 2, 'Joh. Bapt. Mayr, Cooperator')
        consensus.settle_page(conn, 1)
        assert line(conn)['corrected_by'] == 'llm:consensus@2'

    def test_one_voice_short_the_line_returns_to_its_ocr_text(self, conn):
        set_aside(conn, 2)

        counts = consensus.settle_page(conn, 1)

        assert counts == {'agreed': 0, 'filled': 0, 'cleared': 1, 'checked': 0}
        assert line(conn)['corrected_text'] is None
        assert line(conn)['corrected_by'] is None
        assert line(conn)['llm_agree_count'] == 1
        assert line(conn)['text'] == 'Joh. Bapt. Mayr, Coop.'

    def test_the_withdrawal_is_on_record_under_what_agreement_was_left(self, conn):
        """The revisions log is the line's backup, so the fill-in going must be an entry too.
        Signed the same way as the fill-in, with the count that no longer carried it."""
        set_aside(conn, 2)

        consensus.settle_page(conn, 1)

        assert revision_authors(conn) == ['llm:consensus@2', 'llm:consensus@1']

    def test_settling_again_with_the_readings_still_there_changes_nothing(self, conn):
        counts = consensus.settle_page(conn, 1)

        assert counts == {'agreed': 1, 'filled': 0, 'cleared': 0, 'checked': 0}
        assert line(conn)['corrected_by'] == 'llm:consensus@2'
        assert revision_authors(conn) == ['llm:consensus@2']

    def test_what_a_person_typed_over_it_stays_theirs(self, conn):
        conn.execute("UPDATE lines SET corrected_text = 'What alice typed', corrected_by = 'alice' "
                     'WHERE id = 1')
        conn.commit()
        set_aside(conn, 1)
        set_aside(conn, 2)

        counts = consensus.settle_page(conn, 1)

        assert counts['cleared'] == 0
        assert (line(conn)['corrected_text'], line(conn)['corrected_by']) == ('What alice typed', 'alice')
        assert line(conn)['llm_agree_count'] == 0

    def test_a_line_a_person_checked_keeps_its_fill_in(self, conn):
        store.check_line_as_person(conn, 1, True)
        conn.commit()
        set_aside(conn, 2)

        counts = consensus.settle_page(conn, 1)

        assert counts['cleared'] == 0
        assert line(conn)['corrected_text'] == 'Joh. Bapt. Mayr, Cooperator'
        assert line(conn)['checked'] == 1

    def test_raising_the_bar_withdraws_the_settlement_when_the_page_is_settled_again(self, conn):
        settings(conn, minimum=3)

        counts = consensus.settle_page(conn, 1)

        assert counts['cleared'] == 1
        assert line(conn)['corrected_text'] is None
        assert line(conn)['llm_agree_count'] == 2


class TestWithdrawingAnAutocheckedAgreement:
    """A tick autocheck put on a line is the models', not a person's: setting aside the
    readings that settled it withdraws the tick with the fill-in."""

    @pytest.fixture(autouse=True)
    def settled(self, conn):
        settings(conn, autocheck=True)
        read(conn, 1, 'Joh. Bapt. Mayr, Cooperator')
        read(conn, 2, 'Joh. Bapt. Mayr, Cooperator')
        consensus.settle_page(conn, 1)
        assert (line(conn)['checked'], line(conn)['check_source']) == (1, 'llm')

    def test_one_voice_short_the_line_returns_to_its_ocr_text_unchecked(self, conn):
        set_aside(conn, 2)

        counts = consensus.settle_page(conn, 1)

        assert counts == {'agreed': 0, 'filled': 0, 'cleared': 1, 'checked': 0}
        assert (line(conn)['corrected_text'], line(conn)['corrected_by']) == (None, None)
        assert (line(conn)['checked'], line(conn)['check_source']) == (0, None)
        assert revision_authors(conn) == ['llm:consensus@2', 'llm:consensus@2', 'llm:consensus@1']

    def test_settling_again_counts_it_among_the_lines_it_would_put_back(self, conn):
        settings(conn, minimum=3, autocheck=True)

        assert consensus.settle_preview(conn, 'j1') == {'lines': 1, 'fill': 0, 'clear': 1}

    def test_a_person_ticking_it_since_keeps_the_fill_in(self, conn):
        store.check_line_as_person(conn, 1, True)
        conn.commit()
        set_aside(conn, 2)

        counts = consensus.settle_page(conn, 1)

        assert counts['cleared'] == 0
        assert line(conn)['corrected_text'] == 'Joh. Bapt. Mayr, Cooperator'
        assert (line(conn)['checked'], line(conn)['check_source']) == (1, None)


def add_line(conn, line_id: int, text: str) -> None:
    conn.execute('INSERT INTO lines (id, element_id, order_idx, polygon, text) VALUES (?, 1, ?, ?, ?)',
                 (line_id, line_id, '[[0.1,0.4],[0.9,0.4],[0.9,0.5],[0.1,0.5]]', text))
    conn.commit()


class TestSettlingAgain:
    """Changed agreement settings save as they are. Settling the dataset again applies them
    to the lines already read - and says first how many it would touch."""

    def test_lowering_the_bar_settles_nothing_until_the_dataset_is_settled_again(self, conn):
        settings(conn, minimum=3)
        read(conn, 1, 'Joh. Bapt. Mayr, Cooperator')
        read(conn, 2, 'Joh. Bapt. Mayr, Cooperator')
        consensus.settle_page(conn, 1)
        assert line(conn)['corrected_text'] is None

        settings(conn, minimum=2)
        assert consensus.settle_preview(conn, 'j1') == {'lines': 1, 'fill': 1, 'clear': 0}
        # Asking is not doing.
        assert line(conn)['corrected_text'] is None

        assert consensus.settle_job(conn, 'j1') == {'agreed': 1, 'filled': 1, 'cleared': 0, 'checked': 0}
        assert line(conn)['corrected_text'] == 'Joh. Bapt. Mayr, Cooperator'
        assert line(conn)['corrected_by'] == 'llm:consensus@2'

    def test_raising_the_bar_counts_the_lines_it_would_put_back(self, conn):
        read(conn, 1, 'Joh. Bapt. Mayr, Cooperator')
        read(conn, 2, 'Joh. Bapt. Mayr, Cooperator')
        consensus.settle_page(conn, 1)

        settings(conn, minimum=3)
        assert consensus.settle_preview(conn, 'j1') == {'lines': 1, 'fill': 0, 'clear': 1}

        assert consensus.settle_job(conn, 'j1')['cleared'] == 1
        assert line(conn)['corrected_text'] is None

    def test_lines_a_person_checked_or_typed_are_neither_counted_nor_touched(self, conn):
        add_line(conn, 2, 'Second line')
        add_line(conn, 3, 'Third line, never read')
        for model_id in (1, 2):
            read(conn, model_id, 'Joh. Bapt. Mayr, Cooperator', line_id=1)
            read(conn, model_id, 'Second line', line_id=2)
        conn.execute("UPDATE lines SET corrected_text = 'What alice typed', corrected_by = 'alice' "
                     'WHERE id = 1')
        conn.commit()
        store.check_line_as_person(conn, 2, True)
        conn.commit()

        assert consensus.settle_preview(conn, 'j1') == {'lines': 0, 'fill': 0, 'clear': 0}
        assert consensus.settle_job(conn, 'j1')['filled'] == 0
        assert line(conn, 1)['corrected_text'] == 'What alice typed'
        assert line(conn, 2)['corrected_text'] is None
        assert line(conn, 3)['corrected_text'] is None

    def test_a_deleted_page_is_not_settled(self, conn):
        read(conn, 1, 'Joh. Bapt. Mayr, Cooperator')
        read(conn, 2, 'Joh. Bapt. Mayr, Cooperator')
        conn.execute('UPDATE pages SET deleted = 1 WHERE id = 1')
        conn.commit()

        assert consensus.settle_preview(conn, 'j1') == {'lines': 0, 'fill': 0, 'clear': 0}
        assert consensus.settle_job(conn, 'j1')['filled'] == 0
        assert line(conn)['corrected_text'] is None

    def test_a_dataset_that_does_not_exist_has_nothing_to_settle(self, conn):
        assert consensus.settle_preview(conn, 'nope') == {'lines': 0, 'fill': 0, 'clear': 0}
        assert consensus.settle_job(conn, 'nope') == {'agreed': 0, 'filled': 0, 'cleared': 0, 'checked': 0}


class TestSettlingAWholeDataset:
    """Settling runs over every page of a dataset, so its cost is per page, not per line,
    and it is one change: a failure part-way leaves no half-settled dataset behind."""

    def _statements(self, conn, work):
        seen: list[str] = []
        conn.set_trace_callback(seen.append)
        try:
            work()
        finally:
            conn.set_trace_callback(None)
        return seen

    def _second_page(self, conn):
        conn.executescript("""
            INSERT INTO pages (id, job_id, idx, filename, source_file, status)
                VALUES (2, 'j1', 1, 'p2.png', '/p2.png', 'done');
            INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind)
                VALUES (2, 2, 0, 'Paragraph', '[0,0,1,1]', 'content');
            INSERT INTO lines (id, element_id, order_idx, polygon, text)
                VALUES (5, 2, 0, '[[0.1,0.2],[0.9,0.2],[0.9,0.3],[0.1,0.3]]', 'Pfarrer');
        """)
        conn.commit()

    def test_the_readings_are_fetched_once_per_page(self, conn):
        add_line(conn, 2, 'Second line')
        add_line(conn, 3, 'Third line')
        for model_id in (1, 2):
            for line_id in (1, 2, 3):
                read(conn, model_id, f'Reading {line_id}', line_id=line_id)

        seen = self._statements(conn, lambda: consensus.settle_preview(conn, 'j1'))

        assert consensus.settle_preview(conn, 'j1') == {'lines': 3, 'fill': 3, 'clear': 0}
        assert len([s for s in seen if 'FROM candidates' in s]) == 1

    def test_the_dataset_is_settled_in_one_commit(self, conn):
        self._second_page(conn)
        for model_id in (1, 2):
            read(conn, model_id, 'Joh. Bapt. Mayr, Cooperator', line_id=1)
            candidates.add(conn, 2, f'llm:Model {model_id}', 'Pfarrer zu Linz', line_id=5,
                           llm_model_id=model_id)
        conn.commit()

        seen = self._statements(conn, lambda: consensus.settle_job(conn, 'j1'))

        assert [line(conn, i)['corrected_text'] for i in (1, 5)] == \
            ['Joh. Bapt. Mayr, Cooperator', 'Pfarrer zu Linz']
        assert len([s for s in seen if s.strip().upper() == 'COMMIT']) == 1

    def test_every_page_is_scored_before_anything_is_written(self, conn):
        """Scoring is the slow part, and done inside the write it would hold every other
        save in the database back for as long as the whole dataset takes."""
        self._second_page(conn)
        for model_id in (1, 2):
            read(conn, model_id, 'Joh. Bapt. Mayr, Cooperator', line_id=1)
            candidates.add(conn, 2, f'llm:Model {model_id}', 'Pfarrer zu Linz', line_id=5,
                           llm_model_id=model_id)
        conn.commit()

        seen = self._statements(conn, lambda: consensus.settle_job(conn, 'j1'))

        writing = next(i for i, s in enumerate(seen) if s.lstrip().upper().startswith(('BEGIN', 'UPDATE', 'INSERT')))
        assert len([s for s in seen[:writing] if 'FROM candidates' in s]) == 2
        assert [s for s in seen[writing:] if 'FROM candidates' in s] == []
        assert [line(conn, i)['corrected_text'] for i in (1, 5)] == \
            ['Joh. Bapt. Mayr, Cooperator', 'Pfarrer zu Linz']

    def test_a_line_a_person_corrects_while_the_dataset_is_scored_keeps_their_text(self, conn, monkeypatch):
        self._second_page(conn)
        for model_id in (1, 2):
            read(conn, model_id, 'Joh. Bapt. Mayr, Cooperator', line_id=1)
            candidates.add(conn, 2, f'llm:Model {model_id}', 'Pfarrer zu Linz', line_id=5,
                           llm_model_id=model_id)
        conn.commit()
        database = conn.execute('PRAGMA database_list').fetchone()['file']
        scored = consensus._scored_lines

        def a_person_saves_meanwhile(conn_, page_id, with_ocr):
            lines = scored(conn_, page_id, with_ocr)
            if page_id == 2:
                other = sqlite3.connect(database, timeout=0.5)
                other.execute("UPDATE lines SET corrected_text = 'What alice typed', corrected_by = 'alice' "
                              'WHERE id = 1')
                other.commit()
                other.close()
            return lines

        monkeypatch.setattr(consensus, '_scored_lines', a_person_saves_meanwhile)

        assert consensus.settle_job(conn, 'j1') == {'agreed': 2, 'filled': 1, 'cleared': 0, 'checked': 0}
        assert [(line(conn, i)['corrected_text'], line(conn, i)['corrected_by']) for i in (1, 5)] == [
            ('What alice typed', 'alice'), ('Pfarrer zu Linz', 'llm:consensus@2')]
