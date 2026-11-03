import re
from hashlib import sha1

import httpx
from zxcvbn import zxcvbn

# What a password too easy to guess is told, in place of zxcvbn's advice, which changes
# with every password and never says what to type. The page's strength meter says the same.
TOO_EASY = 'Too easy to guess - add another word.'

RE_LOWER = re.compile('[a-z]')
RE_UPPER = re.compile('[A-Z]')
RE_DIGITS = re.compile('[0-9]')


def problems(policy: dict, password: str, user_inputs: list[str]) -> list[str]:
    """What is wrong with a password by an Authentik password policy, checked the way
    Authentik checks it (authentik/policies/password/models.py), in its words except for a
    guessable one. Done here because the policy-test API fails for any caller but a
    superuser."""
    if not password:
        return ['Password not set.']
    if policy.get('check_static_rules') and not _passes_static(policy, password):
        return [policy.get('error_message') or 'Invalid password.']
    if policy.get('check_have_i_been_pwned'):
        seen = _times_pwned(password)
        if seen > policy.get('hibp_allowed_count', 0):
            return [f'Password exists on {seen} online lists.']
    if policy.get('check_zxcvbn'):
        # Only the first 72 characters, as Authentik does: past that zxcvbn is slow and
        # any password passes anyway.
        result = zxcvbn(password[:72], [i for i in user_inputs if i])
        if result['score'] <= policy.get('zxcvbn_score_threshold', 2):
            return [TOO_EASY]
    return []


def _passes_static(policy: dict, password: str) -> bool:
    symbols = sum(password.count(symbol) for symbol in policy.get('symbol_charset', ''))
    return (len(password) >= policy.get('length_min', 0)
            and len(RE_DIGITS.findall(password)) >= policy.get('amount_digits', 0)
            and len(RE_LOWER.findall(password)) >= policy.get('amount_lowercase', 0)
            and len(RE_UPPER.findall(password)) >= policy.get('amount_uppercase', 0)
            and symbols >= policy.get('amount_symbols', 0))


def _times_pwned(password: str) -> int:
    digest = sha1(password.encode()).hexdigest()  # noqa: S324 - the API is keyed by SHA-1
    listed = httpx.get(f'https://api.pwnedpasswords.com/range/{digest[:5]}', timeout=10).text
    for line in listed.splitlines():
        suffix, _, count = line.partition(':')
        if suffix.lower() == digest[5:]:
            return int(count)
    return 0
