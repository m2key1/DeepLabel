import json

from fastapi import HTTPException

from app.store import DATA_USE_COLUMNS

PURPOSES = {'training': 'training or validating a model', 'test': 'scoring models',
            'external_llm': 'LLM providers outside the house', 'export': 'export by others'}
# An admin who stays on a dataset page is one visit, not one per refresh.
ADMIN_VISIT_MINUTES = 30


def allowed(conn, job_id: str, use: str) -> bool:
    row = conn.execute(f'SELECT {DATA_USE_COLUMNS[use]} FROM jobs WHERE id = ?', (job_id,)).fetchone()
    return row is None or bool(row[0])


def refusal(conn, job_ids, use: str) -> str | None:
    """Why these datasets may not be used this way, or None when all of them may."""
    names = [row['name'] for row in conn.execute(
        f'SELECT name FROM jobs WHERE id IN ({",".join("?" * len(job_ids))}) AND {DATA_USE_COLUMNS[use]} = 0 '
        'ORDER BY name', list(job_ids))] if job_ids else []
    if not names:
        return None
    quoted = ', '.join(f'"{name}"' for name in names)
    return f'{quoted} may not be used for {PURPOSES[use]} - its owner has switched that off'


def require(conn, job_ids, use: str) -> None:
    reason = refusal(conn, job_ids, use)
    if reason:
        raise HTTPException(403, reason)


def llm_refusal(conn, job_id: str, llm_model_ids) -> str | None:
    """Why a dataset's pages may not go to these LLM models: it keeps them from external
    providers, and a model's connection is not marked self-hosted."""
    if allowed(conn, job_id, 'external_llm') or not llm_model_ids:
        return None
    external = [row['label'] for row in conn.execute(
        f'SELECT m.label FROM llm_models m JOIN llm_connections c ON c.id = m.connection_id '
        f'WHERE m.id IN ({",".join("?" * len(llm_model_ids))}) AND c.self_hosted = 0 ORDER BY m.label',
        list(llm_model_ids))]
    if not external:
        return None
    return (f'this dataset is kept from LLM providers outside the house, and '
            f'{", ".join(external)} is not on a connection an admin has marked self-hosted')


def require_llm(conn, job_id: str, llm_model_ids) -> None:
    reason = llm_refusal(conn, job_id, llm_model_ids)
    if reason:
        raise HTTPException(403, reason)


def require_export(conn, job_id: str, user: dict) -> None:
    """The owner always may; everyone else, admins included, only while the owner allows it."""
    row = conn.execute('SELECT owner, use_export FROM jobs WHERE id = ?', (job_id,)).fetchone()
    if row is not None and not row['use_export'] and row['owner'] != user['username']:
        raise HTTPException(403, 'the owner of this dataset keeps its exports to themselves')


def restricted(conn, job_id: str) -> bool:
    row = conn.execute(f'SELECT {" + ".join(DATA_USE_COLUMNS.values())} FROM jobs WHERE id = ?',
                       (job_id,)).fetchone()
    return row is not None and row[0] < len(DATA_USE_COLUMNS)


def note_admin_visit(conn, job_id: str, user: dict) -> None:
    """An admin opening a dataset that restricts its use, without owning it or having it
    shared with them, is recorded for the owner to see."""
    if user['role'] != 'admin' or not restricted(conn, job_id):
        return
    row = conn.execute('SELECT owner, group_id FROM jobs WHERE id = ?', (job_id,)).fetchone()
    me = user['username']
    if row['owner'] == me or conn.execute(
            'SELECT 1 FROM job_assignees WHERE job_id = ? AND username = ? UNION '
            'SELECT 1 FROM group_assignees WHERE group_id = ? AND username = ?',
            (job_id, me, row['group_id'], me)).fetchone():
        return
    if conn.execute("SELECT 1 FROM job_log WHERE job_id = ? AND username = ? AND action = 'admin_visit' "
                    f"AND created_at > datetime('now', '-{ADMIN_VISIT_MINUTES} minutes')",
                    (job_id, me)).fetchone():
        return
    log(conn, job_id, me, 'admin_visit')


def log(conn, job_id: str, username: str, action: str, detail: dict | None = None) -> None:
    conn.execute('INSERT INTO job_log (job_id, username, action, detail) VALUES (?, ?, ?, ?)',
                 (job_id, username, action, json.dumps(detail or {})))
    conn.commit()


def models_made_from(conn, job_id: str) -> list[dict]:
    """The models trained, validated or scored on a dataset, each with its roles."""
    rows = conn.execute(
        'SELECT m.id, m.name, m.task, m.created_at, t.id AS training_id, group_concat(md.role) AS roles '
        'FROM model_datasets md JOIN models m ON m.id = md.model_id '
        'LEFT JOIN trainings t ON t.model_id = m.id '
        'WHERE md.job_id = ? GROUP BY m.id ORDER BY m.created_at, m.id', (job_id,)).fetchall()
    order = ['train', 'valid', 'test']
    return [{'id': r['id'], 'name': r['name'], 'task': r['task'], 'created_at': r['created_at'],
             'training_id': r['training_id'], 'roles': sorted(r['roles'].split(','), key=order.index)}
            for r in rows]


def admin_visits(conn, job_id: str, limit: int = 50) -> list[dict]:
    return [dict(r) for r in conn.execute(
        "SELECT username, created_at FROM job_log WHERE job_id = ? AND action = 'admin_visit' "
        'ORDER BY created_at DESC, id DESC LIMIT ?', (job_id, limit))]
