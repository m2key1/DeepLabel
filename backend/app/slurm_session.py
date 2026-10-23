"""One human-answered login to a cluster that demands a second factor.

A training runs for hours and is polled the whole time (squeue, progress file, log
tail, artifacts), so a code cannot be asked for per command. Instead the answered
login opens a multiplexed ssh master and every later ssh/rsync rides that socket.
The code is relayed, never stored.
"""

import os
import pty
import secrets
import select
import subprocess
import threading
import time

from app import config

PROMPT_TIMEOUT = 20
ANSWER_TIMEOUT = 30
_READ_SLICE = 0.25

_lock = threading.Lock()
_pending: dict[str, dict] = {}


class SessionError(RuntimeError):
    pass


def ssh_target() -> str:
    return f'{config.SLURM_USER}@{config.SLURM_HOST}' if config.SLURM_USER else config.SLURM_HOST


# How long a connect may go unanswered. A black-holed port otherwise holds a call for the
# kernel's full SYN retry, two minutes on Linux, and a submit sat queued for all of it.
CONNECT_TIMEOUT = 15


def ssh_opts() -> list[str]:
    """Options every non-interactive call shares. ControlMaster=no keeps them clients:
    they reuse the master when it exists and connect on their own when it does not, so
    a cluster without a second factor needs no session at all."""
    opts = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
            '-o', f'ConnectTimeout={CONNECT_TIMEOUT}']
    if config.SLURM_CONTROL_PATH:
        opts += ['-o', f'ControlPath={config.SLURM_CONTROL_PATH}', '-o', 'ControlMaster=no']
    if config.SLURM_SSH_KEY:
        opts += ['-i', config.SLURM_SSH_KEY]
    return opts


def _master_cmd() -> list[str]:
    """A throwaway remote command, not -N -f: -f implies -n, which redirects stdin from
    /dev/null, and the second factor would have nowhere to be typed. ControlPersist
    detaches the master itself once this first client is done, so it outlives the
    request without ever holding our pty."""
    cmd = ['ssh', '-M',
           '-o', f'ControlPath={config.SLURM_CONTROL_PATH}',
           '-o', 'ControlPersist=yes',
           '-o', 'StrictHostKeyChecking=accept-new',
           '-o', 'NumberOfPasswordPrompts=1',
           '-o', f'ConnectTimeout={CONNECT_TIMEOUT}']
    if config.SLURM_SSH_KEY:
        cmd += ['-i', config.SLURM_SSH_KEY]
    return cmd + [ssh_target(), 'true']


def enabled() -> bool:
    return bool(config.SLURM_HOST and config.SLURM_CONTROL_PATH)


def is_connected() -> bool:
    if not enabled():
        return False
    try:
        proc = subprocess.run(
            ['ssh', '-O', 'check', '-o', f'ControlPath={config.SLURM_CONTROL_PATH}', ssh_target()],
            capture_output=True, text=True, timeout=10)
    except subprocess.SubprocessError:
        return False
    return proc.returncode == 0


def status() -> dict:
    return {'enabled': enabled(), 'connected': is_connected()}


def _last_line(text: str) -> str:
    """The question alone. ssh writes over a terminal, so what arrives is carriage
    returns plus any banner it felt like printing ("Permanently added ... to the list
    of known hosts"), none of which belongs in the prompt the user is shown."""
    lines = [l.strip() for l in text.replace('\r', '\n').splitlines() if l.strip()]
    return lines[-1] if lines else ''


def _close(fd: int) -> None:
    try:
        os.close(fd)
    except OSError:
        pass


def _discard_pending() -> None:
    with _lock:
        stale = list(_pending.values())
        _pending.clear()
    for entry in stale:
        entry['proc'].kill()
        _close(entry['fd'])


def _wait(fd: int, proc: subprocess.Popen, timeout: float, want_prompt: bool) -> str | None:
    """Pump the pty until the master is up (returns None), the cluster prompts
    (returns the prompt) or the attempt fails."""
    buf = ''
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        readable, _, _ = select.select([fd], [], [], _READ_SLICE)
        if readable:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                chunk = b''
            if chunk:
                buf += chunk.decode('utf-8', 'replace')
                if want_prompt and buf.rstrip().endswith(':'):
                    return _last_line(buf)
                continue
        if proc.poll() is not None:
            # -f means a successful login exits this child; only a missing socket
            # makes that a failure.
            if is_connected():
                return None
            raise SessionError(_last_line(buf) or 'the cluster refused the connection')
        if is_connected():
            return None
    raise SessionError('timed out waiting for the cluster')


def start() -> dict:
    """Open the master connection. Returns the prompt to relay, or reports the session
    as connected when the key alone was enough."""
    if not enabled():
        raise SessionError('no cluster configured')
    if is_connected():
        return {'connected': True}
    _discard_pending()
    fd, slave = pty.openpty()
    # login_tty makes the pty the child's controlling terminal. ssh reads a second
    # factor from /dev/tty rather than stdin, so a session without one is refused
    # before it ever prompts. It calls setsid itself, hence no start_new_session.
    proc = subprocess.Popen(_master_cmd(), stdin=slave, stdout=slave, stderr=slave,
                            close_fds=True, preexec_fn=lambda: os.login_tty(0))
    os.close(slave)
    try:
        prompt = _wait(fd, proc, PROMPT_TIMEOUT, want_prompt=True)
    except SessionError:
        proc.kill()
        _close(fd)
        raise
    if prompt is None:
        _close(fd)
        return {'connected': True}
    session_id = secrets.token_urlsafe(9)
    with _lock:
        _pending[session_id] = {'fd': fd, 'proc': proc}
    return {'connected': False, 'session_id': session_id, 'prompt': prompt}


def answer(session_id: str, code: str) -> dict:
    """Relay the code the user typed. Never logged, never written to disk."""
    with _lock:
        entry = _pending.pop(session_id, None)
    if entry is None:
        raise SessionError('that unlock expired, start it again')
    fd, proc = entry['fd'], entry['proc']
    try:
        os.write(fd, code.strip().encode() + b'\n')
        _wait(fd, proc, ANSWER_TIMEOUT, want_prompt=False)
        return {'connected': True}
    except (SessionError, OSError) as e:
        proc.kill()
        raise SessionError(str(e)) from e
    finally:
        _close(fd)


def disconnect() -> bool:
    _discard_pending()
    if not enabled():
        return False
    proc = subprocess.run(
        ['ssh', '-O', 'exit', '-o', f'ControlPath={config.SLURM_CONTROL_PATH}', ssh_target()],
        capture_output=True, text=True, timeout=10)
    return proc.returncode == 0
