from app import store

LIVE_LINES = ('FROM lines l JOIN elements e ON l.element_id = e.id '
              'WHERE e.page_id = ? AND l.deleted = 0 AND e.deleted = 0')


def _model(conn, model_id: int | None) -> dict | None:
    if model_id is None:
        return None
    row = conn.execute('SELECT id, name FROM models WHERE id = ?', (model_id,)).fetchone()
    if row is None:
        return {'id': model_id, 'name': None, 'hash': None}
    weights = conn.execute("SELECT sha256 FROM model_files WHERE model_id = ? AND role = 'weights'",
                           (model_id,)).fetchone()
    return {'id': row['id'], 'name': row['name'], 'hash': weights['sha256'][:7] if weights else None}


def page_provenance(conn, page) -> dict:
    """Which models produced what is on a page, and how much of it people have since done
    by hand: the layout and lines model per page, the OCR model per line."""
    lines = conn.execute(
        f'SELECT COUNT(*) total, COALESCE(SUM(l.by_hand), 0) by_hand {LIVE_LINES}', (page['id'],)).fetchone()
    readers = conn.execute(
        f'SELECT l.ocr_model_id, COUNT(*) n, MAX(l.ocr_run_at) at {LIVE_LINES} AND l.text IS NOT NULL '
        'GROUP BY l.ocr_model_id ORDER BY n DESC, l.ocr_model_id', (page['id'],)).fetchall()
    corrected = conn.execute(
        f'SELECT COUNT(*) c {LIVE_LINES} AND l.corrected_text IS NOT NULL '
        f'AND (l.corrected_by IS NULL OR ({store.person_author_sql("l.corrected_by")}))',
        (page['id'],)).fetchone()['c']

    def stage(name: str) -> dict | None:
        model = _model(conn, page[f'{name}_model_id'])
        return model and {**model, 'at': page[f'{name}_run_at']}

    return {
        'layout': stage('layout'),
        'lines': stage('lines'),
        'lines_total': lines['total'],
        'lines_by_hand': lines['by_hand'],
        'ocr': [{'model': _model(conn, r['ocr_model_id']), 'lines': r['n'], 'at': r['at']} for r in readers],
        'ocr_corrected': corrected,
    }
