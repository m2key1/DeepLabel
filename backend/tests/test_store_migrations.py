"""store.connect() creates the schema AND runs the idempotent ALTER TABLE migrations,
so these guard the columns line tracing depends on: regions.kind and jobs.line_width.
"""
import json
import sqlite3

import pytest

from app import store


def cols(conn, table: str) -> set:
    return {row[1] for row in conn.execute(f'PRAGMA table_info({table})')}


def strip_column(db_path, table: str, keep: list[str]):
    """Rebuild `table` with only `keep`, simulating a database from before a migration."""
    raw = sqlite3.connect(db_path)
    raw.execute(f"CREATE TABLE _old AS SELECT {', '.join(keep)} FROM {table}")
    raw.execute(f'DROP TABLE {table}')
    raw.execute(f'ALTER TABLE _old RENAME TO {table}')
    # CREATE TABLE AS drops the key a real older table still has, which foreign keys need.
    if 'id' in keep:
        raw.execute(f'CREATE UNIQUE INDEX _old_{table}_id ON {table}(id)')
    raw.commit()
    raw.close()


class TestMigrations:
    def test_fresh_database_has_the_new_columns(self, tmp_path):
        conn = store.connect(tmp_path / 'app.db')
        assert 'kind' in cols(conn, 'regions')
        assert 'line_width' in cols(conn, 'jobs')
        assert cols(conn, 'augmentation_pipelines') >= {'id', 'task', 'name', 'owner', 'spec', 'is_default',
                                                        'created_at', 'updated_at'}
        conn.close()

    def test_the_reference_image_table_is_there_with_its_scopes(self, tmp_path):
        conn = store.connect(tmp_path / 'app.db')
        assert cols(conn, 'llm_references') >= {'id', 'owner', 'job_id', 'order_idx',
                                                'filename', 'mime', 'bytes', 'digest'}
        conn.close()

    def test_the_corpus_tables_are_there(self, tmp_path):
        conn = store.connect(tmp_path / 'app.db')
        assert cols(conn, 'job_documents') >= {'id', 'job_id', 'idx', 'name', 'text',
                                               'created_at'}
        assert cols(conn, 'gt_reads') >= {'id', 'page_id', 'job_id', 'llm_model_id', 'model',
                                          'label', 'status', 'raw_text', 'error',
                                          'prompt_hash', 'requested_by'}
        conn.close()

    def test_pages_carry_the_reference_columns(self, tmp_path):
        conn = store.connect(tmp_path / 'app.db')
        assert cols(conn, 'pages') >= {'reference_text', 'reference_document',
                                       'reference_anchors', 'reference_score'}
        assert cols(conn, 'jobs') >= {'gt_prompt', 'reference_overlap'}
        conn.close()

    def test_a_database_from_before_the_corpus_gains_its_columns(self, tmp_path):
        """The reference columns are added by ALTER, so an instance that has been running
        since before them has to pick them up on the next open rather than on a rebuild."""
        db = tmp_path / 'app.db'
        conn = store.connect(db)
        conn.execute("INSERT INTO jobs (id, name, owner) VALUES ('j1', 'old set', 'alice')")
        conn.execute("INSERT INTO pages (job_id, idx, filename, source_file, gt_text) "
                     "VALUES ('j1', 0, 'a.png', '/a.png', 'written by hand')")
        conn.commit()
        conn.close()
        strip_column(db, 'pages', ['id', 'job_id', 'idx', 'filename', 'source_file',
                                   'status', 'deleted', 'gt_text'])
        strip_column(db, 'jobs', ['id', 'name', 'owner', 'status'])

        conn = store.connect(db)
        assert cols(conn, 'pages') >= {'reference_text', 'reference_document',
                                       'reference_anchors', 'reference_score'}
        assert cols(conn, 'jobs') >= {'gt_prompt', 'reference_overlap'}
        page = conn.execute('SELECT gt_text, gt_source, reference_anchors FROM pages').fetchone()
        assert page['gt_text'] == 'written by hand'
        assert page['gt_source'] == 'sidecar'   # backfilled: there was no other source then
        assert page['reference_anchors'] == 0
        assert conn.execute(
            'SELECT reference_overlap FROM jobs').fetchone()['reference_overlap'] == 2
        conn.close()

    def test_reading_order_is_carried_by_the_dataset_and_may_be_overridden_per_page(self, tmp_path):
        conn = store.connect(tmp_path / 'app.db')

        assert 'reading_order' in cols(conn, 'jobs')
        assert 'reading_order' in cols(conn, 'pages')
        conn.execute("INSERT INTO jobs (id, name) VALUES ('j1', 'Volume')")
        assert conn.execute("SELECT reading_order FROM jobs WHERE id = 'j1'").fetchone()[0] == 'auto'

    def test_a_dataset_from_before_it_gains_the_column(self, tmp_path):
        """The CREATE TABLE has it, so a fresh database does too - but every existing
        one reaches it through the ALTER, and without that every page of them 500s."""
        db = tmp_path / 'app.db'
        conn = store.connect(db)
        conn.execute("INSERT INTO jobs (id, name) VALUES ('j1', 'Volume')")
        conn.commit()
        conn.close()
        strip_column(db, 'jobs', ['id', 'name', 'owner', 'status', 'created_at'])

        conn = store.connect(db)

        assert 'reading_order' in cols(conn, 'jobs')
        assert conn.execute("SELECT reading_order FROM jobs WHERE id = 'j1'").fetchone()[0] == 'auto'

    def test_a_database_from_before_it_gains_the_columns(self, tmp_path):
        db = tmp_path / 'app.db'
        conn = store.connect(db)
        conn.execute("INSERT INTO jobs (id, name) VALUES ('j1', 'Volume')")
        conn.execute("INSERT INTO pages (id, job_id, idx, filename, source_file) "
                     "VALUES (1, 'j1', 0, 'p.png', '/p.png')")
        conn.commit()
        conn.close()
        strip_column(db, 'pages', ['id', 'job_id', 'idx', 'filename', 'source_file', 'status'])

        conn = store.connect(db)

        assert 'reading_order' in cols(conn, 'pages')
        assert conn.execute('SELECT reading_order FROM pages WHERE id = 1').fetchone()[0] is None

    def test_a_database_from_before_corrections_named_their_author_gains_the_column(self, tmp_path):
        db = tmp_path / 'app.db'
        conn = store.connect(db)
        conn.execute("INSERT INTO jobs (id, name) VALUES ('j1', 'Volume')")
        conn.execute("INSERT INTO pages (id, job_id, idx, filename, source_file) "
                     "VALUES (1, 'j1', 0, 'p.png', '/p.png')")
        conn.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox) "
                     "VALUES (1, 1, 0, 'Paragraph', '[0,0,1,1]')")
        conn.execute("INSERT INTO lines (id, element_id, order_idx, polygon, text, corrected_text) "
                     "VALUES (1, 1, 0, '[]', 'Frst line', 'First line')")
        conn.commit()
        conn.close()
        strip_column(db, 'lines', ['id', 'element_id', 'order_idx', 'polygon', 'text', 'corrected_text'])

        conn = store.connect(db)

        assert 'corrected_by' in cols(conn, 'lines')
        # Nobody is on record for a correction from before, and nobody is read as a person.
        assert conn.execute('SELECT corrected_by FROM lines WHERE id = 1').fetchone()[0] is None

    def test_text_a_model_read_decomposed_is_stored_composed_once(self, tmp_path):
        db = tmp_path / 'app.db'
        conn = store.connect(db)
        conn.execute("INSERT INTO jobs (id, name) VALUES ('j1', 'Volume')")
        conn.execute("INSERT INTO pages (id, job_id, idx, filename, source_file) "
                     "VALUES (1, 'j1', 0, 'p.png', '/p.png')")
        conn.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox) "
                     "VALUES (1, 1, 0, 'Paragraph', '[0,0,1,1]')")
        conn.execute("INSERT INTO lines (id, element_id, order_idx, polygon, text, corrected_text) "
                     "VALUES (1, 1, 0, '[]', 'Ma\u0308rz', 'Ju\u0308li'), (2, 1, 1, '[]', 'April', NULL)")
        conn.execute(f'PRAGMA user_version = {store.TEXT_COMPOSED - 1}')
        conn.commit()
        conn.close()

        conn = store.connect(db)

        assert [tuple(r) for r in conn.execute('SELECT text, corrected_text FROM lines ORDER BY id')] == [
            ('M\u00e4rz', 'J\u00fcli'), ('April', None)]
        assert conn.execute('PRAGMA user_version').fetchone()[0] == store.TEXT_COMPOSED

    # What each table held in the commit that created it, read out of this repo's own
    # history. Every deployment has at least these columns; anything the schema has
    # gained since has to reach an existing database through a guarded ALTER, and a
    # column that never got one is invisible until a live database answers 500 on it.
    ORIGINAL_COLUMNS = {
        'augmentation_pipelines': ['created_at', 'id', 'is_default', 'name', 'owner', 'spec', 'task', 'updated_at'],
        'candidates': ['author', 'checked', 'created_at', 'dismissed', 'id', 'line_id', 'llm_model_id', 'order_idx', 'page_id', 'polygon', 'similarity', 'source', 'text'],
        'elements': ['bbox', 'checked', 'class_name', 'conf', 'deleted', 'id', 'kind', 'lines_bbox', 'order_idx', 'page_id', 'raw_class_name'],
        'eval_lines': ['confidence', 'cer', 'decode', 'distance', 'evaluation_id', 'ground_truth', 'job_id', 'length', 'line_id', 'ops', 'page_id', 'prediction'],
        'evaluations': ['cer', 'created_at', 'decode', 'error', 'id', 'line_count', 'model_id', 'owner', 'pid', 'source', 'status', 'training_id', 'wer'],
        'group_assignees': ['group_id', 'username'],
        'groups': ['created_at', 'id', 'name', 'owner'],
        'gt_reads': ['completion_tokens', 'created_at', 'error', 'finished_at', 'id', 'job_id', 'label', 'llm_model_id', 'model', 'page_id', 'prompt_hash', 'prompt_tokens', 'raw_text', 'requested_by', 'status'],
        'job_assignees': ['job_id', 'username'],
        'job_classes': ['class_id', 'color', 'job_id', 'name', 'priority_rank'],
        'job_documents': ['created_at', 'id', 'idx', 'job_id', 'name', 'text'],
        'job_layout_classes': ['class_id', 'color', 'job_id', 'name', 'position', 'reads', 'role'],
        'job_maps': ['content_hash', 'deleted', 'filename', 'height', 'id', 'idx', 'job_id', 'n_tiles', 'source_file', 'status', 'width'],
        'jobs': ['checked', 'counters', 'created_at', 'error', 'id', 'line_mode', 'name', 'owner', 'phase', 'pid', 'source_path', 'status'],
        'layout_label_maps': ['class_id', 'job_id', 'label', 'model_id'],
        'layout_template_classes': ['class_id', 'color', 'name', 'position', 'reads', 'role', 'template_id'],
        'layout_templates': ['created_at', 'id', 'is_default', 'name', 'owner', 'rules'],
        'lines': ['checked', 'conf_profile', 'confidence', 'corrected_text', 'deleted', 'element_id', 'id', 'order_idx', 'polygon', 'text'],
        'llm_connections': ['api_key', 'api_key_hint', 'base_url', 'created_at', 'id', 'name', 'owner', 'shared'],
        'llm_models': ['connection_id', 'created_at', 'enabled', 'id', 'label', 'max_image_edge', 'model', 'prompt', 'temperature'],
        'llm_prompts': ['owner', 'prompt', 'updated_at'],
        'llm_read_jobs': ['job_id', 'read_id'],
        'llm_reads': ['completion_tokens', 'content_hash', 'created_at', 'error', 'finished_at', 'id', 'label', 'llm_model_id', 'model', 'prompt_tokens', 'raw_text', 'requested_by', 'status'],
        'llm_references': ['bytes', 'created_at', 'digest', 'filename', 'id', 'job_id', 'mime', 'order_idx', 'owner'],
        'model_files': ['filename', 'model_id', 'role', 'sha256', 'size'],
        'models': ['archived', 'checkpoint', 'created_at', 'id', 'is_default', 'metrics', 'name', 'notes', 'source', 'task', 'trained_from'],
        'pages': ['content_hash', 'deleted', 'filename', 'height', 'id', 'idx', 'job_id', 'layout_checked', 'lines_checked', 'source_file', 'source_page', 'source_pdf', 'status', 'width'],
        'regions': ['checked', 'class_id', 'deleted', 'holes', 'id', 'order_idx', 'page_id', 'points'],
        'review_flags': ['created_at', 'evaluation_id', 'flagged_by', 'line_id'],
        'revisions': ['action', 'author', 'created_at', 'id', 'job_id', 'snapshot', 'target_id', 'target_type'],
        'training_preflights': ['created_at', 'error', 'id', 'owner', 'request', 'result', 'status', 'task'],
        'trainings': ['base_model_id', 'created_at', 'dataset_job_ids', 'epochs', 'error', 'id', 'metrics', 'model_id', 'name', 'owner', 'phase', 'pid', 'slurm_job_id', 'snapshot_counts', 'status', 'target', 'task', 'val_fraction'],
    }

    def test_every_column_added_since_has_a_guarded_alter(self, tmp_path):
        """The CREATE TABLE is what a fresh database gets and the ALTERs are what every
        existing one gets, and only the first is exercised by building a database in a
        test. So this builds one the old way - down to the columns the table was created
        with - and asks the migrations to bring it up to the shape a new one has."""
        fresh = store.connect(tmp_path / 'fresh.db')
        shapes = {table: cols(fresh, table) for table in self.ORIGINAL_COLUMNS}
        fresh.close()

        old = tmp_path / 'old.db'
        store.connect(old).close()
        for table, original in self.ORIGINAL_COLUMNS.items():
            strip_column(old, table, original)

        conn = store.connect(old)

        missing = {table: sorted(shapes[table] - cols(conn, table))
                   for table in self.ORIGINAL_COLUMNS
                   if shapes[table] - cols(conn, table)}
        assert not missing, f'no guarded ALTER for: {missing}'

    def test_a_table_this_build_has_gained_is_named_here(self, tmp_path):
        """A table missing from ORIGINAL_COLUMNS is a table the check above skips, so
        adding one is a decision rather than an omission."""
        conn = store.connect(tmp_path / 'app.db')

        fresh_tables = {row[0] for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")}

        unnamed = fresh_tables - set(self.ORIGINAL_COLUMNS)
        assert not unnamed, (
            f'{sorted(unnamed)} is not in ORIGINAL_COLUMNS, so nothing checks that a column '
            'added to it later can reach an existing database. Add it with the columns it '
            'is created with.')
        assert not set(self.ORIGINAL_COLUMNS) - fresh_tables, 'a named table is gone from the schema'

    def test_reopening_is_idempotent(self, tmp_path):
        db = tmp_path / 'app.db'
        store.connect(db).close()
        conn = store.connect(db)  # would raise "duplicate column" if not guarded
        assert 'kind' in cols(conn, 'regions')
        conn.close()

    def test_backfills_kind_onto_a_pre_migration_regions_table(self, tmp_path):
        db = tmp_path / 'app.db'
        store.connect(db).close()
        strip_column(db, 'regions',
                     ['id', 'page_id', 'order_idx', 'class_id', 'points', 'holes', 'checked', 'deleted'])
        conn = store.connect(db)
        assert 'kind' in cols(conn, 'regions')
        conn.close()

    def test_existing_regions_default_to_polygon(self, tmp_path):
        db = tmp_path / 'app.db'
        store.connect(db).close()
        strip_column(db, 'regions',
                     ['id', 'page_id', 'order_idx', 'class_id', 'points', 'holes', 'checked', 'deleted'])
        raw = sqlite3.connect(db)
        raw.execute('INSERT INTO regions (page_id, order_idx, class_id, points, holes, checked, deleted) '
                    "VALUES (1, 0, 1, '[[0,0],[1,0],[1,1]]', '[]', 1, 0)")
        raw.commit()
        raw.close()
        conn = store.connect(db)
        # Pre-existing rows predate line tracing, so they must read back as polygons.
        assert conn.execute('SELECT kind FROM regions').fetchone()['kind'] == 'polygon'
        conn.close()

    def test_job_line_width_defaults_to_three(self, tmp_path):
        conn = store.connect(tmp_path / 'app.db')
        conn.execute("INSERT INTO jobs (id, name) VALUES ('j1', 'x')")
        job = store.get_job(conn, 'j1')
        assert job['line_width'] == 3
        conn.close()

    def test_gt_source_backfills_existing_transcriptions_as_sidecar(self, tmp_path):
        """Pages transcribed before provenance existed predate the PDF text layer as a
        source, so they must read back as sidecar rather than as an unknown origin the
        alignment phase would then refuse to auto-check."""
        db = tmp_path / 'app.db'
        conn = store.connect(db)
        conn.execute("INSERT INTO jobs (id, name) VALUES ('j1', 'x')")
        conn.execute("INSERT INTO pages (job_id, idx, filename, source_file, gt_text) "
                     "VALUES ('j1', 0, 'p.png', '/p.png', 'Pfarre Wien')")
        conn.execute("INSERT INTO pages (job_id, idx, filename, source_file) "
                     "VALUES ('j1', 1, 'q.png', '/q.png')")
        conn.commit()
        conn.close()
        strip_column(db, 'pages', ['id', 'job_id', 'idx', 'filename', 'source_file', 'gt_text'])

        conn = store.connect(db)
        assert 'gt_source' in cols(conn, 'pages')
        sources = dict(conn.execute('SELECT filename, gt_source FROM pages'))
        assert sources == {'p.png': 'sidecar', 'q.png': None}
        conn.close()

    def test_the_ocr_vote_is_added_and_defaults_to_off(self, tmp_path):
        """A dataset that settled its lines before the choice existed did so with the
        local model excluded, and must keep counting agreement the same way."""
        db = tmp_path / 'app.db'
        conn = store.connect(db)
        conn.execute("INSERT INTO jobs (id, name) VALUES ('j1', 'x')")
        conn.commit()
        conn.close()
        strip_column(db, 'jobs', ['id', 'name'])

        conn = store.connect(db)
        assert 'llm_consensus_with_ocr' in cols(conn, 'jobs')
        assert store.get_job(conn, 'j1')['llm_consensus_with_ocr'] is False
        conn.close()

    def test_gt_from_pdf_is_added_and_defaults_to_off(self, tmp_path):
        """Datasets created before PDF text layers were a ground-truth source must
        not start harvesting them on the next append."""
        db = tmp_path / 'app.db'
        conn = store.connect(db)
        conn.execute("INSERT INTO jobs (id, name) VALUES ('j1', 'x')")
        conn.commit()
        conn.close()
        strip_column(db, 'jobs', ['id', 'name', 'gt_autocheck'])

        conn = store.connect(db)
        assert 'gt_from_pdf' in cols(conn, 'jobs')
        assert conn.execute("SELECT gt_from_pdf FROM jobs WHERE id = 'j1'").fetchone()[0] == 0
        conn.close()


    def test_the_diplomatic_pick_is_added_and_starts_empty(self, tmp_path):
        db = tmp_path / 'app.db'
        conn = store.connect(db)
        conn.execute("INSERT INTO jobs (id, name) VALUES ('j1', 'x')")
        conn.commit()
        conn.close()
        strip_column(db, 'jobs', ['id', 'name'])

        conn = store.connect(db)
        assert 'gt_model_ids' in cols(conn, 'jobs')
        assert store.get_job(conn, 'j1')['gt_model_ids'] == []
        conn.close()


class TestSnapshotProgress:
    def test_snapshot_progress_is_added_and_starts_empty(self, tmp_path):
        """An existing training predates the column and must open without one, rather
        than the schema refusing to migrate around a row that is already there."""
        db = tmp_path / 'app.db'
        conn = store.connect(db)
        conn.execute("INSERT INTO trainings (id, task, name, owner, dataset_job_ids) "
                     "VALUES (1, 'ocr', 'old run', 'root', '[]')")
        conn.commit()
        conn.close()
        strip_column(db, 'trainings', ['id', 'task', 'name', 'owner', 'dataset_job_ids'])

        conn = store.connect(db)
        assert 'snapshot_progress' in cols(conn, 'trainings')
        assert conn.execute('SELECT snapshot_progress FROM trainings WHERE id = 1').fetchone()[0] is None
        conn.close()


class TestTestJobIds:
    def test_test_job_ids_is_added_and_starts_empty(self, tmp_path):
        """A training from before test datasets existed must read back as having none."""
        db = tmp_path / 'app.db'
        conn = store.connect(db)
        conn.execute("INSERT INTO trainings (id, task, name, owner, dataset_job_ids) "
                     "VALUES (1, 'ocr', 'old run', 'root', '[]')")
        conn.commit()
        conn.close()
        strip_column(db, 'trainings', ['id', 'task', 'name', 'owner', 'dataset_job_ids'])

        conn = store.connect(db)
        assert 'test_job_ids' in cols(conn, 'trainings')
        assert conn.execute('SELECT test_job_ids FROM trainings WHERE id = 1').fetchone()[0] == '[]'
        conn.close()


class TestAttempt:
    def test_an_older_training_starts_at_its_first_attempt(self, tmp_path):
        """The column decides who may report on a run, so a row from before it must not
        read back as NULL - every write would then belong to nobody."""
        db = tmp_path / 'app.db'
        conn = store.connect(db)
        conn.execute("INSERT INTO trainings (id, task, name, owner, dataset_job_ids) "
                     "VALUES (1, 'ocr', 'old run', 'root', '[]')")
        conn.commit()
        conn.close()
        strip_column(db, 'trainings', ['id', 'task', 'name', 'owner', 'dataset_job_ids'])

        conn = store.connect(db)
        assert 'attempt' in cols(conn, 'trainings')
        assert conn.execute('SELECT attempt FROM trainings WHERE id = 1').fetchone()[0] == 1
        conn.close()


class TestLanguageModelOutcome:
    def test_an_older_training_gains_the_column_and_has_no_outcome_kept(self, tmp_path):
        """NULL, so the run page falls back to reading the outcome off the run's folder."""
        db = tmp_path / 'app.db'
        conn = store.connect(db)
        conn.execute("INSERT INTO trainings (id, task, name, owner, dataset_job_ids) "
                     "VALUES (1, 'ocr', 'old run', 'root', '[]')")
        conn.commit()
        conn.close()
        strip_column(db, 'trainings', ['id', 'task', 'name', 'owner', 'dataset_job_ids'])

        conn = store.connect(db)
        assert 'lm_build' in cols(conn, 'trainings')
        assert conn.execute('SELECT lm_build FROM trainings WHERE id = 1').fetchone()[0] is None
        conn.close()


class TestSnapshotRegion:
    def test_snapshot_carries_kind(self, tmp_path):
        conn = store.connect(tmp_path / 'app.db')
        conn.execute("INSERT INTO jobs (id, name, task) VALUES ('j1', 'x', 'map_lines')")
        conn.execute("INSERT INTO pages (job_id, idx, filename, source_file) VALUES ('j1', 0, 't.png', '/t.png')")
        page_id = conn.execute('SELECT id FROM pages').fetchone()['id']
        conn.execute('INSERT INTO regions (page_id, order_idx, class_id, points, holes, kind, checked) '
                     "VALUES (?, 0, 1, '[[0,0],[1,1]]', '[]', 'polyline', 1)", (page_id,))
        rid = conn.execute('SELECT id FROM regions').fetchone()['id']
        store.log_region(conn, rid, 'someone', 'create')
        conn.commit()
        snapshot = json.loads(conn.execute(
            "SELECT snapshot FROM revisions WHERE target_type = 'region'").fetchone()['snapshot'])
        assert snapshot['kind'] == 'polyline'
        assert snapshot['points'] == [[0, 0], [1, 1]]
        conn.close()


class TestSnapshotLine:
    def test_snapshot_carries_who_corrected_it(self, tmp_path):
        conn = store.connect(tmp_path / 'app.db')
        conn.execute("INSERT INTO jobs (id, name) VALUES ('j1', 'x')")
        conn.execute("INSERT INTO pages (id, job_id, idx, filename, source_file) VALUES (1, 'j1', 0, 'p.png', '/p.png')")
        conn.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox) VALUES (1, 1, 0, 'Paragraph', '[0,0,1,1]')")
        conn.execute("INSERT INTO lines (id, element_id, order_idx, polygon, text, corrected_text, corrected_by) "
                     "VALUES (1, 1, 0, '[]', 'Frst line', 'First line', 'llm:consensus@2')")
        store.log_line(conn, 1, 'llm:consensus@2', 'update')
        conn.commit()
        snapshot = json.loads(conn.execute(
            "SELECT snapshot FROM revisions WHERE target_type = 'line'").fetchone()['snapshot'])
        assert (snapshot['corrected_text'], snapshot['corrected_by']) == ('First line', 'llm:consensus@2')
        conn.close()


class TestCorrectedByBackfill:
    """A correction from before corrected_by was kept names nobody, and nobody reads as a
    person's - so the eraser spared every consensus and alignment fill-in from back then.
    The revision log knows better: each writer logged the row right after writing it, so
    the newest revision carrying the row's text was logged by whoever wrote that text.
    """

    LEGACY_LINE_COLUMNS = ['id', 'element_id', 'order_idx', 'polygon', 'text', 'corrected_text']

    @staticmethod
    def open_with_a_page(db):
        conn = store.connect(db)
        conn.execute("INSERT INTO jobs (id, name) VALUES ('j1', 'Volume')")
        conn.execute("INSERT INTO pages (id, job_id, idx, filename, source_file) "
                     "VALUES (1, 'j1', 0, 'p.png', '/p.png')")
        conn.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox) "
                     "VALUES (1, 1, 0, 'Paragraph', '[0,0,1,1]')")
        return conn

    @staticmethod
    def add_line(conn, line_id: int, corrected_text: str, corrected_by: str | None = None):
        conn.execute('INSERT INTO lines (id, element_id, order_idx, polygon, text, corrected_text, corrected_by) '
                     "VALUES (?, 1, ?, '[]', 'Frst line', ?, ?)",
                     (line_id, line_id, corrected_text, corrected_by))

    @staticmethod
    def log(conn, line_id: int, author: str, corrected_text: str):
        # Shaped like a line snapshot from before the author was kept: no corrected_by in it.
        store.log_revision(conn, 'line', line_id, 'j1', author, 'update',
                           {'id': line_id, 'text': 'Frst line', 'corrected_text': corrected_text})

    def reopen_from_before_the_backfill(self, conn, db, with_the_column: bool = False):
        """Prod has carried the column since it was added, with NULL on every older row; an
        instance that has not run since then is missing the column too."""
        conn.execute(f'PRAGMA user_version = {store.DECODE_RELABEL}')
        conn.commit()
        conn.close()
        if not with_the_column:
            strip_column(db, 'lines', self.LEGACY_LINE_COLUMNS)
        return store.connect(db)

    @staticmethod
    def author_of(conn, line_id: int):
        return conn.execute('SELECT corrected_by FROM lines WHERE id = ?', (line_id,)).fetchone()[0]

    def test_a_consensus_fill_in_is_signed_by_the_consensus_that_wrote_it(self, tmp_path):
        db = tmp_path / 'app.db'
        conn = self.open_with_a_page(db)
        self.add_line(conn, 1, 'First line')
        self.log(conn, 1, 'llm:consensus@2', 'First line')

        conn = self.reopen_from_before_the_backfill(conn, db)

        assert self.author_of(conn, 1) == 'llm:consensus@2'
        conn.close()

    def test_the_newest_revision_carrying_the_text_names_the_writer(self, tmp_path):
        db = tmp_path / 'app.db'
        conn = self.open_with_a_page(db)
        self.add_line(conn, 1, 'First line')
        self.log(conn, 1, 'llm:consensus@2', 'Fist line')
        self.log(conn, 1, 'alice', 'First line')

        conn = self.reopen_from_before_the_backfill(conn, db)

        assert self.author_of(conn, 1) == 'alice'
        conn.close()

    def test_a_later_revision_with_other_text_does_not_speak_for_the_row(self, tmp_path):
        db = tmp_path / 'app.db'
        conn = self.open_with_a_page(db)
        self.add_line(conn, 1, 'First line')
        self.log(conn, 1, 'llm:consensus@2', 'First line')
        self.log(conn, 1, 'alice', 'Fist line')

        conn = self.reopen_from_before_the_backfill(conn, db)

        assert self.author_of(conn, 1) == 'llm:consensus@2'
        conn.close()

    def test_a_correction_realign_carried_onto_a_redetected_line_stays_nobodys(self, tmp_path):
        """The carrier logged the row under its own name, not the writer's, so its
        revision cannot say whose text that is - and nobody's reads as a person's."""
        db = tmp_path / 'app.db'
        conn = self.open_with_a_page(db)
        self.add_line(conn, 1, 'First line')
        self.log(conn, 1, 'realign:gt@0.95', 'First line')

        conn = self.reopen_from_before_the_backfill(conn, db)

        assert self.author_of(conn, 1) is None
        conn.close()

    def test_a_correction_no_revision_carries_stays_nobodys(self, tmp_path):
        db = tmp_path / 'app.db'
        conn = self.open_with_a_page(db)
        self.add_line(conn, 1, 'First line')
        self.log(conn, 1, 'llm:consensus@2', 'Fist line')
        self.add_line(conn, 2, 'Second line')

        conn = self.reopen_from_before_the_backfill(conn, db)

        assert self.author_of(conn, 1) is None
        assert self.author_of(conn, 2) is None
        conn.close()

    def test_an_author_the_writer_signed_is_kept_while_the_unsigned_row_beside_it_is_filled(self, tmp_path):
        db = tmp_path / 'app.db'
        conn = self.open_with_a_page(db)
        self.add_line(conn, 1, 'First line', corrected_by='bob')
        self.log(conn, 1, 'llm:consensus@2', 'First line')
        self.add_line(conn, 2, 'Second line')
        self.log(conn, 2, 'llm:consensus@2', 'Second line')

        conn = self.reopen_from_before_the_backfill(conn, db, with_the_column=True)

        assert self.author_of(conn, 1) == 'bob'
        assert self.author_of(conn, 2) == 'llm:consensus@2'
        conn.close()

    def test_opening_again_changes_nothing(self, tmp_path):
        db = tmp_path / 'app.db'
        conn = self.open_with_a_page(db)
        self.add_line(conn, 1, 'First line')
        self.log(conn, 1, 'llm:consensus@2', 'First line')
        self.add_line(conn, 2, 'Second line')
        conn = self.reopen_from_before_the_backfill(conn, db)
        first = [self.author_of(conn, 1), self.author_of(conn, 2)]
        conn.close()

        conn = store.connect(db)

        assert [self.author_of(conn, 1), self.author_of(conn, 2)] == first == ['llm:consensus@2', None]
        conn.close()

    def test_it_runs_once_rather_than_scanning_the_lines_on_every_open(self, tmp_path):
        """connect() runs per request, so the backfill is a one-time step: a row left
        unsigned by a later writer names nobody, which reads as a person's."""
        db = tmp_path / 'app.db'
        conn = self.open_with_a_page(db)
        self.add_line(conn, 1, 'First line')
        self.log(conn, 1, 'llm:consensus@2', 'First line')
        conn.commit()
        conn.close()

        conn = store.connect(db)

        assert self.author_of(conn, 1) is None
        conn.close()


class TestEvaluationBreakdown:
    def test_breakdown_is_added_and_starts_empty(self, tmp_path):
        db = tmp_path / 'app.db'
        conn = store.connect(db)
        conn.execute("INSERT INTO models (id, task, name, checkpoint) VALUES (1, 'ocr', 'M', '/c')")
        conn.execute("INSERT INTO evaluations (id, model_id, owner) VALUES (1, 1, 'root')")
        conn.commit()
        conn.close()
        strip_column(db, 'evaluations', ['id', 'model_id', 'owner'])

        conn = store.connect(db)
        assert 'breakdown' in cols(conn, 'evaluations')
        assert conn.execute('SELECT breakdown FROM evaluations WHERE id = 1').fetchone()[0] is None
        conn.close()


class TestDecodeRelabel:
    """'rescored' used to mean whatever the engine felt like: with an LM configured it
    ran beam search, and every job and evaluation recorded the wrong name for what it
    did. The rows are relabelled to what actually ran, once, so past scores stay
    comparable and a later deliberate 'rescored' is not flipped back on the next boot.
    """

    def test_existing_rows_are_relabelled_to_what_they_actually_ran(self, tmp_path):
        db = tmp_path / 'app.db'
        conn = store.connect(db)
        conn.execute("INSERT INTO jobs (id, name, owner, status, ocr_decode) "
                     "VALUES ('j1', 'd', 'root', 'done', 'rescored')")
        conn.execute("INSERT INTO models (id, task, name, source, checkpoint) "
                     "VALUES (1, 'ocr', 'm', 'builtin', '/m.pt')")
        conn.execute("INSERT INTO evaluations (model_id, source, decode, status) "
                     "VALUES (1, '{}', 'rescored', 'done')")
        conn.execute('PRAGMA user_version = 0')
        conn.commit()
        conn.close()

        conn = store.connect(db)
        assert conn.execute("SELECT ocr_decode FROM jobs WHERE id = 'j1'").fetchone()[0] == 'beam'
        assert conn.execute('SELECT decode FROM evaluations').fetchone()[0] == 'beam'
        conn.close()

    def test_a_deliberate_rescored_choice_survives_a_restart(self, tmp_path):
        db = tmp_path / 'app.db'
        conn = store.connect(db)
        conn.execute("INSERT INTO jobs (id, name, owner, status, ocr_decode) "
                     "VALUES ('j2', 'd', 'root', 'done', 'rescored')")
        conn.commit()
        conn.close()

        conn = store.connect(db)
        assert conn.execute("SELECT ocr_decode FROM jobs WHERE id = 'j2'").fetchone()[0] == 'rescored'
        conn.close()

    def test_a_fresh_database_defaults_to_beam(self, tmp_path):
        conn = store.connect(tmp_path / 'app.db')
        conn.execute("INSERT INTO jobs (id, name, owner, status) VALUES ('j3', 'd', 'root', 'done')")
        conn.commit()
        assert conn.execute("SELECT ocr_decode FROM jobs WHERE id = 'j3'").fetchone()[0] == 'beam'
        conn.close()


class TestBuildLmColumn:
    def test_fresh_database_has_the_flag(self, tmp_path):
        conn = store.connect(tmp_path / 'app.db')
        assert 'build_lm' in cols(conn, 'trainings')
        conn.close()

    def test_an_older_database_gains_it_defaulting_off(self, tmp_path):
        db = tmp_path / 'app.db'
        conn = store.connect(db)
        conn.execute("INSERT INTO trainings (id, task, name, target) VALUES (5, 'ocr', 't', 'slurm')")
        conn.commit()
        strip_column(db, 'trainings', ['id', 'task', 'name', 'target'])
        conn.close()

        conn = store.connect(db)
        assert 'build_lm' in cols(conn, 'trainings')
        assert conn.execute('SELECT build_lm FROM trainings WHERE id = 5').fetchone()[0] == 0
        conn.close()


class TestSlurmAccountColumn:
    def test_fresh_database_has_the_column(self, tmp_path):
        conn = store.connect(tmp_path / 'app.db')
        assert 'slurm_account' in cols(conn, 'trainings')
        conn.close()

    def test_an_older_database_gains_it_empty(self, tmp_path):
        """Empty means the cluster-wide account, which is what those runs already used."""
        db = tmp_path / 'app.db'
        conn = store.connect(db)
        conn.execute("INSERT INTO trainings (id, task, name, target) VALUES (5, 'ocr', 't', 'slurm')")
        conn.commit()
        strip_column(db, 'trainings', ['id', 'task', 'name', 'target'])
        conn.close()

        conn = store.connect(db)
        assert 'slurm_account' in cols(conn, 'trainings')
        assert conn.execute('SELECT slurm_account FROM trainings WHERE id = 5').fetchone()[0] == ''
        conn.close()


class TestLlmTables:
    def test_fresh_database_has_the_connection_and_model_tables(self, tmp_path):
        conn = store.connect(tmp_path / 'app.db')
        assert cols(conn, 'llm_connections') == {'id', 'owner', 'name', 'base_url', 'api_key',
                                                 'api_key_hint', 'shared', 'created_at'}
        assert cols(conn, 'llm_models') == {'id', 'connection_id', 'model', 'label', 'prompt',
                                            'temperature', 'max_image_edge', 'max_tokens',
                                            'extra_body', 'max_concurrency', 'enabled',
                                            'created_at'}
        conn.close()

    def test_a_model_table_from_before_gains_its_own_concurrency(self, tmp_path):
        db = tmp_path / 'app.db'
        store.connect(db).close()
        strip_column(db, 'llm_models',
                     ['id', 'connection_id', 'model', 'label', 'prompt', 'temperature'])

        conn = store.connect(db)
        assert 'max_concurrency' in cols(conn, 'llm_models')
        conn.execute("INSERT INTO llm_connections (id, owner, name, base_url) "
                     "VALUES (1, 'alice', 'Local', 'http://vllm:8000/v1')")
        conn.execute("INSERT INTO llm_models (connection_id, model, label) VALUES (1, 'q', 'Q')")
        conn.commit()
        # Unset, so a model nobody has limited still runs under the global ceiling alone.
        assert conn.execute('SELECT max_concurrency FROM llm_models').fetchone()[0] is None
        conn.close()

    def test_who_asked_for_a_reading_is_recorded_beside_it(self, tmp_path):
        db = tmp_path / 'app.db'
        conn = store.connect(db)
        assert cols(conn, 'llm_read_jobs') == {'read_id', 'job_id'}
        conn.close()

        # A database from before it gains the table rather than failing to open.
        raw = sqlite3.connect(db)
        raw.execute('DROP TABLE llm_read_jobs')
        raw.commit()
        raw.close()
        conn = store.connect(db)
        assert conn.execute('SELECT COUNT(*) FROM llm_read_jobs').fetchone()[0] == 0
        conn.close()

    def test_a_database_from_before_the_feature_gains_them(self, tmp_path):
        db = tmp_path / 'app.db'
        store.connect(db).close()
        raw = sqlite3.connect(db)
        raw.execute('DROP TABLE llm_models')
        raw.execute('DROP TABLE llm_connections')
        raw.commit()
        raw.close()

        conn = store.connect(db)
        assert conn.execute('SELECT COUNT(*) FROM llm_connections').fetchone()[0] == 0
        conn.close()

    def test_deleting_a_connection_takes_its_models_with_it(self, tmp_path):
        """The models are meaningless without the endpoint that serves them, and a stale
        model id must never resolve to somebody else's connection."""
        conn = store.connect(tmp_path / 'app.db')
        conn.execute("INSERT INTO llm_connections (id, owner, name, base_url) "
                     "VALUES (1, 'alice', 'Local', 'http://vllm:8000/v1')")
        conn.execute("INSERT INTO llm_models (connection_id, model, label) VALUES (1, 'qwen-vl', 'Qwen')")
        conn.commit()

        conn.execute('DELETE FROM llm_connections WHERE id = 1')
        conn.commit()

        assert conn.execute('SELECT COUNT(*) FROM llm_models').fetchone()[0] == 0
        conn.close()

    def test_a_model_defaults_to_enabled_at_the_cached_rendition_size(self, tmp_path):
        conn = store.connect(tmp_path / 'app.db')
        conn.execute("INSERT INTO llm_connections (id, owner, name, base_url) "
                     "VALUES (1, 'alice', 'Local', 'http://vllm:8000/v1')")
        conn.execute("INSERT INTO llm_models (connection_id, model, label) VALUES (1, 'qwen-vl', 'Qwen')")
        conn.commit()
        row = conn.execute('SELECT enabled, max_image_edge, temperature, prompt FROM llm_models').fetchone()
        assert (row['enabled'], row['max_image_edge'], row['temperature'], row['prompt']) == (1, 1600, 0.0, '')
        conn.close()


class TestCandidatePool:
    def test_fresh_database_has_the_pool_and_the_reads_behind_it(self, tmp_path):
        conn = store.connect(tmp_path / 'app.db')
        assert cols(conn, 'candidates') == {'id', 'page_id', 'line_id', 'source', 'author',
                                            'llm_model_id', 'text', 'order_idx', 'polygon',
                                            'similarity', 'checked', 'dismissed', 'set_aside_at',
                                            'created_at'}
        assert cols(conn, 'llm_reads') >= {'id', 'content_hash', 'llm_model_id', 'model', 'label',
                                           'status', 'raw_text', 'error', 'requested_by'}
        conn.close()

    def test_a_pool_from_before_language_models_gains_the_column(self, tmp_path):
        """The pool shipped a release before the readings did, so a database can hold
        candidates with no model column at all."""
        db = tmp_path / 'app.db'
        store.connect(db).close()
        strip_column(db, 'candidates',
                     ['id', 'page_id', 'line_id', 'source', 'author', 'text', 'order_idx',
                      'polygon', 'similarity', 'checked', 'dismissed', 'created_at'])
        raw = sqlite3.connect(db)
        raw.execute("INSERT INTO candidates (id, page_id, line_id, source, author, text, order_idx, "
                    "polygon, similarity, checked, dismissed, created_at) "
                    "VALUES (5, 1, NULL, 'human', 'alice', 'Kept text', 0, NULL, NULL, 1, 0, '')")
        raw.commit()
        raw.close()

        conn = store.connect(db)
        assert 'llm_model_id' in cols(conn, 'candidates')
        row = conn.execute('SELECT text, llm_model_id FROM candidates WHERE id = 5').fetchone()
        assert (row['text'], row['llm_model_id']) == ('Kept text', None)
        conn.close()

    def test_a_pool_from_before_merges_set_readings_aside_gains_the_revision_column(self, tmp_path):
        """Readings set aside before the column existed were set aside by a re-read, which
        no edit takes back - so NULL is exactly right for them."""
        db = tmp_path / 'app.db'
        store.connect(db).close()
        strip_column(db, 'candidates',
                     ['id', 'page_id', 'line_id', 'source', 'author', 'llm_model_id', 'text',
                      'order_idx', 'polygon', 'similarity', 'checked', 'dismissed', 'created_at'])
        raw = sqlite3.connect(db)
        raw.execute("INSERT INTO candidates (id, page_id, line_id, source, author, llm_model_id, text, "
                    "order_idx, polygon, similarity, checked, dismissed, created_at) "
                    "VALUES (5, 1, NULL, 'llm', 'llm:reader', 1, 'Old word', 0, NULL, NULL, 0, 1, '')")
        raw.commit()
        raw.close()

        conn = store.connect(db)
        row = conn.execute('SELECT dismissed, set_aside_at FROM candidates WHERE id = 5').fetchone()
        assert (row['dismissed'], row['set_aside_at']) == (1, None)
        conn.close()

    def test_a_dataset_from_before_the_feature_reads_with_nothing_and_checks_nothing(self, tmp_path):
        db = tmp_path / 'app.db'
        conn = store.connect(db)
        conn.execute("INSERT INTO jobs (id, name, owner, status) VALUES ('j5', 'Old', 'alice', 'done')")
        conn.commit()
        strip_column(db, 'jobs', ['id', 'name', 'owner', 'status'])
        conn.close()

        conn = store.connect(db)
        job = conn.execute('SELECT * FROM jobs WHERE id = ?', ('j5',)).fetchone()
        assert (job['llm_model_ids'], job['llm_consensus_min'], job['llm_autocheck']) == ('[]', 2, 0)
        conn.close()


class TestPromptColumns:
    def test_fresh_database_carries_the_personal_and_dataset_prompts(self, tmp_path):
        conn = store.connect(tmp_path / 'app.db')
        assert cols(conn, 'llm_prompts') == {'owner', 'prompt', 'updated_at'}
        assert 'llm_prompt' in cols(conn, 'jobs')
        assert {'prompt_hash', 'job_id'} <= cols(conn, 'llm_reads')
        conn.close()

    def test_a_dataset_from_before_prompts_reads_with_the_models_wording(self, tmp_path):
        db = tmp_path / 'app.db'
        conn = store.connect(db)
        conn.execute("INSERT INTO jobs (id, name, owner, status) VALUES ('j9', 'Old', 'alice', 'done')")
        conn.commit()
        strip_column(db, 'jobs', ['id', 'name', 'owner', 'status'])
        conn.close()

        conn = store.connect(db)
        assert conn.execute("SELECT llm_prompt FROM jobs WHERE id = 'j9'").fetchone()[0] == ''
        conn.close()

    def test_a_reading_from_before_prompts_reads_as_taken_under_unknown_wording(self, tmp_path):
        """NULL is what makes it show up as read under a different prompt, which is true:
        nobody recorded which one."""
        db = tmp_path / 'app.db'
        conn = store.connect(db)
        conn.execute("INSERT INTO llm_reads (id, content_hash, llm_model_id, status, raw_text) "
                     "VALUES (3, 'hash', 1, 'done', '[]')")
        conn.commit()
        strip_column(db, 'llm_reads',
                     ['id', 'content_hash', 'llm_model_id', 'model', 'label', 'status',
                      'raw_text', 'error', 'prompt_tokens', 'completion_tokens',
                      'requested_by', 'created_at', 'finished_at'])
        conn.close()

        conn = store.connect(db)
        row = conn.execute('SELECT prompt_hash, job_id FROM llm_reads WHERE id = 3').fetchone()
        assert (row['prompt_hash'], row['job_id']) == (None, None)
        conn.close()

    def test_a_reading_from_before_previous_text_gains_it_empty(self, tmp_path):
        """What a re-read replaces is kept aside while its call is out. A reading from
        before the column has never been sent since, so there is nothing to keep."""
        db = tmp_path / 'app.db'
        conn = store.connect(db)
        conn.execute("INSERT INTO llm_reads (id, content_hash, llm_model_id, status, raw_text) "
                     "VALUES (3, 'hash', 1, 'done', '[\"kept\"]')")
        conn.execute("INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'Old', 'alice', 'done')")
        conn.execute("INSERT INTO pages (id, job_id, idx, filename, source_file, status) "
                     "VALUES (1, 'j1', 0, 'p.png', '/p.png', 'done')")
        conn.execute("INSERT INTO gt_reads (id, page_id, job_id, llm_model_id, status, raw_text) "
                     "VALUES (4, 1, 'j1', 1, 'done', '[\"kept\"]')")
        conn.commit()
        conn.close()
        for table in ('llm_reads', 'gt_reads'):
            strip_column(db, table, TestMigrations.ORIGINAL_COLUMNS[table])

        conn = store.connect(db)
        assert tuple(conn.execute(
            'SELECT raw_text, previous_text FROM llm_reads WHERE id = 3').fetchone()) == ('["kept"]', None)
        assert tuple(conn.execute(
            'SELECT raw_text, previous_text FROM gt_reads WHERE id = 4').fetchone()) == ('["kept"]', None)
        conn.close()


class TestGtOrdered:
    def test_gt_ordered_is_added_and_defaults_to_off(self, tmp_path):
        """Datasets aligned before reading order counted as evidence keep the strict
        rule: nothing gets checked off on an order the transcription never promised."""
        db = tmp_path / 'app.db'
        conn = store.connect(db)
        conn.execute("INSERT INTO jobs (id, name) VALUES ('j1', 'x')")
        conn.commit()
        conn.close()
        strip_column(db, 'jobs', ['id', 'name', 'gt_autocheck'])

        conn = store.connect(db)
        assert 'gt_ordered' in cols(conn, 'jobs')
        assert conn.execute("SELECT gt_ordered FROM jobs WHERE id = 'j1'").fetchone()[0] == 0
        conn.close()


class TestModelRequestOptions:
    def test_fresh_database_has_them(self, tmp_path):
        conn = store.connect(tmp_path / 'app.db')
        assert {'max_tokens', 'extra_body'} <= cols(conn, 'llm_models')
        conn.close()

    def test_a_model_from_before_them_sends_nothing_extra(self, tmp_path):
        db = tmp_path / 'app.db'
        conn = store.connect(db)
        conn.execute("INSERT INTO llm_connections (id, owner, name, base_url) "
                     "VALUES (1, 'alice', 'Local', 'http://vllm:8000/v1')")
        conn.execute("INSERT INTO llm_models (id, connection_id, model, label) "
                     "VALUES (7, 1, 'qwen', 'Qwen')")
        conn.commit()
        strip_column(db, 'llm_models',
                     ['id', 'connection_id', 'model', 'label', 'prompt', 'temperature',
                      'max_image_edge', 'enabled', 'created_at'])
        conn.close()

        conn = store.connect(db)
        row = conn.execute('SELECT max_tokens, extra_body FROM llm_models WHERE id = 7').fetchone()
        assert (row['max_tokens'], row['extra_body']) == (None, '{}')
        conn.close()


class TestATurnedScan:
    def test_fresh_database_records_the_turn_and_where_the_original_is(self, tmp_path):
        conn = store.connect(tmp_path / 'app.db')
        assert {'rotation', 'origin_file'} <= cols(conn, 'pages')
        conn.close()

    def test_a_page_from_before_turning_reads_as_never_turned(self, tmp_path):
        """Its scan is the one that arrived, which is exactly what rotation 0 means."""
        db = tmp_path / 'app.db'
        conn = store.connect(db)
        conn.execute("INSERT INTO jobs (id, name) VALUES ('j1', 'x')")
        conn.execute("INSERT INTO pages (id, job_id, idx, filename, source_file) "
                     "VALUES (1, 'j1', 0, 'p.png', '/data/p.png')")
        conn.commit()
        conn.close()
        strip_column(db, 'pages', ['id', 'job_id', 'idx', 'filename', 'source_file'])

        conn = store.connect(db)
        row = conn.execute('SELECT rotation, origin_file, source_file FROM pages WHERE id = 1').fetchone()
        assert (row['rotation'], row['origin_file'], row['source_file']) == (0, None, '/data/p.png')
        conn.close()


class TestModelInputSize:
    """What a model resizes a line to, so the viewer can say a line is being upscaled eight
    times before it is read. Null until something has loaded the checkpoint: the app venv is
    torch-free and cannot open one to ask."""

    def test_fresh_database_has_the_columns(self, tmp_path):
        conn = store.connect(tmp_path / 'app.db')
        assert {'target_height', 'max_width'} <= cols(conn, 'models')
        conn.close()

    def test_an_older_database_gains_them_empty(self, tmp_path):
        db = tmp_path / 'app.db'
        conn = store.connect(db)
        conn.execute("INSERT INTO models (id, task, name, checkpoint) VALUES (9, 'ocr', 'm', '/c.pt')")
        conn.commit()
        strip_column(db, 'models', ['id', 'task', 'name', 'source', 'checkpoint'])
        conn.close()

        conn = store.connect(db)
        assert {'target_height', 'max_width'} <= cols(conn, 'models')
        assert tuple(conn.execute(
            'SELECT target_height, max_width FROM models WHERE id = 9').fetchone()) == (None, None)
        conn.close()

    def test_the_backend_fills_them_in_once_and_does_not_fight_a_later_edit(self, tmp_path):
        from app import registry
        conn = store.connect(tmp_path / 'app.db')
        conn.execute("INSERT INTO models (id, task, name, checkpoint) VALUES (9, 'ocr', 'm', '/c.pt')")
        conn.commit()

        registry.note_model_facts(conn, 9, {'target_height': 256, 'max_width': 6144}, [])
        assert tuple(conn.execute(
            'SELECT target_height, max_width FROM models WHERE id = 9').fetchone()) == (256, 6144)

        # A model already described is left alone, so a hand-set value survives every run.
        registry.note_model_facts(conn, 9, {'target_height': 128, 'max_width': 3072}, [])
        assert tuple(conn.execute(
            'SELECT target_height, max_width FROM models WHERE id = 9').fetchone()) == (256, 6144)
        conn.close()


class TestRetiredClassIdColumn:
    def test_fresh_database_has_the_column(self, tmp_path):
        conn = store.connect(tmp_path / 'app.db')
        assert 'max_retired_class_id' in cols(conn, 'jobs')
        conn.close()

    def test_an_older_database_gains_it_at_zero(self, tmp_path):
        """Zero retires nothing: ids that ever tagged a region are still found in the
        regions and their revisions, so only empty classes deleted before it are lost."""
        db = tmp_path / 'app.db'
        conn = store.connect(db)
        conn.execute("INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'm', 'root', 'done')")
        conn.commit()
        strip_column(db, 'jobs', TestMigrations.ORIGINAL_COLUMNS['jobs'])
        conn.close()

        conn = store.connect(db)
        assert conn.execute("SELECT max_retired_class_id FROM jobs WHERE id = 'j1'").fetchone()[0] == 0
        conn.close()


class TestTrainingPreflights:
    def test_fresh_database_has_the_table_and_the_link(self, tmp_path):
        conn = store.connect(tmp_path / 'app.db')
        assert cols(conn, 'training_preflights') >= {'id', 'owner', 'task', 'request', 'status',
                                                      'result', 'error', 'created_at'}
        assert 'preflight_id' in cols(conn, 'trainings')
        conn.close()

    def test_an_older_database_gains_the_link_unset(self, tmp_path):
        """Runs from before the pre-flight have none on record, and their pages say so."""
        db = tmp_path / 'app.db'
        conn = store.connect(db)
        conn.execute("INSERT INTO trainings (id, task, name) VALUES (1, 'ocr', 'old run')")
        conn.commit()
        conn.close()
        strip_column(db, 'trainings', ['id', 'task', 'name', 'owner', 'status', 'dataset_job_ids',
                                       'created_at'])
        raw = sqlite3.connect(db)
        raw.execute('DROP TABLE training_preflights')
        raw.commit()
        raw.close()

        conn = store.connect(db)
        assert conn.execute('SELECT preflight_id FROM trainings WHERE id = 1').fetchone()[0] is None
        assert 'request' in cols(conn, 'training_preflights')
        store.connect(db).close()
        conn.close()


class TestTrainingScaling:
    COLUMNS = {'grad_accum_steps', 'lr_scale', 'batch_fallback', 'resumes', 'metric_info'}

    def test_fresh_database_records_how_a_run_was_scaled(self, tmp_path):
        conn = store.connect(tmp_path / 'app.db')
        assert self.COLUMNS <= cols(conn, 'trainings')
        conn.close()

    def test_an_older_run_gains_them_as_trained_unscaled_and_never_resumed(self, tmp_path):
        db = tmp_path / 'app.db'
        conn = store.connect(db)
        conn.execute("INSERT INTO trainings (id, task, name) VALUES (1, 'ocr', 'old run')")
        conn.commit()
        conn.close()
        strip_column(db, 'trainings', ['id', 'task', 'name', 'owner', 'status', 'dataset_job_ids',
                                       'created_at'])

        conn = store.connect(db)
        assert tuple(conn.execute('SELECT grad_accum_steps, lr_scale, batch_fallback, resumes, metric_info '
                                  'FROM trainings WHERE id = 1').fetchone()) == (None, None, None, 0, None)
        store.connect(db).close()
        conn.close()


class TestTheLineShapeARunTrainedOn:
    def test_fresh_database_records_it(self, tmp_path):
        conn = store.connect(tmp_path / 'app.db')
        assert 'line_shape' in cols(conn, 'trainings')
        conn.close()

    def test_an_older_lines_run_trained_on_its_polygons_and_other_tasks_have_none(self, tmp_path):
        db = tmp_path / 'app.db'
        conn = store.connect(db)
        conn.execute("INSERT INTO trainings (id, task, name) VALUES (1, 'lines', 'old lines'), (2, 'ocr', 'old ocr')")
        conn.commit()
        conn.close()
        strip_column(db, 'trainings', ['id', 'task', 'name', 'owner', 'status', 'dataset_job_ids',
                                       'created_at'])

        conn = store.connect(db)
        assert dict(conn.execute('SELECT id, line_shape FROM trainings').fetchall()) == {1: 'polygon', 2: None}
        conn.execute("UPDATE trainings SET line_shape = 'box' WHERE id = 1")
        conn.commit()
        conn.close()
        conn = store.connect(db)
        assert conn.execute('SELECT line_shape FROM trainings WHERE id = 1').fetchone()[0] == 'box'
        conn.close()


class TestEvaluationLines:
    def test_fresh_database_has_the_line_records_and_review_flags(self, tmp_path):
        conn = store.connect(tmp_path / 'app.db')
        assert cols(conn, 'eval_lines') >= {'evaluation_id', 'line_id', 'job_id', 'page_id',
                                            'decode', 'ground_truth', 'prediction', 'cer',
                                            'distance', 'length', 'confidence', 'ops'}
        assert cols(conn, 'review_flags') >= {'line_id', 'evaluation_id', 'flagged_by',
                                              'created_at'}
        indexes = {row[1] for row in conn.execute("PRAGMA index_list('eval_lines')")}
        assert {'eval_lines_by_cer', 'eval_lines_by_confidence', 'eval_lines_by_length'} <= indexes
        conn.close()

    def test_an_older_database_gains_them_and_keeps_its_evaluations(self, tmp_path):
        db = tmp_path / 'app.db'
        conn = store.connect(db)
        conn.execute("INSERT INTO models (id, task, name, checkpoint) VALUES (1, 'ocr', 'm', '/c')")
        conn.execute("INSERT INTO evaluations (id, model_id, status, cer) VALUES (5, 1, 'done', 0.1)")
        conn.commit()
        conn.close()
        raw = sqlite3.connect(db)
        raw.execute('DROP TABLE eval_lines')
        raw.execute('DROP TABLE review_flags')
        raw.commit()
        raw.close()

        conn = store.connect(db)
        assert 'ops' in cols(conn, 'eval_lines')
        assert 'line_id' in cols(conn, 'review_flags')
        assert conn.execute('SELECT cer FROM evaluations WHERE id = 5').fetchone()[0] == 0.1
        assert conn.execute('SELECT COUNT(*) FROM eval_lines').fetchone()[0] == 0
        store.connect(db).close()
        conn.close()

    def test_deleting_an_evaluation_takes_its_line_records(self, tmp_path):
        conn = store.connect(tmp_path / 'app.db')
        conn.execute("INSERT INTO models (id, task, name, checkpoint) VALUES (1, 'ocr', 'm', '/c')")
        conn.execute("INSERT INTO evaluations (id, model_id) VALUES (5, 1)")
        conn.execute("INSERT INTO eval_lines (evaluation_id, line_id, ground_truth, prediction, "
                     "cer, distance, length, ops) VALUES (5, 1, 'a', 'a', 0, 0, 1, '[]')")
        conn.execute('DELETE FROM evaluations WHERE id = 5')
        assert conn.execute('SELECT COUNT(*) FROM eval_lines').fetchone()[0] == 0
        conn.close()


class TestEvaluationAndPreflightIndexes:
    LOOKUPS = {
        'review_flags_by_evaluation': 'SELECT line_id FROM review_flags WHERE evaluation_id = 1',
        'training_preflights_by_owner':
            "SELECT id FROM training_preflights WHERE owner = 'alice' AND id > 1",
    }

    def plan(self, conn, sql):
        return ' '.join(row[3] for row in conn.execute(f'EXPLAIN QUERY PLAN {sql}'))

    def test_each_lookup_uses_its_index(self, tmp_path):
        conn = store.connect(tmp_path / 'app.db')
        for index, sql in self.LOOKUPS.items():
            assert index in self.plan(conn, sql)
        assert 'USING' in self.plan(conn, 'SELECT line_id FROM eval_lines WHERE evaluation_id = 1')
        conn.close()

    def test_a_database_from_before_the_indexes_gains_them(self, tmp_path):
        db = tmp_path / 'app.db'
        store.connect(db).close()
        raw = sqlite3.connect(db)
        for index in self.LOOKUPS:
            raw.execute(f'DROP INDEX IF EXISTS {index}')
        raw.commit()
        raw.close()

        conn = store.connect(db)
        indexes = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'index'")}
        assert set(self.LOOKUPS) <= indexes
        conn.close()


class TestQueueAndAccessIndexes:
    """The queue page asks for the lines waiting on a re-read every few seconds per open
    tab, and every non-admin list asks which datasets are shared with the caller. Both are
    a scan of the whole table without these."""
    LOOKUPS = {
        'idx_lines_needs_ocr':
            'SELECT j.id, COUNT(*) FROM lines l JOIN elements e ON l.element_id = e.id '
            'JOIN pages p ON e.page_id = p.id JOIN jobs j ON j.id = p.job_id '
            'WHERE l.needs_ocr = 1 AND l.deleted = 0 AND j.run_ocr = 1 GROUP BY j.id',
        'idx_job_assignees_user': "SELECT job_id FROM job_assignees WHERE username = 'alice'",
        'idx_group_assignees_user': "SELECT group_id FROM group_assignees WHERE username = 'alice'",
    }

    def plan(self, conn, sql):
        return ' '.join(row[3] for row in conn.execute(f'EXPLAIN QUERY PLAN {sql}'))

    def test_each_lookup_uses_its_index(self, tmp_path):
        conn = store.connect(tmp_path / 'app.db')
        for index, sql in self.LOOKUPS.items():
            assert index in self.plan(conn, sql), index
        conn.close()

    def test_a_database_from_before_the_indexes_gains_them(self, tmp_path):
        db = tmp_path / 'app.db'
        store.connect(db).close()
        raw = sqlite3.connect(db)
        for index in self.LOOKUPS:
            raw.execute(f'DROP INDEX IF EXISTS {index}')
        raw.commit()
        raw.close()

        conn = store.connect(db)
        indexes = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'index'")}
        assert set(self.LOOKUPS) <= indexes
        conn.close()
        store.connect(db).close()

    def test_a_database_from_before_the_re_read_flag_still_opens(self, tmp_path):
        """The re-read index names a column an old database gains on open, so it has to be
        built after that column is added rather than with the schema."""
        db = tmp_path / 'app.db'
        store.connect(db).close()
        raw = sqlite3.connect(db)
        raw.execute('DROP INDEX IF EXISTS idx_lines_needs_ocr')
        raw.commit()
        raw.close()
        strip_column(db, 'lines', ['id', 'element_id', 'order_idx', 'polygon', 'text'])

        conn = store.connect(db)
        assert 'needs_ocr' in cols(conn, 'lines')
        assert 'idx_lines_needs_ocr' in self.plan(conn, self.LOOKUPS['idx_lines_needs_ocr'])
        conn.close()


class TestPageErrorColumn:
    def test_fresh_database_has_the_column(self, tmp_path):
        conn = store.connect(tmp_path / 'app.db')
        assert 'error' in cols(conn, 'pages')
        conn.close()

    def test_an_older_database_gains_it_empty(self, tmp_path):
        """No page ingested before it was recorded failed: a failure stopped the dataset."""
        db = tmp_path / 'app.db'
        conn = store.connect(db)
        conn.execute("INSERT INTO jobs (id, name) VALUES ('j1', 'd')")
        conn.execute("INSERT INTO pages (id, job_id, idx, filename, source_file, status) "
                     "VALUES (7, 'j1', 0, 'a.png', '/a.png', 'done')")
        conn.commit()
        strip_column(db, 'pages', ['id', 'job_id', 'idx', 'filename', 'source_file', 'status'])
        conn.close()

        conn = store.connect(db)
        assert 'error' in cols(conn, 'pages')
        assert conn.execute('SELECT error FROM pages WHERE id = 7').fetchone()[0] is None
        conn.close()


def test_a_database_from_before_the_weight_store_gains_it(tmp_path):
    db = tmp_path / 'app.db'
    store.connect(db).close()
    strip_column(db, 'models', ['id', 'task', 'name', 'source', 'checkpoint', 'trained_from', 'metrics', 'notes',
                                'is_default', 'archived', 'lm_path', 'lm_dict_path', 'target_height',
                                'max_width', 'created_at'])
    raw = sqlite3.connect(db)
    raw.execute('DROP TABLE model_files')
    raw.commit()
    raw.close()

    conn = store.connect(db)
    store.connect(db).close()
    assert cols(conn, 'models') >= {'backend', 'model_type', 'classes', 'input_size', 'ref'}
    assert cols(conn, 'model_files') == {'model_id', 'role', 'filename', 'sha256', 'size'}
    conn.close()


def test_a_database_from_before_conventions_reads_normalized(tmp_path):
    db = tmp_path / 'app.db'
    conn = store.connect(db)
    conn.execute("INSERT INTO jobs (id, name) VALUES ('j1', 'Volume')")
    conn.commit()
    strip_column(db, 'jobs', ['id', 'name', 'owner', 'status'])
    conn.close()

    conn = store.connect(db)
    store.connect(db).close()
    assert cols(conn, 'jobs') >= {'ocr_convention', 'ocr_convention_read'}
    assert {'conventions', 'family_name'} <= cols(conn, 'models')
    row = conn.execute("SELECT ocr_convention, ocr_convention_read FROM jobs WHERE id = 'j1'").fetchone()
    assert tuple(row) == ('{}', None)
    conn.close()


class TestProvenanceBackfill:
    """Pages read before provenance was kept are credited to their dataset's
    model as it stands - its own pick, else the task default - and a line a person
    created is known from its first revision."""

    def test_existing_pages_and_lines_are_credited_once(self, tmp_path):
        db = tmp_path / 'app.db'
        conn = store.connect(db)
        conn.executescript("""
            INSERT INTO models (id, task, name, checkpoint, is_default) VALUES
                (1, 'layout', 'L', '/l', 1), (2, 'lines', 'D', '/d', 1),
                (3, 'ocr', 'O', '/o', 1), (4, 'ocr', 'Picked', '/p', 0);
            INSERT INTO jobs (id, name, task, model_ocr_id) VALUES ('j1', 'Volume', 'text', 4);
            INSERT INTO jobs (id, name, task) VALUES ('m1', 'Map', 'map_segmentation');
            INSERT INTO pages (id, job_id, idx, filename, source_file) VALUES
                (1, 'j1', 0, 'a.png', '/a'), (2, 'j1', 1, 'b.png', '/b'), (3, 'm1', 0, 't.png', '/t');
            INSERT INTO elements (id, page_id, order_idx, class_name, bbox) VALUES (1, 1, 0, 'P', '[0,0,1,1]');
            INSERT INTO lines (id, element_id, order_idx, polygon, text) VALUES
                (1, 1, 0, '[]', 'Anno'), (2, 1, 1, '[]', NULL);
        """)
        store.log_revision(conn, 'line', 2, 'j1', 'alice', 'create', {'id': 2})
        store.log_revision(conn, 'line', 1, 'j1', 'model:lines@db.pt', 'create', {'id': 1})
        conn.execute('PRAGMA user_version = 2')
        conn.commit()
        conn.close()

        conn = store.connect(db)
        pages = {r['id']: tuple(r) for r in conn.execute(
            'SELECT id, layout_model_id, lines_model_id FROM pages')}
        assert pages == {1: (1, 1, 2), 2: (2, None, None), 3: (3, None, None)}
        lines = {r['id']: tuple(r) for r in conn.execute('SELECT id, ocr_model_id, by_hand FROM lines')}
        assert lines == {1: (1, 4, 0), 2: (2, None, 1)}

        conn.execute('UPDATE pages SET layout_model_id = NULL WHERE id = 1')
        conn.commit()
        conn.close()
        conn = store.connect(db)
        assert conn.execute('SELECT layout_model_id FROM pages WHERE id = 1').fetchone()[0] is None
        conn.close()


def test_a_database_from_before_polygon_elements_keeps_its_boxes(tmp_path):
    db = tmp_path / 'app.db'
    conn = store.connect(db)
    conn.execute("INSERT INTO jobs (id, name) VALUES ('j1', 'Volume')")
    conn.execute("INSERT INTO pages (id, job_id, idx, filename, source_file) VALUES (1, 'j1', 0, 'p.png', '/p.png')")
    conn.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox) VALUES (1, 1, 0, 'Paragraph', '[0,0,1,1]')")
    conn.commit()
    conn.close()
    strip_column(db, 'elements', ['id', 'page_id', 'order_idx', 'class_name', 'bbox'])
    strip_column(db, 'jobs', ['id', 'name'])

    conn = store.connect(db)

    assert conn.execute("SELECT layout_shape FROM jobs WHERE id = 'j1'").fetchone()[0] == 'box'
    assert conn.execute('SELECT polygon FROM elements WHERE id = 1').fetchone()[0] is None


class TestStartedAt:
    """When work left the queue, so the queue can say how long it has been running."""

    @pytest.mark.parametrize('table', ['jobs', 'trainings', 'evaluations'])
    def test_an_older_database_gains_it_empty(self, tmp_path, table):
        db = tmp_path / 'app.db'
        conn = store.connect(db)
        keep = sorted(cols(conn, table) - {'started_at'})
        conn.close()
        strip_column(db, table, keep)

        conn = store.connect(db)
        assert 'started_at' in cols(conn, table)
        conn.close()

    def test_it_is_stamped_once_as_work_starts_and_again_after_a_requeue(self, tmp_path):
        conn = store.connect(tmp_path / 'app.db')
        conn.execute("INSERT INTO jobs (id, name) VALUES ('j1', 'd')")
        conn.commit()
        started = lambda: conn.execute("SELECT started_at FROM jobs WHERE id = 'j1'").fetchone()[0]

        assert started() is None
        store.set_job_state(conn, 'j1', status='running', phase='ingest')
        first = started()
        conn.execute("UPDATE jobs SET started_at = '2026-01-01 00:00:00' WHERE id = 'j1'")
        store.set_job_state(conn, 'j1', status='running', phase='ocr')
        assert first is not None and started() == '2026-01-01 00:00:00'
        store.set_job_state(conn, 'j1', status='queued')
        store.set_job_state(conn, 'j1', status='running')
        assert started() != '2026-01-01 00:00:00'
        conn.close()


def test_a_database_from_before_queued_at_stamps_work_queued_again(tmp_path):
    db = tmp_path / 'app.db'
    conn = store.connect(db)
    conn.execute("INSERT INTO jobs (id, name, status, created_at) VALUES ('j1', 'Volume', 'done', '2025-11-01')")
    conn.commit()
    conn.close()
    raw = sqlite3.connect(db)
    raw.execute('DROP TRIGGER jobs_queued_at')
    raw.execute('ALTER TABLE jobs DROP COLUMN queued_at')
    raw.commit()
    raw.close()

    conn = store.connect(db)
    store.connect(db).close()
    conn.execute("UPDATE jobs SET status = 'queued' WHERE id = 'j1'")
    queued_at, now = conn.execute("SELECT queued_at, datetime('now') FROM jobs WHERE id = 'j1'").fetchone()
    assert queued_at == now
    conn.close()


class TestTestPages:
    def test_a_fresh_database_has_the_flags_off(self, tmp_path):
        conn = store.connect(tmp_path / 'app.db')
        conn.execute("INSERT INTO jobs (id, name) VALUES ('j1', 'Volume')")
        conn.execute("INSERT INTO pages (job_id, idx, filename, source_file) VALUES ('j1', 0, 'a.png', '/a.png')")
        assert conn.execute('SELECT is_test FROM pages').fetchone()[0] == 0
        assert conn.execute('SELECT new_pages_test FROM jobs').fetchone()[0] == 0
        conn.close()

    def test_an_older_database_marks_the_datasets_runs_were_tested_on(self, tmp_path):
        """Before pages were marked, a run named whole datasets as its test set. Their pages
        become test pages, so no later run trains on what an earlier one was scored on."""
        db = tmp_path / 'app.db'
        conn = store.connect(db)
        conn.executescript("""
            INSERT INTO jobs (id, name) VALUES ('test', 'Held out'), ('train', 'Trained on');
            INSERT INTO pages (job_id, idx, filename, source_file) VALUES
                ('test', 0, 'a.png', '/a.png'), ('test', 1, 'b.png', '/b.png'),
                ('train', 0, 'c.png', '/c.png');
            INSERT INTO trainings (task, name, test_job_ids) VALUES ('ocr', 'run', '["test"]');
        """)
        conn.commit()
        conn.close()
        raw = sqlite3.connect(db)
        raw.execute('ALTER TABLE pages DROP COLUMN is_test')
        raw.execute('ALTER TABLE jobs DROP COLUMN new_pages_test')
        raw.commit()
        raw.close()

        conn = store.connect(db)
        store.connect(db).close()
        marked = conn.execute('SELECT job_id, SUM(is_test), COUNT(*) FROM pages GROUP BY job_id ORDER BY job_id').fetchall()
        assert [tuple(r) for r in marked] == [('test', 2, 2), ('train', 0, 1)]
        switches = conn.execute('SELECT id, new_pages_test FROM jobs ORDER BY id').fetchall()
        assert [tuple(r) for r in switches] == [('test', 1), ('train', 0)]
        conn.close()
