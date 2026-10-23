"""Layout templates: named sets of layout classes, each a content class or a container
that reads its contents down or across. A dataset gets its own copy of a template's
classes when it is created; Schematismus is the default template and keeps
the Schematismus pipeline's own reading rules.

class_id is immutable once assigned - COCO category ids in exports, training snapshots
and the checkpoints trained on them embed it - so ids are never renumbered or reused.
"""
import json
import sqlite3

from app import layout_classes, reading_order, store

SCHEMATISMUS = 'Schematismus'
SCHEMATISMUS_RULES = 'schematismus'
# How each Schematismus container reads. Divider is a container that holds nothing: a rule
# with no text, kept out of line detection and OCR.
SCHEMATISMUS_READS = {'Column': 'down', 'Nested-Column': 'down', 'Curly': 'down',
                      'Table': 'across', 'Nested-Table': 'across', 'WeirdTable': 'across'}
# The order the Schematismus classes are offered in, most used first, so the editor's digit
# shortcuts land on the classes reached for; their ids keep the checkpoint's order.
SCHEMATISMUS_DISPLAY = ['Paragraph', 'Header', 'BigParagraph', 'PageNumber', 'PageHeader', 'Footnote',
                        'SheetNumber', 'Column', 'Table', 'Divider', 'Curly', 'Nested-Column', 'Nested-Table',
                        'WeirdTable']
ROLES = ('content', 'container')
READS = ('down', 'across')
# How what stands outside every container reads.
TOP_TO_BOTTOM = 'top_to_bottom'
FROM_PAGE = 'from_page'
OUTSIDE_ORDERS = (TOP_TO_BOTTOM, FROM_PAGE)


def schematismus_classes() -> list[dict]:
    """The Schematismus classes at the ids its checkpoints and exports already use: their
    position in the checkpoint's label order, from 1."""
    return [{'id': i + 1, 'name': name,
             'role': 'container' if name in layout_classes.CONTAINER_CLASSES else 'content',
             'reads': SCHEMATISMUS_READS.get(name), 'color': None, 'position': SCHEMATISMUS_DISPLAY.index(name)}
            for i, name in enumerate(layout_classes.CLASS_NAMES)]


def ensure_schematismus(conn: sqlite3.Connection) -> int:
    """The Schematismus template, created on first use, and the default while no other is.
    Returns its id. No commit."""
    row = conn.execute('SELECT id FROM layout_templates WHERE rules = ?', (SCHEMATISMUS_RULES,)).fetchone()
    if row:
        template_id = row['id']
    else:
        template_id = conn.execute('INSERT INTO layout_templates (name, owner, rules, outside_order) '
                                   'VALUES (?, NULL, ?, ?)', (SCHEMATISMUS, SCHEMATISMUS_RULES, TOP_TO_BOTTOM)).lastrowid
        insert_classes(conn, 'layout_template_classes', 'template_id', template_id, schematismus_classes())
    if not conn.execute('SELECT 1 FROM layout_templates WHERE is_default = 1').fetchone():
        conn.execute('UPDATE layout_templates SET is_default = 1 WHERE id = ?', (template_id,))
    return template_id


def insert_classes(conn, table: str, owner_column: str, owner, classes: list[dict]) -> None:
    for c in classes:
        conn.execute(f'INSERT OR IGNORE INTO {table} ({owner_column}, class_id, name, role, reads, color, position) '
                     'VALUES (?,?,?,?,?,?,?)',
                     (owner, c['id'], c['name'], c['role'], c['reads'], c['color'], c['position']))


def default_template(conn: sqlite3.Connection) -> int:
    row = conn.execute('SELECT id FROM layout_templates WHERE is_default = 1').fetchone()
    return row['id'] if row else ensure_schematismus(conn)


def template_classes(conn: sqlite3.Connection, template_id: int) -> list[dict]:
    return _classes(conn.execute(
        'SELECT class_id, name, role, reads, color, position FROM layout_template_classes '
        'WHERE template_id = ? ORDER BY position, class_id', (template_id,)))


def copy_into(conn: sqlite3.Connection, job_id: str, template_id: int | None = None) -> None:
    """Gives a new dataset its own copy of a template's classes - the default template's
    unless one is named - and the template's reading rules. No commit."""
    template = conn.execute('SELECT id, rules FROM layout_templates WHERE id = ?',
                            (template_id or default_template(conn),)).fetchone()
    if template is None:
        raise ValueError(f'no layout template {template_id}')
    insert_classes(conn, 'job_layout_classes', 'job_id', job_id, template_classes(conn, template['id']))
    conn.execute('UPDATE jobs SET layout_template_id = ?, layout_rules = ? WHERE id = ?',
                 (template['id'], template['rules'], job_id))


def backfill(conn: sqlite3.Connection) -> None:
    """Every text dataset from before templates gets the Schematismus classes and rules -
    the vocabulary it was annotated in. Idempotent: only datasets with no classes yet."""
    template_id = ensure_schematismus(conn)
    for row in conn.execute("SELECT id FROM jobs WHERE task NOT IN ('map_segmentation','map_lines') "
                            'AND id NOT IN (SELECT DISTINCT job_id FROM job_layout_classes)').fetchall():
        copy_into(conn, row['id'], template_id)


def _classes(rows) -> list[dict]:
    return [{'id': r['class_id'], 'name': r['name'], 'role': r['role'], 'reads': r['reads'], 'color': r['color'],
             'position': r['position']} for r in rows]


def job_classes(conn: sqlite3.Connection, job_id: str) -> list[dict]:
    """A dataset's layout classes in display order; Schematismus' for one that has none."""
    found = _classes(conn.execute(
        'SELECT class_id, name, role, reads, color, position FROM job_layout_classes '
        'WHERE job_id = ? ORDER BY position, class_id', (job_id,)))
    return found or sorted(schematismus_classes(), key=lambda c: c['position'])


def _job_rules(conn: sqlite3.Connection, job_id: str) -> str | None:
    row = conn.execute('SELECT layout_rules FROM jobs WHERE id = ?', (job_id,)).fetchone()
    if row is None or not conn.execute('SELECT 1 FROM job_layout_classes WHERE job_id = ? LIMIT 1',
                                       (job_id,)).fetchone():
        return SCHEMATISMUS_RULES
    return row['layout_rules']


class Vocabulary:
    """A dataset's classes as the pipeline and the editor use them, and what it decided
    for a layout model's labels it lacks: label -> class name, or None to leave it out."""

    def __init__(self, classes: list[dict], rules: str | None, labels: dict | None = None):
        self.classes = classes
        self.by_name = {c['name']: c for c in classes}
        self.schematismus = rules == SCHEMATISMUS_RULES
        self.labels = labels or {}

    def place(self, label: str) -> str | None:
        """The class a model's box with this label is stored as: the class of that name, the
        class the dataset mapped the label to, or None - skipped, or not decided yet."""
        if label in self.by_name:
            return label
        return self.labels.get(label)

    def resolve(self, raw: str) -> tuple[str, str, str]:
        """A label -> (class_name, raw_class_name, kind). Schematismus stores some labels
        under their downstream name (PageNumber as Pagenumber, WeirdTable as Table). A
        label the dataset lacks is kept as content under its own name."""
        found = self.by_name.get(raw)
        class_name = layout_classes.DOWNSTREAM_LABEL_MAP.get(raw, raw) if self.schematismus else raw
        return class_name, raw, found['role'] if found else 'content'

    def names(self) -> list[str]:
        return [c['name'] for c in self.classes]

    def reading_rules(self, template=None) -> reading_order.Rules:
        """How a page of this dataset reads: by its layout model's template where it runs
        one - the Schematismus rules for the Schematismus template, and
        what stands outside the containers as that template says - else by its own
        classes. The containers themselves are the dataset's."""
        containers = {c['name']: c['reads'] for c in self.classes if c['role'] == 'container' and c['reads']}
        schematismus = self.schematismus if template is None else template['rules'] == SCHEMATISMUS_RULES
        top_to_bottom = template is not None and template['outside_order'] == TOP_TO_BOTTOM
        if schematismus:
            return reading_order.schematismus_rules({name: reads for name, reads in containers.items()
                                                     if name not in layout_classes.CLASS_NAMES}, top_to_bottom)
        return reading_order.template_rules(containers, top_to_bottom)


def vocabulary(conn: sqlite3.Connection, job_id: str, model_id: int | None = None) -> Vocabulary:
    classes = job_classes(conn, job_id)
    names = {c['id']: c['name'] for c in classes}
    labels = {} if model_id is None else {
        r['label']: names.get(r['class_id']) for r in conn.execute(
            'SELECT label, class_id FROM layout_label_maps WHERE job_id = ? AND model_id = ?', (job_id, model_id))}
    return Vocabulary(classes, _job_rules(conn, job_id), labels)


def model_labels(conn: sqlite3.Connection, model_id: int | None) -> list[str]:
    """The labels a layout model predicts: what its backend declares, or the Schematismus
    checkpoint's for a model read in-process."""
    from app import backend_client

    client = backend_client.client_for(conn, model_id)
    if client is None:
        return list(layout_classes.CLASS_NAMES)
    return list(client.info().get('tasks_detail', {}).get('layout', {}).get('labels') or [])


def layout_model_id(conn: sqlite3.Connection, job_id: str) -> int | None:
    """The layout model a run of this dataset reads with: its own choice, else the default."""
    row = conn.execute('SELECT model_layout_id FROM jobs WHERE id = ?', (job_id,)).fetchone()
    if row and row['model_layout_id']:
        return row['model_layout_id']
    found = conn.execute("SELECT id FROM models WHERE task = 'layout' AND is_default = 1 AND archived = 0").fetchone()
    return found['id'] if found else None


def reading_template(conn: sqlite3.Connection, job_id: str):
    """The template whose reading order this dataset's pages follow: its layout model's.
    None for a dataset that runs no layout model, or whose model belongs
    to no template - its order is worked out from the page."""
    job = conn.execute('SELECT run_layout FROM jobs WHERE id = ?', (job_id,)).fetchone()
    model_id = layout_model_id(conn, job_id) if job and job['run_layout'] else None
    if model_id is None:
        return None
    return conn.execute('SELECT t.* FROM layout_templates t JOIN models m ON m.layout_template_id = t.id '
                        'WHERE m.id = ?', (model_id,)).fetchone()


def order_set_by(conn: sqlite3.Connection, job_id: str) -> str | None:
    """The template whose order this dataset reads by instead of its leaves-and-columns
    setting - one reading top to bottom - or None where that setting decides."""
    template = reading_template(conn, job_id)
    return template['name'] if template is not None and template['outside_order'] == TOP_TO_BOTTOM else None


def label_plan(conn: sqlite3.Connection, job_id: str, model_id: int, labels: list[str]) -> list[dict]:
    """Each label and where its boxes go: `how` is 'name' (a class of that name), 'mapped',
    'skipped', or 'undecided' - which a run leaves out until someone decides."""
    found = vocabulary(conn, job_id, model_id)
    decided = {r['label']: r['class_id'] for r in conn.execute(
        'SELECT label, class_id FROM layout_label_maps WHERE job_id = ? AND model_id = ?', (job_id, model_id))}
    plan = []
    for label in labels:
        if label in found.by_name:
            plan.append({'label': label, 'class_id': found.by_name[label]['id'], 'how': 'name'})
        elif label in decided and found.labels.get(label):
            plan.append({'label': label, 'class_id': decided[label], 'how': 'mapped'})
        elif label in decided and decided[label] is None:
            plan.append({'label': label, 'class_id': None, 'how': 'skipped'})
        else:
            plan.append({'label': label, 'class_id': None, 'how': 'undecided'})
    return plan


def decide_labels(conn: sqlite3.Connection, job_id: str, model_id: int, choices: dict) -> None:
    """Record what the dataset does with these labels of the model: a class id, or None to
    leave the boxes out. No commit."""
    ids = {c['id'] for c in job_classes(conn, job_id)}
    for label, class_id in choices.items():
        if class_id is not None and class_id not in ids:
            raise ClassError(400, f'no layout class {class_id} in this dataset')
        conn.execute('INSERT INTO layout_label_maps (job_id, model_id, label, class_id) VALUES (?,?,?,?) '
                     'ON CONFLICT (job_id, model_id, label) DO UPDATE SET class_id = excluded.class_id',
                     (job_id, model_id, label, class_id))


class ClassError(ValueError):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def _class_row(conn, job_id: str, class_id: int) -> dict:
    found = next((c for c in job_classes(conn, job_id) if c['id'] == class_id), None)
    if found is None:
        raise ClassError(404, f'no layout class {class_id} in this dataset')
    return found


def is_builtin(conn, job_id: str, found: dict) -> bool:
    """A Schematismus class of a dataset reading by the Schematismus rules."""
    return (_job_rules(conn, job_id) == SCHEMATISMUS_RULES and found['name'] in layout_classes.CLASS_NAMES
            and found['id'] == layout_classes.CLASS_NAMES.index(found['name']) + 1)


def _check(conn, job_id: str, name: str, role: str, reads: str | None, keep: int | None = None) -> str:
    name = name.strip()
    if not name:
        raise ClassError(400, 'a class needs a name')
    if any(c['name'].lower() == name.lower() and c['id'] != keep for c in job_classes(conn, job_id)):
        raise ClassError(409, f'a class named "{name}" exists')
    if role not in ROLES:
        raise ClassError(400, f'role must be one of {list(ROLES)}')
    if role == 'container' and reads not in READS:
        raise ClassError(400, f'container class {name} must read down or across')
    return name


def _elements_of(conn, job_id: str, name: str) -> list[int]:
    return [r['id'] for r in conn.execute(
        'SELECT e.id FROM elements e JOIN pages p ON e.page_id = p.id '
        "WHERE p.job_id = ? AND e.deleted = 0 AND e.kind != 'orphan' "
        'AND COALESCE(e.raw_class_name, e.class_name) = ?', (job_id, name))]


def element_counts(conn, job_id: str) -> dict:
    return {r['name']: r['c'] for r in conn.execute(
        'SELECT COALESCE(e.raw_class_name, e.class_name) name, COUNT(*) c FROM elements e '
        "JOIN pages p ON e.page_id = p.id WHERE p.job_id = ? AND e.deleted = 0 AND e.kind != 'orphan' "
        'AND p.deleted = 0 GROUP BY 1', (job_id,))}


def _materialize(conn, job_id: str) -> None:
    """A dataset reading the Schematismus fallback gets its own rows before its first edit."""
    if not conn.execute('SELECT 1 FROM job_layout_classes WHERE job_id = ? LIMIT 1', (job_id,)).fetchone():
        copy_into(conn, job_id, ensure_schematismus(conn))


def add_class(conn, job_id: str, name: str, role: str = 'content', reads: str | None = None,
              color: str | None = None) -> int:
    """A new class at the next id never used in this dataset. No commit."""
    _materialize(conn, job_id)
    name = _check(conn, job_id, name, role, reads)
    class_id = conn.execute(
        'SELECT MAX(COALESCE((SELECT MAX(class_id) FROM job_layout_classes WHERE job_id = ?), 0), '
        'max_retired_layout_class_id) + 1 FROM jobs WHERE id = ?', (job_id, job_id)).fetchone()[0]
    position = len(job_classes(conn, job_id))
    insert_classes(conn, 'job_layout_classes', 'job_id', job_id,
                   [{'id': class_id, 'name': name, 'role': role, 'reads': reads if role == 'container' else None,
                     'color': color, 'position': position}])
    return class_id


def change_class(conn, job_id: str, class_id: int, author: str, name: str | None = None,
                 role: str | None = None, reads: str | None = None, color: str | None = None,
                 recolour: bool = False) -> list[int]:
    """Rename, retype or recolour a class; its elements follow a new name and a new role.
    A Schematismus built-in only takes a colour. Returns the elements it
    changed. No commit."""
    _materialize(conn, job_id)
    found = _class_row(conn, job_id, class_id)
    changing = (name is not None and name.strip() != found['name']) or (role is not None and role != found['role']) \
        or (reads is not None and reads != found['reads'])
    if changing and is_builtin(conn, job_id, found):
        raise ClassError(409, f'{found["name"]} is a Schematismus class: it can be recoloured, not changed. '
                              'Save the classes as a new template to change it.')
    new_role = role or found['role']
    new_name = _check(conn, job_id, name if name is not None else found['name'], new_role,
                      (reads or found['reads']) if new_role == 'container' else None, keep=class_id)
    new_reads = (reads or found['reads']) if new_role == 'container' else None
    conn.execute('UPDATE job_layout_classes SET name = ?, role = ?, reads = ?, color = ? '
                 'WHERE job_id = ? AND class_id = ?',
                 (new_name, new_role, new_reads, color if recolour else found['color'], job_id, class_id))
    if new_name != found['name'] or new_role != found['role']:
        return _move_elements(conn, job_id, found['name'], new_name, author)
    return []


def _move_elements(conn, job_id: str, old: str, new: str, author: str) -> list[int]:
    """The elements of class `old` become class `new`, kind and all, each logged."""
    class_name, raw, kind = vocabulary(conn, job_id).resolve(new)
    moved = _elements_of(conn, job_id, old)
    for element_id in moved:
        conn.execute('UPDATE elements SET class_name = ?, raw_class_name = ?, kind = ? WHERE id = ?',
                     (class_name, raw, kind, element_id))
        store.log_element(conn, element_id, author, 'update')
    return moved


def remove_class(conn, job_id: str, class_id: int, author: str, into: int | None = None) -> list[int]:
    """Remove a class: its elements are deleted, or merged into another class. Its id is
    retired. Returns the elements it touched. No commit."""
    _materialize(conn, job_id)
    found = _class_row(conn, job_id, class_id)
    if is_builtin(conn, job_id, found):
        raise ClassError(409, f'{found["name"]} is a Schematismus class and cannot be removed from this dataset')
    elements = _elements_of(conn, job_id, found['name'])
    if into is not None:
        if into == class_id:
            raise ClassError(400, 'merge into a different class')
        target = _class_row(conn, job_id, into)
        _move_elements(conn, job_id, found['name'], target['name'], author)
    else:
        for element_id in elements:
            conn.execute('UPDATE elements SET deleted = 1 WHERE id = ?', (element_id,))
            store.log_element(conn, element_id, author, 'delete')
    conn.execute('DELETE FROM job_layout_classes WHERE job_id = ? AND class_id = ?', (job_id, class_id))
    conn.execute('UPDATE jobs SET max_retired_layout_class_id = MAX(max_retired_layout_class_id, ?) WHERE id = ?',
                 (class_id, job_id))
    return elements


def reorder(conn, job_id: str, order: list[int]) -> None:
    """The display order of a dataset's classes; ids stay. No commit."""
    _materialize(conn, job_id)
    if sorted(order) != sorted(c['id'] for c in job_classes(conn, job_id)):
        raise ClassError(400, 'order must list every class of the dataset exactly once')
    for position, class_id in enumerate(order):
        conn.execute('UPDATE job_layout_classes SET position = ? WHERE job_id = ? AND class_id = ?',
                     (position, job_id, class_id))


def training_classes(conn: sqlite3.Connection, job_ids: list[str]) -> tuple[list[dict], dict]:
    """The classes a layout training learns: its datasets' classes merged by name, and for
    each dataset its class ids -> the training's. Datasets that agree on every id (all
    Schematismus, say) keep their ids, so a training on them is cut as it always was;
    otherwise the classes are numbered afresh in the order the datasets list them."""
    per_job = {job_id: job_classes(conn, job_id) for job_id in job_ids}
    pairs = {(c['id'], c['name']) for classes in per_job.values() for c in classes}
    ids = {}
    if len({i for i, _ in pairs}) == len(pairs) == len({n for _, n in pairs}):
        ids = {name: class_id for class_id, name in pairs}
    else:
        for classes in per_job.values():
            for c in sorted(classes, key=lambda c: c['id']):
                ids.setdefault(c['name'], len(ids) + 1)
    categories = [{'id': class_id, 'name': name} for name, class_id in sorted(ids.items(), key=lambda kv: kv[1])]
    remap = {job_id: {c['id']: ids[c['name']] for c in classes} for job_id, classes in per_job.items()}
    return categories or [{'id': c['id'], 'name': c['name']} for c in schematismus_classes()], remap


def model_classes(conn: sqlite3.Connection, model_id: int) -> list[str]:
    """The classes a layout model was trained on, by category id: what its training
    recorded, else the labels it declares (the Schematismus ones for an in-process model)."""
    row = conn.execute('SELECT classes FROM models WHERE id = ?', (model_id,)).fetchone()
    if row and row['classes']:
        return [c['name'] for c in sorted(json.loads(row['classes']), key=lambda c: c['id'])]
    return model_labels(conn, model_id)
