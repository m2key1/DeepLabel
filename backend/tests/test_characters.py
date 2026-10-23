import pytest

from app import characters, store


def test_a_plain_ascii_line_offers_nothing():
    assert characters.beyond_plain(['Wien, den 3. Mai 1885.']) == []


def test_a_decomposed_accent_stays_with_its_letter():
    """The corpus stores accents decomposed. Splitting on code points would offer the bare
    combining mark as a key, which pastes onto whatever letter came before it."""
    assert characters.beyond_plain(['Pru\u0308f.']) == ['u\u0308']


def test_a_precomposed_accent_is_one_key_too():
    assert characters.beyond_plain(['Pr\u00fcf.']) == ['u\u0308']


def test_the_two_forms_of_a_letter_are_one_key():
    """A corpus holds both: the model was trained on decomposed text, people paste
    precomposed. Offering each as its own key would put the same letter on the bar twice."""
    assert characters.beyond_plain(['Pr\u00fcf.', 'Pru\u0308f.']) == ['u\u0308']


def test_the_order_is_where_they_were_first_met():
    assert characters.beyond_plain(['⁊ and §', '§ again, then ℥']) == \
        ['⁊', '§', '℥']


def test_nothing_is_offered_twice():
    assert characters.beyond_plain(['§§§']) == ['§']


def test_an_empty_reading_is_not_a_character():
    assert characters.beyond_plain([None, '', 'abc']) == []


@pytest.fixture
def conn(tmp_path):
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript("""
        INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'Volume', 'alice', 'done');
        INSERT INTO pages (id, job_id, idx, filename, source_file) VALUES (1, 'j1', 0, 'p.png', '/p.png');
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind)
            VALUES (1, 1, 0, 'Paragraph', '[0,0,1,1]', 'content');
    """)
    connection.commit()
    yield connection
    connection.close()


def add_line(conn, line_id, text=None, corrected=None, deleted=0):
    conn.execute('INSERT INTO lines (id, element_id, order_idx, polygon, text, corrected_text, '
                 'deleted) VALUES (?, 1, ?, \'[]\', ?, ?, ?)',
                 (line_id, line_id, text, corrected, deleted))
    conn.commit()


class TestWhatADatasetWrites:
    def test_it_gathers_what_was_read_and_what_was_typed(self, conn):
        add_line(conn, 1, text='K. K. Finanz-Ministerium ⁊')
        add_line(conn, 2, text='plain', corrected='Mitgl. der Staats-Haupt-Kassen-Prüf.')

        assert characters.in_job(conn, 'j1') == ['\u204a', 'u\u0308']

    def test_a_deleted_line_writes_nothing(self, conn):
        add_line(conn, 1, text='⁊')
        add_line(conn, 2, text='℥', deleted=1)

        assert characters.in_job(conn, 'j1') == ['⁊']

    def test_a_dataset_nobody_has_read_yet_is_empty(self, conn):
        assert characters.in_job(conn, 'j1') == []

    def test_the_answer_is_kept_until_the_dataset_is_written_to(self, conn):
        """Gathering them reads every line - a second of work on a volume - so it is done
        again when a revision says the text moved, and not before."""
        add_line(conn, 1, text='\u204a')
        assert characters.in_job(conn, 'j1') == ['\u204a']

        conn.execute("UPDATE lines SET text = '\u2125' WHERE id = 1")
        conn.commit()
        assert characters.in_job(conn, 'j1') == ['\u204a'], 'no revision logged, nothing re-read'

        store.log_line(conn, 1, 'alice', 'update')
        conn.commit()
        assert characters.in_job(conn, 'j1') == ['\u2125']


class TestTrainingTarget:
    """A diplomatic reading marks what the hand struck out and what it added between the
    lines. The marks belong in the record; a recognizer trained on them would learn to
    write them, so the target keeps only the reading of the line as it now stands."""

    @pytest.mark.parametrize('marked, target', [
        ('der <del>alte</del> Herr <add>Graf</add> kam', 'der Herr Graf kam'),
        ('<del>gestrichen</del>', ''),
        ('nichts markiert', 'nichts markiert'),
        # A plain line keeps its spacing: only a line that lost a mark is tidied.
        ('zwei  Leerzeichen', 'zwei  Leerzeichen'),
        # A deletion running over a line break is cut in two by the line alignment.
        ('Er schrieb <del>einen langen', 'Er schrieb'),
        ('Satz</del> und dann', 'und dann'),
        ('a < b und <add>c</add>', 'a < b und c'),
    ])
    def test_the_marks_come_out(self, marked, target):
        assert characters.training_target(marked) == target
