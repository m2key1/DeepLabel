"""The training pre-flight: statistics over exactly the material a run would train on,
computed in the background and stored with the run. Warnings only - nothing here refuses
a run."""
import json
import time

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import preflight, store, train_snapshot
from app.deps import get_db
from app.main import app
from tests.fakes import FakeTrainer

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}
MEMBER = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'mallory', 'X-Auth-Role': 'member'}

LINE = [[0.1, 0.1], [0.5, 0.1], [0.5, 0.13], [0.1, 0.13]]
# 5 px tall on a 1000 px page: a crop of 400 x 6 once padded, under the 8 px DeepOCR keeps.
SLIVER = [[0.1, 0.5], [0.5, 0.5], [0.5, 0.505], [0.1, 0.505]]
# Two points enclose nothing; the cut cannot make a crop of it.
STROKE = [[0.1, 0.7], [0.5, 0.7]]
CYRILLIC_A = 'а'
ZERO_WIDTH_SPACE = '​'


def add_job(conn, job_id):
    conn.execute("INSERT INTO jobs (id, name, owner, status) VALUES (?, ?, 'root', 'done')",
                 (job_id, f'Set {job_id}'))


def add_page(conn, tmp_path, page_id, job_id, content_hash):
    scan = tmp_path / f'{page_id}.png'
    Image.new('RGB', (1000, 1000), 'white').save(scan)
    conn.execute(
        'INSERT INTO pages (id, job_id, idx, filename, source_file, content_hash, width, height, '
        "status, layout_checked, lines_checked) VALUES (?, ?, ?, ?, ?, ?, 1000, 1000, 'done', 1, 1)",
        (page_id, job_id, page_id, f'scan{page_id}.png', str(scan), content_hash))
    conn.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox) "
                 "VALUES (?, ?, 0, 'Paragraph', '[0.1, 0.1, 0.9, 0.9]')", (page_id, page_id))


def add_line(conn, line_id, page_id, text, polygon=LINE, checked=1, check_source=None,
             corrected_text=None):
    conn.execute(
        'INSERT INTO lines (id, element_id, order_idx, polygon, text, corrected_text, checked, '
        'check_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        (line_id, page_id, line_id, json.dumps(polygon), text, corrected_text, checked, check_source))


def unprobed(monkeypatch):
    """The model repo's constants come from a probe under its own venv; these tests state
    what the model takes instead of depending on whichever checkout this machine has."""
    monkeypatch.setattr(preflight, 'input_size', lambda conn, request: (None, None))
    monkeypatch.setattr(preflight, 'default_epochs', lambda conn, task, base_model_id: None)


@pytest.fixture
def material(tmp_path, monkeypatch):
    """Three datasets, laid out so every warning the pre-flight raises fires exactly once:
    jA trains, jV validates (holdout), jT is the test set and holds a copy of jA's first scan."""
    monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path / 'trainings')
    unprobed(monkeypatch)
    conn = store.connect(tmp_path / 'app.db')
    for job_id in ('jA', 'jV', 'jT'):
        add_job(conn, job_id)
    add_page(conn, tmp_path, 1, 'jA', 'h1')
    add_page(conn, tmp_path, 2, 'jA', 'h2')
    add_page(conn, tmp_path, 3, 'jV', 'h3')
    add_page(conn, tmp_path, 4, 'jT', 'h1')
    add_line(conn, 1, 1, 'abc')
    add_line(conn, 2, 1, f'S{CYRILLIC_A}me', check_source='llm')
    add_line(conn, 3, 1, 'abc', polygon=SLIVER, check_source='align')
    add_line(conn, 4, 1, 'machine read', corrected_text='')
    add_line(conn, 5, 1, 'abc', polygon=STROKE)
    add_line(conn, 6, 1, 'never checked', checked=0)
    add_line(conn, 7, 2, 'abc')
    add_line(conn, 10, 2, 'é')
    add_line(conn, 11, 2, 'é')
    add_line(conn, 12, 2, 'abcabc')
    add_line(conn, 8, 3, 'abcß')
    add_line(conn, 9, 4, f'abc{ZERO_WIDTH_SPACE}')
    conn.commit()
    yield conn
    conn.close()


HOLDOUT = {'task': 'ocr', 'dataset_job_ids': ['jA'], 'split_strategy': 'holdout',
           'valid_job_ids': ['jV'], 'test_job_ids': ['jT'], 'target': 'local',
           'epochs': 3, 'batch_size': 4}


def by_char(result):
    return {row['char']: row for row in result['text']['characters']}


def codes(result):
    return {finding['code']: finding['level'] for finding in result['findings']}


class TestSplit:
    def test_counts_every_dataset_per_split(self, material):
        split = preflight.compute(material, HOLDOUT)['split']
        assert split['totals'] == {'train': {'pages': 2, 'items': 7},
                                   'val': {'pages': 1, 'items': 1},
                                   'test': {'pages': 1, 'items': 1}}
        rows = {row['job_id']: row for row in split['datasets']}
        assert rows['jA']['train'] == {'pages': 2, 'items': 7}
        assert rows['jA']['val'] == {'pages': 0, 'items': 0}
        assert rows['jV']['val'] == {'pages': 1, 'items': 1}
        assert rows['jT']['test'] == {'pages': 1, 'items': 1}

    def test_a_scan_in_two_splits_is_a_duplicate(self, material):
        split = preflight.compute(material, HOLDOUT)['split']
        assert split['duplicate_count'] == 1
        assert split['duplicates'][0]['content_hash'] == 'h1'
        assert split['duplicates'][0]['splits'] == ['train', 'test']
        assert {(p['job_id'], p['page_id']) for p in split['duplicates'][0]['pages']} == {
            ('jA', 1), ('jT', 4)}

    def test_matches_what_the_snapshot_cuts(self, material):
        """The pre-flight reads the run's own selection and split, not a copy of it: its
        train and valid totals are the crops the snapshot writes, empty and uncroppable
        lines left out alike."""
        request = {'task': 'ocr', 'dataset_job_ids': ['jA', 'jV'], 'val_fraction': 0.5}
        totals = preflight.compute(material, request)['split']['totals']
        counts = train_snapshot.build(material, 99, 'ocr', ['jA', 'jV'], 0.5)
        assert {'train': totals['train']['items'], 'val': totals['val']['items']} == counts

    def test_an_empty_valid_split_is_warned_about(self, material):
        result = preflight.compute(material, {'task': 'ocr', 'dataset_job_ids': ['jV'],
                                              'val_fraction': 0.1})
        assert result['split']['totals']['val'] == {'pages': 0, 'items': 0}
        empty = [f for f in result['findings'] if f['code'] == 'empty_split']
        assert [f['level'] for f in empty] == ['warn']
        assert 'valid' in empty[0]['message']

    def test_person_only_leaves_out_what_models_settled(self, material):
        result = preflight.compute(material, {**HOLDOUT, 'human_checked_only': True})
        assert result['split']['totals']['train'] == {'pages': 2, 'items': 6}
        assert result['text']['sources'] == {'person': 7, 'transcription': 1, 'models': 0}


class TestCrops:
    def test_tiny_and_degenerate_shapes_are_flagged(self, material):
        crops = preflight.compute(material, HOLDOUT)['crops']
        assert crops['measured'] == 9
        assert crops['tiny']['count'] == 1
        assert [e['line_id'] for e in crops['tiny']['examples']] == [3]
        assert crops['degenerate']['count'] == 1
        assert [e['line_id'] for e in crops['degenerate']['examples']] == [5]
        assert crops['height']['min'] == 6
        assert crops['height']['max'] == 37
        assert crops['width']['median'] == 400
        assert sum(b['n'] for b in crops['height']['bins']) == 9

    def test_a_crop_wider_than_the_model_takes_is_flagged(self, material, monkeypatch):
        """At a 32 px input height a 400 x 37 crop scales to 346 px wide, the sliver to 2133."""
        monkeypatch.setattr(preflight, 'input_size', lambda conn, request: (32, 300))
        crops = preflight.compute(material, HOLDOUT)['crops']
        assert crops['too_wide']['count'] == 9
        assert crops['too_wide']['max_width'] == 300


class TestBinMembership:
    """Measured lines 1, 2, 7-12 are 400 x 37 crops, line 3 the 400 x 6 sliver; line 12
    holds six characters, every other one under five."""

    def test_a_bar_keeps_its_first_lines_by_id(self, material):
        add_line(material, 13, 1, 'abc')
        material.commit()
        result = preflight.compute(material, HOLDOUT)
        bins = {b['lo']: b for b in result['crops']['height']['bins']}
        assert bins[32]['n'] == 9
        assert [e['line_id'] for e in bins[32]['examples']] == [1, 2, 7, 8, 9, 10, 11, 12]
        assert bins[32]['examples'][0] == {'job_id': 'jA', 'page_id': 1, 'line_id': 1, 'text': 'abc'}
        assert [e['line_id'] for e in bins[0]['examples']] == [3]
        assert bins[8]['examples'] == []

    def test_every_pair_of_distributions_counts_the_lines_two_bars_share(self, material):
        joint = preflight.compute(material, HOLDOUT)['joint']
        assert sorted((a, b) for a in joint for b in joint[a]) == [
            ('aspect', 'chars_per_line'), ('height', 'aspect'), ('height', 'chars_per_line'),
            ('height', 'width'), ('width', 'aspect'), ('width', 'chars_per_line')]
        height_width = joint['height']['width']
        assert (len(height_width), len(height_width[0])) == (11, 8)
        assert {(i, j): n for i, row in enumerate(height_width) for j, n in enumerate(row) if n} == {
            (0, 3): 1, (4, 3): 8}
        assert {(i, j): n for i, row in enumerate(joint['height']['chars_per_line'])
                for j, n in enumerate(row) if n} == {(0, 1): 1, (4, 1): 7, (4, 2): 1}

    def test_a_line_on_a_page_of_unknown_size_is_only_in_characters_per_line(self, material):
        material.execute('UPDATE pages SET width = NULL, height = NULL WHERE id = 3')
        material.commit()
        result = preflight.compute(material, HOLDOUT)
        chars_bin = result['text']['chars_per_line']['bins'][1]
        assert (chars_bin['n'], 8 in [e['line_id'] for e in chars_bin['examples']]) == (8, True)
        assert sum(map(sum, result['joint']['height']['chars_per_line'])) == 8

    def test_the_stored_size_does_not_grow_with_the_corpus(self):
        def stored(lines):
            binned = preflight.Binned(preflight.LINE_EDGES)
            for i in range(lines):
                where = {'job_id': f'job{i % 7}', 'page_id': i // 30, 'line_id': i, 'text': 'x' * 80}
                binned.add(where, {'height': 8 + i % 250, 'width': 50 + (i * 37) % 4500,
                                   'aspect': 0.5 + i % 70, 'chars_per_line': i % 130})
            return len(json.dumps({name: binned.distribution(name) for name in preflight.LINE_EDGES}
                                  | {'joint': binned.joint()}))
        # Only the counts' digits grow: twenty times the lines adds no bytes beyond them.
        assert stored(100_000) - stored(5_000) < 1_000


class TestText:
    def test_line_lengths_empty_lines_and_sources(self, material):
        text = preflight.compute(material, HOLDOUT)['text']
        assert text['chars_per_line']['min'] == 1
        assert text['chars_per_line']['median'] == 3
        assert text['chars_per_line']['max'] == 6
        assert text['empty']['count'] == 1
        assert [e['line_id'] for e in text['empty']['examples']] == [4]
        assert text['sources'] == {'person': 7, 'transcription': 1, 'models': 1}

    def test_characters_are_ranked_with_their_split_counts(self, material):
        rows = preflight.compute(material, HOLDOUT)['text']['characters']
        assert [r['char'] for r in rows] == ['a', 'b', 'c', 'é', 'S', 'e', 'm', 'ß',
                                             CYRILLIC_A, ZERO_WIDTH_SPACE]
        assert {k: rows[0][k] for k in ('total', 'train', 'val', 'test')} == {
            'total': 7, 'train': 5, 'val': 1, 'test': 1}
        assert rows[0]['codepoints'] == ['U+0061']
        assert rows[0]['flags'] == []

    def test_a_character_only_valid_or_test_holds_is_flagged(self, material):
        chars = by_char(preflight.compute(material, HOLDOUT))
        assert chars['ß']['flags'] == ['split_only']
        assert 'split_only' in chars[ZERO_WIDTH_SPACE]['flags']

    def test_a_homoglyph_among_latin_text_is_a_lookalike(self, material):
        chars = by_char(preflight.compute(material, HOLDOUT))
        assert chars[CYRILLIC_A]['flags'] == ['rare', 'lookalike']
        assert chars[CYRILLIC_A]['name'] == 'CYRILLIC SMALL LETTER A'
        assert 'U+0061' in chars[CYRILLIC_A]['hint']

    def test_a_character_nfkc_changes_is_a_lookalike_naming_its_normal_form(self, material):
        add_line(material, 13, 2, 'ﬁ² Ａ')
        material.commit()
        chars = by_char(preflight.compute(material, HOLDOUT))
        assert {c: (chars[c]['flags'], chars[c]['hint']) for c in ('ﬁ', '²', 'Ａ')} == {
            'ﬁ': (['rare', 'lookalike'], 'NFKC: fi (U+0066 U+0069) - replace it if the hand wrote the plain form'),
            '²': (['rare', 'lookalike'], 'NFKC: 2 (U+0032) - replace it if the hand wrote the plain form'),
            'Ａ': (['rare', 'lookalike'], 'NFKC: A (U+0041) - replace it if the hand wrote the plain form'),
        }
        assert chars['a']['flags'] == []

    def test_an_invisible_codepoint_is_odd(self, material):
        chars = by_char(preflight.compute(material, HOLDOUT))
        assert chars[ZERO_WIDTH_SPACE]['flags'] == ['split_only', 'odd']
        assert chars[ZERO_WIDTH_SPACE]['codepoints'] == ['U+200B']

    def test_a_letter_stored_both_ways_is_one_row_flagged_mixed(self, material):
        chars = by_char(preflight.compute(material, HOLDOUT))
        assert chars['é']['train'] == 2
        assert chars['é']['flags'] == ['rare', 'mixed_forms']
        assert 'é' not in chars

    def test_findings_name_every_warning_once(self, material):
        assert codes(preflight.compute(material, HOLDOUT)) == {
            'duplicates': 'warn', 'tiny': 'warn', 'degenerate': 'warn', 'empty_lines': 'warn',
            'split_only': 'warn', 'lookalike': 'warn', 'odd': 'warn', 'mixed_forms': 'warn',
            'rare': 'info'}

    def test_characters_new_to_a_base_trained_here(self, material):
        """A base model trained in this app has its own pre-flight on record, and with it the
        characters it was trained on."""
        known = {'text': {'characters': [{'char': c, 'train': 5} for c in 'abc']}}
        base = material.execute("INSERT INTO models (task, name, source, checkpoint) "
                                "VALUES ('ocr', 'base', 'trained', '/x.pt')").lastrowid
        record = material.execute(
            "INSERT INTO training_preflights (owner, task, request, status, result) "
            "VALUES ('root', 'ocr', '{}', 'done', ?)", (json.dumps(known),)).lastrowid
        material.execute("INSERT INTO trainings (task, name, model_id, preflight_id) "
                         "VALUES ('ocr', 'base', ?, ?)", (base, record))
        material.commit()
        result = preflight.compute(material, {**HOLDOUT, 'base_model_id': base})
        assert result['text']['base_charset_known'] is True
        assert sorted(c for c, row in by_char(result).items() if 'new_to_base' in row['flags']) == sorted(
            ['S', 'e', 'm', 'é', 'ß', CYRILLIC_A, ZERO_WIDTH_SPACE])
        assert codes(result)['new_to_base'] == 'warn'


class TestSettings:
    def test_the_recap_derives_steps_from_the_train_split(self, material):
        settings = preflight.compute(material, HOLDOUT)['settings']
        assert settings['batch_size'] == 4
        assert settings['devices'] == 1
        assert settings['steps_per_epoch'] == 2
        assert settings['epochs'] == 3
        assert settings['total_steps'] == 6

    def test_line_detection_steps_count_pages_not_polygons(self, material):
        """DeepSegment batches whole pages: jA's two train pages hold ten polygons."""
        result = preflight.compute(material, {**HOLDOUT, 'task': 'lines', 'test_job_ids': [],
                                              'batch_size': 1})
        assert result['split']['totals']['train'] == {'pages': 2, 'items': 10}
        assert result['settings']['steps_per_epoch'] == 2
        assert result['settings']['total_steps'] == 6


class TestWhitespaceOnlyLines:
    def test_a_blank_line_is_reported_empty_and_left_out_of_the_cut(self, material):
        add_line(material, 13, 2, '   ')
        material.commit()
        result = preflight.compute(material, HOLDOUT)
        assert result['text']['empty']['count'] == 2
        assert [e['line_id'] for e in result['text']['empty']['examples']] == [4, 13]
        assert result['split']['totals']['train'] == {'pages': 2, 'items': 7}
        request = {'task': 'ocr', 'dataset_job_ids': ['jA', 'jV'], 'val_fraction': 0.5}
        totals = preflight.compute(material, request)['split']['totals']
        counts = train_snapshot.build(material, 99, 'ocr', ['jA', 'jV'], 0.5)
        assert {'train': totals['train']['items'], 'val': totals['val']['items']} == counts
        assert sum(counts.values()) == 8


def test_layout_runs_get_classes_per_split(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path / 'trainings')
    unprobed(monkeypatch)
    conn = store.connect(tmp_path / 'app.db')
    add_job(conn, 'jL')
    add_job(conn, 'jM')
    add_page(conn, tmp_path, 1, 'jL', 'h1')
    conn.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox) "
                 "VALUES (10, 1, 1, 'Paragraph', '[0.1, 0.5, 0.9, 0.8]')")
    add_page(conn, tmp_path, 2, 'jM', 'h2')
    conn.execute("UPDATE elements SET class_name = 'Header' WHERE page_id = 2")
    conn.commit()
    result = preflight.compute(conn, {'task': 'layout', 'dataset_job_ids': ['jL'],
                                      'split_strategy': 'holdout', 'valid_job_ids': ['jM']})
    assert result['unit'] == 'boxes'
    assert result['split']['totals'] == {'train': {'pages': 1, 'items': 2},
                                         'val': {'pages': 1, 'items': 1},
                                         'test': {'pages': 0, 'items': 0}}
    classes = {row['name']: row for row in result['classes']}
    assert {k: classes['Paragraph'][k] for k in ('train', 'val', 'test')} == {'train': 2, 'val': 0, 'test': 0}
    assert classes['Header']['flags'] == ['split_only']
    assert result['text'] is None and result['crops'] is None
    conn.close()


def test_layout_steps_count_pages_not_boxes(tmp_path, monkeypatch):
    """The layout model batches whole pages: one train page with two boxes is one step."""
    monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path / 'trainings')
    unprobed(monkeypatch)
    conn = store.connect(tmp_path / 'app.db')
    add_job(conn, 'jL')
    add_page(conn, tmp_path, 1, 'jL', 'h1')
    conn.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox) "
                 "VALUES (10, 1, 1, 'Paragraph', '[0.1, 0.5, 0.9, 0.8]')")
    conn.commit()
    result = preflight.compute(conn, {'task': 'layout', 'dataset_job_ids': ['jL'],
                                      'val_fraction': 0.1, 'batch_size': 1, 'epochs': 4})
    assert result['split']['totals']['train'] == {'pages': 1, 'items': 2}
    assert result['settings']['steps_per_epoch'] == 1
    assert result['settings']['total_steps'] == 4
    conn.close()


@pytest.fixture
def client(material, tmp_path, monkeypatch, training_backend):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.DB_PATH', tmp_path / 'app.db')
    app.dependency_overrides[get_db] = lambda: material
    yield TestClient(app), material
    app.dependency_overrides.clear()


def settled(api, preflight_id, headers=ADMIN):
    deadline = time.monotonic() + 10
    while True:
        res = api.get(f'/api/trainings/preflights/{preflight_id}', headers=headers)
        assert res.status_code == 200, res.text
        if res.json()['status'] != 'running' or time.monotonic() > deadline:
            return res.json()
        time.sleep(0.05)


class TestApi:
    def test_a_preflight_runs_in_the_background_and_is_polled(self, client):
        api, _ = client
        res = api.post('/api/trainings/preflights', json=HOLDOUT, headers=ADMIN)
        assert res.status_code == 200, res.text
        assert res.json()['status'] == 'running'
        done = settled(api, res.json()['id'])
        assert done['status'] == 'done'
        assert done['result']['split']['totals']['train'] == {'pages': 2, 'items': 7}
        assert done['datasets'] == {'jA': 'Set jA', 'jV': 'Set jV', 'jT': 'Set jT'}

    def test_someone_else_cannot_read_it(self, client):
        api, _ = client
        preflight_id = api.post('/api/trainings/preflights', json=HOLDOUT, headers=ADMIN).json()['id']
        settled(api, preflight_id)
        assert api.get(f'/api/trainings/preflights/{preflight_id}', headers=MEMBER).status_code == 404

    def test_a_preflight_needs_access_to_every_dataset(self, client):
        api, _ = client
        assert api.post('/api/trainings/preflights', json=HOLDOUT, headers=MEMBER).status_code == 404

    def test_the_run_keeps_the_preflight_the_form_showed(self, client):
        api, _ = client
        preflight_id = api.post('/api/trainings/preflights', json=HOLDOUT, headers=ADMIN).json()['id']
        settled(api, preflight_id)
        run = api.post('/api/trainings', headers=ADMIN,
                       json={**HOLDOUT, 'name': 'run', 'description': 'anything',
                             'preflight_id': preflight_id})
        assert run.status_code == 200, run.text
        assert run.json()['preflight_id'] == preflight_id
        stored = api.get(f"/api/trainings/{run.json()['id']}/preflight", headers=ADMIN).json()
        assert stored['id'] == preflight_id
        assert stored['result']['split']['totals']['val'] == {'pages': 1, 'items': 1}

    def test_a_preflight_for_other_settings_is_recomputed_at_submit(self, client):
        api, _ = client
        preflight_id = api.post('/api/trainings/preflights', json=HOLDOUT, headers=ADMIN).json()['id']
        settled(api, preflight_id)
        run = api.post('/api/trainings', headers=ADMIN,
                       json={**HOLDOUT, 'name': 'run', 'human_checked_only': True,
                             'preflight_id': preflight_id}).json()
        assert run['preflight_id'] not in (None, preflight_id)
        stored = settled(api, run['preflight_id'])
        assert stored['result']['split']['totals']['train'] == {'pages': 2, 'items': 6}

    def test_a_run_submitted_without_one_gets_its_own(self, client):
        api, _ = client
        run = api.post('/api/trainings', headers=ADMIN, json={**HOLDOUT, 'name': 'run'}).json()
        assert run['preflight_id'] is not None
        stored = api.get(f"/api/trainings/{run['id']}/preflight", headers=ADMIN).json()
        assert settled(api, stored['id'])['result']['split']['totals']['test'] == {'pages': 1, 'items': 1}

    @pytest.mark.parametrize('settings, detail', [
        ({'epochs': 0}, 'epochs must be at least 1'),
        ({'split_strategy': 'uniform'}, 'valid_job_ids only applies to the holdout strategy'),
        ({'test_job_ids': ['jA']}, 'test datasets must not also be training datasets'),
        ({'gpu_count': 2}, 'gpu_count needs a gpu_type'),
    ])
    def test_settings_a_submit_refuses_are_refused_for_review_alike(self, client, settings, detail):
        api, conn = client
        review = api.post('/api/trainings/preflights', json={**HOLDOUT, **settings}, headers=ADMIN)
        submit = api.post('/api/trainings', json={**HOLDOUT, **settings, 'name': 'run'}, headers=ADMIN)
        assert (review.status_code, review.json().get('detail')) == (400, detail)
        assert (submit.status_code, submit.json()['detail']) == (400, detail)
        assert conn.execute('SELECT COUNT(*) FROM training_preflights').fetchone()[0] == 0

    def test_a_review_a_newer_one_replaced_is_not_computed(self, client):
        """Editing the form starts a review per change; one still waiting for a slot when
        the next arrives would read the whole corpus for nobody."""
        api, conn = client
        for _ in range(2):
            preflight._slots.acquire()
        try:
            older = api.post('/api/trainings/preflights', json=HOLDOUT, headers=ADMIN).json()['id']
            newer = api.post('/api/trainings/preflights', json={**HOLDOUT, 'epochs': 4},
                             headers=ADMIN).json()['id']
        finally:
            for _ in range(2):
                preflight._slots.release()
        assert settled(api, newer)['status'] == 'done'
        replaced = settled(api, older)
        assert (replaced['status'], replaced['error'], replaced['result']) == (
            'error', 'superseded by a newer review', None)
        assert conn.execute('SELECT status FROM training_preflights WHERE id = ?',
                            (older,)).fetchone()[0] == 'error'

    def test_a_runs_own_review_is_computed_whatever_follows_it(self, client):
        api, conn = client
        for _ in range(2):
            preflight._slots.acquire()
        try:
            run = api.post('/api/trainings', headers=ADMIN, json={**HOLDOUT, 'name': 'run'}).json()
            api.post('/api/trainings/preflights', json={**HOLDOUT, 'epochs': 4}, headers=ADMIN)
        finally:
            for _ in range(2):
                preflight._slots.release()
        assert settled(api, run['preflight_id'])['status'] == 'done'

    def test_a_runs_own_review_is_computed_even_before_the_run_is_stored(self, client,
                                                                         monkeypatch):
        """The form fires a fresh review as the run is submitted. When the run's own one
        gets a slot before the run's row is written, nothing yet says it belongs to a run."""
        api, conn = client
        original = preflight.begin

        def racing(begin_conn, owner, request, **kwargs):
            for _ in range(2):
                preflight._slots.acquire()
            try:
                own = original(begin_conn, owner, request, **kwargs)
                original(begin_conn, owner, {**request, 'epochs': 4})
            finally:
                for _ in range(2):
                    preflight._slots.release()
            deadline = time.monotonic() + 10
            while own in preflight._running and time.monotonic() < deadline:
                time.sleep(0.02)
            return own

        monkeypatch.setattr(preflight, 'begin', racing)
        run = api.post('/api/trainings', headers=ADMIN, json={**HOLDOUT, 'name': 'run'}).json()

        stored = settled(api, run['preflight_id'])
        assert (stored['status'], stored['error']) == ('done', None)

    def test_a_review_a_restart_cut_off_says_so(self, client):
        api, conn = client
        orphan = conn.execute("INSERT INTO training_preflights (owner, task, request) "
                              "VALUES ('root', 'ocr', ?)", (json.dumps(HOLDOUT),)).lastrowid
        conn.commit()
        assert conn.execute('SELECT status FROM training_preflights WHERE id = ?',
                            (orphan,)).fetchone()[0] == 'running'
        found = api.get(f'/api/trainings/preflights/{orphan}', headers=ADMIN).json()
        assert (found['status'], found['error']) == (
            'error', 'interrupted by a restart - go back and review again')
        assert conn.execute('SELECT status FROM training_preflights WHERE id = ?',
                            (orphan,)).fetchone()[0] == 'error'

    def test_starting_a_review_clears_the_owners_stale_ones_only(self, client):
        api, conn = client

        def stored(owner, status, age):
            return conn.execute(
                "INSERT INTO training_preflights (owner, task, request, status, created_at) "
                "VALUES (?, 'ocr', '{}', ?, datetime('now', ?))", (owner, status, age)).lastrowid
        stale = stored('root', 'done', '-2 days')
        failed = stored('root', 'error', '-2 days')
        running = stored('root', 'running', '-2 days')
        kept_by_run = stored('root', 'done', '-2 days')
        fresh = stored('root', 'done', '-1 hour')
        someone_elses = stored('mallory', 'done', '-2 days')
        conn.execute("INSERT INTO trainings (task, name, preflight_id) VALUES ('ocr', 'old', ?)",
                     (kept_by_run,))
        conn.commit()

        started = preflight.begin(conn, 'root', HOLDOUT)

        remaining = {row[0] for row in conn.execute('SELECT id FROM training_preflights')}
        assert remaining == {running, kept_by_run, fresh, someone_elses, started}
        assert {stale, failed} & remaining == set()
        settled(api, started)

    def test_a_reader_who_cannot_open_a_dataset_gets_its_lines_redacted(self, client):
        api, conn = client
        conn.execute("UPDATE jobs SET owner = 'mallory' WHERE id = 'jT'")
        conn.commit()
        run = api.post('/api/trainings', headers=ADMIN, json={**HOLDOUT, 'name': 'run'}).json()
        settled(api, run['preflight_id'])

        full = api.get(f"/api/trainings/{run['id']}/preflight", headers=ADMIN).json()
        redacted = api.get(f"/api/trainings/{run['id']}/preflight", headers=MEMBER).json()

        assert full['datasets'] == {'jA': 'Set jA', 'jV': 'Set jV', 'jT': 'Set jT'}
        assert redacted['datasets'] == {'jA': 'another dataset', 'jV': 'another dataset',
                                        'jT': 'Set jT'}
        for section, flag, line_id in (('text', 'empty', 4), ('crops', 'tiny', 3),
                                       ('crops', 'degenerate', 5)):
            assert [e['line_id'] for e in full['result'][section][flag]['examples']] == [line_id]
            assert redacted['result'][section][flag]['examples'] == []
            assert redacted['result'][section][flag]['count'] == 1
        assert [p['job_id'] for p in full['result']['split']['duplicates'][0]['pages']] == ['jA', 'jT']
        assert redacted['result']['split']['duplicates'][0]['pages'] == [
            {'job_id': 'jT', 'page_id': 4, 'filename': 'scan4.png'}]
        tall = lambda payload: next(b for b in payload['result']['crops']['height']['bins'] if b['lo'] == 32)
        assert [e['line_id'] for e in tall(full)['examples']] == [1, 2, 7, 8, 9, 10, 11, 12]
        assert [e['line_id'] for e in tall(redacted)['examples']] == [9]
        assert redacted['result']['joint'] == full['result']['joint']


class TestWhatTheBackendSaid:
    @pytest.fixture
    def conn(self, tmp_path):
        connection = store.connect(tmp_path / 'app.db')
        connection.executescript("""
            INSERT INTO models (id, task, name, checkpoint, is_default, target_height, max_width)
                VALUES (1, 'ocr', 'Default', '', 1, 128, 3072),
                       (2, 'ocr', 'Base', '', 0, 256, 6144),
                       (3, 'ocr', 'Never loaded', '', 0, NULL, NULL);
        """)
        yield connection
        connection.close()

    def test_a_crop_is_sized_as_the_base_reported(self, conn):
        assert preflight.input_size(conn, {'task': 'ocr', 'base_model_id': 2}) == (256, 6144)

    def test_a_base_not_yet_loaded_is_sized_as_the_default_model(self, conn):
        assert preflight.input_size(conn, {'task': 'ocr', 'base_model_id': 3}) == (128, 3072)
        assert preflight.input_size(conn, {'task': 'ocr'}) == (128, 3072)

    def test_nothing_reported_leaves_the_size_unknown(self, conn):
        conn.execute('UPDATE models SET target_height = NULL, max_width = NULL')
        assert preflight.input_size(conn, {'task': 'ocr'}) == (None, None)
        assert preflight.input_size(conn, {'task': 'lines'}) == (None, None)

    def test_the_epochs_are_the_ones_the_backend_declares(self, conn, monkeypatch):
        trainer = FakeTrainer({'default_epochs': 7})
        monkeypatch.setattr('app.remote_training.training_backend', lambda _conn, _training: trainer)
        assert preflight.default_epochs(conn, 'ocr', None) == 7

    def test_no_backend_leaves_the_epochs_unknown(self, conn, monkeypatch):
        monkeypatch.setattr('app.config.MODEL_BACKENDS', {})
        assert preflight.default_epochs(conn, 'ocr', None) is None
