import json
import os

TASKS = ('layout', 'lines', 'ocr')

# The registry id of the model each phase runs, handed to the job's process so what it
# writes can say which model produced it.
MODEL_ID_ENV = {'layout': 'LAYOUT_MODEL_ID', 'lines': 'LINES_MODEL_ID', 'ocr': 'OCR_MODEL_ID'}

JOB_MODEL_COLUMNS = {
    'layout': 'model_layout_id',
    'lines': 'model_lines_id',
    'ocr': 'model_ocr_id',
}


def get_model(conn, model_id: int):
    return conn.execute('SELECT * FROM models WHERE id = ?', (model_id,)).fetchone()


def name_clash(conn, task: str, name: str, model_id: int | None = None) -> str | None:
    """Why `name` cannot name a model of `task`, or None when it is free. Archived models
    keep theirs. A run registers its model under its own name when it finishes, so two
    sharing one would leave a pair nothing downstream can tell apart; a run that is over
    without a model - cancelled, failed - registered nothing and frees the name again."""
    if conn.execute('SELECT id FROM models WHERE task = ? AND lower(name) = lower(?) '
                    'AND id IS NOT ?', (task, name, model_id)).fetchone():
        return f'a {task} model named "{name}" already exists'
    if conn.execute("SELECT id FROM trainings WHERE task = ? AND lower(name) = lower(?) "
                    "AND status IN ('queued', 'preparing', 'running')", (task, name)).fetchone():
        return f'a {task} training run named "{name}" is already queued or running'
    return None


def default_model(conn, task: str):
    return conn.execute(
        'SELECT * FROM models WHERE task = ? AND is_default = 1 AND archived = 0', (task,)).fetchone()


def chosen_models(conn, job: dict) -> dict:
    """Env for a job's process: the id of the job's selected model per task, else the
    task's default."""
    env = {}
    for task, column in JOB_MODEL_COLUMNS.items():
        row = get_model(conn, job[column]) if job.get(column) else None
        if row is None:
            row = default_model(conn, task)
        if row is not None:
            env[MODEL_ID_ENV[task]] = str(row['id'])
    return env


def running_model_id(task: str) -> int | None:
    """Inside a job's process: the id of the model chosen_models chose for this task."""
    return int(os.environ[MODEL_ID_ENV[task]]) if os.environ.get(MODEL_ID_ENV[task]) else None


def note_model_facts(conn, model_id: int, facts: dict, convention_names: list[str]) -> None:
    """What a model backend reported about a model's weights when it loaded them (3.4). The
    app venv is torch-free, so nothing on this side can open the weights and ask."""
    if facts.get('target_height'):
        conn.execute('UPDATE models SET target_height = ?, max_width = ? WHERE id = ? '
                     'AND (target_height IS NULL OR max_width IS NULL)',
                     (int(facts['target_height']), int(facts.get('max_width') or 0), model_id))
    conn.execute('UPDATE models SET conventions = ? WHERE id = ? AND conventions IS NULL',
                 (json.dumps(list(convention_names)), model_id))
    conn.commit()


def reader_name(conn, model_id: int | None) -> str:
    """What to call a model in the author of its readings."""
    row = get_model(conn, model_id) if model_id is not None else None
    return row['name'] if row else f'model {model_id}'


UNNAMED_READER = 'model:ocr@model.ckpt'


def named_reader(author: str, reader: str) -> str:
    """Readings from before the model's name was written into the author all say
    `model.ckpt`, the file every training writes, which names nothing. Read those as the
    dataset's own OCR model - the closest thing left to who did the reading."""
    name, _, decode = author.partition('#')
    if not reader or name != UNNAMED_READER:
        return author
    return f'model:ocr@{reader}' + (f'#{decode}' if decode else '')


def job_reader(conn, job_id: str) -> str:
    """The OCR model a dataset names, or '' where it names none.

    Deliberately not falling back to the current default: an author is only nameless when
    it was written before the name went into it, and today's default says nothing about
    what read a page a year ago. Naming it anyway would put a model's name on work it
    never did."""
    row = conn.execute('SELECT model_ocr_id FROM jobs WHERE id = ?', (job_id,)).fetchone()
    model = get_model(conn, row['model_ocr_id']) if row and row['model_ocr_id'] else None
    return (model['name'] if model else '') or ''


def line_readers(conn, line_ids) -> dict[int, str]:
    """Which model last read each of these lines, off the revision log, named."""
    ids = list(line_ids)
    if not ids:
        return {}
    marks = ','.join('?' * len(ids))
    rows = conn.execute(
        'SELECT r.target_id, r.author, r.job_id FROM revisions r JOIN ('
        "SELECT MAX(id) mid FROM revisions WHERE target_type = 'line' "
        f"AND author LIKE 'model:ocr@%' AND target_id IN ({marks}) "
        'GROUP BY target_id) latest ON latest.mid = r.id', (*ids,)).fetchall()
    readers = {}
    named = {line_id: '' for line_id in ids}
    for row in rows:
        if row['job_id'] not in readers:
            readers[row['job_id']] = job_reader(conn, row['job_id'])
        named[row['target_id']] = named_reader(row['author'], readers[row['job_id']])
    return named


def model_payload(row) -> dict:
    model = dict(row)
    model['is_default'] = bool(model['is_default'])
    model['archived'] = bool(model['archived'])
    model['metrics'] = json.loads(model['metrics']) if model['metrics'] else None
    model['conventions'] = json.loads(model['conventions']) if model.get('conventions') else None
    return model
