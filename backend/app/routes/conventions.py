from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import conventions
from app.deps import current_user, get_db, require_role

router = APIRouter(tags=['conventions'])


class FlagBody(BaseModel):
    name: str
    label: str
    description: str = ''


class FlagPatch(BaseModel):
    label: str | None = None
    description: str | None = None


def _flag(conn, name: str) -> dict:
    flag = next((f for f in conventions.catalog(conn) if f['name'] == name), None)
    if flag is None:
        raise HTTPException(404, 'no such convention flag')
    return flag


@router.get('/api/convention-flags')
def list_flags(conn=Depends(get_db), user: dict = Depends(current_user)):
    """Every transcription-convention flag, as people read it, with how many models read it
    and how many datasets ask for it."""
    return {'flags': conventions.catalog(conn)}


@router.post('/api/convention-flags')
def add_flag(body: FlagBody, conn=Depends(get_db), user: dict = Depends(require_role('admin'))):
    """A flag no model declares yet, described ahead of the model that will read it."""
    if not conventions.FLAG_NAME.match(body.name):
        raise HTTPException(400, 'a flag name is lowercase letters, digits and underscores, starting with a letter')
    if not body.label.strip():
        raise HTTPException(400, 'a flag needs a label')
    if conn.execute('SELECT 1 FROM convention_flags WHERE name = ?', (body.name,)).fetchone():
        raise HTTPException(409, f'there is already a flag named {body.name}')
    conn.execute('INSERT INTO convention_flags (name, label, description) VALUES (?, ?, ?)',
                 (body.name, body.label.strip(), body.description.strip()))
    conn.commit()
    return _flag(conn, body.name)


@router.patch('/api/convention-flags/{name}')
def update_flag(name: str, body: FlagPatch, conn=Depends(get_db), user: dict = Depends(require_role('admin'))):
    """The label and description; the name is what models and datasets store, so it stays."""
    _flag(conn, name)
    if body.label is not None:
        if not body.label.strip():
            raise HTTPException(400, 'a flag needs a label')
        conn.execute('UPDATE convention_flags SET label = ? WHERE name = ?', (body.label.strip(), name))
    if body.description is not None:
        conn.execute('UPDATE convention_flags SET description = ? WHERE name = ?', (body.description.strip(), name))
    conn.commit()
    return _flag(conn, name)
