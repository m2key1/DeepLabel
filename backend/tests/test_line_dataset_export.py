"""The line-detection dataset derived from reviewed pages, and the sync that keeps both
COCO exports up to date as people review.

The line dataset's images are element crops and its polygons are in crop space, so the one
thing worth testing hard is that the coordinates survive the change of frame: a polygon
written in page coordinates would train the detector on nothing.
"""
import json

import pytest
from PIL import Image

from app import coco_lines, dataset_sync, store
from app.coco import ANNOTATION_FILE


def quad(x0, y0, x1, y1):
    return json.dumps([[x0, y0], [x1, y0], [x1, y1], [x0, y1]])


@pytest.fixture
def scan(tmp_path):
    path = tmp_path / 'p1.png'
    Image.new('RGB', (400, 200), 'white').save(path)
    return path


@pytest.fixture
def conn(tmp_path, scan, monkeypatch):
    monkeypatch.setattr('app.config.COCO_EXPORT_DIR', tmp_path / 'coco')
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript(f"""
        INSERT INTO jobs (id, name, owner, status, task) VALUES ('j1', 'Volume', 'alice', 'done', 'text');
        INSERT INTO pages (id, job_id, idx, filename, source_file, status, width, height,
                           content_hash, lines_checked, layout_checked)
            VALUES (1, 'j1', 0, 'p1.png', '{scan}', 'done', 400, 200, 'abcdef0123', 1, 1);
        INSERT INTO elements (id, page_id, order_idx, class_name, raw_class_name, bbox, kind)
            VALUES (1, 1, 0, 'Paragraph', 'Paragraph', '[0.25,0.5,0.75,1.0]', 'content');
        INSERT INTO lines (id, element_id, order_idx, polygon)
            VALUES (1, 1, 0, '{quad(0.3, 0.6, 0.7, 0.7)}');
    """)
    connection.commit()
    yield connection
    connection.close()


class TestWhatGoesIn:
    def test_each_reviewed_element_becomes_one_training_image(self, conn):
        dataset, manifest = coco_lines.collect(conn, 'j1')

        assert manifest == {'pages': 1, 'skipped_lines': 0, 'images': 1, 'annotations': 1}
        assert dataset['doc']['images'][0]['width'] == 200, 'half of a 400px page'
        assert dataset['doc']['images'][0]['height'] == 100

    def test_the_polygon_is_written_in_the_crops_own_coordinates(self, conn):
        """The element starts at x=0.25 of a 400px page, so its crop begins at 100px; a
        line at x=0.3 of the page is at 20px inside the crop, not 120."""
        dataset, _ = coco_lines.collect(conn, 'j1')

        segmentation = dataset['doc']['annotations'][0]['segmentation'][0]
        assert segmentation[0] == pytest.approx(20.0)
        assert segmentation[1] == pytest.approx(20.0), 'y=0.6 of 200px, crop starts at 100px'

    def test_the_box_and_area_describe_the_same_polygon(self, conn):
        annotation = coco_lines.collect(conn, 'j1')[0]['doc']['annotations'][0]

        assert annotation['bbox'] == [20.0, 20.0, 160.0, 20.0]
        assert annotation['area'] == pytest.approx(160.0 * 20.0)

    def test_a_page_nobody_has_reviewed_is_not_in_it(self, conn):
        conn.execute('UPDATE pages SET lines_checked = 0')
        conn.commit()

        assert coco_lines.collect(conn, 'j1')[1]['pages'] == 0

    def test_an_element_with_no_lines_is_not_an_image(self, conn):
        conn.execute('UPDATE lines SET deleted = 1')
        conn.commit()

        assert coco_lines.collect(conn, 'j1')[1]['images'] == 0

    def test_a_line_too_thin_to_train_on_is_counted_rather_than_written(self, conn):
        conn.execute('UPDATE lines SET polygon = ? WHERE id = 1',
                     (quad(0.3, 0.6, 0.3001, 0.6001),))
        conn.commit()

        _, manifest = coco_lines.collect(conn, 'j1')

        assert (manifest['annotations'], manifest['skipped_lines']) == (0, 1)

    def test_a_polygon_reaching_past_its_crop_is_clamped_to_it(self, conn):
        conn.execute('UPDATE lines SET polygon = ? WHERE id = 1', (quad(0.1, 0.6, 0.9, 0.7),))
        conn.commit()

        segmentation = coco_lines.collect(conn, 'j1')[0]['doc']['annotations'][0]['segmentation'][0]

        assert min(segmentation[::2]) >= 0.0
        assert max(segmentation[::2]) <= 200.0, 'the crop is 200px wide'

    def test_a_container_is_not_a_training_image(self, conn):
        conn.execute("UPDATE elements SET kind = 'container' WHERE id = 1")
        conn.commit()

        assert coco_lines.collect(conn, 'j1')[1]['images'] == 0


class TestWriting:
    def test_the_crops_are_cut_and_the_annotations_written(self, conn, tmp_path):
        dataset, _ = coco_lines.collect(conn, 'j1')
        dest = tmp_path / 'out'

        coco_lines.write(dataset, dest)

        assert (dest / ANNOTATION_FILE).exists()
        crops = [p for p in dest.iterdir() if p.suffix == '.jpg']
        assert len(crops) == 1
        with Image.open(crops[0]) as img:
            assert img.size == (200, 100)

    def test_a_file_no_longer_wanted_is_pruned(self, conn, tmp_path):
        dest = tmp_path / 'out'
        dest.mkdir()
        (dest / 'stale.jpg').write_bytes(b'old')
        (dest / 'valid').mkdir()

        coco_lines.write(coco_lines.collect(conn, 'j1')[0], dest)

        assert not (dest / 'stale.jpg').exists()
        assert not (dest / 'valid').exists(), 'including an old split directory'

    def test_a_source_that_has_gone_is_skipped_rather_than_fatal(self, conn, tmp_path, scan):
        dataset, _ = coco_lines.collect(conn, 'j1')
        scan.unlink()

        coco_lines.write(dataset, tmp_path / 'out')

        assert (tmp_path / 'out' / ANNOTATION_FILE).exists()

    def test_the_annotations_are_replaced_atomically(self, conn, tmp_path):
        """Written to a temp name and moved, so a reader never sees half a file."""
        dest = tmp_path / 'out'
        coco_lines.write(coco_lines.collect(conn, 'j1')[0], dest)

        assert [p.name for p in dest.iterdir() if p.suffix == '.tmp'] == []
        assert json.loads((dest / ANNOTATION_FILE).read_text())['categories'][0]['name'] == 'Line'


class TestKeepingBothExportsCurrent:
    def test_reviewing_a_dataset_rebuilds_both_of_them(self, conn, tmp_path):
        result = dataset_sync.sync_job(conn, 'j1')

        assert result['layout']['pages'] == 1
        assert result['lines']['pages'] == 1
        assert (tmp_path / 'coco' / 'volume' / ANNOTATION_FILE).exists()
        assert (tmp_path / 'coco' / 'volume-lines' / ANNOTATION_FILE).exists()

    def test_a_dataset_nobody_has_reviewed_prunes_nothing_away(self, conn, tmp_path):
        """An all-unchecked state must never delete an export that was built earlier."""
        dataset_sync.sync_job(conn, 'j1')
        conn.execute('UPDATE pages SET layout_checked = 0, lines_checked = 0')
        conn.commit()

        dataset_sync.sync_job(conn, 'j1')

        assert (tmp_path / 'coco' / 'volume' / ANNOTATION_FILE).exists()
        assert (tmp_path / 'coco' / 'volume-lines' / ANNOTATION_FILE).exists()

    def test_a_map_dataset_never_leaks_into_the_text_exports(self, conn, tmp_path):
        """Map tiles reuse layout_checked as a reviewed flag; they are not layout data."""
        conn.execute("UPDATE jobs SET task = 'map_segmentation' WHERE id = 'j1'")
        conn.commit()

        assert dataset_sync.sync_job(conn, 'j1') is None
        assert not (tmp_path / 'coco').exists()

    def test_a_dataset_that_does_not_exist_syncs_nothing(self, conn):
        assert dataset_sync.sync_job(conn, 'nope') is None

    def test_the_backfill_queues_every_reviewed_dataset(self, conn, tmp_path, monkeypatch):
        monkeypatch.setattr('app.config.DB_PATH', tmp_path / 'app.db')

        dataset_sync.backfill()

        assert dataset_sync._queue.get_nowait() == 'j1'
