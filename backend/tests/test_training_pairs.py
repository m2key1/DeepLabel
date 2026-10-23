"""What reaches the OCR training corpus on disk. Every checked line becomes an image and
a target beside it; a line whose check is taken back has to lose them again, or the model
keeps being trained on text the reviewer withdrew.
"""
import json
import unicodedata

import pytest
from PIL import Image

from app import store, training

POLY = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.4], [0.1, 0.4]]
TINY = [[0.1, 0.1], [0.11, 0.1], [0.11, 0.105], [0.1, 0.105]]


@pytest.fixture
def scan(tmp_path):
    path = tmp_path / 'scan.png'
    Image.new('RGB', (400, 200), 'white').save(path)
    return path


@pytest.fixture
def corrections(tmp_path, monkeypatch):
    directory = tmp_path / 'corrections'
    monkeypatch.setattr('app.config.CORRECTIONS_DIR', directory)
    monkeypatch.setattr('app.config.SAVE_OCR_DATA', True)
    return directory


@pytest.fixture
def conn(tmp_path, scan, corrections, monkeypatch):
    db = tmp_path / 'app.db'
    monkeypatch.setattr('app.config.DB_PATH', db)
    connection = store.connect(db)
    connection.executescript(f"""
        INSERT INTO jobs (id, name, owner, status) VALUES ('job-abcdef12', 'Volume', 'alice', 'done');
        INSERT INTO pages (id, job_id, idx, filename, source_file, status)
            VALUES (1, 'job-abcdef12', 0, 'p1.png', '{scan}', 'done');
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind)
            VALUES (1, 1, 0, 'Paragraph', '[0,0,1,1]', 'content');
    """)
    connection.commit()
    yield connection
    connection.close()


def add_line(conn, text='Sarnple', corrected='Sample', checked=1, polygon=POLY, deleted=0):
    cur = conn.execute(
        'INSERT INTO lines (element_id, order_idx, polygon, text, corrected_text, checked, deleted) '
        'VALUES (1, 0, ?, ?, ?, ?, ?)',
        (json.dumps(polygon), text, corrected, checked, deleted))
    conn.commit()
    return cur.lastrowid


def pair(corrections, job_id, line_id):
    stem = training._stem(job_id, line_id)
    return (corrections / f'{stem}.png', corrections / f'{stem}.corrected.txt')


class TestWhatIsWritten:
    def test_a_checked_line_becomes_an_image_and_a_target(self, conn, corrections):
        line_id = add_line(conn)

        training.write_pair(conn, line_id)

        image, text = pair(corrections, 'job-abcdef12', line_id)
        assert image.exists() and text.exists()
        assert text.read_text(encoding='utf-8') == 'Sample'
        with Image.open(image) as crop:
            assert crop.width >= training.MIN_SIDE and crop.height >= training.MIN_SIDE

    def test_the_target_is_the_correction_where_there_is_one(self, conn, corrections):
        line_id = add_line(conn, text='Sarnple', corrected='Sample')

        training.write_pair(conn, line_id)

        assert pair(corrections, 'job-abcdef12', line_id)[1].read_text() == 'Sample'

    def test_a_checked_line_nobody_edited_still_counts_as_verified(self, conn, corrections):
        """Checking a line the machine already got right is a person vouching for it, and
        it is the cheapest ground truth there is."""
        line_id = add_line(conn, text='Machine got it right', corrected=None)

        training.write_pair(conn, line_id)

        assert pair(corrections, 'job-abcdef12', line_id)[1].read_text() == 'Machine got it right'

    def test_the_target_is_decomposed_the_way_the_recognizer_expects(self, conn, corrections):
        """DeepOCR normalizes its targets to NFD, so a precomposed umlaut would train
        against a target it can never match."""
        line_id = add_line(conn, corrected='Schönberg')

        training.write_pair(conn, line_id)

        written = pair(corrections, 'job-abcdef12', line_id)[1].read_text(encoding='utf-8')
        assert written == unicodedata.normalize('NFD', 'Schönberg')
        assert written != 'Schönberg', 'the precomposed form would be the wrong target'

    def test_the_target_carries_no_diplomatic_markup(self, conn, corrections):
        line_id = add_line(conn, corrected='der <del>alte</del> Herr <add>Graf</add>')

        training.write_pair(conn, line_id)

        assert pair(corrections, 'job-abcdef12', line_id)[1].read_text() == 'der Herr Graf'

    def test_a_line_struck_out_whole_writes_no_pair(self, conn, corrections):
        line_id = add_line(conn, corrected='<del>gestrichen</del>')

        training.write_pair(conn, line_id)

        image, text = pair(corrections, 'job-abcdef12', line_id)
        assert not image.exists() and not text.exists()

    def test_surrounding_whitespace_is_not_part_of_the_target(self, conn, corrections):
        line_id = add_line(conn, corrected='  Sample  ')

        training.write_pair(conn, line_id)

        assert pair(corrections, 'job-abcdef12', line_id)[1].read_text() == 'Sample'


class TestWhatIsTakenBack:
    def write_then(self, conn, corrections, **change):
        line_id = add_line(conn)
        training.write_pair(conn, line_id)
        assert pair(corrections, 'job-abcdef12', line_id)[0].exists()
        for column, value in change.items():
            conn.execute(f'UPDATE lines SET {column} = ? WHERE id = ?', (value, line_id))
        conn.commit()
        training.write_pair(conn, line_id)
        return pair(corrections, 'job-abcdef12', line_id)

    def test_unchecking_a_line_removes_its_pair(self, conn, corrections):
        image, text = self.write_then(conn, corrections, checked=0)
        assert not image.exists() and not text.exists()

    def test_deleting_a_line_removes_its_pair(self, conn, corrections):
        image, text = self.write_then(conn, corrections, deleted=1)
        assert not image.exists() and not text.exists()

    def test_emptying_the_text_removes_its_pair(self, conn, corrections):
        image, text = self.write_then(conn, corrections, corrected_text='', text='')
        assert not image.exists() and not text.exists()

    def test_a_line_that_no_longer_exists_is_not_an_error(self, conn):
        training.write_pair(conn, 9999)


class TestWhenTheCropCannotBeMade:
    def test_a_line_too_small_to_read_is_skipped(self, conn, corrections):
        line_id = add_line(conn, polygon=TINY)

        training.write_pair(conn, line_id)

        assert not pair(corrections, 'job-abcdef12', line_id)[0].exists()

    def test_a_scan_that_is_gone_is_reported_rather_than_raised(self, conn, corrections, scan,
                                                                capsys):
        """It would otherwise fail on every boot, forever, while backfill kept reporting
        the same pair as pending."""
        line_id = add_line(conn)
        scan.unlink()

        training.write_pair(conn, line_id)

        assert 'source gone' in capsys.readouterr().out
        assert not pair(corrections, 'job-abcdef12', line_id)[0].exists()


class TestFlushingBeforeAPurge:
    def test_every_outstanding_pair_for_a_page_is_written(self, conn, corrections):
        first = add_line(conn, corrected='First')
        second = add_line(conn, corrected='Second')

        assert training.flush_pending(conn, [1]) == 2

        assert pair(corrections, 'job-abcdef12', first)[1].read_text() == 'First'
        assert pair(corrections, 'job-abcdef12', second)[1].read_text() == 'Second'

    def test_unchecked_and_deleted_lines_are_not_counted(self, conn, corrections):
        add_line(conn, corrected='Kept')
        add_line(conn, corrected='Not checked', checked=0)
        add_line(conn, corrected='Gone', deleted=1)

        assert training.flush_pending(conn, [1]) == 1

    def test_nothing_is_written_when_the_deployment_keeps_no_data(self, conn, corrections,
                                                                  monkeypatch):
        add_line(conn)
        monkeypatch.setattr('app.config.SAVE_OCR_DATA', False)

        assert training.flush_pending(conn, [1]) == 0
        assert list(corrections.glob('*')) == [] if corrections.exists() else True

    def test_no_pages_means_no_work(self, conn):
        assert training.flush_pending(conn, []) == 0


class TestReconcilingWithDisk:
    def test_a_pair_whose_line_is_no_longer_verified_is_removed(self, conn, corrections):
        """The case this exists for: a correction reverted while the backend was down
        would otherwise keep training the model on text the reviewer took back."""
        line_id = add_line(conn)
        training.write_pair(conn, line_id)
        conn.execute('UPDATE lines SET checked = 0 WHERE id = ?', (line_id,))
        conn.commit()

        training.backfill()

        image, text = pair(corrections, 'job-abcdef12', line_id)
        assert not image.exists() and not text.exists()

    def test_a_pair_written_by_nobody_we_know_is_removed(self, conn, corrections):
        corrections.mkdir(parents=True, exist_ok=True)
        (corrections / 'appcorr_deadbeef_00000042.png').write_bytes(b'stale')
        (corrections / 'appcorr_deadbeef_00000042.corrected.txt').write_text('stale')

        training.backfill()

        assert list(corrections.glob('appcorr_deadbeef*')) == []

    def test_a_verified_line_with_no_pair_is_queued_to_be_written(self, conn, corrections):
        line_id = add_line(conn)

        training.backfill()

        assert training._queue.get_nowait() == line_id

    def test_a_deployment_that_keeps_no_data_reconciles_nothing(self, conn, corrections,
                                                                monkeypatch):
        corrections.mkdir(parents=True, exist_ok=True)
        (corrections / 'appcorr_deadbeef_00000042.png').write_bytes(b'stale')
        monkeypatch.setattr('app.config.SAVE_OCR_DATA', False)

        training.backfill()

        assert (corrections / 'appcorr_deadbeef_00000042.png').exists()


class TestTheQueue:
    def test_nothing_is_queued_where_the_deployment_keeps_no_data(self, monkeypatch):
        monkeypatch.setattr('app.config.SAVE_OCR_DATA', False)
        before = training._queue.qsize()

        training.enqueue(1)

        assert training._queue.qsize() == before

    def test_a_line_is_queued_where_it_does(self, corrections):
        training.enqueue(4242)

        assert training._queue.get_nowait() == 4242

    def test_the_writer_does_not_start_where_the_deployment_keeps_no_data(self, monkeypatch,
                                                                         capsys):
        monkeypatch.setattr('app.config.SAVE_OCR_DATA', False)

        training.start_writer()

        assert 'not archiving' in capsys.readouterr().out


class TestNaming:
    def test_a_pair_is_named_by_its_dataset_and_line(self, conn):
        assert training._stem('job-abcdef12', 7) == 'appcorr_job-abcd_00000007'

    def test_two_datasets_cannot_collide_on_the_same_line_id(self, conn):
        assert training._stem('aaaaaaaa-1', 7) != training._stem('bbbbbbbb-2', 7)
