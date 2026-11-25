import json

from fastapi import HTTPException

from app import rights
from app.store import DATA_USE_COLUMNS

PURPOSES = {'training': 'training or validating a model', 'test': 'scoring models',
            'external_llm': 'LLM providers outside the house', 'export': 'export by others'}


def allowed(conn, job_id: str, use: str) -> bool:
    row = conn.execute(f'SELECT {DATA_USE_COLUMNS[use]} FROM jobs WHERE id = ?', (job_id,)).fetchone()
    return row is None or bool(row[0])


def refusal(conn, job_ids, use: str) -> str | None:
    """Why these datasets may not be used this way, or None when all of them may. Training
    also waits for the owner's word where the rights restrict it."""
    names = [row['name'] for row in conn.execute(
        f'SELECT name FROM jobs WHERE id IN ({",".join("?" * len(job_ids))}) AND {DATA_USE_COLUMNS[use]} = 0 '
        'ORDER BY name', list(job_ids))] if job_ids else []
    if not names:
        return rights.training_refusal(conn, job_ids) if use == 'training' and job_ids else None
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
    """Its creator always may; everyone else, admins included, only while its use allows it."""
    row = conn.execute('SELECT owner, use_export FROM jobs WHERE id = ?', (job_id,)).fetchone()
    if row is not None and not row['use_export'] and row['owner'] != user['username']:
        raise HTTPException(403, 'the creator of this dataset keeps its exports to themselves')


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
