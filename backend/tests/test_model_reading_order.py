"""The reading order is set in the layout template, and a dataset
reads by its layout model's template. The Schematismus template reads exactly as the
pipeline does - containers by their per-class rules, everything else top to bottom by
centre, the page number first, no guess at leaves or columns - and a dataset that runs no
layout model works its order out from the page.
"""
import json
import sqlite3

import pytest

from fastapi.testclient import TestClient

from app import geometry, layout_templates, reading_order, registry, store
from app.deps import get_db
from app.main import app
from tests.fakes import seed_defaults

# An open book, one loose paragraph per column, drawn in the order a detector might give
# them. The left column holds 0 (centre y 0.3) and 1 (0.7), the right one 2 (0.2) and 3 (0.6).
#   0 .     . 2
#   1 .     . 3
SPREAD = [[0.05, 0.1, 0.45, 0.5], [0.05, 0.5, 0.45, 0.9], [0.55, 0.0, 0.95, 0.4], [0.55, 0.4, 0.95, 0.8]]
PARAGRAPHS = ['Paragraph'] * 4


class TestThePipelinesOrder:
    def test_everything_outside_containers_reads_top_to_bottom_by_centre(self):
        order = reading_order.page_order(SPREAD, PARAGRAPHS, [], 1, 2, rules=reading_order.PIPELINE)
        assert order.content == [2, 0, 3, 1]

    def test_the_guessed_order_reads_the_columns_instead(self):
        order = reading_order.page_order(SPREAD, PARAGRAPHS, [], 1, 2, rules=reading_order.SCHEMATISMUS)
        assert order.content == [0, 1, 2, 3]

    def test_the_page_number_is_read_first(self):
        boxes = [*SPREAD, [0.9, 0.95, 0.95, 0.98]]
        order = reading_order.page_order(boxes, [*PARAGRAPHS, 'Pagenumber'], [], rules=reading_order.PIPELINE)
        assert order.content == [4, 2, 0, 3, 1]

    def test_a_column_reads_level_entries_by_height_not_from_the_left(self):
        # Two entries side by side in one Column, the right one a hair higher: the pipeline
        # sorts a Column by height alone, so the right one comes first.
        boxes = [[0.0, 0.0, 1.0, 1.0], [0.05, 0.302, 0.45, 0.352], [0.55, 0.3, 0.95, 0.35]]
        classes = ['Column', 'H5', 'H5']
        assert reading_order.page_order(boxes, classes, [], rules=reading_order.PIPELINE).content == [2, 1]
        assert reading_order.page_order(boxes, classes, [], rules=reading_order.SCHEMATISMUS).content == [1, 2]

    def test_of_two_overlapping_columns_the_one_detected_first_takes_what_both_hold(self):
        # Box 3 stands where the columns overlap. The pipeline fills containers of one kind
        # in the order they were detected, so the wider left Column, listed first, takes it.
        boxes = [[0.0, 0.0, 0.57, 1.0], [0.48, 0.1, 1.0, 1.0], [0.6, 0.2, 0.9, 0.25], [0.49, 0.7, 0.56, 0.8]]
        classes = ['Column', 'Column', 'Header', 'Header']
        assert reading_order.page_order(boxes, classes, [], rules=reading_order.PIPELINE).content == [3, 2]
        assert reading_order.page_order(boxes, classes, [], rules=reading_order.SCHEMATISMUS).content == [2, 3]

    def test_containers_keep_their_per_class_rules(self):
        # A Curly reads its right-hand group before its left one, as the pipeline does.
        boxes = [[0.0, 0.0, 1.0, 0.5], [0.05, 0.1, 0.4, 0.15], [0.05, 0.2, 0.4, 0.25], [0.6, 0.15, 0.9, 0.2]]
        order = reading_order.page_order(boxes, ['Curly', 'Paragraph', 'Paragraph', 'H5'], [],
                                         rules=reading_order.PIPELINE)
        assert order.content == [3, 1, 2] and order.containers == [0]


SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    connection = store.connect(tmp_path / 'app.db')
    seed_defaults(connection)
    yield connection
    connection.close()


@pytest.fixture
def client(conn, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()


def spread_page(conn, run_layout: bool, model_id: int | None) -> int:
    conn.execute("INSERT INTO jobs (id, name, owner, status, run_layout, model_layout_id) "
                 "VALUES ('j1', 'Volume', 'root', 'done', ?, ?)", (int(run_layout), model_id))
    layout_templates.copy_into(conn, 'j1')
    conn.execute("INSERT INTO pages (id, job_id, idx, filename, source_file, status) "
                 "VALUES (1, 'j1', 0, 'p1.png', '/p1.png', 'done')")
    for i, bbox in enumerate(SPREAD):
        conn.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) "
                     "VALUES (?, 1, ?, 'Paragraph', ?, 'content')", (i + 1, i, json.dumps(bbox)))
    conn.execute("UPDATE jobs SET reading_order = '1x2' WHERE id = 'j1'")
    conn.commit()
    return 1


def element_order(conn) -> list[int]:
    return [r['id'] for r in conn.execute('SELECT id FROM elements WHERE page_id = 1 ORDER BY order_idx')]


def template(conn, outside: str) -> int:
    template_id = conn.execute("INSERT INTO layout_templates (name, owner, outside_order) VALUES (?, 'alice', ?)",
                               (f'Letters {outside}', outside)).lastrowid
    layout_templates.insert_classes(conn, 'layout_template_classes', 'template_id', template_id,
                                    [{'id': 1, 'name': 'Paragraph', 'role': 'content', 'reads': None, 'color': None,
                                      'position': 0}])
    return template_id


def layout_model(conn, template_id: int | None) -> int:
    return conn.execute("INSERT INTO models (task, name, source, checkpoint, layout_template_id) "
                        "VALUES ('layout', 'Layout', 'imported', '/m.pth', ?)", (template_id,)).lastrowid


SCHEMATISMUS_ORDER = [3, 1, 4, 2]
GUESSED_ORDER = [1, 2, 3, 4]


class TestADatasetReadsByItsLayoutModelsTemplate:
    def test_a_model_of_the_schematismus_template_reads_as_the_pipeline_does(self, conn):
        model = layout_model(conn, layout_templates.ensure_schematismus(conn))
        geometry.resequence_page(conn, spread_page(conn, True, model))
        assert element_order(conn) == SCHEMATISMUS_ORDER

    def test_a_template_reading_top_to_bottom_reads_so_outside_its_containers(self, conn):
        geometry.resequence_page(conn, spread_page(conn, True, layout_model(conn, template(conn, 'top_to_bottom'))))
        assert element_order(conn) == SCHEMATISMUS_ORDER

    def test_a_template_reading_from_the_page_works_its_columns_out(self, conn):
        geometry.resequence_page(conn, spread_page(conn, True, layout_model(conn, template(conn, 'from_page'))))
        assert element_order(conn) == GUESSED_ORDER

    def test_a_model_of_no_template_works_its_columns_out(self, conn):
        geometry.resequence_page(conn, spread_page(conn, True, layout_model(conn, None)))
        assert element_order(conn) == GUESSED_ORDER

    def test_the_default_layout_model_decides_when_the_dataset_names_none(self, conn):
        geometry.resequence_page(conn, spread_page(conn, True, None))
        assert element_order(conn) == SCHEMATISMUS_ORDER

    def test_a_dataset_that_runs_no_layout_model_works_its_columns_out(self, conn):
        model = layout_model(conn, layout_templates.ensure_schematismus(conn))
        geometry.resequence_page(conn, spread_page(conn, False, model))
        assert element_order(conn) == GUESSED_ORDER


class TestWhereAModelsTemplateComesFrom:
    def test_the_builtin_layout_model_belongs_to_the_schematismus_template(self, conn):
        schematismus = layout_templates.ensure_schematismus(conn)
        assert registry.default_model(conn, 'layout')['layout_template_id'] == schematismus
        assert registry.default_model(conn, 'ocr')['layout_template_id'] is None

    def test_the_schematismus_template_reads_top_to_bottom(self, conn):
        row = conn.execute('SELECT outside_order FROM layout_templates WHERE id = ?',
                           (layout_templates.ensure_schematismus(conn),)).fetchone()
        assert row['outside_order'] == 'top_to_bottom'

    def test_a_database_from_before_templates_held_the_order_moves_it_there(self, tmp_path):
        db = tmp_path / 'old.db'
        first = store.connect(db)
        seed_defaults(first)
        first.execute("INSERT INTO layout_templates (name, owner) VALUES ('Letters', 'alice')")
        first.commit()
        first.close()
        raw = sqlite3.connect(db)
        raw.execute('ALTER TABLE models DROP COLUMN layout_template_id')
        raw.execute('ALTER TABLE layout_templates DROP COLUMN outside_order')
        raw.execute('ALTER TABLE models ADD COLUMN reading_rules TEXT')
        raw.execute("UPDATE models SET reading_rules = 'schematismus' WHERE task = 'layout'")
        raw.execute("INSERT INTO models (task, name, source, checkpoint) VALUES ('layout', 'Mine', 'imported', '/x')")
        raw.commit()
        raw.close()

        conn = store.connect(db)
        store.connect(db).close()
        schematismus = layout_templates.ensure_schematismus(conn)
        templates = {r['name']: r['outside_order'] for r in conn.execute('SELECT name, outside_order FROM layout_templates')}
        models = {r['name']: r['layout_template_id'] for r in conn.execute('SELECT name, layout_template_id FROM models')}
        assert templates == {'Schematismus': 'top_to_bottom', 'Letters': 'from_page'}
        assert (models['RF-DETR 2XL'], models['Mine'], models['DeepOCR']) == (schematismus, None, None)
        conn.close()


class TestSettingItUp:
    def test_a_template_says_how_it_reads_outside_its_containers(self, client):
        made = client.post('/api/layout-templates', headers=ALICE, json={
            'name': 'Letters', 'outside_order': 'top_to_bottom', 'classes': [{'name': 'Body'}]})
        assert made.status_code == 201, made.text
        assert made.json()['outside_order'] == 'top_to_bottom'
        changed = client.patch(f"/api/layout-templates/{made.json()['id']}", headers=ALICE,
                               json={'outside_order': 'from_page'})
        assert changed.json()['outside_order'] == 'from_page'

    def test_a_new_template_works_its_columns_out_unless_told(self, client):
        made = client.post('/api/layout-templates', headers=ALICE, json={'name': 'Letters', 'classes': [{'name': 'Body'}]})
        assert made.json()['outside_order'] == 'from_page'

    def test_an_order_nobody_offers_is_refused(self, client):
        made = client.post('/api/layout-templates', headers=ALICE, json={
            'name': 'Letters', 'outside_order': 'diagonal', 'classes': [{'name': 'Body'}]})
        assert made.status_code == 422

    def test_a_template_a_model_belongs_to_cannot_be_deleted(self, client, conn):
        made = client.post('/api/layout-templates', headers=ALICE, json={'name': 'Letters', 'classes': [{'name': 'Body'}]})
        layout_model(conn, made.json()['id'])
        conn.commit()
        refused = client.delete(f"/api/layout-templates/{made.json()['id']}", headers=ALICE)
        assert refused.status_code == 409 and 'Layout' in refused.json()['detail']

    def test_a_model_is_given_its_template(self, client, conn):
        letters = template(conn, 'from_page')
        model = layout_model(conn, None)
        conn.commit()
        answer = client.patch(f'/api/models/{model}', headers=ADMIN, json={'layout_template_id': letters})
        assert answer.status_code == 200, answer.text
        assert answer.json()['layout_template_id'] == letters
        assert registry.get_model(conn, model)['layout_template_id'] == letters

    def test_only_a_layout_model_belongs_to_a_template(self, client, conn):
        ocr = registry.default_model(conn, 'ocr')['id']
        answer = client.patch(f'/api/models/{ocr}', headers=ADMIN, json={'layout_template_id': template(conn, 'from_page')})
        assert answer.status_code == 400

    def test_a_template_that_does_not_exist_is_refused(self, client, conn):
        model = layout_model(conn, None)
        conn.commit()
        assert client.patch(f'/api/models/{model}', headers=ADMIN, json={'layout_template_id': 999}).status_code == 400


class TestTheSettingItOverrides:
    """A dataset whose order its layout model's template sets says so, where the page and
    the dataset would otherwise choose leaves and columns."""

    def test_the_dataset_and_its_pages_name_the_template_that_sets_the_order(self, client, conn):
        spread_page(conn, True, layout_model(conn, layout_templates.ensure_schematismus(conn)))
        conn.commit()
        assert client.get('/api/jobs/j1?pages=false', headers=ADMIN).json()['reading_order_template'] == 'Schematismus'
        assert client.get('/api/jobs/j1/pages/1', headers=ADMIN).json()['reading_order_template'] == 'Schematismus'

    def test_a_template_reading_from_the_page_leaves_the_setting_to_the_dataset(self, client, conn):
        spread_page(conn, True, layout_model(conn, template(conn, 'from_page')))
        conn.commit()
        assert client.get('/api/jobs/j1?pages=false', headers=ADMIN).json()['reading_order_template'] is None
        assert client.get('/api/jobs/j1/pages/1', headers=ADMIN).json()['reading_order_template'] is None
