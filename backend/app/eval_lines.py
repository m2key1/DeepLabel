"""An evaluation's per-line records: imported from the evaluator's JSONL, read back a page
at a time, and sent to review."""
import json
from dataclasses import dataclass
from pathlib import Path

from app import eval_metrics

SORTS = {'cer': 'cer', 'confidence': 'confidence', 'length': 'length', 'line': 'line_id'}
COLUMNS = ('line_id', 'job_id', 'page_id', 'decode', 'ground_truth', 'prediction', 'cer',
           'distance', 'length', 'confidence', 'ops')


PLACEMENT_CHUNK = 500

# Bumped on every replace or copy of an evaluation's rows. A re-import of as many lines
# reuses the same rowids, so the rows alone cannot tell a cached summary it is stale.
_generations: dict[int, int] = {}


def generation(eval_id: int) -> int:
    return _generations.get(eval_id, 0)


def _replaced(eval_id: int) -> None:
    _generations[eval_id] = generation(eval_id) + 1


def _placements(conn, line_ids: list[int]) -> dict[int, tuple[str, int]]:
    """Where each line sits, as (job_id, page_id), in one query per chunk of ids."""
    found = {}
    for start in range(0, len(line_ids), PLACEMENT_CHUNK):
        chunk = line_ids[start:start + PLACEMENT_CHUNK]
        found.update({r['line_id']: (r['job_id'], r['page_id']) for r in conn.execute(
            'SELECT l.id line_id, p.job_id, p.id page_id FROM lines l '
            'JOIN elements e ON l.element_id = e.id JOIN pages p ON e.page_id = p.id '
            f'WHERE l.id IN ({", ".join("?" * len(chunk))})', chunk)})
    return found


def import_records(conn, eval_id: int, records) -> int:
    """Replace the evaluation's rows with these. A snapshot crop names only its line, so
    where the line sits is looked up here, where the database is."""
    conn.execute('DELETE FROM eval_lines WHERE evaluation_id = ?', (eval_id,))
    rows = [eval_metrics.scored_row(record) for record in records]
    placements = _placements(conn, [r['line_id'] for r in rows
                                    if r.get('job_id') is None or r.get('page_id') is None])
    count = 0
    for row in rows:
        if row['line_id'] in placements:
            job_id, page_id = placements[row['line_id']]
            row = {**row, 'job_id': row.get('job_id') or job_id,
                   'page_id': row.get('page_id') or page_id}
        values = [row.get(c) for c in COLUMNS]
        values[COLUMNS.index('ops')] = json.dumps(row['ops'], ensure_ascii=False)
        conn.execute(
            f'INSERT OR REPLACE INTO eval_lines (evaluation_id, {", ".join(COLUMNS)}) '
            f'VALUES (?, {", ".join("?" * len(COLUMNS))})', (eval_id, *values))
        count += 1
    conn.commit()
    _replaced(eval_id)
    return count


def import_file(conn, eval_id: int, path: Path) -> int:
    if not path.is_file():
        return 0
    with path.open(encoding='utf-8') as lines:
        return import_records(conn, eval_id, (json.loads(line) for line in lines if line.strip()))


def copy(conn, source_id: int, target_id: int) -> None:
    conn.execute(
        f'INSERT INTO eval_lines (evaluation_id, {", ".join(COLUMNS)}) '
        f'SELECT ?, {", ".join(COLUMNS)} FROM eval_lines WHERE evaluation_id = ?',
        (target_id, source_id))
    conn.commit()
    _replaced(target_id)


def job_ids(conn, eval_id: int) -> list[str]:
    return [r['job_id'] for r in conn.execute(
        'SELECT DISTINCT job_id FROM eval_lines WHERE evaluation_id = ? AND job_id IS NOT NULL '
        'ORDER BY job_id', (eval_id,))]


def count(conn, eval_id: int, jobs: list[str] | None = None) -> int:
    where, params = _where(eval_id, jobs, LineFilter())
    return conn.execute(f'SELECT COUNT(*) FROM eval_lines WHERE {where}', params).fetchone()[0]


@dataclass(frozen=True)
class LineFilter:
    cer_min: float | None = None
    cer_max: float | None = None
    job_id: str | None = None
    q: str | None = None


def _where(eval_id: int, jobs: list[str] | None, flt: LineFilter) -> tuple[str, list]:
    """Rows of this evaluation the viewer may see (jobs None: all of them), narrowed by the
    filter."""
    clauses, params = ['evaluation_id = ?'], [eval_id]
    if jobs is not None:
        clauses.append(f'job_id IN ({", ".join("?" * len(jobs))})' if jobs else '0')
        params += jobs
    if flt.cer_min is not None:
        clauses.append('cer >= ?')
        params.append(flt.cer_min)
    if flt.cer_max is not None:
        clauses.append('cer <= ?')
        params.append(flt.cer_max)
    if flt.job_id:
        clauses.append('job_id = ?')
        params.append(flt.job_id)
    if flt.q:
        clauses.append("(ground_truth LIKE ? ESCAPE '\\' OR prediction LIKE ? ESCAPE '\\')")
        needle = '%' + flt.q.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'
        params += [needle, needle]
    return ' AND '.join(clauses), params


def _row(row) -> dict:
    """A line as the table shows it. The truth belongs to the line, the reading to this
    evaluation - so a second evaluation of the same lines joins as a second reading."""
    return {'line_id': row['line_id'], 'job_id': row['job_id'], 'page_id': row['page_id'],
            'ground_truth': row['ground_truth'], 'length': row['length'],
            'reading': {'evaluation_id': row['evaluation_id'], 'decode': row['decode'],
                        'prediction': row['prediction'], 'cer': row['cer'],
                        'distance': row['distance'], 'confidence': row['confidence'],
                        'ops': json.loads(row['ops'])}}


def page(conn, eval_id: int, jobs: list[str] | None, flt: LineFilter, sort: str = 'cer',
         order: str = 'desc', offset: int = 0, limit: int = 50) -> dict:
    where, params = _where(eval_id, jobs, flt)
    total = conn.execute(f'SELECT COUNT(*) FROM eval_lines WHERE {where}', params).fetchone()[0]
    direction = 'DESC' if order == 'desc' else 'ASC'
    # A line with no confidence sorts last either way, rather than heading an ascending list.
    rows = conn.execute(
        f'SELECT * FROM eval_lines WHERE {where} '
        f'ORDER BY {SORTS[sort]} IS NULL, {SORTS[sort]} {direction}, line_id '
        'LIMIT ? OFFSET ?', (*params, limit, offset)).fetchall()
    return {'total': total, 'lines': [_row(r) for r in rows]}


def scored_rows(conn, eval_id: int, jobs: list[str] | None) -> list[dict]:
    where, params = _where(eval_id, jobs, LineFilter())
    return [eval_metrics.scored_row(dict(r)) for r in conn.execute(
        f'SELECT * FROM eval_lines WHERE {where} ORDER BY line_id', params)]


def flag_for_review(conn, eval_id: int, jobs: list[str] | None, flt: LineFilter,
                    user: str) -> list[dict]:
    """Every live line in the filter joins its dataset's review queue. Returns the flagged
    lines with where they sit, in reading order."""
    where, params = _where(eval_id, jobs, flt)
    rows = conn.execute(
        'SELECT l.id, p.job_id, p.id page_id FROM lines l '
        'JOIN elements e ON l.element_id = e.id JOIN pages p ON e.page_id = p.id '
        f'WHERE l.id IN (SELECT line_id FROM eval_lines WHERE {where}) '
        'AND l.deleted = 0 AND e.deleted = 0 AND p.deleted = 0 '
        'ORDER BY p.job_id, p.idx, e.order_idx, l.order_idx', params).fetchall()
    conn.executemany(
        'INSERT OR REPLACE INTO review_flags (line_id, evaluation_id, flagged_by) VALUES (?, ?, ?)',
        [(r['id'], eval_id, user) for r in rows])
    conn.commit()
    return [dict(r) for r in rows]
