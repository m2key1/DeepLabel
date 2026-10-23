import pytest

from app import conventions, registry, store


def test_only_the_flags_the_model_knows_are_honoured_in_its_order():
    asked = {'typographic_punctuation': True, 'long_s': True, 'ligatures': True, 'oblique_hyphen': False}
    known = ['long_s', 'oblique_hyphen', 'typographic_punctuation']

    assert conventions.honoured(asked, known) == ['long_s', 'typographic_punctuation']
    assert conventions.model_row(asked, known) == [1.0, 0.0, 1.0]


def test_a_model_without_conditioning_honours_nothing():
    assert conventions.honoured({'long_s': True}, []) == []
    assert conventions.model_row({'long_s': True}, []) == []


def test_more_flags_than_any_model_has_are_refused():
    with pytest.raises(ValueError, match='at most 32'):
        conventions.validate({f'flag_{i}': True for i in range(33)})


def test_the_model_flags_are_recorded_once(tmp_path):
    conn = store.connect(tmp_path / 'app.db')
    conn.execute("INSERT INTO models (id, task, name, checkpoint) VALUES (1, 'ocr', 'OCR', '/m.ckpt')")

    registry.note_model_facts(conn, 1, {}, ['long_s', 'oblique_hyphen'])
    registry.note_model_facts(conn, 1, {}, ['something_else'])

    row = conn.execute('SELECT * FROM models WHERE id = 1').fetchone()
    assert registry.model_payload(row)['conventions'] == ['long_s', 'oblique_hyphen']
    conn.close()


def test_a_model_not_yet_loaded_has_unknown_flags(tmp_path):
    conn = store.connect(tmp_path / 'app.db')
    conn.execute("INSERT INTO models (id, task, name, checkpoint) VALUES (1, 'ocr', 'OCR', '/m.ckpt')")

    row = conn.execute('SELECT * FROM models WHERE id = 1').fetchone()
    assert registry.model_payload(row)['conventions'] is None
    conn.close()
