import json
from pathlib import Path

import pytest
from PIL import Image

from app import store, train_snapshot


def test_rank_split_is_deterministic_and_exact():
    keys = {f'page:h{i}' for i in range(2000)}
    val = train_snapshot._rank_split(keys, 0.2)
    assert val == train_snapshot._rank_split(set(keys), 0.2)
    assert len(val) == 400


def test_rank_split_zero_fraction_puts_everything_in_train():
    assert train_snapshot._rank_split({f'k{i}' for i in range(100)}, 0.0) == set()


def test_rank_split_never_empties_train():
    assert train_snapshot._rank_split({'page:only'}, 0.5) == set()
    assert len(train_snapshot._rank_split({'page:a', 'page:b', 'page:c'}, 1.0)) == 2


def test_holdout_splitter_routes_by_dataset_only():
    split = train_snapshot._holdout_splitter(['val-job'])
    assert split('train-job', 'line:1') == 'train'
    assert split('val-job', 'line:1') == 'val'


@pytest.fixture
def seeded(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path / 'trainings')
    conn = store.connect(tmp_path / 'app.db')
    scan = tmp_path / 'scan.png'
    Image.new('RGB', (400, 300), 'white').save(scan)
    conn.execute("INSERT INTO jobs (id, name) VALUES ('job1', 'Job')")
    conn.execute(
        "INSERT INTO pages (id, job_id, idx, filename, source_file, content_hash, width, height, "
        "status, layout_checked, lines_checked) VALUES (1, 'job1', 0, 'scan.png', ?, 'hash1', 400, 300, "
        "'done', 1, 1)", (str(scan),))
    conn.execute(
        "INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) "
        "VALUES (1, 1, 0, 'Paragraph', '[0.1, 0.1, 0.9, 0.9]', 'content')")
    poly = json.dumps([[0.1, 0.1], [0.9, 0.1], [0.9, 0.3], [0.1, 0.3]])
    conn.execute(
        'INSERT INTO lines (id, element_id, order_idx, polygon, text, corrected_text, checked) '
        "VALUES (1, 1, 0, ?, 'raw text', 'fixed text', 1)", (poly,))
    conn.execute(
        'INSERT INTO lines (id, element_id, order_idx, polygon, text, checked) '
        "VALUES (2, 1, 1, ?, 'unchecked text', 0)", (poly,))
    conn.commit()
    yield conn
    conn.close()


def seed_ocr_job(conn, job_id, page_id, scan, n_lines):
    conn.execute('INSERT INTO jobs (id, name) VALUES (?, ?)', (job_id, job_id))
    conn.execute(
        'INSERT INTO pages (id, job_id, idx, filename, source_file, content_hash, width, height, '
        "status, layout_checked, lines_checked) VALUES (?, ?, 0, 'scan.png', ?, ?, 400, 300, "
        "'done', 1, 1)", (page_id, job_id, str(scan), f'hash{page_id}'))
    conn.execute(
        'INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) '
        "VALUES (?, ?, 0, 'Paragraph', '[0.1, 0.1, 0.9, 0.9]', 'content')", (page_id, page_id))
    poly = json.dumps([[0.1, 0.1], [0.9, 0.1], [0.9, 0.3], [0.1, 0.3]])
    for i in range(n_lines):
        conn.execute(
            'INSERT INTO lines (element_id, order_idx, polygon, text, checked) '
            'VALUES (?, ?, ?, ?, 1)', (page_id, i, poly, f'text {i}'))
    conn.commit()


@pytest.fixture
def two_jobs(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path / 'trainings')
    conn = store.connect(tmp_path / 'app.db')
    scan = tmp_path / 'scan.png'
    Image.new('RGB', (400, 300), 'white').save(scan)
    seed_ocr_job(conn, 'jobA', 1, scan, 10)
    seed_ocr_job(conn, 'jobB', 2, scan, 4)
    yield conn
    conn.close()


def seed_ocr_pages(conn, job_id, scan, hashes, lines_per_page, first_page_id, first_line_id):
    conn.execute('INSERT INTO jobs (id, name) VALUES (?, ?)', (job_id, job_id))
    poly = json.dumps([[0.1, 0.1], [0.9, 0.1], [0.9, 0.3], [0.1, 0.3]])
    line_id = first_line_id
    for offset, content_hash in enumerate(hashes):
        page_id = first_page_id + offset
        conn.execute(
            'INSERT INTO pages (id, job_id, idx, filename, source_file, content_hash, width, '
            "height, status, layout_checked, lines_checked) VALUES (?, ?, ?, 'scan.png', ?, ?, "
            "400, 300, 'done', 1, 1)", (page_id, job_id, offset, str(scan), content_hash))
        conn.execute(
            'INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) '
            "VALUES (?, ?, 0, 'Paragraph', '[0.1, 0.1, 0.9, 0.9]', 'content')",
            (page_id, page_id))
        for i in range(lines_per_page):
            conn.execute(
                'INSERT INTO lines (id, element_id, order_idx, polygon, text, checked) '
                'VALUES (?, ?, ?, ?, ?, 1)', (line_id, page_id, i, poly, f'text {line_id}'))
            line_id += 1
    conn.commit()


def snapshot_sides(snapshot) -> dict[int, str]:
    return {int(p.stem.split('_')[1]): part
            for part in ('train', 'valid') for p in (snapshot / part).glob('*.txt')}


def test_identical_pages_across_datasets_never_straddle_the_split(tmp_path, monkeypatch):
    """The same scan ingested into two training datasets must land on one side of the
    split - otherwise the model validates on a page it trained on and the score lies."""
    monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path / 'trainings')
    conn = store.connect(tmp_path / 'app.db')
    scan = tmp_path / 'scan.png'
    Image.new('RGB', (400, 300), 'white').save(scan)
    seed_ocr_pages(conn, 'jobA', scan, ['h1', 'h2', 'h3', 'h4'], 2, first_page_id=1, first_line_id=1)
    # jobB holds a byte-identical copy of jobA's second page.
    seed_ocr_pages(conn, 'jobB', scan, ['h2'], 2, first_page_id=101, first_line_id=101)

    train_snapshot.build(conn, 9, 'ocr', ['jobA', 'jobB'], val_fraction=0.5)
    snapshot = tmp_path / 'trainings' / '9' / 'snapshot'
    # The manifest records each crop's dataset, so evaluations over the frozen
    # split can report per-dataset scores.
    manifest = json.loads((snapshot / 'manifest.json').read_text())
    assert manifest['line_3'] == 'jobA'
    assert manifest['line_101'] == 'jobB'
    assert len(manifest) == 10
    sides = snapshot_sides(snapshot)
    # jobA's h2 page holds lines 3-4; jobB's copy holds 101-102. One side for all four.
    assert len({sides[3], sides[4], sides[101], sides[102]}) == 1, 'twin pages split apart'
    # With four distinct pages at 50%, both sides are still populated.
    assert set(sides.values()) == {'train', 'valid'}
    conn.close()


def test_holdout_build_puts_the_validation_dataset_entirely_in_valid(two_jobs, tmp_path):
    counts = train_snapshot.build(two_jobs, 5, 'ocr', ['jobA'],
                                  split_strategy='holdout', valid_job_ids=['jobB'])
    assert counts == {'train': 10, 'val': 4}
    snapshot = tmp_path / 'trainings' / '5' / 'snapshot'
    # jobA lines have ids 1-10, jobB 11-14; no line may cross its dataset's side.
    train_ids = {int(p.stem.split('_')[1]) for p in (snapshot / 'train').glob('*.txt')}
    val_ids = {int(p.stem.split('_')[1]) for p in (snapshot / 'valid').glob('*.txt')}
    assert train_ids == set(range(1, 11))
    assert val_ids == set(range(11, 15))


def test_stratified_build_takes_the_exact_page_fraction_from_each_dataset(tmp_path, monkeypatch):
    """The split unit is the page, so a page's lines never straddle the split, and
    every dataset contributes exactly its rounded page fraction to valid."""
    monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path / 'trainings')
    conn = store.connect(tmp_path / 'app.db')
    scan = tmp_path / 'scan.png'
    Image.new('RGB', (400, 300), 'white').save(scan)
    seed_ocr_pages(conn, 'jobA', scan, ['a1', 'a2', 'a3', 'a4'], 2, first_page_id=1, first_line_id=1)
    seed_ocr_pages(conn, 'jobB', scan, ['b1', 'b2'], 2, first_page_id=101, first_line_id=101)

    counts = train_snapshot.build(conn, 6, 'ocr', ['jobA', 'jobB'],
                                  val_fraction=0.5, split_strategy='stratified')
    sides = snapshot_sides(tmp_path / 'trainings' / '6' / 'snapshot')
    # round(4 * 0.5) = 2 of jobA's pages (lines 1-8) and round(2 * 0.5) = 1 of jobB's
    # (lines 101-104) validate - counted in lines, that is 4 + 2.
    assert sum(1 for i, part in sides.items() if i <= 8 and part == 'valid') == 4
    assert sum(1 for i, part in sides.items() if i > 100 and part == 'valid') == 2
    assert counts == {'train': 6, 'val': 6}
    # Page atomicity: each page's two lines share a side.
    for first_line in (1, 3, 5, 7, 101, 103):
        assert sides[first_line] == sides[first_line + 1]
    conn.close()


def test_stratified_build_validates_on_at_least_one_page_of_each_dataset(tmp_path, monkeypatch):
    """A small fraction of a small dataset rounds to no page at all, which would leave
    that dataset unvalidated - unless it has a single page, which has to train."""
    monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path / 'trainings')
    conn = store.connect(tmp_path / 'app.db')
    scan = tmp_path / 'scan.png'
    Image.new('RGB', (400, 300), 'white').save(scan)
    seed_ocr_pages(conn, 'jobA', scan, ['a1', 'a2', 'a3'], 1, first_page_id=1, first_line_id=1)
    seed_ocr_pages(conn, 'jobB', scan, ['b1'], 1, first_page_id=101, first_line_id=101)

    counts = train_snapshot.build(conn, 6, 'ocr', ['jobA', 'jobB'],
                                  val_fraction=0.1, split_strategy='stratified')
    sides = snapshot_sides(tmp_path / 'trainings' / '6' / 'snapshot')
    assert sum(1 for i, part in sides.items() if i <= 3 and part == 'valid') == 1
    assert sides[101] == 'train'
    assert counts == {'train': 3, 'val': 1}
    conn.close()


def test_stratified_build_is_deterministic(two_jobs, tmp_path):
    first = train_snapshot.build(two_jobs, 7, 'ocr', ['jobA', 'jobB'],
                                 val_fraction=0.5, split_strategy='stratified')
    snapshot = tmp_path / 'trainings' / '7' / 'snapshot'
    first_val = {p.name for p in (snapshot / 'valid').glob('*.txt')}
    second = train_snapshot.build(two_jobs, 8, 'ocr', ['jobA', 'jobB'],
                                  val_fraction=0.5, split_strategy='stratified')
    second_val = {p.name for p in (tmp_path / 'trainings' / '8' / 'snapshot' / 'valid').glob('*.txt')}
    assert first == second
    assert first_val == second_val


def test_ocr_snapshot_exports_only_checked_lines_with_corrections(seeded, tmp_path):
    counts = train_snapshot.build(seeded, 1, 'ocr', ['job1'], val_fraction=0.1)
    assert counts['train'] + counts['val'] == 1
    snapshot = tmp_path / 'trainings' / '1' / 'snapshot'
    pairs = list(snapshot.glob('*/line_*.txt'))
    assert len(pairs) == 1
    # The human correction wins over the raw OCR text; unchecked lines are absent.
    assert pairs[0].read_text(encoding='utf-8') == 'fixed text'
    # The polygon spans 0.1-0.9 x 0.1-0.3 of the 400x300 scan; the crop must be the
    # real deskewed cutout in pixels, not a degenerate sliver from normalized coords.
    crop = Image.open(pairs[0].with_suffix('.png'))
    assert crop.size == (320, 74)


class TestMachineSettledLines:
    """A line language models agreed on carries check_source 'llm'. It counts as checked
    like any other, but a run that wants a corpus only people vouched for can leave it out.
    """

    def add_consensus_line(self, conn, poly):
        conn.execute(
            'INSERT INTO lines (id, element_id, order_idx, polygon, text, corrected_text, checked, '
            "check_source) VALUES (3, 1, 2, ?, 'machine text', 'models agreed', 1, 'llm')", (poly,))
        conn.commit()

    def test_by_default_a_settled_line_trains_like_any_other(self, seeded, tmp_path):
        poly = json.dumps([[0.1, 0.4], [0.9, 0.4], [0.9, 0.6], [0.1, 0.6]])
        self.add_consensus_line(seeded, poly)

        counts = train_snapshot.build(seeded, 1, 'ocr', ['job1'], val_fraction=0.0)

        assert counts == {'train': 2, 'val': 0}
        texts = sorted(p.read_text(encoding='utf-8')
                       for p in (tmp_path / 'trainings' / '1' / 'snapshot' / 'train').glob('*.txt'))
        assert texts == ['fixed text', 'models agreed']

    def test_a_run_may_train_only_on_what_people_verified(self, seeded, tmp_path):
        poly = json.dumps([[0.1, 0.4], [0.9, 0.4], [0.9, 0.6], [0.1, 0.6]])
        self.add_consensus_line(seeded, poly)

        counts = train_snapshot.build(seeded, 2, 'ocr', ['job1'], val_fraction=0.0,
                                      human_checked_only=True)

        assert counts == {'train': 1, 'val': 0}
        texts = [p.read_text(encoding='utf-8')
                 for p in (tmp_path / 'trainings' / '2' / 'snapshot' / 'train').glob('*.txt')]
        assert texts == ['fixed text']

    def test_a_dataset_of_nothing_but_settled_lines_contributes_nothing(self, seeded, tmp_path):
        """The split keys have to agree with the cut, or the run would validate on pages
        it never trained on."""
        seeded.execute("UPDATE lines SET check_source = 'llm' WHERE id = 1")
        seeded.commit()

        counts = train_snapshot.build(seeded, 3, 'ocr', ['job1'], val_fraction=0.0,
                                      human_checked_only=True)

        assert counts == {'train': 0, 'val': 0}


class TestDiplomaticMarkup:
    def test_a_marked_line_trains_on_the_line_as_it_now_reads(self, seeded, tmp_path):
        seeded.execute("UPDATE lines SET corrected_text = 'der <del>alte</del> Herr <add>Graf</add>' "
                       'WHERE id = 1')
        seeded.commit()

        counts = train_snapshot.build(seeded, 1, 'ocr', ['job1'], val_fraction=0.0)

        assert counts == {'train': 1, 'val': 0}
        texts = [p.read_text(encoding='utf-8')
                 for p in (tmp_path / 'trainings' / '1' / 'snapshot' / 'train').glob('*.txt')]
        assert texts == ['der Herr Graf']

    def test_a_line_struck_out_whole_trains_on_nothing(self, seeded, tmp_path):
        seeded.execute("UPDATE lines SET corrected_text = '<del>gestrichen</del>' WHERE id = 1")
        seeded.commit()

        counts = train_snapshot.build(seeded, 2, 'ocr', ['job1'], val_fraction=0.0)

        assert counts == {'train': 0, 'val': 0}


def test_a_lines_run_gets_the_contracts_page_lines(seeded, tmp_path):
    counts = train_snapshot.build(seeded, 7, 'lines', ['job1'], val_fraction=0.0)
    snap = tmp_path / 'trainings' / '7' / 'snapshot'
    [stem] = [p.stem for p in (snap / 'train' / 'images').glob('*.png')]
    lines = json.loads((snap / 'train' / 'lines' / f'{stem}.json').read_text())
    assert counts == {'train': 1, 'val': 0}
    assert (lines['width'], lines['height']) == (400, 300)
    # Every line of a line-verified page, in pixels, with the class of its element.
    assert lines['lines'] == [
        {'id': 1, 'polygon': [[40.0, 30.0], [360.0, 30.0], [360.0, 90.0], [40.0, 90.0]], 'element_class': 'Paragraph'},
        {'id': 2, 'polygon': [[40.0, 30.0], [360.0, 30.0], [360.0, 90.0], [40.0, 90.0]], 'element_class': 'Paragraph'}]
    assert not (snap / 'train' / 'instances').exists()
    # Which dataset each page came from, so a backend can score its run per dataset.
    assert json.loads((snap / 'manifest.json').read_text()) == {stem: 'job1'}


class TestTheShapeALineTrainsAs:
    """A line outlined step by step around its words, on the 400 x 300 page."""
    STAIRCASE = [[0.1, 0.5], [0.3, 0.5], [0.3, 0.45], [0.6, 0.45], [0.6, 0.6], [0.1, 0.6]]
    BOX = [[40.0, 135.0], [240.0, 135.0], [240.0, 180.0], [40.0, 180.0]]

    @pytest.fixture
    def staircase(self, seeded):
        seeded.execute('UPDATE lines SET polygon = ? WHERE id = 1', (json.dumps(self.STAIRCASE),))
        seeded.execute('DELETE FROM lines WHERE id = 2')
        seeded.commit()
        return seeded

    def contract_line(self, conn, tmp_path, **shape):
        train_snapshot.build(conn, 7, 'lines', ['job1'], val_fraction=0.0, **shape)
        snap = tmp_path / 'trainings' / '7' / 'snapshot' / 'train' / 'lines'
        [described] = snap.glob('*.json')
        return json.loads(described.read_text())['lines'][0]['polygon']

    def test_each_line_comes_in_the_shape_the_run_chose(self, staircase, tmp_path):
        assert self.contract_line(staircase, tmp_path, line_shape='box') == self.BOX

    def test_a_polygon_run_gets_the_outline_as_drawn(self, staircase, tmp_path):
        drawn = [[round(x * 400, 2), round(y * 300, 2)] for x, y in self.STAIRCASE]
        assert self.contract_line(staircase, tmp_path, line_shape='polygon') == drawn
        assert self.contract_line(staircase, tmp_path) == drawn


def test_a_layout_run_gets_the_contracts_page_boxes(seeded, tmp_path):
    counts = train_snapshot.build(seeded, 7, 'layout', ['job1'], val_fraction=0.0)
    snap = tmp_path / 'trainings' / '7' / 'snapshot'
    doc = json.loads((snap / 'train' / '_annotations.coco.json').read_text())
    assert counts == {'train': 1, 'val': 0}
    assert [(snap / 'train' / 'images' / img['file_name']).is_file() for img in doc['images']] == [True]
    assert [a['bbox'] for a in doc['annotations']] == [[40.0, 30.0, 320.0, 240.0]]
    # No roboflow test/ mirror: that is an RF-DETR entrypoint's to add.
    assert not (snap / 'test').exists()
    assert json.loads((snap / 'manifest.json').read_text()) == {
        Path(doc['images'][0]['file_name']).stem: 'job1'}


def add_test_dataset(conn, job_id='job2', page_id=2):
    """A second checked dataset of one test page, a copy of job1's page under its own content."""
    scan = conn.execute('SELECT source_file FROM pages WHERE id = 1').fetchone()[0]
    conn.execute('INSERT INTO jobs (id, name) VALUES (?, ?)', (job_id, job_id))
    conn.execute(
        'INSERT INTO pages (id, job_id, idx, filename, source_file, content_hash, width, height, '
        "status, layout_checked, lines_checked, is_test) VALUES (?, ?, 0, 'scan.png', ?, ?, 400, 300, 'done', 1, 1, 1)",
        (page_id, job_id, scan, f'hash{page_id}'))
    conn.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) "
                 "VALUES (?, ?, 0, 'Paragraph', '[0.1, 0.1, 0.9, 0.9]', 'content')", (page_id, page_id))
    conn.execute('INSERT INTO lines (element_id, order_idx, polygon, checked) VALUES (?, 0, ?, 1)',
                 (page_id, json.dumps([[0.1, 0.1], [0.9, 0.1], [0.9, 0.3], [0.1, 0.3]])))
    conn.commit()


class TestTestDatasetsOnABackend:
    """A layout or lines run's test datasets ride along as a test split, which its backend
    scores once trained - never trained on, never steering the run."""

    def test_a_lines_run_carries_them_as_its_test_split(self, seeded, tmp_path):
        add_test_dataset(seeded)

        counts = train_snapshot.build(seeded, 7, 'lines', ['job1'], val_fraction=0.0,
                                      test_job_ids=['job2'])

        snap = tmp_path / 'trainings' / '7' / 'snapshot'
        [test_stem] = [p.stem for p in (snap / 'test' / 'lines').glob('*.json')]
        assert counts == {'train': 1, 'val': 0, 'test': 1}
        assert (snap / 'test' / 'images' / f'{test_stem}.png').is_file()
        assert len(list((snap / 'train' / 'lines').glob('*.json'))) == 1
        assert json.loads((snap / 'manifest.json').read_text())[test_stem] == 'job2'

    def test_a_layout_run_carries_them_with_their_own_coco_file(self, seeded, tmp_path):
        add_test_dataset(seeded)

        counts = train_snapshot.build(seeded, 7, 'layout', ['job1'], val_fraction=0.0,
                                      test_job_ids=['job2'])

        snap = tmp_path / 'trainings' / '7' / 'snapshot'
        doc = json.loads((snap / 'test' / '_annotations.coco.json').read_text())
        assert counts == {'train': 1, 'val': 0, 'test': 1}
        assert [(snap / 'test' / 'images' / img['file_name']).is_file() for img in doc['images']] == [True]

    def test_a_dataset_both_trained_on_and_named_as_test_stays_training_material(self, seeded, tmp_path):
        counts = train_snapshot.build(seeded, 7, 'lines', ['job1'], val_fraction=0.0,
                                      test_job_ids=['job1'])

        assert counts == {'train': 1, 'val': 0}
        assert not (tmp_path / 'trainings' / '7' / 'snapshot' / 'test').exists()

    def test_an_ocr_run_scores_its_test_sets_itself_so_they_stay_out(self, seeded, tmp_path):
        add_test_dataset(seeded)

        counts = train_snapshot.build(seeded, 7, 'ocr', ['job1'], val_fraction=0.0,
                                      test_job_ids=['job2'])

        assert 'test' not in counts
