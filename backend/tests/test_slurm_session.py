import sys

import pytest

from app import slurm_session


@pytest.fixture
def cluster(monkeypatch):
    monkeypatch.setattr('app.config.SLURM_HOST', '10.0.0.1')
    monkeypatch.setattr('app.config.SLURM_USER', 'someone')
    monkeypatch.setattr('app.config.SLURM_SSH_KEY', '/run/secrets/slurm_key')
    monkeypatch.setattr('app.config.SLURM_CONTROL_PATH', '/tmp/test-slurm.sock')


def fake_ssh(monkeypatch, script: str):
    """Stand in for ssh, so the pty relay itself is exercised rather than mocked."""
    monkeypatch.setattr(slurm_session, '_master_cmd', lambda: [sys.executable, '-c', script])


PROMPTS_THEN_ACCEPTS = (
    'import sys\n'
    'sys.stdout.write("(someone@10.0.0.1) Verification code: ")\n'
    'sys.stdout.flush()\n'
    'code = sys.stdin.readline().strip()\n'
    'sys.exit(0 if code == "123456" else 1)\n'
)

# What ssh actually does: a second factor is read from the controlling terminal, not
# from stdin, so a child without one is refused before it can prompt.
PROMPTS_ON_CONTROLLING_TTY = (
    'import sys\n'
    'out = open("/dev/tty", "w")\n'
    'tty_in = open("/dev/tty", "r")\n'
    'out.write("(someone@10.0.0.1) Verification code: ")\n'
    'out.flush()\n'
    'code = tty_in.readline().strip()\n'
    'sys.exit(0 if code == "123456" else 1)\n'
)

REFUSES_IMMEDIATELY = (
    'import sys\n'
    'sys.stderr.write("someone@10.0.0.1: Permission denied (publickey).\\n")\n'
    'sys.stdout.flush()\n'
    'sys.exit(255)\n'
)


def connection(monkeypatch, states):
    """is_connected() answers from `states`, so a test can flip the socket on."""
    monkeypatch.setattr(slurm_session, 'is_connected', lambda: states['up'])


def test_ssh_opts_make_every_call_reuse_the_master(cluster):
    opts = slurm_session.ssh_opts()
    assert 'ControlPath=/tmp/test-slurm.sock' in opts
    # Clients must never become the master themselves, or each call would
    # authenticate on its own and hit the second factor again.
    assert 'ControlMaster=no' in opts
    assert opts[opts.index('-i') + 1] == '/run/secrets/slurm_key'


def test_ssh_opts_without_a_control_path_stay_plain(cluster, monkeypatch):
    monkeypatch.setattr('app.config.SLURM_CONTROL_PATH', '')
    assert not any('ControlPath' in o for o in slurm_session.ssh_opts())


def test_ssh_opts_give_up_on_a_connect_that_hangs(cluster):
    """A host whose port is black-holed answers nothing, and ssh then waits out the
    kernel's SYN retries - two minutes on Linux, which is how long a submit sat queued
    before its probe was declared timed out. Clients give up when the master would."""
    option = f'ConnectTimeout={slurm_session.CONNECT_TIMEOUT}'
    opts = slurm_session.ssh_opts()
    assert opts[opts.index(option) - 1] == '-o'
    assert option in slurm_session._master_cmd()


def test_start_relays_the_prompt_the_cluster_sent(cluster, monkeypatch):
    connection(monkeypatch, {'up': False})
    fake_ssh(monkeypatch, PROMPTS_THEN_ACCEPTS)
    result = slurm_session.start()
    assert result['connected'] is False
    assert result['prompt'] == '(someone@10.0.0.1) Verification code:'
    assert result['session_id']
    slurm_session._discard_pending()


def test_the_right_code_opens_the_session(cluster, monkeypatch):
    states = {'up': False}
    connection(monkeypatch, states)
    fake_ssh(monkeypatch, PROMPTS_THEN_ACCEPTS)
    started = slurm_session.start()
    states['up'] = True  # the master authenticated and the socket appeared
    assert slurm_session.answer(started['session_id'], '123456') == {'connected': True}


def test_a_wrong_code_reports_the_refusal_and_drops_the_attempt(cluster, monkeypatch):
    connection(monkeypatch, {'up': False})
    fake_ssh(monkeypatch, PROMPTS_THEN_ACCEPTS)
    started = slurm_session.start()
    with pytest.raises(slurm_session.SessionError):
        slurm_session.answer(started['session_id'], '000000')
    # The attempt is spent: answering it again must not hang waiting on a dead pty.
    with pytest.raises(slurm_session.SessionError, match='expired'):
        slurm_session.answer(started['session_id'], '123456')


def test_start_reports_a_refused_login_instead_of_prompting(cluster, monkeypatch):
    connection(monkeypatch, {'up': False})
    fake_ssh(monkeypatch, REFUSES_IMMEDIATELY)
    with pytest.raises(slurm_session.SessionError, match='Permission denied'):
        slurm_session.start()


def test_an_already_open_session_needs_no_second_factor(cluster, monkeypatch):
    connection(monkeypatch, {'up': True})
    fake_ssh(monkeypatch, REFUSES_IMMEDIATELY)  # must never be spawned
    assert slurm_session.start() == {'connected': True}


def test_a_cluster_without_a_second_factor_connects_without_a_prompt(cluster, monkeypatch):
    states = {'up': False}
    connection(monkeypatch, states)
    # Authenticates on the key alone: no prompt, exits once backgrounded.
    fake_ssh(monkeypatch, 'import sys; sys.exit(0)')
    monkeypatch.setattr(slurm_session, '_READ_SLICE', 0.05)

    calls = {'n': 0}

    def flips_on(*_args):
        calls['n'] += 1
        states['up'] = calls['n'] > 1
        return states['up']

    monkeypatch.setattr(slurm_session, 'is_connected', flips_on)
    assert slurm_session.start() == {'connected': True}


def test_the_pty_is_the_child_s_controlling_terminal(cluster, monkeypatch):
    """ssh prompts on /dev/tty. Without a controlling terminal it never asks and the
    login is refused as 'keyboard-interactive', which is indistinguishable from a
    wrong code unless this is exercised."""
    states = {'up': False}
    connection(monkeypatch, states)
    fake_ssh(monkeypatch, PROMPTS_ON_CONTROLLING_TTY)
    started = slurm_session.start()
    assert started['prompt'] == '(someone@10.0.0.1) Verification code:'
    states['up'] = True
    assert slurm_session.answer(started['session_id'], '123456') == {'connected': True}


def test_the_prompt_drops_ssh_s_banner_and_carriage_returns(cluster, monkeypatch):
    """Verbatim from the cluster: ssh prefixes its own chatter and writes for a
    terminal, and only the question belongs in the label the user reads."""
    connection(monkeypatch, {'up': False})
    fake_ssh(monkeypatch, (
        'import sys\n'
        'sys.stdout.write("Warning: Permanently added \'10.0.0.1\' (ED25519) to the list of '
        'known hosts.\\r\\r\\n\\r(someone@10.0.0.1) Verification code: ")\n'
        'sys.stdout.flush()\n'
        'sys.stdin.readline()\n'
    ))
    started = slurm_session.start()
    assert started['prompt'] == '(someone@10.0.0.1) Verification code:'
    slurm_session._discard_pending()


def test_status_is_disabled_without_a_cluster(monkeypatch):
    monkeypatch.setattr('app.config.SLURM_HOST', '')
    assert slurm_session.status() == {'enabled': False, 'connected': False}
