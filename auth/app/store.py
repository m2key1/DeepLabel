import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCHEMA = """
-- Roles are enforced by the frontend/backend; accounts live in the OIDC provider (subject = its 'sub').
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT UNIQUE NOT NULL,
    username TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    display_name TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'member',
    active INTEGER NOT NULL DEFAULT 1,
    -- Training is granted per person and per target, because the two cost different
    -- things: the local GPU is one card everyone shares, the cluster is someone's
    -- allocation. Independent, so a person can have the cluster without tying up the
    -- local card. Admins always have both.
    train_local INTEGER NOT NULL DEFAULT 1,
    train_cluster INTEGER NOT NULL DEFAULT 0,
    -- SLURM account this person's jobs are charged to, empty to fall back to the
    -- cluster-wide default. Constrained to account-name characters: it ends up in an
    -- HTTP header and then in a #SBATCH directive.
    slurm_account TEXT NOT NULL DEFAULT '',
    settings TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT,
    -- When the account was last used, which is not when it last signed in: a session
    -- lasts weeks, so someone here half an hour ago can have logged in last month.
    last_seen_at TEXT
);
-- What changed on an account and who did it: admin edits of role, status and grants,
-- plus renames the provider reports at login. Attribution in the backend is keyed by
-- username, so a rename is exactly the kind of event someone will need to trace.
CREATE TABLE IF NOT EXISTS user_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor TEXT NOT NULL,
    field TEXT NOT NULL,
    old_value TEXT NOT NULL,
    new_value TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_user_audit_user ON user_audit(user_id, id);
-- Opaque server-side sessions: the cookie carries only the token, so logout and
-- deactivate revoke instantly. Cookies (not headers) because SSE / <img> / <a> carry them.
CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
-- Long-lived credentials for scripts, which have no cookie to send. Only the hash is
-- stored, so a leaked database yields no usable token; `prefix` exists to let a user
-- recognise which token a row is. A read-only token is refused every write by the
-- backend, so one pasted into a notebook cannot destroy a dataset.
CREATE TABLE IF NOT EXISTS api_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT '',
    token_hash TEXT UNIQUE NOT NULL,
    prefix TEXT NOT NULL DEFAULT '',
    readonly INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT,
    expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
"""

ROLES = ('admin', 'member', 'viewer')

# What a person may ask the backend to do, beyond reading and editing what they can
# already see. Ordered, because the admin page lays them out in this order.
CAPABILITIES = (
    'pipeline.layout',   # detect the layout boxes again
    'pipeline.lines',    # detect the lines again
    'pipeline.ocr',      # read the lines again
    'pipeline.discard',  # the answers that throw checked work away
    'dataset.delete',
    'models.manage',     # register, rename, retire and default a model
    'train.local',
    'train.cluster',
)

# A role is a name for a set of these. Everyone starts from their role and an admin can
# make an exception per person, which is stored as the exception rather than as the whole
# set - so a role gaining a capability later reaches everybody who never overrode it.
ROLE_CAPS = {
    'admin': frozenset(CAPABILITIES),
    # A member runs the pipeline over the datasets they can already open, but does not
    # throw away what somebody checked, delete a dataset or touch the model registry.
    'member': frozenset({'pipeline.layout', 'pipeline.lines', 'pipeline.ocr', 'train.local'}),
    'viewer': frozenset(),
}

# The two grants that predate this and have their own columns. They are capabilities like
# any other now, but for a member these columns are where they are kept: the Training
# column on the admin page and the permission matrix both write here, so the two cannot
# disagree. An admin has every capability and a viewer may not write at all, so the
# columns never meant anything for either.
GRANT_COLUMNS = {'train.local': 'train_local', 'train.cluster': 'train_cluster'}


def role_caps(role: str) -> frozenset:
    return ROLE_CAPS.get(role, frozenset())


def grant_columns(role: str) -> dict:
    return GRANT_COLUMNS if role == 'member' else {}


def effective_caps(user) -> set:
    """The role's set with the person's exceptions applied."""
    caps = set(role_caps(user['role']))
    for cap, allowed in overrides_of(user).items():
        caps.add(cap) if allowed else caps.discard(cap)
    return caps


def overrides_of(user) -> dict:
    """Every exception made for this person, wherever it is kept."""
    role = role_caps(user['role'])
    overrides = stored_overrides(user)
    for cap, column in grant_columns(user['role']).items():
        if bool(user[column]) is not (cap in role):
            overrides[cap] = bool(user[column])
    return overrides


def stored_overrides(user) -> dict:
    """The exceptions kept in the permissions column: only what differs from the role,
    only names this build still offers, and none that a grant column holds instead. A
    viewer has none: every write of theirs is refused before a capability is looked at."""
    if user['role'] == 'viewer':
        return {}
    role = role_caps(user['role'])
    columns = grant_columns(user['role'])
    return {cap: allowed for cap, allowed in _stored_permissions(user).items()
            if cap not in columns and allowed is not (cap in role)}


def dormant_grants(user) -> dict:
    """What is kept for this person that their role ignores: the grants stored on a
    viewer account, and the training columns of anyone but a member, read as a member's."""
    if user['role'] == 'member':
        return {}
    member = role_caps('member')
    dormant = {cap: bool(user[column]) for cap, column in GRANT_COLUMNS.items()
               if bool(user[column]) is not (cap in member)}
    if user['role'] == 'viewer':
        dormant.update({cap: True for cap, allowed in _stored_permissions(user).items()
                        if allowed and cap not in GRANT_COLUMNS})
    return dormant


def _stored_permissions(user) -> dict:
    try:
        stored = json.loads(user['permissions'] or '{}')
    except (ValueError, TypeError):
        return {}
    if not isinstance(stored, dict):
        return {}
    return {cap: bool(value) for cap, value in stored.items() if cap in CAPABILITIES}


# One-off data moves, numbered in PRAGMA user_version so a connection runs each only once.
TRAINING_OVERRIDES_MOVED = 1


def _move_training_overrides_to_columns(conn: sqlite3.Connection) -> None:
    """The permission matrix once stored a member's training capabilities beside their
    columns, where the backend never looked. Where it differed from the member default
    it won in the capability set, so it wins here too and moves into the column it
    belongs in. Where it matched the default the set ignored it and the column counted,
    so it is dropped and the column stays."""
    member = role_caps('member')
    rows = conn.execute("SELECT id, permissions FROM users WHERE role = 'member' "
                        """AND permissions LIKE '%"train.%'""").fetchall()
    for row in rows:
        try:
            stored = json.loads(row['permissions'])
        except ValueError:
            continue
        if not isinstance(stored, dict):
            continue
        for cap, column in GRANT_COLUMNS.items():
            if cap not in stored:
                continue
            allowed = bool(stored.pop(cap))
            if allowed is not (cap in member):
                conn.execute(f'UPDATE users SET {column} = ? WHERE id = ?', (int(allowed), row['id']))
        conn.execute('UPDATE users SET permissions = ? WHERE id = ?',
                     (json.dumps(stored, sort_keys=True), row['id']))


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    if conn.execute('PRAGMA journal_mode').fetchone()[0].lower() != 'wal':
        conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA foreign_keys=ON')
    conn.executescript(SCHEMA)
    columns = {r[1] for r in conn.execute('PRAGMA table_info(users)')}
    if 'settings' not in columns:
        conn.execute("ALTER TABLE users ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'")
    if 'permissions' not in columns:
        conn.execute("ALTER TABLE users ADD COLUMN permissions TEXT NOT NULL DEFAULT '{}'")
    if 'train_cluster' not in columns:
        conn.execute('ALTER TABLE users ADD COLUMN train_cluster INTEGER NOT NULL DEFAULT 0')
        if 'cluster_access' in columns:  # the grant this replaced, kept so nobody loses it
            conn.execute('UPDATE users SET train_cluster = cluster_access')
    if 'train_local' not in columns:
        conn.execute('ALTER TABLE users ADD COLUMN train_local INTEGER NOT NULL DEFAULT 1')
    if 'slurm_account' not in columns:
        conn.execute("ALTER TABLE users ADD COLUMN slurm_account TEXT NOT NULL DEFAULT ''")
    if 'email' not in columns:
        conn.execute("ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''")
        conn.execute("ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT ''")
    if 'last_login_at' not in columns:
        conn.execute('ALTER TABLE users ADD COLUMN last_login_at TEXT')
    if 'last_seen_at' not in columns:
        conn.execute('ALTER TABLE users ADD COLUMN last_seen_at TEXT')
    if 'avatar' not in columns:
        # The token of the picture this person currently has, empty for none. It names the
        # file on disk and versions the URL, so a new picture is a new address and nothing
        # has to ask a cache to forget the old one.
        conn.execute("ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT ''")
    if conn.execute('PRAGMA user_version').fetchone()[0] < TRAINING_OVERRIDES_MOVED:
        _move_training_overrides_to_columns(conn)
        conn.execute(f'PRAGMA user_version = {TRAINING_OVERRIDES_MOVED}')
    conn.commit()
    return conn


def get_user_settings(conn: sqlite3.Connection, user_id: int) -> str:
    row = conn.execute('SELECT settings FROM users WHERE id = ?', (user_id,)).fetchone()
    return row['settings'] if row else '{}'


def merge_user_settings(conn: sqlite3.Connection, user_id: int, patch: dict) -> dict:
    """Write the named settings and leave the rest alone. The document is one blob, so a
    client that sends all of it overwrites whatever it had not heard about yet - a fold
    saved from one tab taking back a keyboard changed in another. Read and write are one
    immediate transaction, so two writers cannot interleave here either.

    One level deep on purpose: an overlay set or a key list is one setting, and merging
    into it would leave no way to remove a member."""
    conn.execute('BEGIN IMMEDIATE')
    try:
        row = conn.execute('SELECT settings FROM users WHERE id = ?', (user_id,)).fetchone()
        stored = row['settings'] if row is not None else None
        merged = {**json.loads(stored or '{}'), **patch}
        conn.execute('UPDATE users SET settings = ? WHERE id = ?', (json.dumps(merged), user_id))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return merged


def set_user_settings(conn: sqlite3.Connection, user_id: int, settings_json: str):
    conn.execute('UPDATE users SET settings = ? WHERE id = ?', (settings_json, user_id))
    conn.commit()


LOGIN_ACTOR = 'login'


def upsert_user(conn: sqlite3.Connection, subject: str, username: str, role: str | None = None,
                email: str = '', display_name: str = ''):
    """Return the user for an OIDC subject, creating it on first sight. `role` applies
    only when creating (bootstrap admin); an existing user's role is left to the admin
    UI. The profile fields are refreshed to the latest the provider reports; a changed
    username is logged because the backend attributes work by that name."""
    row = conn.execute('SELECT * FROM users WHERE subject = ?', (subject,)).fetchone()
    if row is None:
        conn.execute('INSERT INTO users (subject, username, email, display_name, role) VALUES (?, ?, ?, ?, ?)',
                     (subject, username or '', email or '', display_name or '', role or 'member'))
    else:
        reported = {'username': username, 'email': email, 'display_name': display_name}
        for field, value in reported.items():
            if value and value != row[field]:
                conn.execute(f'UPDATE users SET {field} = ? WHERE id = ?', (value, row['id']))
                if field == 'username':
                    log_user_change(conn, row['id'], LOGIN_ACTOR, field, row[field], value)
    conn.commit()
    return conn.execute('SELECT * FROM users WHERE subject = ?', (subject,)).fetchone()


def create_session(conn: sqlite3.Connection, user_id: int, token: str, expires_at: str):
    conn.execute('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)',
                 (token, user_id, expires_at))
    conn.execute("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", (user_id,))
    conn.commit()


def get_user_by_session(conn: sqlite3.Connection, token: str | None):
    """Active user behind a live (unexpired) session, or None."""
    if not token:
        return None
    return conn.execute(
        "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id "
        "WHERE s.token = ? AND u.active = 1 AND s.expires_at > datetime('now')",
        (token,)).fetchone()


SEEN_RESOLUTION_SECONDS = 60


def seen_is_stale(last_seen_at: str | None) -> bool:
    """Whether the account's last-seen time is old enough to be worth rewriting. Every
    authenticated request would otherwise take a write lock on the whole database for a
    column that is read at a minute's resolution, so the row already in hand is asked
    first and the write happens about once a minute per person."""
    if not last_seen_at:
        return True
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=SEEN_RESOLUTION_SECONDS)
    return last_seen_at < cutoff.strftime('%Y-%m-%d %H:%M:%S')


def touch_seen(conn: sqlite3.Connection, user_id: int):
    conn.execute("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?", (user_id,))
    conn.commit()


def delete_session(conn: sqlite3.Connection, token: str | None):
    if token:
        conn.execute('DELETE FROM sessions WHERE token = ?', (token,))
        conn.commit()


# One account as the admin page shows it: profile, role, grants, and how it is being
# used right now. Live means unexpired - a revoked session is deleted, not expired.
_USER_SUMMARY = """
    SELECT u.id, u.subject, u.username, u.email, u.display_name, u.role, u.active,
           u.train_local, u.train_cluster, u.slurm_account, u.permissions, u.created_at,
           u.last_login_at, u.last_seen_at, u.avatar,
           (SELECT COUNT(*) FROM sessions s
             WHERE s.user_id = u.id AND s.expires_at > datetime('now')) AS sessions,
           (SELECT COUNT(*) FROM api_tokens t
             WHERE t.user_id = u.id AND (t.expires_at IS NULL OR t.expires_at > datetime('now'))) AS tokens,
           (SELECT COUNT(*) FROM api_tokens t
             WHERE t.user_id = u.id AND t.expires_at <= datetime('now')) AS expired_tokens
    FROM users u
"""


def list_users(conn: sqlite3.Connection):
    return conn.execute(_USER_SUMMARY + ' ORDER BY u.created_at').fetchall()


def get_user(conn: sqlite3.Connection, user_id: int):
    return conn.execute(_USER_SUMMARY + ' WHERE u.id = ?', (user_id,)).fetchone()


def get_user_by_username(conn: sqlite3.Connection, username: str):
    """By the name the rest of the app knows someone as. The backend attributes work by
    username - a dataset's owner, who a line was checked by - so that is the only handle
    it can ask a picture for. Falls back to the subject for an account that never got one."""
    return conn.execute(
        _USER_SUMMARY + ' WHERE u.active = 1 AND (u.username = ? OR (u.username = ? AND u.subject = ?))',
        (username, '', username)).fetchone()


def get_user_by_email(conn: sqlite3.Connection, email: str):
    return conn.execute(_USER_SUMMARY + ' WHERE u.email = ?', (email,)).fetchone()


def set_avatar(conn: sqlite3.Connection, user_id: int, token: str) -> None:
    conn.execute('UPDATE users SET avatar = ? WHERE id = ?', (token, user_id))
    conn.commit()


def revoke_sessions(conn: sqlite3.Connection, user_id: int) -> int:
    """Sign a person out everywhere. Their API tokens stay: those are revoked one by one.
    Never commits, so the caller can log the revocation in the same transaction."""
    return conn.execute('DELETE FROM sessions WHERE user_id = ?', (user_id,)).rowcount


def log_user_change(conn: sqlite3.Connection, user_id: int, actor: str, field: str,
                    old_value, new_value):
    """Never commits: the caller's transaction carries the change and its log together."""
    conn.execute('INSERT INTO user_audit (user_id, actor, field, old_value, new_value) '
                 'VALUES (?, ?, ?, ?, ?)', (user_id, actor, field, str(old_value), str(new_value)))


def list_user_audit(conn: sqlite3.Connection, user_id: int):
    return conn.execute('SELECT id, actor, field, old_value, new_value, created_at FROM user_audit '
                        'WHERE user_id = ? ORDER BY id DESC', (user_id,)).fetchall()


# The account setters never commit: patch_user records each change in the audit log
# inside the same transaction, so a logged change and an applied one are the same thing.
def set_user_role(conn: sqlite3.Connection, user_id: int, role: str):
    conn.execute('UPDATE users SET role = ? WHERE id = ?', (role, user_id))


def clear_exceptions(conn: sqlite3.Connection, user_id: int):
    """Back to exactly what the role says, grant columns included: they hold a member's
    training exceptions, and a member's default is what they must read for anyone else."""
    member = role_caps('member')
    conn.execute('UPDATE users SET permissions = ?, train_local = ?, train_cluster = ? WHERE id = ?',
                 ('{}', int('train.local' in member), int('train.cluster' in member), user_id))


def set_user_permissions(conn: sqlite3.Connection, user_id: int, overrides: dict):
    conn.execute('UPDATE users SET permissions = ? WHERE id = ?',
                 (json.dumps(overrides, sort_keys=True), user_id))


def set_user_train_local(conn: sqlite3.Connection, user_id: int, allowed: bool):
    conn.execute('UPDATE users SET train_local = ? WHERE id = ?', (int(allowed), user_id))


def set_user_train_cluster(conn: sqlite3.Connection, user_id: int, allowed: bool):
    conn.execute('UPDATE users SET train_cluster = ? WHERE id = ?', (int(allowed), user_id))


def set_user_slurm_account(conn: sqlite3.Connection, user_id: int, account: str):
    conn.execute('UPDATE users SET slurm_account = ? WHERE id = ?', (account, user_id))


def set_user_active(conn: sqlite3.Connection, user_id: int, active: bool):
    conn.execute('UPDATE users SET active = ? WHERE id = ?', (int(active), user_id))
    if not active:  # revoke any live sessions and tokens immediately
        conn.execute('DELETE FROM sessions WHERE user_id = ?', (user_id,))
        conn.execute('DELETE FROM api_tokens WHERE user_id = ?', (user_id,))


def create_api_token(conn: sqlite3.Connection, user_id: int, name: str, token_hash: str,
                     prefix: str, readonly: bool, expires_at: str | None):
    cur = conn.execute(
        'INSERT INTO api_tokens (user_id, name, token_hash, prefix, readonly, expires_at) '
        'VALUES (?, ?, ?, ?, ?, ?)',
        (user_id, name, token_hash, prefix, int(readonly), expires_at))
    conn.commit()
    return conn.execute('SELECT * FROM api_tokens WHERE id = ?', (cur.lastrowid,)).fetchone()


def get_user_by_api_token(conn: sqlite3.Connection, token_hash: str | None):
    """Active user behind a live token, plus the token row, or None. Mirrors
    get_user_by_session: a deactivated account authenticates by no means at all."""
    if not token_hash:
        return None
    row = conn.execute(
        'SELECT u.*, t.id token_id, t.readonly FROM api_tokens t JOIN users u ON u.id = t.user_id '
        "WHERE t.token_hash = ? AND u.active = 1 "
        "AND (t.expires_at IS NULL OR t.expires_at > datetime('now'))",
        (token_hash,)).fetchone()
    return row


def touch_api_token(conn: sqlite3.Connection, token_id: int):
    """Every proxied request validates, so the write is skipped unless the stamp is
    actually stale - a scripted batch must not cost one commit per call."""
    conn.execute("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ? "
                 "AND (last_used_at IS NULL OR last_used_at < datetime('now', '-60 seconds'))",
                 (token_id,))
    conn.commit()


def list_api_tokens(conn: sqlite3.Connection, user_id: int | None = None):
    """Every token, or one user's. The hash never leaves the database."""
    where = 'WHERE t.user_id = ?' if user_id is not None else ''
    args = (user_id,) if user_id is not None else ()
    return conn.execute(
        'SELECT t.id, t.user_id, t.name, t.prefix, t.readonly, t.created_at, t.last_used_at, '
        "t.expires_at, t.expires_at <= datetime('now') AS expired, u.username, u.subject "
        'FROM api_tokens t JOIN users u ON u.id = t.user_id '
        f'{where} ORDER BY t.created_at DESC', args).fetchall()


def delete_api_token(conn: sqlite3.Connection, token_id: int, user_id: int | None = None) -> bool:
    """user_id scopes the delete to its owner; None revokes as an admin."""
    where = 'WHERE id = ?' + (' AND user_id = ?' if user_id is not None else '')
    args = (token_id, user_id) if user_id is not None else (token_id,)
    deleted = conn.execute(f'DELETE FROM api_tokens {where}', args).rowcount
    conn.commit()
    return bool(deleted)
