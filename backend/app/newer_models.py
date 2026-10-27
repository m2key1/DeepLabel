from collections import Counter

from app import registry

# What each step's output records about the model that made it.
READ_BY = {
    'layout': ('SELECT p.layout_model_id m FROM pages p '
               'WHERE p.job_id = ? AND p.deleted = 0 AND p.layout_model_id IS NOT NULL'),
    'lines': ('SELECT p.lines_model_id m FROM pages p '
              'WHERE p.job_id = ? AND p.deleted = 0 AND p.lines_model_id IS NOT NULL'),
    'ocr': ('SELECT l.ocr_model_id m FROM lines l JOIN elements e ON l.element_id = e.id '
            'JOIN pages p ON e.page_id = p.id WHERE p.job_id = ? AND p.deleted = 0 '
            'AND e.deleted = 0 AND l.deleted = 0 AND l.checked = 0 AND l.ocr_model_id IS NOT NULL'),
}
RUNS_TASK = {'layout': 'run_layout', 'lines': 'run_lines', 'ocr': 'run_ocr'}
_LIVE_LINES = ('FROM lines l JOIN elements e ON l.element_id = e.id JOIN pages p ON e.page_id = p.id '
               'WHERE p.job_id = ? AND p.deleted = 0 AND e.deleted = 0 AND l.deleted = 0')


def newest_version(conn, model_id: int):
    """The model at the end of `model_id`'s version chain, skipping archived ones - the
    model itself when nothing newer is marked. A model several others claim to replace
    hands on to the one registered last."""
    model = registry.get_model(conn, model_id)
    seen = {model_id}
    while model is not None:
        newer = conn.execute(
            'SELECT * FROM models WHERE supersedes = ? AND archived = 0 ORDER BY created_at DESC, id DESC LIMIT 1',
            (model['id'],)).fetchone()
        if newer is None or newer['id'] in seen:
            return model
        seen.add(newer['id'])
        model = newer
    return None


def chain_loops(conn, model_id: int, older_id: int) -> bool:
    """Whether marking `model_id` as the new version of `older_id` would close a loop."""
    seen = set()
    current = older_id
    while current is not None and current not in seen:
        if current == model_id:
            return True
        seen.add(current)
        row = registry.get_model(conn, current)
        current = row['supersedes'] if row else None
    return False


def target_model(conn, job: dict, task: str):
    """The model a step would use if it ran now, moved on to its newest version."""
    chosen = job.get(registry.JOB_MODEL_COLUMNS[task])
    row = registry.get_model(conn, chosen) if chosen else registry.default_model(conn, task)
    return newest_version(conn, row['id']) if row is not None else None


def _named(row) -> dict:
    return {'id': row['id'], 'name': row['name']}


def _costs(conn, job_id: str, task: str) -> dict:
    count = lambda sql: conn.execute(sql, (job_id,)).fetchone()[0]
    if task == 'ocr':
        return {'unchecked': count(f'SELECT COUNT(*) {_LIVE_LINES} AND l.checked = 0'),
                'checked': count(f'SELECT COUNT(*) {_LIVE_LINES} AND l.checked = 1')}
    costs = {'lines': count(f'SELECT COUNT(*) {_LIVE_LINES}'),
             'corrected': count(f'SELECT COUNT(*) {_LIVE_LINES} AND l.corrected_text IS NOT NULL')}
    if task == 'layout':
        costs['boxes'] = count('SELECT COUNT(*) FROM elements e JOIN pages p ON e.page_id = p.id '
                               'WHERE p.job_id = ? AND p.deleted = 0 AND e.deleted = 0')
        costs['layout_checked'] = count('SELECT COUNT(*) FROM pages WHERE job_id = ? '
                                        'AND deleted = 0 AND layout_checked = 1')
    return costs


def offers(conn, job: dict) -> list[dict]:
    """Each step whose output was made by a model other than the one it would run now -
    a new default the dataset follows, a model changed under Processing, or a newer
    version marked for its own - with what running it again would cost. A step the owner
    declined for that very model is left out."""
    if job['task'] != 'text' or job['status'] in ('queued', 'running', 'uploading'):
        return []
    declined = {r['task']: r['model_id'] for r in conn.execute(
        'SELECT task, model_id FROM declined_models WHERE job_id = ?', (job['id'],))}
    found = []
    for task in registry.TASKS:
        if not job[RUNS_TASK[task]]:
            continue
        target = target_model(conn, job, task)
        if target is None or declined.get(task) == target['id']:
            continue
        readers = Counter(r['m'] for r in conn.execute(READ_BY[task], (job['id'],)) if r['m'] != target['id'])
        if not readers:
            continue
        reader = registry.get_model(conn, readers.most_common(1)[0][0])
        found.append({'task': task, 'from': _named(reader) if reader else {'id': None, 'name': 'an earlier model'},
                      'to': _named(target), **_costs(conn, job['id'], task)})
    return found


def decline(conn, job: dict) -> None:
    for offer in offers(conn, job):
        conn.execute('INSERT OR REPLACE INTO declined_models (job_id, task, model_id) VALUES (?, ?, ?)',
                     (job['id'], offer['task'], offer['to']['id']))


def switch_to(conn, job: dict, offer: dict) -> None:
    """Set the step to the offered model - unless that is the default the dataset already
    follows, so it goes on following the default."""
    column = registry.JOB_MODEL_COLUMNS[offer['task']]
    default = registry.default_model(conn, offer['task'])
    if job[column] is None and default is not None and default['id'] == offer['to']['id']:
        return
    conn.execute(f'UPDATE jobs SET {column} = ? WHERE id = ?', (offer['to']['id'], job['id']))
