"""Reading order on a page with no layout boxes. Every fixture is a page drawn in
normalized coordinates, so the expected order can be read off the picture in the
comment rather than taken from what the code happens to do.
"""
import json

import pytest
from fastapi.testclient import TestClient

from app import geometry, reading_order, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}


def line(x0, x1, y):
    """A line as a rectangle - only its extents and its height are read."""
    return [[x0, y], [x1, y], [x1, y + 0.02], [x0, y + 0.02]]


# One leaf, two columns, four lines each. The left column's lines sit at the same
# heights as the right column's, which is what makes sorting by y alone wrong.
#   0 4      col 1: 0 1 2 3 at x 0.08-0.45
#   1 5      col 2: 4 5 6 7 at x 0.55-0.92
#   2 6
#   3 7
TWO_COLUMNS = (
    [line(0.08, 0.45, 0.10 + 0.08 * i) for i in range(4)]
    + [line(0.55, 0.92, 0.10 + 0.08 * i) for i in range(4)]
)


class TestOneColumn:
    def test_lines_are_read_down_the_page(self):
        page = [line(0.1, 0.9, 0.5), line(0.1, 0.9, 0.2), line(0.1, 0.9, 0.35)]

        assert reading_order.order(page, pages=1, columns=1) == [1, 2, 0]

    def test_a_page_with_one_line_or_none_is_already_in_order(self):
        assert reading_order.order([], 1, 1) == []
        assert reading_order.order([line(0.1, 0.9, 0.2)], 1, 1) == [0]


class TestTwoColumns:
    def test_a_column_is_read_out_before_the_next_one_starts(self):
        assert reading_order.order(TWO_COLUMNS, pages=1, columns=2) == [0, 1, 2, 3, 4, 5, 6, 7]

    def test_sorting_by_height_alone_is_what_this_replaces(self):
        """The same page told it is one column comes out interleaved - the bug."""
        assert reading_order.order(TWO_COLUMNS, pages=1, columns=1) == [0, 4, 1, 5, 2, 6, 3, 7]

    def test_a_heading_across_both_is_read_before_either(self):
        page = [line(0.05, 0.95, 0.04), *TWO_COLUMNS]

        assert reading_order.order(page, pages=1, columns=2) == [0, 1, 2, 3, 4, 5, 6, 7, 8]

    def test_a_line_across_both_separates_what_is_above_it_from_what_is_below(self):
        #   0 2      col 1 / col 2 above the rule
        #   ===  3   a rule across the page
        #   4 5      and the columns start again under it
        page = [
            line(0.08, 0.45, 0.10), line(0.08, 0.45, 0.40),
            line(0.55, 0.92, 0.10), line(0.05, 0.95, 0.25),
            line(0.55, 0.92, 0.40),
        ]

        assert reading_order.order(page, pages=1, columns=2) == [0, 2, 3, 1, 4]

    def test_a_third_column_that_is_not_there_does_not_invent_a_cut(self):
        assert reading_order.order(TWO_COLUMNS, pages=1, columns=3) == [0, 1, 2, 3, 4, 5, 6, 7]


class TestThreeColumns:
    def test_each_is_read_out_in_turn(self):
        page = [
            line(0.05, 0.30, 0.2), line(0.05, 0.30, 0.4),
            line(0.37, 0.62, 0.2), line(0.37, 0.62, 0.4),
            line(0.69, 0.94, 0.2), line(0.69, 0.94, 0.4),
        ]

        assert reading_order.order(page, pages=1, columns=3) == [0, 1, 2, 3, 4, 5]


class TestTwoLeaves:
    # An open book: two leaves, one column each, the fold at 0.5.
    SPREAD = (
        [line(0.06, 0.44, 0.15 + 0.1 * i) for i in range(3)]
        + [line(0.56, 0.94, 0.15 + 0.1 * i) for i in range(3)]
    )

    def test_the_left_leaf_is_finished_before_the_right_one_begins(self):
        assert reading_order.order(self.SPREAD, pages=2, columns=1) == [0, 1, 2, 3, 4, 5]

    def test_two_columns_on_each_leaf_are_read_leaf_by_leaf(self):
        page = [
            line(0.04, 0.23, 0.2), line(0.27, 0.46, 0.2),   # left leaf, two columns
            line(0.54, 0.73, 0.2), line(0.77, 0.96, 0.2),   # right leaf, two columns
        ]

        assert reading_order.order(page, pages=2, columns=2) == [0, 1, 2, 3]

    def test_a_heading_across_the_fold_belongs_to_neither_leaf(self):
        page = [line(0.06, 0.94, 0.04), *self.SPREAD]

        assert reading_order.order(page, pages=2, columns=1) == [0, 1, 2, 3, 4, 5, 6]

    def test_a_leaf_that_is_blank_is_simply_not_there(self):
        page = [line(0.06, 0.44, 0.15 + 0.1 * i) for i in range(3)]

        assert reading_order.order(page, pages=2, columns=1) == [0, 1, 2]


class TestWorkingItOut:
    def test_two_columns_are_recognised_from_the_channel_between_them(self):
        assert reading_order.detect(TWO_COLUMNS) == (1, 2)

    def test_an_open_book_of_single_columns_reads_the_same_as_a_two_column_page(self):
        """Because it is the same picture: one channel, down the middle. Auto calls it
        columns, and the order that comes out is the one the fold would have given -
        which is why only a person who has seen the volume needs to say which it is."""
        spread = list(TestTwoLeaves.SPREAD)

        assert reading_order.detect(spread) == (1, 2)
        assert reading_order.order(spread, *reading_order.detect(spread)) == \
            reading_order.order(spread, pages=2, columns=1)

    def test_a_fold_is_claimed_only_when_each_leaf_has_columns_of_its_own(self):
        #  | 0 | 1 ‖ 2 | 3 |   two leaves, two columns each
        page = [
            line(0.03, 0.22, 0.2), line(0.27, 0.46, 0.2),
            line(0.54, 0.73, 0.2), line(0.78, 0.97, 0.2),
            line(0.03, 0.22, 0.4), line(0.27, 0.46, 0.4),
            line(0.54, 0.73, 0.4), line(0.78, 0.97, 0.4),
        ]

        assert reading_order.detect(page) == (2, 2)

    def test_a_page_set_solid_has_one_column(self):
        page = [line(0.08, 0.92, 0.1 + 0.06 * i) for i in range(8)]

        assert reading_order.detect(page) == (1, 1)

    def test_a_ragged_right_margin_is_not_a_column_boundary(self):
        page = [line(0.08, 0.92 - 0.02 * i, 0.1 + 0.06 * i) for i in range(8)]

        assert reading_order.detect(page) == (1, 1)

    def test_too_few_lines_to_tell_is_one_column(self):
        assert reading_order.detect([line(0.1, 0.4, 0.2), line(0.6, 0.9, 0.2)]) == (1, 1)


class TestTheSetting:
    def test_a_structure_is_read_as_leaves_by_columns(self):
        assert reading_order.parse('2x3') == (2, 3)
        assert reading_order.parse('1x1') == (1, 1)

    def test_auto_and_nonsense_both_mean_work_it_out(self):
        assert reading_order.parse('auto') is None
        assert reading_order.parse(None) is None
        assert reading_order.parse('') is None
        assert reading_order.parse('4x9') is None

    def test_what_the_dataset_says_beats_what_the_page_looks_like(self):
        # The page looks like two columns; told it is one, it is read as one.
        assert reading_order.resolve(TWO_COLUMNS, '1x1') == (1, 1)
        assert reading_order.resolve(TWO_COLUMNS, 'auto') == (1, 2)


@pytest.fixture
def conn(tmp_path, monkeypatch):
    """One page of two columns, its lines in the bucket a page without layout keeps them
    in. Written in the interleaved order a y-sort produces, which is what the dataset's
    answer has to put right."""
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript("""
        INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'Volume', 'root', 'done');
        INSERT INTO pages (id, job_id, idx, filename, source_file, status)
            VALUES (1, 'j1', 0, 'p1.png', '/p1.png', 'done');
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind)
            VALUES (1, 1, 0, 'Unassigned', '[0,0,1,1]', 'orphan');
    """)
    for i, poly in enumerate([
        line(0.08, 0.45, 0.10), line(0.55, 0.92, 0.10),
        line(0.08, 0.45, 0.30), line(0.55, 0.92, 0.30),
    ]):
        connection.execute('INSERT INTO lines (id, element_id, order_idx, polygon) VALUES (?,?,?,?)',
                           (i + 1, 1, i, json.dumps(poly)))
    connection.commit()
    yield connection
    connection.close()


@pytest.fixture
def client(conn, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()


def order_of(conn) -> list:
    return [r['id'] for r in conn.execute(
        'SELECT id FROM lines WHERE deleted = 0 ORDER BY order_idx')]


class TestTheDatasetSaysSo:
    def test_telling_it_two_columns_puts_the_lines_back_in_order(self, client, conn):
        # 1 3 down the left, 2 4 down the right - read as columns, that is 1 3 2 4.
        response = client.patch('/api/jobs/j1', json={'reading_order': '1x2'}, headers=ADMIN)

        assert response.status_code == 200, response.text
        assert response.json()['reading_order'] == '1x2'
        assert order_of(conn) == [1, 3, 2, 4]

    def test_telling_it_one_column_puts_them_back_the_way_they_were(self, client, conn):
        client.patch('/api/jobs/j1', json={'reading_order': '1x2'}, headers=ADMIN)
        client.patch('/api/jobs/j1', json={'reading_order': '1x1'}, headers=ADMIN)

        assert order_of(conn) == [1, 2, 3, 4]

    def test_it_puts_a_page_of_boxes_alone_in_order_too(self, client, conn):
        # Two paragraphs drawn side by side, the right one first; no line is unassigned.
        conn.executescript("""
            INSERT INTO pages (id, job_id, idx, filename, source_file, status)
                VALUES (2, 'j1', 1, 'p2.png', '/p2.png', 'done');
            INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) VALUES
                (5, 2, 0, 'Paragraph', '[0.55,0.1,0.92,0.9]', 'content'),
                (6, 2, 1, 'Paragraph', '[0.08,0.2,0.45,0.9]', 'content');
        """)

        client.patch('/api/jobs/j1', json={'reading_order': '1x2'}, headers=ADMIN)

        assert [r['id'] for r in conn.execute(
            'SELECT id FROM elements WHERE page_id = 2 ORDER BY order_idx')] == [6, 5]

    def test_a_structure_nobody_offers_is_refused_and_changes_nothing(self, client, conn):
        response = client.patch('/api/jobs/j1', json={'reading_order': '9x9'}, headers=ADMIN)

        assert response.status_code == 400
        assert order_of(conn) == [1, 2, 3, 4]


class TestOnePageOfIt:
    def test_a_page_may_say_something_different_from_its_dataset(self, client, conn):
        client.patch('/api/jobs/j1', json={'reading_order': '1x1'}, headers=ADMIN)

        response = client.patch('/api/pages/1', json={'reading_order': '1x2'}, headers=ADMIN)

        assert response.status_code == 200, response.text
        assert order_of(conn) == [1, 3, 2, 4]

    def test_clearing_it_follows_the_dataset_again(self, client, conn):
        client.patch('/api/jobs/j1', json={'reading_order': '1x1'}, headers=ADMIN)
        client.patch('/api/pages/1', json={'reading_order': '1x2'}, headers=ADMIN)

        client.patch('/api/pages/1', json={'reading_order': ''}, headers=ADMIN)

        assert conn.execute('SELECT reading_order FROM pages WHERE id = 1').fetchone()[0] is None
        assert order_of(conn) == [1, 2, 3, 4]

    def test_what_the_page_says_is_written_to_the_history(self, client, conn):
        client.patch('/api/pages/1', json={'reading_order': '1x2'}, headers=ADMIN)

        snapshot = conn.execute(
            "SELECT snapshot FROM revisions WHERE target_type = 'page' ORDER BY id DESC LIMIT 1"
        ).fetchone()[0]
        assert json.loads(snapshot)['reading_order'] == '1x2'

    def test_a_structure_nobody_offers_is_refused_here_too(self, client, conn):
        response = client.patch('/api/pages/1', json={'reading_order': 'sideways'}, headers=ADMIN)

        assert response.status_code == 400
        assert order_of(conn) == [1, 2, 3, 4]


def revert(client, span, direction, headers=ADMIN):
    return client.post('/api/pages/1/revert', headers=headers,
                       json={'from_revision': span['from'], 'to_revision': span['to'], 'direction': direction})


def page_setting(conn):
    return conn.execute('SELECT reading_order FROM pages WHERE id = 1').fetchone()[0]


class TestTakingItBack:
    def test_undo_puts_the_page_back_to_following_the_dataset(self, client, conn):
        client.patch('/api/jobs/j1', json={'reading_order': '1x1'}, headers=ADMIN)
        span = client.patch('/api/pages/1', json={'reading_order': '1x2'}, headers=ADMIN).json()['span']

        response = revert(client, span, 'undo')

        assert response.status_code == 200, response.text
        assert page_setting(conn) is None
        assert order_of(conn) == [1, 2, 3, 4]
        body = response.json()
        assert body['reading_order'] is None
        assert [ln['id'] for ln in body['elements'][0]['lines']] == [1, 2, 3, 4]

    def test_redo_sets_the_page_apart_again(self, client, conn):
        client.patch('/api/jobs/j1', json={'reading_order': '1x1'}, headers=ADMIN)
        span = client.patch('/api/pages/1', json={'reading_order': '1x2'}, headers=ADMIN).json()['span']
        revert(client, span, 'undo')

        response = revert(client, span, 'redo')

        assert response.status_code == 200, response.text
        assert page_setting(conn) == '1x2'
        assert order_of(conn) == [1, 3, 2, 4]
        assert response.json()['reading_order'] == '1x2'

    def test_undo_returns_to_the_setting_before_rather_than_the_dataset(self, client, conn):
        client.patch('/api/pages/1', json={'reading_order': '1x2'}, headers=ADMIN)
        span = client.patch('/api/pages/1', json={'reading_order': '1x1'}, headers=ADMIN).json()['span']

        revert(client, span, 'undo')

        assert page_setting(conn) == '1x2'
        assert order_of(conn) == [1, 3, 2, 4]

    def test_a_setting_someone_else_changed_since_is_not_taken_back(self, client, conn):
        span = client.patch('/api/pages/1', json={'reading_order': '1x2'}, headers=ADMIN).json()['span']
        other = {**ADMIN, 'X-Auth-User': 'boss'}
        client.patch('/api/pages/1', json={'reading_order': '1x1'}, headers=other)

        response = revert(client, span, 'undo')

        assert response.status_code == 409
        assert response.json()['detail']['author'] == 'boss'
        assert page_setting(conn) == '1x1'

    def test_a_check_given_with_it_still_refuses_the_span(self, client, conn):
        span = client.patch('/api/pages/1', json={'reading_order': '1x2', 'lines_checked': True},
                            headers=ADMIN).json()['span']

        response = revert(client, span, 'undo')

        assert response.status_code == 409
        assert response.json()['detail']['message'] == 'the page itself changed in this span'
        assert page_setting(conn) == '1x2'


def box(x0, x1, y, height=0.015):
    return [x0, y, x1, y + height]


def corners(bbox):
    x0, y0, x1, y1 = bbox
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


# The page that started this (dataset c4b7cc65634a, page 160): one column, layout boxed
# some of its lines and left the rest outside every box. Boxes and lines by the height
# they start at; the unassigned lines are of every width a column of text has.
BOXES_AT = (0.10, 0.16, 0.18, 0.22, 0.38, 0.42, 0.48, 0.52, 0.57, 0.60, 0.67, 0.73)
UNASSIGNED_AT = (0.14, 0.20, 0.24, 0.26, 0.28, 0.32, 0.34, 0.63, 0.69, 0.71, 0.75, 0.79, 0.80)
SINGLE_COLUMN_BOXES = [box(0.12, 0.88, y) for y in BOXES_AT]
SINGLE_COLUMN_LINES = [line(0.12, 0.86 if i % 3 else 0.50, y) for i, y in enumerate(UNASSIGNED_AT)]


def runs(boxes, lines, pages=1, columns=1):
    """Where the unassigned lines are read among boxes that are all plain paragraphs."""
    return reading_order.page_order(boxes, ['Paragraph'] * len(boxes), lines, pages, columns).runs


class TestUnassignedLinesAmongTheBoxes:
    def test_a_single_column_page_reads_top_to_bottom(self):
        # Before box 0 nothing; after box 0 the line at .14; after box 2 the one at .20;
        # after box 3 the five from .24 to .34; after box 9 .63; after box 10 .69 and
        # .71; after the last box .75, .79 and .80.
        assert runs(SINGLE_COLUMN_BOXES, SINGLE_COLUMN_LINES) == [
            [], [0], [], [1], [2, 3, 4, 5, 6], [], [], [], [], [], [7], [8, 9], [10, 11, 12]]

    def test_the_page_is_seen_as_one_column_when_left_to_work_it_out(self):
        polygons = SINGLE_COLUMN_LINES + [corners(b) for b in SINGLE_COLUMN_BOXES]

        assert reading_order.resolve(polygons, 'auto') == (1, 1)

    def test_each_column_keeps_the_unassigned_lines_that_stand_in_it(self):
        #   box 0      box 2
        #   a          c
        #   b          box 3
        #   box 1      d
        boxes = [box(0.08, 0.45, 0.10), box(0.08, 0.45, 0.40),
                 box(0.55, 0.92, 0.10), box(0.55, 0.92, 0.50)]
        lines = [line(0.08, 0.45, 0.20), line(0.08, 0.45, 0.25),
                 line(0.55, 0.92, 0.30), line(0.55, 0.92, 0.60)]
        polygons = lines + [corners(b) for b in boxes]

        assert reading_order.resolve(polygons, 'auto') == (1, 2)
        assert runs(boxes, lines, 1, 2) == [[], [0, 1], [], [2], [3]]

    def test_with_no_boxes_the_lines_are_one_run_in_the_order_they_always_had(self):
        assert runs([], TWO_COLUMNS, 1, 2) == [reading_order.order(TWO_COLUMNS, 1, 2)]

    def test_a_box_drawn_at_the_top_is_read_first_and_the_line_under_it_follows_it(self):
        boxes = [box(0.1, 0.9, 0.30), box(0.1, 0.9, 0.60), box(0.1, 0.9, 0.05)]

        order = reading_order.page_order(boxes, ['Paragraph'] * 3, [line(0.1, 0.9, 0.10)])

        assert order.content == [2, 0, 1]
        assert order.runs == [[], [0], [], []]


def rect(x0, y0, x1, y1):
    return [x0, y0, x1, y1]


def layout(*boxes, lines=(), pages=1, columns=1):
    """The order of boxes given as (class, bbox) pairs, in the order they were drawn."""
    return reading_order.page_order([b for _, b in boxes], [c for c, _ in boxes], list(lines), pages, columns)


# A heading across the page, a table of two columns with two paragraphs each - the
# right column's set a little higher than the left's - and a paragraph under it all.
# Listed in no particular order, so only the rules can put them right.
#   7 heading
#   3 table:  6 column  | 0 column
#               4 (.30) |   5 (.25)
#               8 (.60) |   1 (.55)
#   2 under the table
TABLE_PAGE = (
    ('Column', rect(0.51, 0.15, 0.95, 0.85)),
    ('Paragraph', rect(0.55, 0.50, 0.90, 0.60)),
    ('Paragraph', rect(0.05, 0.90, 0.95, 0.95)),
    ('Table', rect(0.05, 0.15, 0.95, 0.85)),
    ('Paragraph', rect(0.10, 0.25, 0.45, 0.35)),
    ('Paragraph', rect(0.55, 0.20, 0.90, 0.30)),
    ('Column', rect(0.05, 0.15, 0.49, 0.85)),
    ('Header', rect(0.05, 0.02, 0.95, 0.08)),
    ('Paragraph', rect(0.10, 0.55, 0.45, 0.65)),
)

# A column whose heading stands level with the paragraph it heads, a hair lower, and a
# second heading well below the next paragraph.
COLUMN_PAGE = (
    ('Column', rect(0.1, 0.1, 0.9, 0.9)),
    ('Paragraph', rect(0.30, 0.250, 0.9, 0.350)),
    ('Header', rect(0.10, 0.255, 0.28, 0.355)),
    ('Paragraph', rect(0.10, 0.40, 0.9, 0.50)),
    ('Header', rect(0.10, 0.52, 0.30, 0.60)),
)

# A curly brace: the entries it gathers on the left, what they share on the right.
CURLY_PAGE = (
    ('Curly', rect(0.1, 0.1, 0.9, 0.6)),
    ('Paragraph', rect(0.15, 0.35, 0.30, 0.45)),
    ('Paragraph', rect(0.60, 0.45, 0.85, 0.55)),
    ('Paragraph', rect(0.15, 0.15, 0.30, 0.25)),
    ('Paragraph', rect(0.60, 0.25, 0.85, 0.35)),
)


class TestTheLayoutsOwnRules:
    def test_a_table_is_read_column_by_column_from_the_left(self):
        order = layout(*TABLE_PAGE)

        assert order.content == [7, 4, 8, 5, 1, 2]

    def test_containers_are_numbered_among_themselves_outside_in(self):
        assert layout(*TABLE_PAGE).containers == [3, 6, 0]

    def test_a_heading_level_with_its_paragraph_is_read_before_it(self):
        assert layout(*COLUMN_PAGE).content == [2, 1, 3, 4]

    def test_a_nested_table_reads_across_and_a_nested_column_down(self):
        order = layout(
            ('Nested-Table', rect(0.1, 0.1, 0.9, 0.5)),
            ('Paragraph', rect(0.55, 0.15, 0.85, 0.25)),
            ('Paragraph', rect(0.15, 0.30, 0.45, 0.40)),
            ('Nested-Column', rect(0.1, 0.55, 0.9, 0.95)),
            ('Paragraph', rect(0.15, 0.80, 0.85, 0.90)),
            ('Paragraph', rect(0.15, 0.60, 0.85, 0.70)),
        )

        assert order.content == [2, 1, 5, 4]

    def test_a_curly_brace_reads_its_right_hand_side_first(self):
        assert layout(*CURLY_PAGE).content == [4, 2, 3, 1]

    def test_a_box_belongs_to_the_innermost_container_its_centre_falls_in(self):
        # The paragraph pokes out of its column; its centre does not.
        order = layout(
            ('Paragraph', rect(0.05, 0.10, 0.95, 0.12)),
            ('Column', rect(0.10, 0.20, 0.50, 0.90)),
            ('Paragraph', rect(0.12, 0.70, 0.70, 0.80)),
            ('Paragraph', rect(0.60, 0.30, 0.90, 0.40)),
        )

        assert order.content == [0, 2, 3]

    def test_a_page_number_is_read_first_wherever_it_stands(self):
        order = layout(('Paragraph', rect(0.1, 0.1, 0.9, 0.8)), ('Pagenumber', rect(0.45, 0.92, 0.55, 0.96)))

        assert order.content == [1, 0]

    def test_a_divider_is_read_where_it_stands_among_the_boxes(self):
        order = layout(('Divider', rect(0.1, 0.35, 0.9, 0.36)),
                       ('Paragraph', rect(0.1, 0.1, 0.9, 0.3)), ('Paragraph', rect(0.1, 0.4, 0.9, 0.6)))

        assert (order.content, order.containers) == ([1, 0, 2], [])

    def test_boxes_standing_level_keep_the_order_they_were_drawn_in(self):
        same = rect(0.1, 0.1, 0.9, 0.3)

        assert layout(('Paragraph', same), ('Paragraph', same)).content == [0, 1]

    def test_one_line_paragraphs_stacked_closer_than_a_row_are_read_downwards(self):
        # From the 1910 volume's page 349: one-line entries 0.0095 apart, the lowest the
        # narrowest. Read as level rows they were ordered by their centres, bottom up.
        order = layout(('Column', rect(0.691, 0.492, 0.954, 0.789)),
                       ('Paragraph', rect(0.693, 0.779, 0.852, 0.789)),
                       ('Paragraph', rect(0.693, 0.770, 0.899, 0.780)),
                       ('Paragraph', rect(0.693, 0.761, 0.903, 0.771)))

        assert order.content == [3, 2, 1]

    def test_two_paragraphs_level_in_a_column_are_read_from_the_left(self):
        order = layout(('Column', rect(0.1, 0.1, 0.9, 0.9)),
                       ('Paragraph', rect(0.55, 0.30, 0.85, 0.40)), ('Paragraph', rect(0.15, 0.305, 0.45, 0.405)))

        assert order.content == [2, 1]


# Page 152 (page_385.png) of dataset 009f7b0fac40: a table the model read as one Column
# across its full width (7288), split by hand into two Columns (7920, 7921) drawn over
# it, with a paragraph a hair higher in the right half (7245) than in the left (7247).
SPLIT_TABLE = {
    7245: ('Paragraph', rect(0.50, 0.703, 0.93, 0.719)),
    7246: ('Paragraph', rect(0.50, 0.750, 0.93, 0.790)),
    7247: ('Paragraph', rect(0.04, 0.708, 0.47, 0.724)),
    7249: ('Paragraph', rect(0.04, 0.760, 0.47, 0.800)),
    7287: ('Table', rect(0.025, 0.695, 0.945, 0.855)),
    7288: ('Column', rect(0.033, 0.701, 0.941, 0.851)),
    7920: ('Column', rect(0.029, 0.700, 0.485, 0.850)),
    7921: ('Column', rect(0.489, 0.705, 0.943, 0.852)),
}


class TestColumnsDrawnToSplitAColumn:
    def test_each_half_is_read_out_before_the_next_the_left_one_first(self):
        ids = list(SPLIT_TABLE)
        order = layout(*SPLIT_TABLE.values())

        assert [ids[i] for i in order.content] == [7247, 7249, 7245, 7246]
        assert [ids[i] for i in order.containers] == [7287, 7288, 7920, 7921]

    def test_the_page_is_put_in_that_order(self, tmp_path):
        conn = store.connect(tmp_path / 'app.db')
        conn.executescript("""
            INSERT INTO jobs (id, name, owner, status) VALUES ('j9', 'Split', 'root', 'done');
            INSERT INTO pages (id, job_id, idx, filename, source_file, status)
                VALUES (152, 'j9', 0, 'page_385.png', '/page_385.png', 'done');
        """)
        for order_idx, (element_id, (class_name, bbox)) in enumerate(SPLIT_TABLE.items()):
            kind = 'content' if class_name == 'Paragraph' else 'container'
            conn.execute('INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) VALUES (?,152,?,?,?,?)',
                         (element_id, order_idx, class_name, json.dumps(bbox), kind))

        geometry.resequence_page(conn, 152)

        assert [r['id'] for r in conn.execute(
            "SELECT id FROM elements WHERE kind = 'content' ORDER BY order_idx")] == [7247, 7249, 7245, 7246]
        conn.close()


class TestOutsideEveryContainer:
    # Four loose paragraphs in two columns, as hand-drawn boxes on a page layout never saw.
    LOOSE = (
        ('Paragraph', box(0.08, 0.45, 0.10)), ('Paragraph', box(0.55, 0.92, 0.10)),
        ('Paragraph', box(0.08, 0.45, 0.40)), ('Paragraph', box(0.55, 0.92, 0.40)),
    )

    def test_loose_boxes_follow_the_columns_the_page_is_set_in(self):
        assert layout(*self.LOOSE, columns=2).content == [0, 2, 1, 3]

    def test_told_it_is_one_column_they_are_read_straight_down(self):
        assert layout(*self.LOOSE, columns=1).content == [0, 1, 2, 3]

    def test_two_columns_without_a_table_are_read_by_the_setting_not_by_height(self):
        # The right column starts higher; set in two columns, the left one is still first.
        order = layout(
            ('Column', rect(0.52, 0.10, 0.95, 0.90)),
            ('Paragraph', rect(0.55, 0.15, 0.90, 0.25)),
            ('Column', rect(0.05, 0.20, 0.48, 0.90)),
            ('Paragraph', rect(0.10, 0.30, 0.45, 0.40)),
            columns=2,
        )

        assert (order.content, order.containers) == ([3, 1], [2, 0])

    def test_an_unassigned_line_inside_a_column_is_read_in_its_place_there(self):
        order = layout(
            ('Column', rect(0.10, 0.10, 0.90, 0.70)),
            ('Paragraph', rect(0.12, 0.15, 0.88, 0.30)),
            ('Paragraph', rect(0.12, 0.50, 0.88, 0.65)),
            lines=[line(0.12, 0.88, 0.80), line(0.12, 0.88, 0.40)],
        )

        assert (order.content, order.runs) == ([1, 2], [[], [1], [0]])


@pytest.fixture
def boxed(tmp_path, monkeypatch):
    """The page above as detection leaves it: a line of text under every box, and every
    line outside a box in one Unassigned bucket after the last of them - so it reads the
    boxes top to bottom and then starts over at the top."""
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript("""
        INSERT INTO jobs (id, name, owner, status) VALUES ('j2', 'Single column', 'root', 'done');
        INSERT INTO pages (id, job_id, idx, filename, source_file, status)
            VALUES (2, 'j2', 0, 'p160.png', '/p160.png', 'done');
    """)
    for k, bbox in enumerate(SINGLE_COLUMN_BOXES):
        connection.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) "
                           "VALUES (?, 2, ?, 'Paragraph', ?, 'content')", (10 + k, k, json.dumps(bbox)))
        x0, y0, x1, _ = bbox
        connection.execute('INSERT INTO lines (id, element_id, order_idx, polygon, text) VALUES (?,?,0,?,?)',
                           (100 + k, 10 + k, json.dumps(line(x0, x1, y0 + 0.001)), f'box {y0:.2f}'))
    connection.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) "
                       "VALUES (40, 2, ?, 'Unassigned', '[0.12,0.14,0.86,0.82]', 'orphan')",
                       (len(SINGLE_COLUMN_BOXES),))
    for k, (poly, y) in enumerate(zip(SINGLE_COLUMN_LINES, UNASSIGNED_AT)):
        connection.execute('INSERT INTO lines (id, element_id, order_idx, polygon, text) VALUES (?,40,?,?,?)',
                           (200 + k, k, json.dumps(poly), f'free {y:.2f}'))
    connection.commit()
    app.dependency_overrides[get_db] = lambda: connection
    yield TestClient(app), connection
    app.dependency_overrides.clear()
    connection.close()


def reading(conn) -> list:
    """The page as everything downstream reads it: element order, then line order."""
    return [r['text'] for r in conn.execute(
        'SELECT l.text FROM lines l JOIN elements e ON l.element_id = e.id '
        'WHERE e.page_id = 2 AND e.deleted = 0 AND l.deleted = 0 ORDER BY e.order_idx, l.order_idx')]


TOP_TO_BOTTOM = [
    'box 0.10', 'free 0.14', 'box 0.16', 'box 0.18', 'free 0.20', 'box 0.22',
    'free 0.24', 'free 0.26', 'free 0.28', 'free 0.32', 'free 0.34',
    'box 0.38', 'box 0.42', 'box 0.48', 'box 0.52', 'box 0.57', 'box 0.60', 'free 0.63',
    'box 0.67', 'free 0.69', 'free 0.71', 'box 0.73', 'free 0.75', 'free 0.79', 'free 0.80',
]


def content_order(conn) -> list:
    return [r['id'] for r in conn.execute(
        "SELECT id FROM elements WHERE page_id = 2 AND deleted = 0 AND kind = 'content' ORDER BY order_idx")]


def live_buckets(conn) -> int:
    return conn.execute(
        "SELECT COUNT(DISTINCT e.id) FROM elements e JOIN lines l ON l.element_id = e.id "
        "WHERE e.page_id = 2 AND e.kind = 'orphan' AND e.deleted = 0 AND l.deleted = 0").fetchone()[0]


class TestAPageLayoutBoxedInPart:
    def test_as_detected_it_reads_the_boxes_and_then_starts_over(self, boxed):
        _, conn = boxed

        assert reading(conn)[:13] == [f'box {y:.2f}' for y in BOXES_AT] + ['free 0.14']

    def test_changing_the_datasets_reading_order_puts_it_right(self, boxed):
        client, conn = boxed

        response = client.patch('/api/jobs/j2', json={'reading_order': '1x1'}, headers=ADMIN)

        assert response.status_code == 200, response.text
        assert reading(conn) == TOP_TO_BOTTOM
        assert content_order(conn) == [10 + k for k in range(len(BOXES_AT))]
        assert live_buckets(conn) == 6

    def test_setting_the_page_apart_puts_it_right_too(self, boxed):
        client, conn = boxed

        response = client.patch('/api/pages/2', json={'reading_order': '1x1'}, headers=ADMIN)

        assert response.status_code == 200, response.text
        assert reading(conn) == TOP_TO_BOTTOM

    def test_the_viewer_gets_the_page_in_that_order(self, boxed):
        client, conn = boxed
        client.patch('/api/jobs/j2', json={'reading_order': '1x1'}, headers=ADMIN)

        page = client.get('/api/jobs/j2/pages/2', headers=ADMIN).json()

        assert [ln['text'] for e in page['elements'] for ln in e['lines']] == TOP_TO_BOTTOM

    def test_the_moves_are_the_systems_and_written_to_the_history(self, boxed):
        client, conn = boxed
        client.patch('/api/jobs/j2', json={'reading_order': '1x1'}, headers=ADMIN)

        moved = conn.execute(
            "SELECT target_id, author, json_extract(snapshot, '$.element_id') AS element_id "
            "FROM revisions WHERE target_type = 'line' AND action = 'update' ORDER BY id").fetchall()
        holders = {r['id'] for r in conn.execute(
            'SELECT element_id AS id FROM lines WHERE id >= 200')}
        assert {r['author'] for r in moved} == {'system:reading-order'}
        assert {r['element_id'] for r in moved} <= holders

    def test_putting_it_right_twice_writes_nothing_the_second_time(self, boxed):
        client, conn = boxed
        client.patch('/api/jobs/j2', json={'reading_order': '1x1'}, headers=ADMIN)
        before = store.revision_mark(conn)

        client.patch('/api/jobs/j2', json={'reading_order': '1x1'}, headers=ADMIN)

        assert store.revision_mark(conn) == before
        assert reading(conn) == TOP_TO_BOTTOM


class TestDrawingAnUnassignedLine:
    def test_it_is_read_between_the_boxes_it_stands_between(self, boxed):
        client, conn = boxed
        client.patch('/api/jobs/j2', json={'reading_order': '1x1'}, headers=ADMIN)

        drawn = client.post('/api/pages/2/lines', json={'polygon': line(0.12, 0.86, 0.45)}, headers=ADMIN)
        assert drawn.status_code == 200, drawn.text
        client.patch(f"/api/lines/{drawn.json()['id']}", json={'corrected_text': 'drawn 0.45'}, headers=ADMIN)

        order = [r['id'] for r in conn.execute(
            'SELECT l.id FROM lines l JOIN elements e ON l.element_id = e.id '
            'WHERE e.page_id = 2 AND e.deleted = 0 AND l.deleted = 0 ORDER BY e.order_idx, l.order_idx')]
        at = TOP_TO_BOTTOM.index('box 0.42') + 1
        assert order[at] == drawn.json()['id']
        assert reading(conn)[:at] + reading(conn)[at + 1:] == TOP_TO_BOTTOM

    def test_undoing_it_puts_the_page_back_as_it_was(self, boxed):
        client, conn = boxed
        client.patch('/api/jobs/j2', json={'reading_order': '1x1'}, headers=ADMIN)
        orders = conn.execute('SELECT id, order_idx FROM elements WHERE deleted = 0 ORDER BY id').fetchall()

        span = client.post('/api/pages/2/lines', json={'polygon': line(0.12, 0.86, 0.45)},
                           headers=ADMIN).json()['span']
        response = client.post('/api/pages/2/revert', headers=ADMIN,
                               json={'from_revision': span['from'], 'to_revision': span['to'], 'direction': 'undo'})

        assert response.status_code == 200, response.text
        assert reading(conn) == TOP_TO_BOTTOM
        assert conn.execute('SELECT id, order_idx FROM elements WHERE deleted = 0 ORDER BY id').fetchall() == orders
