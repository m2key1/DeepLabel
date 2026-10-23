"""What an evaluation holds while it is scored. A 30,426-line split opened all at once
reached 54 GB and was killed by the kernel, twice, so the property under test is not what
comes out but how much is alive at any moment.
"""
import json

import pytest
from PIL import Image

from app import store
from app import eval_material


def crop(path, text, width=200, height=48):
    Image.new('RGB', (width, height), 'white').save(path)
    path.with_suffix('.txt').write_text(text, encoding='utf-8')


@pytest.fixture
def snapshot(tmp_path):
    valid = tmp_path / 'valid'
    valid.mkdir(parents=True)
    for i in range(7):
        crop(valid / f'line_{i:02d}.png', f'line {i}')
    (tmp_path / 'manifest.json').write_text(
        json.dumps({f'line_{i:02d}': 'volume-a' if i < 4 else 'volume-b' for i in range(7)}))
    return tmp_path


class TestTheFrozenSplit:
    def test_each_crop_names_the_line_it_was_cut_from(self, snapshot):
        seen = [(item.line_id, item.page_id)
                for batch in eval_material.snapshot_batches(snapshot) for item in batch]

        assert seen == [(i, None) for i in range(7)]

    def test_every_crop_is_handed_over_once_with_its_text_and_dataset(self, snapshot):
        seen = [(text, group) for batch in eval_material.snapshot_batches(snapshot, held=3)
                for _, text, group, *_ in batch]

        assert seen == [('line 0', 'volume-a'), ('line 1', 'volume-a'), ('line 2', 'volume-a'),
                        ('line 3', 'volume-a'), ('line 4', 'volume-b'), ('line 5', 'volume-b'),
                        ('line 6', 'volume-b')]

    def test_no_batch_is_larger_than_it_may_hold(self, snapshot):
        sizes = [len(batch) for batch in eval_material.snapshot_batches(snapshot, held=3)]

        assert sizes == [3, 3, 1]

    def test_taking_one_batch_opens_one_batch(self, snapshot, monkeypatch):
        """The regression itself: the old walk opened all 30,426 before scoring any."""
        opened = []
        real = Image.open
        monkeypatch.setattr(Image, 'open', lambda path, *a, **k: opened.append(path) or real(path))

        batches = eval_material.snapshot_batches(snapshot, held=3)
        next(batches)

        assert len(opened) == 3, 'the rest of the split is still on disk'

    def test_a_text_with_no_crop_beside_it_is_skipped(self, snapshot):
        (snapshot / 'valid' / 'orphan.txt').write_text('no image for this one')

        texts = [text for batch in eval_material.snapshot_batches(snapshot) for _, text, *_ in batch]

        assert 'no image for this one' not in texts

    def test_a_snapshot_cut_before_manifests_still_scores(self, snapshot):
        (snapshot / 'manifest.json').unlink()

        groups = {group for batch in eval_material.snapshot_batches(snapshot) for _, _, group, *_ in batch}

        assert groups == {''}


@pytest.fixture
def conn(tmp_path):
    page = tmp_path / 'page.png'
    Image.new('RGB', (400, 200), 'white').save(page)
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript(f"""
        INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'Volume', 'alice', 'done');
        INSERT INTO pages (id, job_id, idx, filename, source_file, status)
            VALUES (1, 'j1', 0, 'p.png', '{page}', 'done');
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind)
            VALUES (1, 1, 0, 'Paragraph', '[0,0,1,1]', 'content');
        INSERT INTO lines (id, element_id, order_idx, polygon, text, corrected_text, checked)
            VALUES (1, 1, 0, '[[0.1,0.1],[0.9,0.1],[0.9,0.3],[0.1,0.3]]', 'read', NULL, 1),
                   (2, 1, 1, '[[0.1,0.4],[0.9,0.4],[0.9,0.6],[0.1,0.6]]', 'read', 'corrected', 1),
                   (3, 1, 2, '[[0.1,0.7],[0.9,0.7],[0.9,0.9],[0.1,0.9]]', 'unchecked', NULL, 0);
    """)
    connection.commit()
    yield connection
    connection.close()


def test_a_frozen_crop_whose_line_still_exists_is_described_as_a_live_one_is(snapshot, conn):
    """A model backend may read by what it is told of a line; the split's crops are told
    the same as the dataset's, so one line is read alike whichever material scores it."""
    contexts = {item.line_id: item.context for batch in eval_material.snapshot_batches(snapshot, conn=conn)
                for item in batch}

    assert contexts[2] == {'element_class': 'Paragraph', 'line_index': 1}
    assert contexts[5] is None


class TestALiveDataset:
    def test_each_line_carries_its_id_and_page(self, conn):
        seen = [(item.line_id, item.page_id)
                for batch in eval_material.job_batches(conn, ['j1']) for item in batch]

        assert seen == [(1, 1), (2, 1)]

    def test_only_checked_lines_are_scored_and_a_correction_is_the_reference(self, conn):
        seen = [(text, group) for batch in eval_material.job_batches(conn, ['j1'])
                for _, text, group, *_ in batch]

        assert seen == [('read', 'j1'), ('corrected', 'j1')]

    def test_a_dataset_with_nothing_checked_yields_nothing(self, conn):
        conn.execute('UPDATE lines SET checked = 0')
        conn.commit()

        assert list(eval_material.job_batches(conn, ['j1'])) == []

    def test_the_page_is_opened_once_however_many_lines_it_has(self, conn, monkeypatch):
        opened = []
        real = Image.open
        monkeypatch.setattr(Image, 'open', lambda path, *a, **k: opened.append(path) or real(path))

        list(eval_material.job_batches(conn, ['j1']))

        assert len(opened) == 1, 'two checked lines, one page read'

    def test_a_person_only_run_scores_none_of_what_models_settled(self, conn):
        conn.execute("UPDATE lines SET check_source = 'llm' WHERE id = 1")
        conn.commit()

        seen = [(text, group) for batch in eval_material.job_batches(
            conn, ['j1'], human_checked_only=True) for _, text, group, *_ in batch]
        everything = [text for batch in eval_material.job_batches(conn, ['j1'])
                      for _, text, *_ in batch]

        assert seen == [('corrected', 'j1')]
        assert everything == ['read', 'corrected']
