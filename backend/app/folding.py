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
# folds the case of the rest.
#
# Each pass over double spaces halves a run of them, so six take a run of up to 64 down to one.
_SPACES = [('\t', ' '), ('\r', ' '), ('\n', ' '), *(('  ', ' '),) * 6]
# A person's correction is stored decomposed, an accent as a code point of its own, which plain
# SQL cannot compose as the query's fold does: a letter and an accent that make one composed
# letter are put together before the umlauts are written out (#169).
_ACCENTS = '\u0300\u0301\u0302\u0303\u0304\u0306\u0307\u0308\u030a\u030b\u030c\u0323\u0326\u0327\u0328'
_COMPOSED = [(letter + accent, unicodedata.normalize('NFC', letter + accent))
             for letter in 'abcdefghijklmnopqrstuvwxyz' for accent in _ACCENTS
             if len(unicodedata.normalize('NFC', letter + accent)) == 1]
_SQL_REPLACEMENTS = [*_SPACES, *_COMPOSED,
                     *((q, "'") for q in QUOTES), *((q, '"') for q in DOUBLE_QUOTES), *((d, '-') for d in DASHES),
                     *UMLAUT.items(), ('Ä', 'ae'), ('Ö', 'oe'), ('Ü', 'ue'), ('ẞ', 'ss')]


def sql_search_form(expression: str) -> str:
    folded = f'lower({expression})'
    for old, new in _SQL_REPLACEMENTS:
        folded = f"replace({folded}, '{old}', '{new.replace(chr(39), chr(39) * 2)}')"
    return f'trim({folded})'
