"""The dataset's page table, a screenful at a time.

The whole point is that the filter and the order are applied before the slice: asking for
the first page of unreviewed pages, in a volume whose first pages are all reviewed, must
answer with the unreviewed ones rather than with nothing.
"""
import pytest
from fastapi.testclient import TestClient

from app import page_rows, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    monkeypatch.setattr('app.config.BLOBS_DIR', tmp_path / 'blobs')
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript("""
        INSERT INTO jobs (id, name, owner, status, task) VALUES
            ('j1', 'Volume I', 'alice', 'done', 'text');
        -- Five live pages and one deleted. Page 1 is fully reviewed, 2 is half, 3 has no
        -- boxes at all, 4 has boxes but no lines, 5 has its layout unchecked.
        INSERT INTO pages (id, job_id, idx, filename, source_file, width, height, status,
                           layout_checked, deleted) VALUES
            (1, 'j1', 0, 'a.png', 'a.png', 600, 800, 'done', 1, 0),
            (2, 'j1', 1, 'b.png', 'b.png', 600, 800, 'done', 1, 0),
            (3, 'j1', 2, 'c.png', 'c.png', 400, 400, 'done', 1, 0),
            (4, 'j1', 3, 'd.png', 'd.png', 600, 800, 'done', 1, 0),
            (5, 'j1', 4, 'e.png', 'e.png', 600, 800, 'done', 0, 0),
            (6, 'j1', 5, 'gone.png', 'gone.png', 600, 800, 'done', 1, 1);
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind, checked, deleted) VALUES
            (1, 1, 0, 'text', '[]', 'content', 0, 0),
            (2, 2, 0, 'text', '[]', 'content', 0, 0),
            (4, 4, 0, 'text', '[]', 'content', 0, 0),
            (5, 5, 0, 'text', '[]', 'content', 0, 0);
        INSERT INTO lines (id, element_id, order_idx, polygon, text, checked, confidence, deleted) VALUES
            (1, 1, 0, '[]', 'one',   1, 0.9, 0),
            (2, 1, 1, '[]', 'two',   1, 0.8, 0),
            (3, 2, 0, '[]', 'three', 1, 0.7, 0),
            (4, 2, 1, '[]', 'four',  0, 0.4, 0),
            (5, 5, 0, '[]', 'five',  0, 0.6, 0);
        INSERT INTO llm_connections (id, owner, name, base_url) VALUES (1, 'alice', 'stub', 'http://x');
        INSERT INTO llm_models (id, connection_id, model, label) VALUES (1, 1, 'm', 'M');
        INSERT INTO candidates (page_id, source, text, dismissed, llm_model_id) VALUES
            (2, 'llm', 'a reading', 0, 1);
    """)
    connection.commit()
    yield connection
    connection.close()


@pytest.fixture
def client(conn, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()


def get(client, **params):
    return client.get('/api/jobs/j1/page-rows', params=params, headers=ALICE)


def test_a_row_carries_what_the_table_shows(client):
    body = get(client, limit=1).json()

    assert body['rows'] == [{
        'id': 1, 'idx': 0, 'filename': 'a.png', 'width': 600, 'height': 800,
        'status': 'done', 'layout_checked': True, 'lines_checked': False, 'deleted': False,
        'rotation': 0, 'is_test': False, 'note': None,
        'elements_total': 1, 'elements_checked': 1,
        'lines_total': 2, 'lines_reviewed': 2,
        'min_confidence': 0.8, 'avg_confidence': pytest.approx(0.85),
        'llm_models': 0,
        'regions_total': 0, 'regions_checked': 0,
    }]


def test_deleted_pages_are_not_in_the_default_view(client):
    body = get(client, limit=50).json()

    assert [r['id'] for r in body['rows']] == [1, 2, 3, 4, 5]
    assert body['matched'] == 5


def test_each_chip_says_how_many_it_would_show(client):
    counts = get(client, limit=1).json()['counts']

    assert counts == {
        'all': 5,
        # Page 1 has every line checked; page 3 has no lines, so there is nothing to have
        # reviewed and it does not count as reviewed.
        'lines-reviewed': 1,
        # Pages 1 to 4 are marked layout complete, whatever their lines say.
        'layout-reviewed': 4,
        # Pages 2 and 5 have unchecked lines. Pages 3 and 4 have no lines at all.
        'unreviewed-lines': 2,
        'layout-unchecked': 1,
        # Page 3 has no elements at all.
        'no-layout': 1, 'test-pages': 0, 'has-note': 0,
        'deleted': 1,
    }


def test_a_duplicate_is_not_left_waiting_for_a_review_it_cannot_have(client, conn):
    """Review is refused on a duplicate, so the to-do chip would never empty."""
    conn.execute("UPDATE pages SET status = 'duplicate' WHERE id = 5")
    conn.commit()

    body = get(client, filter='layout-unchecked').json()

    assert (body['rows'], body['counts']['layout-unchecked']) == ([], 0)
    assert [r['id'] for r in get(client, limit=50).json()['rows']] == [1, 2, 3, 4, 5]


def test_lines_reviewed_and_layout_reviewed_are_independent(client, conn):
    """Two chips with one rule each: a page whose lines are all checked is lines reviewed
    whether or not its layout is, and a layout marked complete says nothing of its lines."""
    conn.execute('UPDATE pages SET layout_checked = 0 WHERE id = 1')
    conn.commit()

    lines = get(client, filter='lines-reviewed', limit=50).json()
    layout = get(client, filter='layout-reviewed', limit=50).json()

    assert ([r['id'] for r in lines['rows']], lines['counts']['lines-reviewed']) == ([1], 1)
    assert ([r['id'] for r in layout['rows']], layout['counts']['layout-reviewed']) == ([2, 3, 4], 3)


def test_the_combined_reviewed_filter_is_gone_from_a_text_dataset(client):
    assert get(client, filter='reviewed').status_code == 400


def test_a_duplicate_is_listed_but_counted_by_no_chip(client, conn):
    """The same bytes uploaded twice are one page of work: the copy stays in the list,
    flagged by its status, and every count leaves it out."""
    conn.execute("INSERT INTO pages (id, job_id, idx, filename, source_file, status, "
                 "layout_checked, deleted) VALUES (7, 'j1', 6, 'a_again.png', 'a.png', "
                 "'duplicate', 0, 0)")
    conn.commit()

    body = get(client, limit=50).json()

    assert [(r['id'], r['status']) for r in body['rows']][-2:] == [(5, 'done'), (7, 'duplicate')]
    assert body['counts'] == {
        'all': 5, 'lines-reviewed': 1, 'layout-reviewed': 4, 'unreviewed-lines': 2,
        'layout-unchecked': 1, 'no-layout': 1, 'test-pages': 0, 'has-note': 0, 'deleted': 1}
    assert [r['id'] for r in get(client, filter='no-layout', limit=50).json()['rows']] == [3]
    job = client.get('/api/jobs/j1', params={'pages': 'false'}, headers=ALICE).json()
    assert job['pages_live'] == 5


def test_the_filter_is_applied_before_the_slice(client):
    """The whole reason this endpoint exists. Page 1 is reviewed and sorts first, so a
    filter applied after a limit of one would answer with an empty list."""
    body = get(client, filter='unreviewed-lines', limit=1).json()

    assert [r['id'] for r in body['rows']] == [2]
    assert body['matched'] == 2


def test_the_order_is_applied_before_the_slice(client):
    body = get(client, sort='confidence', limit=2).json()

    # Worst confidence first: page 2 has a 0.4 line, page 5 a 0.6, page 1 a 0.8.
    assert [r['id'] for r in body['rows']] == [2, 5]


def test_test_pages_sort_first_descending(client, conn):
    conn.execute('UPDATE pages SET is_test = 1 WHERE id = 5')
    conn.commit()

    assert [r['id'] for r in get(client, sort='test', desc=True, limit=2).json()['rows']] == [5, 1]


def test_a_descending_sort_turns_it_round(client):
    body = get(client, sort='confidence', desc=True, limit=3).json()

    # Best measured confidence first: page 1 at 0.8, page 5 at 0.6, page 2 at 0.4.
    assert [r['id'] for r in body['rows']] == [1, 5, 2]


def test_a_page_with_nothing_to_measure_sorts_last_either_way(client):
    """Pages 3 and 4 have no lines, so no confidence. SQLite would put them first on an
    ascending sort, which would open the worst-first view on the pages nobody has read."""
    up = [r['id'] for r in get(client, sort='confidence', limit=50).json()['rows']]
    down = [r['id'] for r in get(client, sort='confidence', desc=True, limit=50).json()['rows']]

    assert up == [2, 5, 1, 3, 4]
    assert down == [1, 5, 2, 3, 4]


def test_paging_walks_the_whole_set_without_repeating_a_row(client):
    seen = []
    for offset in (0, 2, 4):
        seen += [r['id'] for r in get(client, offset=offset, limit=2).json()['rows']]

    assert seen == [1, 2, 3, 4, 5]


def test_an_unknown_filter_is_refused_rather_than_ignored(client):
    r = get(client, filter='nonsense')

    assert r.status_code == 400
    assert 'filter must be one of' in r.json()['detail']


def test_an_unknown_sort_is_refused_rather_than_ignored(client):
    r = get(client, sort='nonsense')

    assert r.status_code == 400


def test_anyone_who_may_edit_sees_the_deleted_pages_a_viewer_does_not(client):
    assert [r['id'] for r in get(client, filter='deleted').json()['rows']] == [6]

    admin = client.get('/api/jobs/j1/page-rows', params={'filter': 'deleted'}, headers=ADMIN)
    assert [r['id'] for r in admin.json()['rows']] == [6]

    viewer = {**ALICE, 'X-Auth-Role': 'viewer'}
    assert client.get('/api/jobs/j1/page-rows', params={'filter': 'deleted'},
                      headers=viewer).status_code == 403


def test_a_dataset_the_caller_cannot_reach_is_a_404(client, conn):
    conn.execute("INSERT INTO jobs (id, name, owner, status, task) "
                 "VALUES ('j9', 'Not hers', 'carol', 'done', 'text')")
    conn.commit()

    assert client.get('/api/jobs/j9/page-rows', headers=ALICE).status_code == 404


def test_the_limit_is_capped_rather_than_honoured(client):
    body = get(client, limit=10_000).json()

    assert body['limit'] == page_rows.MAX_LIMIT


def test_the_detail_endpoint_can_leave_the_page_list_out(client):
    """The table reads its rows a screenful at a time now, so the caller that opens a
    dataset does not need 10 MB of pages it will not render."""
    with_pages = client.get('/api/jobs/j1', headers=ALICE).json()
    without = client.get('/api/jobs/j1', params={'pages': 'false'}, headers=ALICE).json()

    assert len(with_pages['pages']) == 6, 'deleted pages are in the list for the Deleted chip'
    assert 'pages' not in without
    # Everything read off the list is still answered, so nothing has to fetch it to count.
    assert with_pages['pages_checked'] == without['pages_checked'] == 1
    assert with_pages['pages_live'] == without['pages_live'] == 5


def test_without_the_page_list_no_per_page_figure_is_computed(client, conn):
    """The header polls this every five seconds; the per-page roll-ups only feed the list."""
    with_pages = client.get('/api/jobs/j1', headers=ALICE).json()
    statements = []
    conn.set_trace_callback(statements.append)
    try:
        without = client.get('/api/jobs/j1', params={'pages': 'false'}, headers=ALICE).json()
    finally:
        conn.set_trace_callback(None)

    assert without == {k: v for k, v in with_pages.items() if k != 'pages'}
    assert [s for s in statements if 'FROM candidates' in s or 'min(l.confidence)' in s] == []
    assert any('FROM jobs WHERE id' in s for s in statements)


def test_a_map_dataset_counts_its_regions(client, conn):
    """A tile has regions where a page has lines, and the table counts those instead."""
    conn.executescript("""
        INSERT INTO job_classes (job_id, class_id, name, color, priority_rank)
            VALUES ('j1', 1, 'water', '[0,0,255]', 0);
        INSERT INTO regions (page_id, order_idx, class_id, points, checked, deleted) VALUES
            (1, 0, 1, '[]', 1, 0),
            (1, 1, 1, '[]', 0, 0),
            (1, 2, 1, '[]', 1, 1);
    """)
    conn.commit()

    row = next(r for r in get(client, limit=50).json()['rows'] if r['id'] == 1)

    assert row['regions_total'] == 2, 'the deleted region is not counted'
    assert row['regions_checked'] == 1


def test_a_turned_page_says_so(client, conn):
    """Renditions are served immutable, so the table needs the turn to give a turned page's
    pictures an address of their own - or the browser keeps showing the old way up."""
    conn.execute('UPDATE pages SET rotation = 90 WHERE id = 1')
    conn.commit()

    turns = {r['id']: r['rotation'] for r in get(client, limit=50).json()['rows']}

    assert turns == {1: 90, 2: 0, 3: 0, 4: 0, 5: 0}


def test_a_reviewed_tile_counts_as_reviewed(client, conn):
    """A tile has no boxes and no lines: the Reviewed toggle in the tile editor writes
    pages.layout_checked, and that flag alone is its review. The text dataset's filter wants
    checked elements or lines, which a tile never has, so it matched no tile at all."""
    conn.executescript("""
        INSERT INTO jobs (id, name, owner, status, task) VALUES
            ('m1', 'Tiles', 'alice', 'done', 'map_segmentation');
        INSERT INTO pages (id, job_id, idx, filename, source_file, width, height, status,
                           layout_checked, deleted) VALUES
            (11, 'm1', 0, 'tile_1.png', 'tile_1.png', 512, 512, 'done', 1, 0),
            (12, 'm1', 1, 'tile_2.png', 'tile_2.png', 512, 512, 'done', 0, 0);
    """)
    conn.commit()

    body = client.get('/api/jobs/m1/page-rows', params={'filter': 'reviewed'}, headers=ALICE).json()

    assert ([r['id'] for r in body['rows']], body['matched']) == ([11], 1)
    assert body['counts']['reviewed'] == 1
    assert body['counts']['layout-unchecked'] == 1


def test_the_counts_are_held_across_a_change_to_another_dataset(conn):
    """The chips are recounted when their own dataset moves, not whenever any line in the
    deployment does. The write the stamp cannot see on j1 shows whether j1 was recounted."""
    conn.executescript("""
        INSERT INTO jobs (id, name, owner, status, task) VALUES ('j2', 'Volume II', 'alice', 'done', 'text');
        INSERT INTO pages (id, job_id, idx, filename, source_file, status) VALUES
            (20, 'j2', 0, 'z.png', 'z.png', 'done');
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) VALUES
            (20, 20, 0, 'text', '[]', 'content');
    """)
    conn.commit()
    assert page_rows.counts(conn, 'j1', task='text')['layout-reviewed'] == 4
    conn.execute('UPDATE pages SET layout_checked = 0 WHERE id = 1')
    conn.execute("INSERT INTO lines (element_id, order_idx, polygon, text) VALUES (20, 0, '[]', 'j2')")
    conn.commit()

    assert page_rows.counts(conn, 'j1', task='text')['layout-reviewed'] == 4

    conn.execute("INSERT INTO lines (element_id, order_idx, polygon, text) VALUES (5, 1, '[]', 'j1')")
    conn.commit()

    assert page_rows.counts(conn, 'j1', task='text')['layout-reviewed'] == 3, (
        'a change to j1 itself is counted again')


def test_a_filtered_screen_takes_its_total_from_the_chips(client, conn):
    """The chips already count every filter, and they are held; counting the filtered set
    a second time per screen walks every page of the dataset again for the same number."""
    get(client, filter='unreviewed-lines')
    seen = []
    conn.set_trace_callback(seen.append)
    try:
        body = get(client, filter='unreviewed-lines').json()
    finally:
        conn.set_trace_callback(None)

    assert (body['matched'], body['counts']['unreviewed-lines']) == (2, 2)
    assert [sql for sql in seen if sql.startswith('SELECT COUNT(*) c FROM')] == []
    assert any(sql.startswith('SELECT * FROM') for sql in seen), 'the rows are still read'
