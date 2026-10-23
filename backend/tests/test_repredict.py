"""The re-predict preview splits a job's regions into what a re-run discards (still
model-authored) and what it keeps (human-touched). Every region must land in exactly one
bucket, or the dialog under-reports what the user is about to lose or keep.
"""
import pytest

from app import store
from app.routes import maps


@pytest.fixture
def conn(tmp_path):
    connection = store.connect(tmp_path / 'app.db')
    connection.execute("INSERT INTO jobs (id, name, owner, task, status) "
                       "VALUES ('j', 'maps', 'alice', 'map_segmentation', 'done')")
    connection.execute(
        "INSERT INTO pages (job_id, idx, filename, source_file, status, width, height) "
        "VALUES ('j', 0, 't.png', '/nonexistent.png', 'done', 512, 512)")
    yield connection
    connection.close()


def add_region(conn, author: str | None) -> int:
    """A region on the job's tile, optionally with one revision by `author`.
    author=None leaves it with no revision history at all."""
    page_id = conn.execute("SELECT id FROM pages WHERE job_id = 'j'").fetchone()['id']
    rid = conn.execute(
        'INSERT INTO regions (page_id, order_idx, class_id, points, holes, kind) '
        "VALUES (?, 0, 1, '[[0.1,0.1],[0.2,0.1],[0.2,0.2]]', '[]', 'polygon')", (page_id,)).lastrowid
    if author is not None:
        store.log_region(conn, rid, author, 'create')
    conn.commit()
    return rid


def test_model_authored_regions_are_discarded(conn):
    add_region(conn, 'model:mapseg@ckpt.pth')
    scope = maps._repredict_scope(conn, 'j', force=False)
    assert (scope['regions_discard'], scope['regions_kept']) == (1, 0)


def test_human_edited_regions_are_kept(conn):
    add_region(conn, 'alice')
    scope = maps._repredict_scope(conn, 'j', force=False)
    assert (scope['regions_discard'], scope['regions_kept']) == (0, 1)


def test_a_region_without_revisions_counts_as_kept(conn):
    """NULL LIKE and NULL NOT LIKE are both falsy in SQL, so an unlogged region used to
    fall out of both counts while the re-predict itself still kept it - the preview
    silently under-reported. Nothing writes such a region today; the arithmetic must
    hold anyway, since it is what the user is shown before destroying annotations."""
    add_region(conn, None)
    scope = maps._repredict_scope(conn, 'j', force=False)
    assert (scope['regions_discard'], scope['regions_kept']) == (0, 1)


def test_every_region_lands_in_exactly_one_bucket(conn):
    add_region(conn, 'model:mapseg@ckpt.pth')
    add_region(conn, 'alice')
    add_region(conn, None)
    scope = maps._repredict_scope(conn, 'j', force=False)
    assert scope['regions_discard'] + scope['regions_kept'] == 3
