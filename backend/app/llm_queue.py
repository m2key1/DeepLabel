"""The queue a language-model reading waits in, and the worker that drains it.

Two kinds of reading share this. One reads a page for its lines and is keyed by the scan,
so the same scan in another dataset is never paid for twice. The other reads a page
against the corpus cut onto it and is keyed by the page, because the reference text it
carries belongs to a dataset rather than to an image. They differ in what they are keyed
by, what their prompt says and what becomes of the answer, and in nothing else - so the
slots, the watchdog and the per-model ceiling live here once instead of twice.

The ceiling is counted across both queues. Kept per table it would let one model be given
its whole allowance twice over, which is a bill rather than a race.
"""
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

from app import config, llm_client, store

POLL_SECONDS = 1.0
# How long past the client's own timeout a reading may stay silent before the worker gives
# up on it. The call has a timeout of its own; this is the backstop for a thread that
# returns from neither - which once left four paid-for answers unrecorded, because the
# batch was written only after its slowest member.
WATCHDOG_GRACE = 30.0


@dataclass(frozen=True)
class Queue:
    """One kind of reading: where its rows live, and what to do at each step.

    `prepare` gathers everything a call needs off the worker's thread, `finish` writes an
    answer down, and `resume` finishes a row that already had its text when the process
    died - so an answer is never paid for twice.
    """
    table: str
    prepare: Callable
    finish: Callable
    resume: Callable

    def __post_init__(self):
        if not self.table.isidentifier():
            raise ValueError(f'not a table name: {self.table}')


def _busy(tables: list[str]) -> str:
    return ' UNION ALL '.join(
        f"SELECT llm_model_id FROM {table} WHERE status = 'running'" for table in tables)


def claimable(conn, queue: Queue, tables: list[str], free: int) -> list:
    """The readings that may start now, oldest first. A model already holding as many as it
    allows is passed over rather than queued behind - what it is holding is what the rows
    say, so this needs no memory of its own and survives a restart."""
    if free <= 0:
        return []
    return conn.execute(
        'SELECT r.* FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY llm_model_id ORDER BY id) '
        f"AS seq FROM {queue.table} WHERE status = 'pending') r "
        'LEFT JOIN llm_models m ON m.id = r.llm_model_id '
        f'LEFT JOIN (SELECT llm_model_id, COUNT(*) AS busy FROM ({_busy(tables)}) '
        'GROUP BY llm_model_id) b ON b.llm_model_id = r.llm_model_id '
        'WHERE r.seq + COALESCE(b.busy, 0) <= COALESCE(m.max_concurrency, ?) '
        'ORDER BY r.id LIMIT ?',
        (config.LLM_MAX_CONCURRENCY, free)).fetchall()


def fetch(prepared: dict) -> dict:
    """The network call, and nothing else - it runs off the worker's thread, where a
    database handle has no business being."""
    if 'error' in prepared:
        return prepared
    try:
        answer = llm_client.transcribe(prepared['base_url'], prepared['key'], prepared['model'],
                                       prepared['prompt'], prepared['image'],
                                       prepared['temperature'], prepared['max_tokens'],
                                       prepared['extra'], prepared['references'])
    except llm_client.LlmError as exc:
        return {'error': str(exc)}
    return {**answer, 'prompt_hash': prepared['prompt_hash']}


class _Slots:
    """The readings that are out, and the threads carrying them.

    A reading that never comes back costs itself and nothing else: it is given up on at its
    deadline and written down as a failure, and because the thread carrying it cannot be
    killed, the pool it is stuck in is put down and a fresh one takes over. Keeping that
    pool would leave the worker one slot poorer for every hung call it ever made."""

    def __init__(self) -> None:
        self.pool = ThreadPoolExecutor(max_workers=config.LLM_MAX_CONCURRENCY)
        self.out: dict = {}

    def free(self) -> int:
        return config.LLM_MAX_CONCURRENCY - len(self.out)

    def start(self, conn, queue: Queue, read) -> None:
        try:
            prepared = queue.prepare(conn, read)
        except Exception as exc:  # one row that cannot be gathered fails alone
            conn.rollback()
            prepared = {'error': f'{type(exc).__name__}: {exc}'}
        self.out[self.pool.submit(fetch, prepared)] = (queue, read, time.monotonic())

    def landed(self, conn) -> int:
        """Bank every answer that has arrived, and give up on anything past its deadline."""
        banked = 0
        for future in [f for f in self.out if f.done()]:
            queue, read, began = self.out.pop(future)
            record(conn, queue, read, future, began)
            banked += 1
        deadline = config.LLM_TIMEOUT + WATCHDOG_GRACE
        overdue = [f for f, (_q, _r, began) in self.out.items()
                   if time.monotonic() - began > deadline]
        for future in overdue:
            queue, read, began = self.out.pop(future)
            record(conn, queue, read, None, began)
            banked += 1
        if overdue:
            self.pool.shutdown(wait=False, cancel_futures=True)
            self.pool = ThreadPoolExecutor(max_workers=config.LLM_MAX_CONCURRENCY)
        return banked


def record(conn, queue: Queue, read, future, started: float) -> None:
    """One reading written down, said out loud. Silence here is what made a stuck worker
    indistinguishable from a slow provider."""
    elapsed = time.monotonic() - started
    if future is None:
        result = {'error': f'no answer and no failure within '
                           f'{config.LLM_TIMEOUT + WATCHDOG_GRACE:.0f}s'}
    else:
        try:
            result = future.result()
        except Exception as exc:  # a reading must not take its batch down with it
            result = {'error': f'{type(exc).__name__}: {exc}'}
    print(f"{queue.table} {read['id']} ({read['label']}): "
          f"{result.get('error') or 'answered'} after {elapsed:.1f}s", flush=True)
    try:
        queue.finish(conn, read, result)
    except Exception as exc:  # escaping, it would strand every other reading still out
        conn.rollback()
        print(f"{queue.table} {read['id']}: not written down: {exc}", flush=True)
        _fail(conn, queue, read, f'{type(exc).__name__}: {exc}')


def _fail(conn, queue: Queue, read, error: str) -> None:
    """A reading that could not be written down is an error on its own row. Whatever text
    the row already holds stays; a row cleared for its call gets back what it replaced."""
    conn.execute(f"UPDATE {queue.table} SET status = 'error', error = ?, "
                 "raw_text = COALESCE(raw_text, previous_text), finished_at = datetime('now') "
                 'WHERE id = ?', (error, read['id']))
    conn.commit()


def drain_once(conn, queues: list[Queue]) -> int:
    """Readings started and seen through, never leaving a slot idle while anything waits.
    Returns how many were written down, so the loop knows whether to wait.

    Each answer is recorded on its own, as it lands. Waiting for a whole batch cost four
    paid-for answers on 2026-09-10 - they were fetched, billed, and never written, because
    one of the four returned from neither the call nor its timeout. Waiting for the batch
    also left the other slots idle for as long as its slowest reading, which at a ten
    minute ceiling is most of an hour of a four-slot worker doing nothing."""
    slots = _Slots()
    tables = [queue.table for queue in queues]
    banked = 0
    while True:
        for queue in queues:
            for read in claimable(conn, queue, tables, slots.free()):
                # A re-read still holds the answer it is replacing. Cleared here, text on a
                # running row is always the new answer, which is what `recover` relies on;
                # the old one is kept in previous_text, for a failure, a restart or a
                # withdrawal to put back.
                conn.execute(f"UPDATE {queue.table} SET status = 'running', "
                             'previous_text = raw_text, raw_text = NULL WHERE id = ?',
                             (read['id'],))
                conn.commit()
                slots.start(conn, queue, read)
        if not slots.out:
            return banked
        landed = slots.landed(conn)
        banked += landed
        # Something is still out. Wait a beat unless an answer just came in, which is
        # exactly when there is a free slot worth filling straight away.
        if not landed:
            time.sleep(POLL_SECONDS)


def recover(conn, queues: list[Queue]) -> None:
    """After a restart: a reading with no answer was never answered, so it goes back in the
    queue holding whatever answer it was meant to replace; one that has its text was
    interrupted on the way to the pages, and is finished from what it already holds rather
    than fetched again. One that cannot be finished is an error on its own row, as it would
    have been had the process lived."""
    for queue in queues:
        interrupted = conn.execute(
            f"SELECT * FROM {queue.table} WHERE status = 'running' "
            'AND raw_text IS NOT NULL').fetchall()
        conn.execute(f"UPDATE {queue.table} SET status = 'pending', raw_text = previous_text "
                     "WHERE status = 'running' AND raw_text IS NULL")
        conn.commit()
        for read in interrupted:
            try:
                queue.resume(conn, read)
            except Exception as exc:  # escaping, it would stop the worker before it began
                conn.rollback()
                _fail(conn, queue, read, f'{type(exc).__name__}: {exc}')
                continue
            conn.execute(f"UPDATE {queue.table} SET status = 'done', "
                         "finished_at = datetime('now') WHERE id = ?", (read['id'],))
            conn.commit()


def _loop(queues: list[Queue]) -> None:
    conn = store.connect(config.DB_PATH)
    recover(conn, queues)
    while True:
        try:
            if not drain_once(conn, queues):
                time.sleep(POLL_SECONDS)
        except Exception as exc:  # a bad row must not take the worker down with it
            print(f'llm worker: {type(exc).__name__}: {exc}', flush=True)
            time.sleep(POLL_SECONDS)


def start_worker(queues: list[Queue]) -> None:
    threading.Thread(target=_loop, args=(queues,), daemon=True, name='llm-reads').start()
