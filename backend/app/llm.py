"""LLM pre-annotation: the OpenAI-compatible endpoints people register, the models each
one offers, and the credential handling that keeps their keys out of every payload.

A connection is private to whoever created it; an admin can publish one so a keyless
in-house endpoint is usable by everyone, exactly as a default augmentation pipeline is.
Keys are encrypted with LLM_SECRET_KEY and are never returned by the API - a payload
carries only whether a key is set and its last characters, enough to tell two apart.
"""
import base64
import hashlib
import json
import re
import threading
from urllib.parse import urlparse

from cryptography.fernet import Fernet, InvalidToken

from app import config

MAX_NAME_LENGTH = 80
MAX_PROMPT_LENGTH = 8000
MIN_IMAGE_EDGE = 256
MAX_IMAGE_EDGE = 6000
KEY_HINT_CHARS = 4

# A diplomatic transcription: the record is what the page prints, down to the broken word
# at a line end and the glyph that has no modern equivalent. Every rule here exists because
# a model breaks it by default - reuniting a hyphenated word, dropping a page number,
# silently modernising a spelling - and each break costs a line its candidate.
DEFAULT_PROMPT = (
    'Transcribe every line of text in this scan, exactly as it is printed. Work line by '
    'line.\n'
    '- One output line per line on the page, in reading order. Never join two printed '
    'lines and never split one.\n'
    '- A word broken at a line end keeps its hyphen and continues on the next line. Do '
    'not reunite it.\n'
    '- On a page in columns, finish one column top to bottom before starting the next.\n'
    '- Keep the original spelling, capitalisation and punctuation, including archaic, '
    'inconsistent and plainly wrong forms. Never modernise and never correct.\n'
    '- A comma, full stop, colon or semicolon is written tight against the word before it '
    'and followed by one space: "test, and", never "test ,and" or "test , and". That is '
    'spacing only - never add, drop or change a mark.\n'
    '- Keep abbreviations exactly as they appear. Never expand them.\n'
    '- Transcribe the characters actually printed - long s, ligatures, macrons, currency '
    'and order symbols - and never substitute an archaic character for a modern one the '
    'page does not show.\n'
    '- Include everything on the page: page numbers, running heads, footnotes and their '
    'markers, catchwords, signature marks, and text struck through.\n'
    '- Emphasis printed letter-spaced is written closed up: S c h e m a becomes Schema.\n'
    '- Where a character is hard to read, give your best reading of what is there. Never '
    'write a placeholder, a description or an ellipsis, and never drop the line.\n'
    '- Never repeat a line. Two lines that happen to read alike are both transcribed.\n'
    '- Do not add commentary, numbering, or markdown. Output the transcription only.'
)

REFERENCE_NOTE = (
    'Before the page you are shown {count} reference image{plural}. The last image is the '
    'page to transcribe; everything before it is reference material and is never '
    'transcribed.'
)

# Reading a page against an existing transcription of it. The published text is an edited
# reading text - abbreviations expanded, spelling and punctuation regularised, deletions
# resolved - so the danger is not that the model reads badly but that it stops reading and
# copies. Two rules carry most of the weight: the sheet decides where the transcription
# starts and stops, because the cut deliberately hands over a span that runs past both
# ends; and what an edition silently resolves is marked rather than lost, so a deletion
# and an insertion survive into the corpus instead of being read as plain text.
DEFAULT_GT_PROMPT = """\
You are a specialist paleographer and archivist creating strict diplomatic ground-truth \
transcriptions for Handwritten Text Recognition (HTR) training.

I will provide:
1. An image scan of a handwritten manuscript page.
2. A "reading-edition draft" (non-diplomatic text) corresponding roughly to this letter.

Your task is to produce a strict line-by-line diplomatic transcription matching ONLY what is \
physically inked on this specific image. Use the reading draft solely as a semantic guide to \
assist in deciphering ambiguous cursive words.

### Strict Formatting Rules:
- **One physical line per output line:** Emit exactly one line of output for every physical \
line of handwriting on the page, strictly in top-to-bottom reading order. Never merge lines \
and never wrap one physical line into two.
- **Physical page boundary:** Transcribe ONLY the text visible on this exact sheet. If the \
reading draft extends past the bottom of the page, stop transcribing. If the page starts \
partway through the reading draft, begin only at the first visible line.
- **Manuscript over draft:** The manuscript is ground truth. The reading draft contains \
editorial normalizations, modernised spellings, and omissions. You must revert all of these \
back to the ink:
  - Keep uncorrected misspellings, archaic orthography, slips of the pen, and idiosyncratic \
capitalization.
  - Retain raw abbreviations (e.g. write "u." if written as such, never expand to "und").
  - Retain exact punctuation marks, hyphens, and dashes as drawn. Do not add missing periods \
or commas found in the reading text.
- **Hyphenation:** If a word breaks across a line end with a hyphen, keep the hyphen at the \
end of that line and continue the rest on the next line. Do not reunite broken words.
- **Marginalia & Stamps:** Include archival references, pencil numbers, stamps, or dates \
written at the top or margins before or after the main letter body in natural reading order.
- **Insertions & Strikethroughs:** Represent crossed-out words as <del>word</del> and \
interlinear/marginal additions as <add>word</add>.
- **Spacing:** Punctuation goes tight against the preceding token followed by a single space.
- **No omissions or placeholders:** Transcribe your best paleographic reading for difficult \
characters. Never use ellipses (...), brackets like [unclear], or explanations.
- **Zero meta-output:** Do not wrap the text in code blocks, do not number lines, and do not \
provide introductory remarks, commentary, or summary. Output raw transcribed lines only.

---
### Reading Draft (to adapt and align):
{{reference}}"""

# What a dataset may put in its wording and have filled in per page. Kept small on purpose:
# every name here is a promise the page has to be able to keep.
PLACEHOLDER = re.compile(r'\{\{\s*(\w+)\s*\}\}')
PAGE_VARIABLES = ('reference',)


def placeholders(prompt: str) -> set[str]:
    """The names a piece of wording asks the page to fill in."""
    return set(PLACEHOLDER.findall(prompt))


def unknown_placeholders(prompt: str) -> list[str]:
    """Names asked for that nothing supplies, so a route can say so before a run is paid
    for rather than after."""
    return sorted(placeholders(prompt) - set(PAGE_VARIABLES))


def render(prompt: str, variables: dict[str, str]) -> str:
    """The wording as this page asks it. A name nothing supplies is left standing rather
    than blanked: wording that happens to contain braces survives untouched, and a
    misspelled placeholder shows up in the answer instead of vanishing silently."""
    return PLACEHOLDER.sub(
        lambda found: variables.get(found.group(1), found.group(0)), prompt)


_lock = threading.Lock()
_fernet: Fernet | None = None


class SecretUnavailable(RuntimeError):
    """A key was handed in or asked for while LLM_SECRET_KEY is unset or wrong, so it
    can be neither stored nor read back."""


def fernet() -> Fernet | None:
    """Fernet built from LLM_SECRET_KEY, or None when the deployment set none. Derived
    by hashing so operators can use any passphrase rather than a generated 32-byte key."""
    global _fernet
    with _lock:
        if _fernet is None and config.LLM_SECRET_KEY:
            digest = hashlib.sha256(config.LLM_SECRET_KEY.encode()).digest()
            _fernet = Fernet(base64.urlsafe_b64encode(digest))
        return _fernet


def encrypt_key(plain: str) -> str:
    box = fernet()
    if box is None:
        raise SecretUnavailable(
            'LLM_SECRET_KEY is not set on the backend, so an API key cannot be stored. '
            'Set it and restart, or use an endpoint that needs no key.')
    return box.encrypt(plain.encode()).decode()


def decrypt_key(token: str) -> str:
    box = fernet()
    if box is None:
        raise SecretUnavailable('LLM_SECRET_KEY is not set on the backend, so the stored '
                                'API key cannot be read.')
    try:
        return box.decrypt(token.encode()).decode()
    except InvalidToken as exc:
        raise SecretUnavailable('the stored API key cannot be decrypted - LLM_SECRET_KEY '
                                'has changed since it was saved. Enter the key again.') from exc


def key_hint(plain: str) -> str:
    return plain[-KEY_HINT_CHARS:] if len(plain) > KEY_HINT_CHARS else ''


def normalize_base_url(url: str) -> str:
    """The endpoint root a client appends /chat/completions to. Trailing slashes are
    dropped so two people writing the same endpoint differently still match."""
    url = url.strip().rstrip('/')
    parsed = urlparse(url)
    if parsed.scheme not in ('http', 'https') or not parsed.netloc:
        raise ValueError('base URL must start with http:// or https://')
    return url


def get_connection(conn, connection_id: int) -> dict | None:
    row = conn.execute('SELECT * FROM llm_connections WHERE id = ?', (connection_id,)).fetchone()
    return dict(row) if row else None


def visible_to(connection: dict, user: dict) -> bool:
    """A person sees their own connections and the published ones; nothing else exists
    for them. Admins get no window into someone else's account - the credential behind a
    private connection is personal."""
    return connection['owner'] == user['username'] or bool(connection['shared'])


def editable_by(connection: dict, user: dict) -> bool:
    return connection['owner'] == user['username']


def get_model(conn, model_id: int) -> dict | None:
    row = conn.execute('SELECT * FROM llm_models WHERE id = ?', (model_id,)).fetchone()
    return dict(row) if row else None


def model_payload(row) -> dict:
    model = dict(row)
    model['enabled'] = bool(model['enabled'])
    return model


def connection_payload(conn, row, user: dict) -> dict:
    """One connection as the API returns it. The encrypted key never appears - only
    whether there is one, and the last characters of it."""
    connection = dict(row)
    connection.pop('api_key', None)
    connection['has_key'] = bool(row['api_key'])
    connection['key_hint'] = row['api_key_hint'] or ''
    connection['shared'] = bool(row['shared'])
    connection['self_hosted'] = bool(row['self_hosted'])
    connection['editable'] = editable_by(dict(row), user)
    models = conn.execute('SELECT * FROM llm_models WHERE connection_id = ? ORDER BY lower(label)',
                          (row['id'],)).fetchall()
    connection['models'] = [model_payload(m) for m in models]
    return connection


def list_connections(conn, user: dict) -> list[dict]:
    rows = conn.execute(
        'SELECT * FROM llm_connections WHERE owner = ? OR shared = 1 '
        'ORDER BY shared DESC, lower(name)', (user['username'],)).fetchall()
    return [connection_payload(conn, row, user) for row in rows]


def usable_models(conn, user: dict) -> list[dict]:
    """Every enabled model the caller may read a page with, connection included. This is
    what a dataset's model picker offers."""
    rows = conn.execute(
        'SELECT m.*, c.name AS connection_name, c.owner AS connection_owner, c.shared AS shared, '
        'c.self_hosted AS self_hosted '
        'FROM llm_models m JOIN llm_connections c ON m.connection_id = c.id '
        'WHERE m.enabled = 1 AND (c.owner = ? OR c.shared = 1) '
        'ORDER BY lower(c.name), lower(m.label)', (user['username'],)).fetchall()
    return [{**model_payload(r), 'shared': bool(r['shared']), 'self_hosted': bool(r['self_hosted'])}
            for r in rows]


def name_taken(conn, owner: str, name: str, except_id: int | None = None) -> bool:
    row = conn.execute(
        'SELECT id FROM llm_connections WHERE owner = ? AND lower(name) = lower(?)',
        (owner, name)).fetchone()
    return row is not None and row['id'] != except_id


def credentials(conn, model_id: int) -> tuple[dict, dict, str | None]:
    """(model, connection, api key) for a read. Raises SecretUnavailable when the stored
    key cannot be decrypted, so a run fails with that message instead of a 401 from the
    provider. A connection with no key is legitimate - self-hosted endpoints need none."""
    model = get_model(conn, model_id)
    if model is None:
        raise LookupError(f'llm model {model_id} no longer exists')
    connection = get_connection(conn, model['connection_id'])
    if connection is None:
        raise LookupError(f'the connection behind llm model {model_id} no longer exists')
    key = decrypt_key(connection['api_key']) if connection['api_key'] else None
    return model, connection, key


def user_prompt(conn, username: str) -> str:
    """This person's own default wording, or '' when they have kept the shipped one."""
    row = conn.execute('SELECT prompt FROM llm_prompts WHERE owner = ?', (username,)).fetchone()
    return row['prompt'] if row else ''


def set_user_prompt(conn, username: str, prompt: str) -> str:
    """Save a personal default. Empty restores the shipped one rather than asking a model
    to transcribe with no instructions at all."""
    prompt = prompt.strip()
    conn.execute(
        'INSERT INTO llm_prompts (owner, prompt, updated_at) VALUES (?,?,datetime(\'now\')) '
        "ON CONFLICT(owner) DO UPDATE SET prompt = excluded.prompt, updated_at = datetime('now')",
        (username, prompt))
    conn.commit()
    return prompt


def effective_prompt(conn, model: dict, username: str, job_prompt: str = '') -> str:
    """What this model is actually asked with, most specific first: the dataset's own
    wording, then the model's, then the running person's default, then the shipped one.

    The dataset replaces rather than extends - material that needs saying in full usually
    needs saying in full - which is why the dialog seeds its box with what is in force
    rather than an empty one.
    """
    return (job_prompt or '').strip() or (model.get('prompt') or '').strip() \
        or user_prompt(conn, username) or DEFAULT_PROMPT


def effective_gt_prompt(job_prompt: str = '') -> str:
    """What a diplomatic reading is asked with: the dataset's own wording or the shipped
    one. Two levels rather than four, because this wording is about a corpus rather than
    about a hand - a model default or a personal default would be answering the wrong
    question, and the reference it must carry is a promise only the dataset can make."""
    return (job_prompt or '').strip() or DEFAULT_GT_PROMPT


def with_references(prompt: str, count: int) -> str:
    """The wording as it is actually sent. A model shown a glyph chart before the page is
    looking at two pictures and, unless the wording says which is which, may transcribe the
    chart. Said here rather than left to each prompt, because it is a fact about the payload
    this code builds rather than something a corpus knows about itself."""
    if not count:
        return prompt
    note = REFERENCE_NOTE.format(count=count, plural='' if count == 1 else 's')
    return f'{prompt}\n\n{note}'


# What a model can be shown before the page, and how much of it. Small because every
# picture is sent with every page: a chart is a chart, not an album.
MAX_REFERENCES = 4
MAX_REFERENCE_BYTES = 4 * 1024 * 1024
REFERENCE_MIMES = ('image/png', 'image/jpeg', 'image/webp', 'image/gif')


def references(conn, username: str, job_id: str | None = None) -> list:
    """The pictures shown before the page, in the order they are sent: the dataset's own
    set where it has one, otherwise this person's default. A dataset replaces rather than
    extends, the way its prompt does - a corpus with its own chart wants only that one."""
    own = _held_references(conn, username, job_id) if job_id else []
    return own or _held_references(conn, username, None)


def _held_references(conn, owner: str, job_id: str | None) -> list:
    """One scope's pictures. A dataset's set belongs to the dataset, whoever added them;
    without a dataset it is the owner's default."""
    if job_id:
        return conn.execute('SELECT * FROM llm_references WHERE job_id = ? '
                            'ORDER BY order_idx, id', (job_id,)).fetchall()
    return conn.execute('SELECT * FROM llm_references WHERE owner = ? AND job_id IS NULL '
                        'ORDER BY order_idx, id', (owner,)).fetchall()


def add_reference(conn, owner: str, job_id: str | None, filename: str, mime: str,
                  data: bytes) -> int:
    """Keep one picture in a scope. The identical picture already there is kept once - a
    chart re-uploaded is the same chart - and its id comes back."""
    if not data:
        raise ValueError('that file is empty')
    if mime not in REFERENCE_MIMES:
        raise ValueError(f'a reference must be an image ({", ".join(REFERENCE_MIMES)})')
    if len(data) > MAX_REFERENCE_BYTES:
        raise ValueError(f'that image is too large - at most {MAX_REFERENCE_BYTES // 1024 // 1024} MB')
    digest = hashlib.sha256(data).hexdigest()
    held = _held_references(conn, owner, job_id)
    for row in held:
        if row['digest'] == digest:
            return row['id']
    if len(held) >= MAX_REFERENCES:
        raise ValueError(f'at most {MAX_REFERENCES} reference images')
    cur = conn.execute(
        'INSERT INTO llm_references (owner, job_id, order_idx, filename, mime, bytes, digest) '
        'VALUES (?,?,?,?,?,?,?)',
        (owner, job_id, len(held), filename.strip() or 'reference', mime, data, digest))
    conn.commit()
    return cur.lastrowid


def delete_reference(conn, reference_id: int) -> bool:
    deleted = conn.execute('DELETE FROM llm_references WHERE id = ?', (reference_id,)).rowcount
    conn.commit()
    return bool(deleted)


def reference_payload(row) -> dict:
    """What a reference looks like over the wire - everything but the bytes, which are
    fetched on their own so a list of charts does not carry megabytes."""
    return {'id': row['id'], 'job_id': row['job_id'], 'filename': row['filename'],
            'mime': row['mime'], 'bytes': len(row['bytes']), 'digest': row['digest'][:16],
            'created_at': row['created_at']}


def ask_digest(prompt: str, reference_rows: list) -> str:
    """What a reading was taken under: the wording and the pictures together, in order. A
    new chart makes the readings taken under the old one stale, exactly as new wording does."""
    parts = [prompt, *(row['digest'] for row in reference_rows)]
    return hashlib.sha256('\n'.join(parts).encode()).hexdigest()[:16]


def prompt_digest(prompt: str) -> str:
    """Short digest recorded against a reading, so a dataset can tell that a page was read
    under wording since changed."""
    return hashlib.sha256(prompt.encode()).hexdigest()[:16]

def extra_body(model: dict) -> dict:
    """A model's own request fields, as an object. A malformed one is treated as absent
    rather than failing the run - the endpoint's own defaults are a working fallback."""
    try:
        parsed = json.loads(model.get('extra_body') or '{}')
    except ValueError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def valid_extra_body(text: str) -> dict:
    """Parse what someone typed, refusing anything that is not a JSON object. Raises
    ValueError with a sentence to show them."""
    text = (text or '').strip()
    if not text:
        return {}
    try:
        parsed = json.loads(text)
    except ValueError as exc:
        raise ValueError(f'the extra request fields must be JSON: {exc}') from exc
    if not isinstance(parsed, dict):
        raise ValueError('the extra request fields must be a JSON object, like '
                         '{"chat_template_kwargs": {"enable_thinking": false}}')
    return parsed
