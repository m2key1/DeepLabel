import re
import unicodedata

UMLAUT = {'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss'}
QUOTES = '‘’‚'
DOUBLE_QUOTES = '“”„'
DASHES = '‐‑‒–—−'
QUOTE = re.compile(f'[{QUOTES}]')
DOUBLE_QUOTE = re.compile(f'[{DOUBLE_QUOTES}]')
DASH = re.compile(f'[{DASHES}]')
SPACE = re.compile(r'\s+')


def fold(text: str) -> str:
    text = unicodedata.normalize('NFC', text)
    text = DASH.sub('-', DOUBLE_QUOTE.sub('"', QUOTE.sub("'", text)))
    return SPACE.sub(' ', text).strip()


def search_form(text: str) -> str:
    """Folded, lowercased, and with the German umlauts written out: a volume spells the same
    name Müller on one page and Mueller on the next, and somebody searching for either
    means both."""
    return re.sub('[äöüß]', lambda m: UMLAUT[m.group()], fold(text).lower())


# search_form in plain SQL, for the search index's triggers: written with an application
# function instead, a line could no longer be changed from the sqlite3 shell. lower() folds
# ASCII alone, so the capital umlauts are written out here and the index's trigram tokenizer
# folds the case of the rest; stored text is already composed.
_SQL_REPLACEMENTS = [('\t', ' '), ('\n', ' '), ('  ', ' '), ('  ', ' '),
                     *((q, "'") for q in QUOTES), *((q, '"') for q in DOUBLE_QUOTES), *((d, '-') for d in DASHES),
                     *UMLAUT.items(), ('Ä', 'ae'), ('Ö', 'oe'), ('Ü', 'ue'), ('ẞ', 'ss')]


def sql_search_form(expression: str) -> str:
    folded = f'lower({expression})'
    for old, new in _SQL_REPLACEMENTS:
        folded = f"replace({folded}, '{old}', '{new.replace(chr(39), chr(39) * 2)}')"
    return f'trim({folded})'
