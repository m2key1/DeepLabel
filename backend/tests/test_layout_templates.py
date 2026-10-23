"""Layout templates: a dataset copies its layout classes from a template
when it is made - Schematismus unless it names another - and from then on its classes, not
the template's, decide what is a container, how a page reads and what exports under which
category id.
"""
import json

import pytest
from fastapi.testclient import TestClient

from app import coco, layout_classes, layout_templates, reading_order, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}
BOB = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member'}
PNG = b'\x89PNG\r\n\x1a\n'
LETTERS = [{'name': 'Salutation'}, {'name': 'Body'}, {'name': 'Signature'},
           {'name': 'Panel', 'role': 'container', 'reads': 'across'}]


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    connection = store.connect(tmp_path / 'app.db')
    yield connection
    connection.close()


@pytest.fixture
def client(conn, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()


def upload(client, name, headers=ALICE, **data):
    return client.post('/api/jobs', headers=headers,
                       data={'name': name, 'run_layout': 'false', 'run_lines': 'false', 'run_ocr': 'false', **data},
                       files=[('files', ('a.png', PNG, 'image/png'))])


def template(client, name='Letters', classes=LETTERS, headers=ALICE):
    response = client.post('/api/layout-templates', headers=headers, json={'name': name, 'classes': classes})
    assert response.status_code == 201, response.text
    return response.json()


def dataset_classes(conn, job_id):
    return [(c['id'], c['name'], c['role'], c['reads']) for c in layout_templates.job_classes(conn, job_id)]


class TestSchematismus:
    def test_it_is_the_default_with_the_checkpoints_ids_and_containers(self, conn):
        row = conn.execute('SELECT * FROM layout_templates WHERE is_default = 1').fetchone()
        assert row['name'] == 'Schematismus' and row['rules'] == 'schematismus'
        classes = layout_templates.template_classes(conn, row['id'])
        assert sorted((c['id'], c['name']) for c in classes) == [(i + 1, n) for i, n in enumerate(layout_classes.CLASS_NAMES)]
        assert [c['name'] for c in classes] == layout_templates.SCHEMATISMUS_DISPLAY
        assert {c['name'] for c in classes if c['role'] == 'container'} == layout_classes.CONTAINER_CLASSES
        assert {c['name']: c['reads'] for c in classes if c['reads']} == layout_templates.SCHEMATISMUS_READS

    def test_an_existing_text_dataset_is_given_it_and_a_map_dataset_is_not(self, tmp_path):
        db = tmp_path / 'old.db'
        raw = store.connect(db)
        raw.execute("INSERT INTO jobs (id, name, owner) VALUES ('old', 'Old volume', 'alice')")
        raw.execute("INSERT INTO jobs (id, name, owner, task) VALUES ('map', 'Old map', 'alice', 'map_segmentation')")
        raw.execute("DELETE FROM job_layout_classes")
        raw.commit()
        raw.close()

        reopened = store.connect(db)
        store.connect(db).close()  # a second open adds nothing
        assert dataset_classes(reopened, 'old') == [
            (c['id'], c['name'], c['role'], c['reads'])
            for c in sorted(layout_templates.schematismus_classes(), key=lambda c: c['position'])]
        assert reopened.execute("SELECT layout_rules FROM jobs WHERE id = 'old'").fetchone()[0] == 'schematismus'
        assert reopened.execute("SELECT COUNT(*) FROM job_layout_classes WHERE job_id = 'map'").fetchone()[0] == 0
        assert reopened.execute("SELECT COUNT(*) FROM job_layout_classes WHERE job_id = 'old'").fetchone()[0] == 14
        reopened.close()

    def test_it_cannot_be_edited_even_by_an_admin(self, client, conn):
        schematismus = conn.execute("SELECT id FROM layout_templates WHERE rules = 'schematismus'").fetchone()[0]
        response = client.patch(f'/api/layout-templates/{schematismus}', headers=ADMIN, json={'name': 'Mine'})
        assert response.status_code == 409
        assert conn.execute('SELECT name FROM layout_templates WHERE id = ?', (schematismus,)).fetchone()[0] == 'Schematismus'


class TestMakingTemplates:
    def test_classes_are_numbered_in_order_and_owned_by_their_maker(self, client):
        made = template(client)
        assert made['owner'] == 'alice' and not made['is_default'] and not made['builtin']
        assert [(c['id'], c['name'], c['role'], c['reads']) for c in made['classes']] == [
            (1, 'Salutation', 'content', None), (2, 'Body', 'content', None), (3, 'Signature', 'content', None),
            (4, 'Panel', 'container', 'across')]

    @pytest.mark.parametrize('classes, message', [
        ([], 'at least one class'),
        ([{'name': 'Body'}, {'name': 'Body'}], 'unique'),
        ([{'name': 'Panel', 'role': 'container'}], 'must read down or across'),
        ([{'name': '  '}], 'needs a name'),
    ])
    def test_a_class_set_that_cannot_work_is_refused(self, client, conn, classes, message):
        response = client.post('/api/layout-templates', headers=ALICE, json={'name': 'Broken', 'classes': classes})
        assert response.status_code == 400 and message in response.json()['detail']
        assert conn.execute("SELECT COUNT(*) FROM layout_templates WHERE name = 'Broken'").fetchone()[0] == 0

    def test_a_second_template_of_one_name_is_refused(self, client):
        template(client)
        response = client.post('/api/layout-templates', headers=BOB, json={'name': 'Letters', 'classes': LETTERS})
        assert response.status_code == 409

    def test_a_dataset_saved_as_a_template_carries_its_classes(self, client, conn):
        job_id = upload(client, 'Letters 1', layout_template_id=str(template(client)['id'])).json()['job_id']
        saved = client.post('/api/layout-templates', headers=ALICE, json={'name': 'From letters', 'from_job_id': job_id})
        assert saved.status_code == 201
        assert [(c['id'], c['name'], c['role'], c['reads']) for c in saved.json()['classes']] == dataset_classes(conn, job_id)


class TestEditingTemplates:
    def test_only_its_owner_or_an_admin_may_change_it(self, client, conn):
        made = template(client)
        assert client.patch(f"/api/layout-templates/{made['id']}", headers=BOB, json={'name': 'Bob'}).status_code == 403
        assert client.patch(f"/api/layout-templates/{made['id']}", headers=ADMIN, json={'name': 'Post'}).status_code == 200
        assert conn.execute('SELECT name FROM layout_templates WHERE id = ?', (made['id'],)).fetchone()[0] == 'Post'

    def test_a_kept_class_keeps_its_id_and_a_new_one_takes_the_next(self, client):
        made = template(client)
        body = [{'id': 4, 'name': 'Panel', 'role': 'container', 'reads': 'down'}, {'id': 2, 'name': 'Text'},
                {'name': 'Postscript'}]
        changed = client.patch(f"/api/layout-templates/{made['id']}", headers=ALICE, json={'classes': body}).json()
        assert [(c['id'], c['name'], c['reads']) for c in changed['classes']] == [
            (4, 'Panel', 'down'), (2, 'Text', None), (5, 'Postscript', None)]

    def test_a_dataset_made_from_it_keeps_the_classes_it_was_made_with(self, client, conn):
        made = template(client)
        job_id = upload(client, 'Letters 1', layout_template_id=str(made['id'])).json()['job_id']
        before = dataset_classes(conn, job_id)
        client.patch(f"/api/layout-templates/{made['id']}", headers=ALICE, json={'classes': [{'name': 'Other'}]})
        assert dataset_classes(conn, job_id) == before

    def test_only_an_admin_chooses_the_default_and_new_datasets_follow_it(self, client, conn):
        made = template(client)
        assert client.put(f"/api/layout-templates/{made['id']}/default", headers=ALICE).status_code == 403
        assert client.put(f"/api/layout-templates/{made['id']}/default", headers=ADMIN).status_code == 200
        assert [tuple(r) for r in conn.execute('SELECT id FROM layout_templates WHERE is_default = 1')] == [(made['id'],)]
        job_id = upload(client, 'Plain').json()['job_id']
        assert [c[1] for c in dataset_classes(conn, job_id)] == ['Salutation', 'Body', 'Signature', 'Panel']
        assert client.delete(f"/api/layout-templates/{made['id']}", headers=ALICE).status_code == 409


class TestDatasets:
    def test_a_new_dataset_without_a_choice_gets_schematismus(self, client, conn):
        job_id = upload(client, 'Volume').json()['job_id']
        assert [c[1] for c in dataset_classes(conn, job_id)] == layout_templates.SCHEMATISMUS_DISPLAY
        row = conn.execute('SELECT layout_rules, layout_template_id FROM jobs WHERE id = ?', (job_id,)).fetchone()
        assert row['layout_rules'] == 'schematismus'
        assert client.get(f'/api/jobs/{job_id}/layout-classes', headers=ALICE).json()['template_id'] == row['layout_template_id']

    def test_an_unknown_template_is_refused_before_anything_is_written(self, client, conn):
        response = upload(client, 'Volume', layout_template_id='999')
        assert response.status_code == 400
        assert conn.execute("SELECT COUNT(*) FROM jobs WHERE name = 'Volume'").fetchone()[0] == 0

    def test_an_imported_dataset_gets_the_default(self, client, conn):
        import io
        import zipfile
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as archive:
            archive.writestr('folio_1.xml', '<?xml version="1.0"?><PcGts xmlns="http://schema.primaresearch.org/'
                             'PAGE/gts/pagecontent/2019-07-15"><Page imageFilename="folio_1.png" imageWidth="10" '
                             'imageHeight="20"/></PcGts>')
            archive.writestr('folio_1.png', PNG)
        buffer.seek(0)
        job_id = client.post('/api/jobs/import', headers=ADMIN, data={'name': 'Imported'},
                             files={'file': ('export.zip', buffer, 'application/zip')}).json()['job_id']
        assert len(dataset_classes(conn, job_id)) == 14

    def test_a_class_decides_its_kind_and_one_the_dataset_lacks_is_refused(self, client, conn):
        job_id = upload(client, 'Letters 1', layout_template_id=str(template(client)['id'])).json()['job_id']
        page_id = conn.execute('SELECT id FROM pages WHERE job_id = ?', (job_id,)).fetchone()[0]
        made = client.post(f'/api/pages/{page_id}/elements', headers=ALICE,
                           json={'class_name': 'Panel', 'bbox': [0.1, 0.1, 0.9, 0.9]})
        assert made.status_code in (200, 201), made.text
        stored = conn.execute('SELECT class_name, raw_class_name, kind FROM elements WHERE page_id = ?',
                              (page_id,)).fetchone()
        assert tuple(stored) == ('Panel', 'Panel', 'container')
        refused = client.post(f'/api/pages/{page_id}/elements', headers=ALICE,
                              json={'class_name': 'Paragraph', 'bbox': [0.1, 0.1, 0.5, 0.5]})
        assert refused.status_code == 400

    def test_its_coco_export_numbers_categories_by_its_class_ids(self, client, conn):
        job_id = upload(client, 'Letters 1', layout_template_id=str(template(client)['id'])).json()['job_id']
        conn.execute("UPDATE pages SET layout_checked = 1, content_hash = 'abcdef12', width = 100, height = 200, "
                     "status = 'done' WHERE job_id = ?", (job_id,))
        page_id = conn.execute('SELECT id FROM pages WHERE job_id = ?', (job_id,)).fetchone()[0]
        conn.execute("INSERT INTO elements (page_id, order_idx, class_name, raw_class_name, bbox, kind) "
                     "VALUES (?, 0, 'Signature', 'Signature', '[0.1,0.1,0.5,0.5]', 'content')", (page_id,))
        doc = coco.collect(conn, job_id)[0]['doc']
        assert doc['categories'] == [{'id': 1, 'name': 'Salutation'}, {'id': 2, 'name': 'Body'},
                                     {'id': 3, 'name': 'Signature'}, {'id': 4, 'name': 'Panel'}]
        assert [a['category_id'] for a in doc['annotations']] == [3]


class TestReadingRules:
    BOXES = [[0.05, 0.1, 0.95, 0.5], [0.6, 0.15, 0.9, 0.2], [0.1, 0.3, 0.3, 0.35], [0.3, 0.15, 0.5, 0.2]]

    def test_a_container_reading_across_takes_its_children_left_to_right(self):
        rules = reading_order.template_rules({'Panel': 'across'})
        order = reading_order.page_order(self.BOXES, ['Panel', 'Body', 'Body', 'Body'], [], rules=rules)
        assert order.containers == [0]
        assert order.content == [2, 3, 1]

    def test_a_container_reading_down_takes_them_top_to_bottom(self):
        rules = reading_order.template_rules({'Panel': 'down'})
        order = reading_order.page_order(self.BOXES, ['Panel', 'Body', 'Body', 'Body'], [], rules=rules)
        assert order.content == [3, 1, 2]

    def test_a_schematismus_dataset_reads_by_the_schematismus_rules(self, conn):
        conn.execute("INSERT INTO jobs (id, name, owner) VALUES ('s', 'Volume', 'alice')")
        layout_templates.copy_into(conn, 's')
        assert layout_templates.vocabulary(conn, 's').reading_rules() is reading_order.SCHEMATISMUS

    def test_a_template_dataset_reads_by_its_own(self, client, conn):
        job_id = upload(client, 'Letters 1', layout_template_id=str(template(client)['id'])).json()['job_id']
        rules = layout_templates.vocabulary(conn, job_id).reading_rules()
        assert rules.reads == {'Panel': 'across'} and not rules.schematismus and rules.page_number is None


def test_a_schematismus_label_still_stores_under_its_downstream_name(conn):
    conn.execute("INSERT INTO jobs (id, name, owner) VALUES ('s', 'Volume', 'alice')")
    layout_templates.copy_into(conn, 's')
    vocabulary = layout_templates.vocabulary(conn, 's')
    assert vocabulary.resolve('PageNumber') == ('Pagenumber', 'PageNumber', 'content')
    assert vocabulary.resolve('WeirdTable') == ('Table', 'WeirdTable', 'container')
    assert vocabulary.resolve('Marginalia') == ('Marginalia', 'Marginalia', 'content')
    assert json.dumps(coco.categories()) == json.dumps(
        [{'id': i + 1, 'name': n} for i, n in enumerate(layout_classes.CLASS_NAMES)])


VIEWER = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'vera', 'X-Auth-Role': 'viewer'}


class TestEditingADatasetsClasses:
    @pytest.fixture
    def letters(self, client, conn):
        job_id = upload(client, 'Letters 1', layout_template_id=str(template(client)['id'])).json()['job_id']
        page_id = conn.execute('SELECT id FROM pages WHERE job_id = ?', (job_id,)).fetchone()[0]
        for class_name, bbox in (('Body', [0.1, 0.1, 0.5, 0.3]), ('Body', [0.1, 0.4, 0.5, 0.6]),
                                 ('Signature', [0.1, 0.7, 0.5, 0.8])):
            assert client.post(f'/api/pages/{page_id}/elements', headers=ALICE,
                               json={'class_name': class_name, 'bbox': bbox}).status_code in (200, 201)
        return job_id, page_id

    def classes_of_elements(self, conn, page_id):
        return sorted(tuple(r) for r in conn.execute(
            'SELECT class_name, raw_class_name, kind FROM elements WHERE page_id = ? AND deleted = 0', (page_id,)))

    def test_a_renamed_class_takes_its_elements_along_and_logs_each(self, client, conn, letters):
        job_id, page_id = letters
        before = conn.execute('SELECT COUNT(*) FROM revisions').fetchone()[0]
        changed = client.patch(f'/api/jobs/{job_id}/layout-classes/2', headers=ALICE, json={'name': 'Text'})
        assert changed.status_code == 200 and changed.json()['elements_changed'] == 2
        assert self.classes_of_elements(conn, page_id) == [('Signature', 'Signature', 'content'),
                                                           ('Text', 'Text', 'content'), ('Text', 'Text', 'content')]
        assert conn.execute('SELECT COUNT(*) FROM revisions').fetchone()[0] - before >= 2

    def test_a_retyped_class_changes_its_elements_kind(self, client, conn, letters):
        job_id, page_id = letters
        client.patch(f'/api/jobs/{job_id}/layout-classes/3', headers=ALICE,
                     json={'role': 'container', 'reads': 'down'})
        assert ('Signature', 'Signature', 'container') in self.classes_of_elements(conn, page_id)

    def test_a_container_without_a_direction_is_refused(self, client, letters):
        job_id, _ = letters
        response = client.patch(f'/api/jobs/{job_id}/layout-classes/3', headers=ALICE, json={'role': 'container'})
        assert response.status_code == 400

    def test_a_removed_class_deletes_its_elements_and_its_id_is_never_reused(self, client, conn, letters):
        job_id, page_id = letters
        removed = client.delete(f'/api/jobs/{job_id}/layout-classes/3', headers=ALICE)
        assert removed.json()['elements_affected'] == 1
        assert self.classes_of_elements(conn, page_id) == [('Body', 'Body', 'content')] * 2
        added = client.post(f'/api/jobs/{job_id}/layout-classes', headers=ALICE, json={'name': 'Seal'})
        assert added.status_code == 201 and added.json()['id'] == 5
        client.delete(f'/api/jobs/{job_id}/layout-classes/5', headers=ALICE)
        assert client.post(f'/api/jobs/{job_id}/layout-classes', headers=ALICE,
                           json={'name': 'Stamp'}).json()['id'] == 6

    def test_a_class_merged_into_another_hands_it_its_elements(self, client, conn, letters):
        job_id, page_id = letters
        client.delete(f'/api/jobs/{job_id}/layout-classes/3?into=2', headers=ALICE)
        assert self.classes_of_elements(conn, page_id) == [('Body', 'Body', 'content')] * 3
        assert [c[1] for c in dataset_classes(conn, job_id)] == ['Salutation', 'Body', 'Panel']

    def test_a_viewer_cannot_change_them(self, client, conn, letters):
        job_id, _ = letters
        conn.execute("INSERT INTO job_assignees (job_id, username) VALUES (?, 'vera')", (job_id,))
        assert client.get(f'/api/jobs/{job_id}/layout-classes', headers=VIEWER).status_code == 200
        assert client.post(f'/api/jobs/{job_id}/layout-classes', headers=VIEWER,
                           json={'name': 'Seal'}).status_code == 403
        assert [c[1] for c in dataset_classes(conn, job_id)] == ['Salutation', 'Body', 'Signature', 'Panel']

    def test_the_order_changes_and_the_ids_stay(self, client, conn, letters):
        job_id, _ = letters
        listed = client.put(f'/api/jobs/{job_id}/layout-classes/order', headers=ALICE, json={'order': [4, 3, 2, 1]})
        assert [(c['id'], c['name']) for c in listed.json()['classes']] == [
            (4, 'Panel'), (3, 'Signature'), (2, 'Body'), (1, 'Salutation')]


class TestSchematismusDatasets:
    @pytest.fixture
    def volume(self, client):
        return upload(client, 'Volume').json()['job_id']

    def test_a_schematismus_class_can_be_recoloured_and_nothing_else(self, client, conn, volume):
        column = layout_classes.CLASS_NAMES.index('Column') + 1
        assert client.patch(f'/api/jobs/{volume}/layout-classes/{column}', headers=ALICE,
                            json={'color': '#336699'}).status_code == 200
        for change in ({'name': 'Spalte'}, {'role': 'content'}, {'reads': 'across'}):
            response = client.patch(f'/api/jobs/{volume}/layout-classes/{column}', headers=ALICE, json=change)
            assert response.status_code == 409 and 'Schematismus class' in response.json()['detail']
        assert client.delete(f'/api/jobs/{volume}/layout-classes/{column}', headers=ALICE).status_code == 409
        found = next(c for c in client.get(f'/api/jobs/{volume}/layout-classes', headers=ALICE).json()['classes']
                     if c['id'] == column)
        assert (found['name'], found['color'], found['builtin']) == ('Column', '#336699', True)

    def test_an_added_container_nests_inside_the_schematismus_ones(self, client, conn, volume):
        added = client.post(f'/api/jobs/{volume}/layout-classes', headers=ALICE,
                            json={'name': 'Box', 'role': 'container', 'reads': 'across'})
        assert added.json()['id'] == 15 and not added.json()['builtin']
        rules = layout_templates.vocabulary(conn, volume).reading_rules()
        assert rules.schematismus and rules.levels['Box'] < rules.levels['Curly'] and rules.reads == {'Box': 'across'}
        # A Column holding a Box holding two entries side by side: the Box reads across.
        boxes = [[0.0, 0.0, 0.5, 1.0], [0.0, 0.1, 0.5, 0.3], [0.3, 0.15, 0.45, 0.2], [0.05, 0.16, 0.2, 0.21]]
        order = reading_order.page_order(boxes, ['Column', 'Box', 'Paragraph', 'Paragraph'], [], rules=rules)
        assert order.content == [3, 2] and order.containers == [0, 1]


class TestModelLabels:
    @pytest.fixture
    def letters(self, client, conn):
        conn.execute("INSERT INTO models (id, task, name, checkpoint, is_default) VALUES (7, 'layout', 'Schematismus RF-DETR', '/l.pt', 1)")
        conn.commit()
        return upload(client, 'Letters 1', layout_template_id=str(template(client)['id'])).json()['job_id']

    def plan(self, response):
        return {p['label']: (p['how'], p['class_id']) for p in response.json()['labels']}

    def test_a_label_without_a_class_of_its_name_is_undecided_until_mapped_or_skipped(self, client, letters):
        before = self.plan(client.get(f'/api/jobs/{letters}/layout-labels', headers=ALICE))
        assert set(before) == set(layout_classes.CLASS_NAMES)
        assert set(before.values()) == {('undecided', None)}

        decided = client.put(f'/api/jobs/{letters}/layout-labels', headers=ALICE, json={
            'model_id': 7, 'choices': [{'label': 'Paragraph', 'class_id': 2}, {'label': 'PageNumber', 'class_id': None}]})
        after = self.plan(decided)
        assert after['Paragraph'] == ('mapped', 2) and after['PageNumber'] == ('skipped', None)
        assert after['Column'] == ('undecided', None)
        assert self.plan(client.get(f'/api/jobs/{letters}/layout-labels?model_id=7', headers=ALICE)) == after

    def test_a_label_matching_a_class_by_name_needs_no_decision(self, client, conn):
        conn.execute("INSERT INTO models (id, task, name, checkpoint, is_default) VALUES (7, 'layout', 'Schematismus RF-DETR', '/l.pt', 1)")
        job_id = upload(client, 'Volume').json()['job_id']
        plan = self.plan(client.get(f'/api/jobs/{job_id}/layout-labels', headers=ALICE))
        assert {how for how, _ in plan.values()} == {'name'}

    def test_a_class_the_dataset_lacks_is_refused(self, client, letters):
        response = client.put(f'/api/jobs/{letters}/layout-labels', headers=ALICE,
                              json={'model_id': 7, 'choices': [{'label': 'Paragraph', 'class_id': 99}]})
        assert response.status_code == 400
        assert self.plan(client.get(f'/api/jobs/{letters}/layout-labels', headers=ALICE))['Paragraph'] == ('undecided', None)


class TestTrainingAcrossClassSets:
    """A layout model can be carried to other classes - its training learns its
    datasets' classes, and a base trained on others is warned to start its head afresh."""

    @pytest.fixture
    def material(self, tmp_path, monkeypatch, conn):
        from PIL import Image
        monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path / 'trainings')
        monkeypatch.setattr('app.preflight.input_size', lambda conn, request: (None, None))
        monkeypatch.setattr('app.preflight.default_epochs', lambda conn, task, base_model_id: None)
        letters = conn.execute("INSERT INTO layout_templates (name, owner) VALUES ('Letters', 'alice')").lastrowid
        layout_templates.insert_classes(conn, 'layout_template_classes', 'template_id', letters, [
            {'id': 1, 'name': 'Body', 'role': 'content', 'reads': None, 'color': None, 'position': 0},
            {'id': 2, 'name': 'Paragraph', 'role': 'content', 'reads': None, 'color': None, 'position': 1}])
        for job_id, template, boxes in (('vol', None, ['Paragraph', 'Header']), ('let', letters, ['Body', 'Paragraph'])):
            conn.execute("INSERT INTO jobs (id, name, owner, status) VALUES (?, ?, 'root', 'done')", (job_id, job_id))
            layout_templates.copy_into(conn, job_id, template)
            scan = tmp_path / f'{job_id}.png'
            Image.new('RGB', (100, 100), 'white').save(scan)
            page_id = conn.execute(
                'INSERT INTO pages (job_id, idx, filename, source_file, content_hash, width, height, status, '
                "layout_checked) VALUES (?, 0, ?, ?, ?, 100, 100, 'done', 1)",
                (job_id, f'{job_id}.png', str(scan), f'hash-{job_id}')).lastrowid
            for i, name in enumerate(boxes):
                conn.execute("INSERT INTO elements (page_id, order_idx, class_name, raw_class_name, bbox, kind) "
                             "VALUES (?, ?, ?, ?, '[0.1, 0.1, 0.5, 0.5]', 'content')", (page_id, i, name, name))
        conn.commit()
        return conn

    def test_datasets_that_agree_on_every_id_keep_them(self, material):
        conn = material
        conn.execute("INSERT INTO jobs (id, name, owner, status) VALUES ('vol2', 'vol2', 'root', 'done')")
        layout_templates.copy_into(conn, 'vol2')
        categories, remap = layout_templates.training_classes(conn, ['vol', 'vol2'])
        assert categories == coco.categories()
        assert remap['vol'] == remap['vol2'] == {i: i for i in range(1, 15)}

    def test_datasets_of_other_classes_are_merged_by_name_and_renumbered(self, material):
        categories, remap = layout_templates.training_classes(material, ['let', 'vol'])
        names = [c['name'] for c in categories]
        assert names[:2] == ['Body', 'Paragraph'] and len(names) == 15 and names.count('Paragraph') == 1
        assert [c['id'] for c in categories] == list(range(1, 16))
        paragraph = layout_classes.CLASS_NAMES.index('Paragraph') + 1
        assert remap['let'] == {1: 1, 2: 2} and remap['vol'][paragraph] == 2

    def test_the_snapshot_carries_the_merged_classes_and_the_manifest_names_them(self, material):
        from app import config, remote_training, train_snapshot
        train_snapshot.build(material, 5, 'layout', ['let', 'vol'], 0.0)
        snapshot = config.training_dir(5) / 'snapshot'
        doc = json.loads((snapshot / 'train' / '_annotations.coco.json').read_text())
        by_id = {c['id']: c['name'] for c in doc['categories']}
        assert sorted(by_id[a['category_id']] for a in doc['annotations']) == ['Body', 'Header', 'Paragraph', 'Paragraph']
        assert remote_training.snapshot_classes(snapshot)[:2] == ['Body', 'Paragraph']

    def test_a_base_of_other_classes_is_warned_to_start_its_head_afresh(self, material):
        from app import preflight
        material.execute("INSERT INTO models (id, task, name, checkpoint, classes) VALUES "
                         "(8, 'layout', 'Letters model', '/l.pt', ?)",
                         (json.dumps([{'id': 1, 'name': 'Body'}, {'id': 2, 'name': 'Paragraph'}]),))
        material.commit()
        same = preflight.compute(material, {'task': 'layout', 'dataset_job_ids': ['let'], 'base_model_id': 8,
                                            'val_fraction': 0.0})
        assert 'fresh_head' not in [f['code'] for f in same['findings']]
        other = preflight.compute(material, {'task': 'layout', 'dataset_job_ids': ['vol'], 'base_model_id': 8,
                                             'val_fraction': 0.0})
        warning = next(f for f in other['findings'] if f['code'] == 'fresh_head')
        assert warning['level'] == 'warn' and 'not in these datasets: Body' in warning['message']
        assert 'classification head starts afresh' in warning['message']
