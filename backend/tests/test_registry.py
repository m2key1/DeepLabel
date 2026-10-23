import json

import pytest

from app import registry, store
from tests.fakes import seed_defaults


@pytest.fixture
def conn(tmp_path):
    connection = store.connect(tmp_path / 'app.db')
    yield connection
    connection.close()


NO_PICKS = {'model_layout_id': None, 'model_lines_id': None, 'model_ocr_id': None}


def test_a_job_with_no_picks_runs_each_tasks_default(conn):
    seed_defaults(conn)
    defaults = {r['task']: str(r['id']) for r in conn.execute('SELECT * FROM models')}
    assert registry.chosen_models(conn, NO_PICKS) == {
        'LAYOUT_MODEL_ID': defaults['layout'], 'LINES_MODEL_ID': defaults['lines'], 'OCR_MODEL_ID': defaults['ocr']}


def test_a_job_runs_the_model_it_picked(conn):
    seed_defaults(conn)
    cur = conn.execute("INSERT INTO models (task, name, source, checkpoint) VALUES ('ocr', 'finetune', 'trained', '/ckpt/ft.pt')")
    assert registry.chosen_models(conn, {**NO_PICKS, 'model_ocr_id': cur.lastrowid})['OCR_MODEL_ID'] == str(cur.lastrowid)


def test_a_job_whose_pick_is_gone_runs_the_default(conn):
    seed_defaults(conn)
    default_ocr = conn.execute("SELECT id FROM models WHERE task = 'ocr'").fetchone()['id']
    assert registry.chosen_models(conn, {**NO_PICKS, 'model_ocr_id': 999})['OCR_MODEL_ID'] == str(default_ocr)


def test_registering_a_result_scores_the_base_model_beside_it(conn, tmp_path, monkeypatch):
    from app import trainer

    monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path)
    seed_defaults(conn)
    base = conn.execute(
        "SELECT id FROM models WHERE task = 'ocr'").fetchone()['id']
    conn.execute(
        "INSERT INTO trainings (id, task, name, owner, base_model_id, dataset_job_ids) "
        "VALUES (2, 'ocr', 'pairwise', 'eva', ?, '[]')", (base,))
    training = dict(conn.execute('SELECT * FROM trainings WHERE id = 2').fetchone())

    # Both are queued when the result is registered: a baseline scheduled at submit put a
    # long local GPU job beside the snapshot transfer, which is how one machine lost its
    # network and then its memory on 2026-09-11.
    out = tmp_path / 'out2'
    out.mkdir(parents=True)
    (out / trainer.CHECKPOINT_NAME).write_bytes(b'x')
    new_model = trainer.register_result(conn, training, out)

    rows = conn.execute(
        'SELECT model_id, training_id, source, decode, status, owner FROM evaluations '
        'ORDER BY id').fetchall()
    # Every decode is scored for both, so base and result are comparable in each mode.
    from app import decode
    assert [(r['model_id'], r['training_id'], r['source'], r['decode'], r['status'], r['owner'])
            for r in rows] == [
        *[(base, 2, '{"snapshot": 2}', m, 'queued', 'eva') for m in decode.OCR_DECODES],
        *[(new_model, 2, '{"snapshot": 2}', m, 'queued', 'eva') for m in decode.OCR_DECODES],
    ]


def _seed_training_with_valid_split(conn, tmp_path, training_id, base, pairs):
    conn.execute(
        "INSERT INTO trainings (id, task, name, owner, base_model_id, dataset_job_ids) "
        "VALUES (?, 'ocr', ?, 'eva', ?, '[]')", (training_id, f't{training_id}', base))
    valid = tmp_path / str(training_id) / 'snapshot' / 'valid'
    valid.mkdir(parents=True)
    for stem, text in pairs:
        (valid / f'{stem}.txt').write_text(text, encoding='utf-8')
        (valid / f'{stem}.png').write_bytes(b'pixels-' + stem.encode())
    return dict(conn.execute('SELECT * FROM trainings WHERE id = ?', (training_id,)).fetchone())


def test_identical_valid_split_reuses_the_baseline_scores(conn, tmp_path, monkeypatch):
    from app import decode, evaluator

    monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path)
    seed_defaults(conn)
    base = conn.execute("SELECT id FROM models WHERE task = 'ocr'").fetchone()['id']
    pairs = [('line_7', 'Pfarre Wien'), ('line_9', 'Kaplan Huber')]

    first = _seed_training_with_valid_split(conn, tmp_path, 10, base, pairs)
    evaluator.create_baseline(conn, first)
    # Score one mode; only that mode's result should be copied to the identical split.
    scored = conn.execute("SELECT id FROM evaluations WHERE decode = 'beam'").fetchone()['id']
    evaluator.set_state(conn, scored, status='done', cer=0.09, wer=0.49, line_count=2)

    second = _seed_training_with_valid_split(conn, tmp_path, 11, base, pairs)
    evaluator.create_baseline(conn, second)

    rows = conn.execute("SELECT training_id, status, cer, wer, line_count FROM evaluations "
                        "WHERE decode = 'beam' ORDER BY id").fetchall()
    assert [tuple(r) for r in rows] == [
        (10, 'done', 0.09, 0.49, 2),
        (11, 'done', 0.09, 0.49, 2),
    ]
    # The modes with nothing to copy are queued to run, not silently skipped.
    assert conn.execute("SELECT COUNT(*) FROM evaluations WHERE training_id = 11 "
                        "AND status = 'queued'").fetchone()[0] == len(decode.OCR_DECODES) - 1


def test_changed_valid_split_queues_a_fresh_baseline(conn, tmp_path, monkeypatch):
    from app import evaluator

    monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path)
    seed_defaults(conn)
    base = conn.execute("SELECT id FROM models WHERE task = 'ocr'").fetchone()['id']

    first = _seed_training_with_valid_split(conn, tmp_path, 10, base, [('line_7', 'Pfarre Wien')])
    evaluator.create_baseline(conn, first)
    evaluator.set_state(conn, conn.execute('SELECT id FROM evaluations').fetchone()['id'],
                        status='done', cer=0.09, wer=0.49, line_count=1)

    second = _seed_training_with_valid_split(conn, tmp_path, 11, base, [('line_7', 'Pfarre Wein')])
    evaluator.create_baseline(conn, second)

    assert conn.execute(
        "SELECT status FROM evaluations WHERE training_id = 11").fetchone()['status'] == 'queued'


def test_from_scratch_trainings_get_no_baseline(conn, tmp_path, monkeypatch):
    from app import evaluator

    monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path)
    seed_defaults(conn)
    conn.execute(
        "INSERT INTO trainings (id, task, name, owner, dataset_job_ids) "
        "VALUES (3, 'ocr', 'scratch', 'eva', '[]')")
    evaluator.create_baseline(conn, dict(conn.execute(
        'SELECT * FROM trainings WHERE id = 3').fetchone()))
    assert conn.execute('SELECT COUNT(*) n FROM evaluations').fetchone()['n'] == 0


def test_registered_finetune_inherits_the_base_models_lm(conn, tmp_path, monkeypatch):
    from app import trainer

    monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path)
    seed_defaults(conn)
    base = conn.execute(
        "INSERT INTO models (task, name, source, checkpoint, lm_path, lm_dict_path) "
        "VALUES ('ocr', 'base', 'trained', '/ckpt/base.pt', '/lm/base.bin', '/lm/base.dict')").lastrowid
    conn.execute(
        "INSERT INTO trainings (id, task, name, base_model_id, dataset_job_ids) "
        "VALUES (1, 'ocr', 'child', ?, '[]')", (base,))
    out = tmp_path / 'out'
    out.mkdir(parents=True)
    (out / trainer.CHECKPOINT_NAME).write_bytes(b'x')
    model_id = trainer.register_result(conn, dict(conn.execute(
        'SELECT * FROM trainings WHERE id = 1').fetchone()), out)
    child = registry.get_model(conn, model_id)
    assert child['lm_path'] == '/lm/base.bin'
    assert child['lm_dict_path'] == '/lm/base.dict'


class TestALayoutRunsTemplate:
    """A layout run belongs to the template of the datasets it trained on, which hold the
    classes it learned; with no one template among them, to its base's."""

    def register(self, conn, tmp_path, base_template, dataset_templates):
        from app import trainer

        base = conn.execute("INSERT INTO models (task, name, source, checkpoint, layout_template_id) "
                            "VALUES ('layout', 'base', 'trained', '/ckpt/base.pth', ?)", (base_template,)).lastrowid
        for i, template_id in enumerate(dataset_templates):
            conn.execute("INSERT INTO jobs (id, name, owner, layout_template_id) VALUES (?, ?, 'eva', ?)",
                         (f'd{i}', f'Volume {i}', template_id))
        conn.execute("INSERT INTO trainings (id, task, name, base_model_id, dataset_job_ids) "
                     "VALUES (1, 'layout', 'child', ?, ?)",
                     (base, json.dumps([f'd{i}' for i in range(len(dataset_templates))])))
        out = tmp_path / 'out'
        out.mkdir(parents=True)
        (out / trainer.CHECKPOINT_NAME).write_bytes(b'x')
        model_id = trainer.register_result(conn, dict(conn.execute('SELECT * FROM trainings WHERE id = 1').fetchone()), out)
        return registry.get_model(conn, model_id)['layout_template_id']

    def templates(self, conn):
        return [conn.execute("INSERT INTO layout_templates (name, owner) VALUES (?, 'eva')", (name,)).lastrowid
                for name in ('Letters', 'Ledgers')]

    def test_it_belongs_to_its_datasets_template(self, conn, tmp_path, monkeypatch):
        monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path)
        letters, ledgers = self.templates(conn)
        assert self.register(conn, tmp_path, ledgers, [letters, letters]) == letters

    def test_datasets_of_two_templates_leave_it_with_its_bases(self, conn, tmp_path, monkeypatch):
        monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path)
        letters, ledgers = self.templates(conn)
        assert self.register(conn, tmp_path, ledgers, [letters, ledgers]) == ledgers


def _train(conn, name: str, checkpoint: str) -> None:
    conn.execute("INSERT INTO models (task, name, source, checkpoint) VALUES ('ocr', ?, 'trained', ?)",
                 (name, checkpoint))
    conn.commit()


def test_reader_name_tells_apart_two_trainings_that_share_a_file_name(conn):
    _train(conn, 'letters-v03', '/data/trainings/12/output/model.ckpt')
    _train(conn, 'letters-v11', '/data/trainings/17/output/model.ckpt')
    ids = {r['name']: r['id'] for r in conn.execute('SELECT id, name FROM models')}
    assert registry.reader_name(conn, ids['letters-v03']) == 'letters-v03'
    assert registry.reader_name(conn, ids['letters-v11']) == 'letters-v11'


def test_reader_name_falls_back_to_the_id_for_a_model_not_in_the_registry(conn):
    assert registry.reader_name(conn, 404) == 'model 404'


def _job(conn, job_id: str, model_ocr_id=None) -> None:
    conn.execute('INSERT INTO jobs (id, name, model_ocr_id) VALUES (?, ?, ?)',
                 (job_id, job_id, model_ocr_id))
    conn.commit()


def _read_line(conn, job_id: str, line_id: int, author: str) -> None:
    conn.execute("INSERT INTO revisions (job_id, target_type, target_id, author, action, snapshot) "
                 "VALUES (?, 'line', ?, ?, 'ocr', '{}')", (job_id, line_id, author))
    conn.commit()


def test_named_reader_leaves_an_author_that_already_names_its_model(conn):
    assert registry.named_reader('model:ocr@letters-v11', 'letters-v03') == 'model:ocr@letters-v11'


def test_named_reader_replaces_the_training_output_file_and_keeps_the_decode(conn):
    assert registry.named_reader('model:ocr@model.ckpt', 'letters-v03') == 'model:ocr@letters-v03'
    assert registry.named_reader('model:ocr@model.ckpt#greedy', 'letters-v03') == 'model:ocr@letters-v03#greedy'


def test_named_reader_keeps_the_file_name_when_the_dataset_names_no_model(conn):
    assert registry.named_reader('model:ocr@model.ckpt', '') == 'model:ocr@model.ckpt'


def test_job_reader_prefers_the_model_the_dataset_was_given(conn):
    seed_defaults(conn)
    _train(conn, 'letters-v11', '/data/trainings/17/output/model.ckpt')
    chosen = conn.execute("SELECT id FROM models WHERE name = 'letters-v11'").fetchone()['id']
    _job(conn, 'picked', model_ocr_id=chosen)
    assert registry.job_reader(conn, 'picked') == 'letters-v11'


def test_job_reader_names_nothing_where_the_dataset_named_no_model(conn):
    """Today's default is not evidence about what read a page a year ago, and every
    dataset carrying a nameless author has no model pinned."""
    seed_defaults(conn)
    _job(conn, 'unpicked')
    assert registry.job_reader(conn, 'unpicked') == ''
    _read_line(conn, 'unpicked', 5, 'model:ocr@model.ckpt')
    assert registry.line_readers(conn, [5]) == {5: 'model:ocr@model.ckpt'}


def test_line_readers_names_a_reading_stored_before_the_name_was_written_in(conn):
    """Every training writes `<training>/output/model.ckpt`, so authors from before the
    name was recorded say nothing at all. The dataset's own model is who read them."""
    seed_defaults(conn)
    _train(conn, 'letters-v11', '/data/trainings/17/output/model.ckpt')
    chosen = conn.execute("SELECT id FROM models WHERE name = 'letters-v11'").fetchone()['id']
    _job(conn, 'old', model_ocr_id=chosen)
    _read_line(conn, 'old', 41, 'model:ocr@model.ckpt')
    _read_line(conn, 'old', 42, 'model:ocr@letters-v03#greedy')

    assert registry.line_readers(conn, [41, 42, 43]) == {
        41: 'model:ocr@letters-v11', 42: 'model:ocr@letters-v03#greedy', 43: ''}


def test_line_readers_names_each_line_from_its_own_dataset(conn):
    seed_defaults(conn)
    _train(conn, 'letters-v11', '/data/trainings/17/output/model.ckpt')
    _train(conn, 'letters-v03', '/data/trainings/12/output/model.ckpt')
    ids = {r['name']: r['id'] for r in conn.execute("SELECT id, name FROM models WHERE source = 'trained'")}
    _job(conn, 'newer', model_ocr_id=ids['letters-v11'])
    _job(conn, 'older', model_ocr_id=ids['letters-v03'])
    _read_line(conn, 'newer', 7, 'model:ocr@model.ckpt')
    _read_line(conn, 'older', 8, 'model:ocr@model.ckpt')

    assert registry.line_readers(conn, [7, 8]) == {
        7: 'model:ocr@letters-v11', 8: 'model:ocr@letters-v03'}


def test_a_runner_reads_the_model_it_was_handed(monkeypatch):
    monkeypatch.setenv('OCR_MODEL_ID', '7')
    monkeypatch.delenv('LINES_MODEL_ID', raising=False)

    assert registry.running_model_id('ocr') == 7
    assert registry.running_model_id('lines') is None
