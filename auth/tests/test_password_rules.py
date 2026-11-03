"""The password policy, applied the way Authentik applies it. Authentik's own test endpoint
fails for any caller but a superuser, so DeepLabel reads the policy and checks it itself."""
import pytest

from app import password_rules

DEFAULT = {'length_min': 8, 'amount_digits': 0, 'amount_uppercase': 0, 'amount_lowercase': 0, 'amount_symbols': 0,
           'symbol_charset': '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~ ', 'check_static_rules': True,
           'error_message': 'Password needs to be 8 characters or longer.', 'check_have_i_been_pwned': False,
           'check_zxcvbn': True, 'zxcvbn_score_threshold': 2}


def test_a_short_password_gets_the_policy_s_own_message():
    assert password_rules.problems(DEFAULT, 'Xq7#', []) == ['Password needs to be 8 characters or longer.']


@pytest.mark.parametrize('rule, weak, strong', [
    ('amount_digits', 'no digits here at all', 'one digit 7 here at all'),
    ('amount_uppercase', 'no capitals here at all', 'one Capital here at all'),
    # Authentik's default symbols include the space, so these have none.
    ('amount_symbols', 'nosymbolshereatall', 'onesymbol!hereatall'),
])
def test_each_count_rule_is_held(rule, weak, strong):
    policy = {**DEFAULT, rule: 1, 'check_zxcvbn': False}
    assert password_rules.problems(policy, weak, []) == ['Password needs to be 8 characters or longer.']
    assert password_rules.problems(policy, strong, []) == []


def test_a_guessable_password_gets_one_plain_sentence_not_zxcvbn_s_advice():
    assert password_rules.problems(DEFAULT, 'password1', []) == [password_rules.TOO_EASY]
    assert password_rules.TOO_EASY == 'Too easy to guess - add another word.'


def test_the_person_s_own_name_does_not_make_a_strong_password():
    strong_alone = 'annaexample2026'
    assert password_rules.problems(DEFAULT, strong_alone, []) == []
    assert password_rules.problems(DEFAULT, strong_alone, ['anna@example.org', 'Anna Example', 'annaexample']) \
        == [password_rules.TOO_EASY]


def test_a_good_password_passes_everything():
    assert password_rules.problems(DEFAULT, 'violet hinge saddle parade', []) == []


def test_nothing_typed_is_not_a_password():
    assert password_rules.problems(DEFAULT, '', []) == ['Password not set.']
