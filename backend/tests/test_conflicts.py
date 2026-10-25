"""Two people can open the same page. Every editable row carries the id of its newest
revision; an edit that hands it back is refused once someone else has saved a newer one,
and a page can stream the revisions that touch it so the other person's edit shows up
without a reload.
"""
import asyncio
import json
import threading
import time

import pytest
from fastapi.testclient import TestClient

from app import store
from app.deps import get_db
from app.main import app
from app.routes.pages import page_change_events

SECRET = 'test-secret'
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}
BOB = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member'}
MALLORY = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'mallory', 'X-Auth-Role': 'member'}


@pytest.fixture
def stack(tmp_path, monkeypatch):
    """Alice's dataset, shared with Bob: one page, one element with two lines, one
    region. Nothing has been edited yet, so every revision token starts at 0."""
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    # The event stream opens its own connections (it outlives the request), so it must
    # find the same database the overridden dependency hands out.
    monkeypatch.setattr('app.config.DB_PATH', tmp_path / 'app.db')
    conn = store.connect(tmp_path / 'app.db')
    conn.execute("INSERT INTO jobs (id, name, owner, status) VALUES ('j', 'Shared', 'alice', 'done')")
    conn.execute("INSERT INTO job_assignees (job_id, username) VALUES ('j', 'bob')")
    conn.execute("INSERT INTO pages (id, job_id, idx, filename, source_file, status) "
                 "VALUES (1, 'j', 0, 'p1.png', '/nonexistent.png', 'done')")
    conn.execute("INSERT INTO pages (id, job_id, idx, filename, source_file, status) "
                 "VALUES (2, 'j', 1, 'p2.png', '/nonexistent.png', 'done')")
    conn.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) "
                 "VALUES (1, 1, 0, 'Paragraph', '[0,0,1,1]', 'content')")
    conn.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) "
                 "VALUES (2, 2, 0, 'Paragraph', '[0,0,1,1]', 'content')")
    conn.executemany("INSERT INTO lines (id, element_id, order_idx, polygon, text) VALUES (?, ?, ?, ?, ?)", [
        (1, 1, 0, '[[0,0],[1,0],[1,1],[0,1]]', 'first'),
        (2, 1, 1, '[[0,0],[1,0],[1,1],[0,1]]', 'second'),
        (3, 2, 0, '[[0,0],[1,0],[1,1],[0,1]]', 'other page'),
    ])
    store.seed_job_classes(conn, 'j', [{'id': 1, 'name': 'water', 'color': [0, 0, 255], 'priority': 0}])
    conn.execute("INSERT INTO regions (id, page_id, order_idx, class_id, points, holes, kind) "
                 "VALUES (1, 1, 0, 1, '[[0.1,0.1],[0.2,0.1],[0.2,0.2]]', '[]', 'polygon')")
    conn.commit()
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app), conn
    app.dependency_overrides.clear()
    conn.close()


def patch_line(client, line_id, headers, **body):
    return client.patch(f'/api/lines/{line_id}', json=body, headers=headers)


class TestRevisionTokens:
    def test_a_page_carries_a_token_per_row_and_one_for_the_dataset(self, stack):
        client, _ = stack
        page = client.get('/api/jobs/j/pages/1', headers=ALICE).json()
        assert page['job_revision'] == 0
        assert page['elements'][0]['revision'] == 0
        assert [line['revision'] for line in page['elements'][0]['lines']] == [0, 0]
        assert page['regions'][0]['revision'] == 0

    def test_an_edit_advances_the_token_of_that_row_only(self, stack):
        client, _ = stack
        saved = patch_line(client, 1, ALICE, corrected_text='First').json()
        # The row's starting point is logged first, so the edit itself is the second entry.
        assert saved['revision'] == 2
        page = client.get('/api/jobs/j/pages/1', headers=ALICE).json()
        assert [line['revision'] for line in page['elements'][0]['lines']] == [2, 0]
        assert page['elements'][0]['revision'] == 0
        assert page['job_revision'] == 2


class TestConflicts:
    def test_saving_over_someone_elses_edit_is_refused_with_both_versions(self, stack):
        client, _ = stack
        page = client.get('/api/jobs/j/pages/1', headers=ALICE).json()
        line = page['elements'][0]['lines'][0]
        theirs = patch_line(client, 1, BOB, corrected_text='Bobs reading').json()

        refused = patch_line(client, 1, ALICE, corrected_text='Alices reading', revision=line['revision'])
        assert refused.status_code == 409
        detail = refused.json()['detail']
        assert detail['code'] == 'conflict'
        assert detail['author'] == 'bob'
        assert detail['revision'] == theirs['revision']
        assert detail['current']['corrected_text'] == 'Bobs reading'
        assert detail['message'] == 'changed by bob since you loaded it'
        assert client.get('/api/jobs/j/pages/1', headers=ALICE).json()['elements'][0]['lines'][0]['corrected_text'] == 'Bobs reading'

    def test_a_save_with_the_current_token_goes_through(self, stack):
        client, _ = stack
        theirs = patch_line(client, 1, BOB, corrected_text='Bobs reading').json()
        accepted = patch_line(client, 1, ALICE, corrected_text='Alices reading', revision=theirs['revision'])
        assert accepted.status_code == 200
        assert accepted.json()['corrected_text'] == 'Alices reading'
        assert accepted.json()['revision'] == theirs['revision'] + 1

    def test_no_token_keeps_last_write_wins_for_scripts(self, stack):
        client, _ = stack
        patch_line(client, 1, BOB, corrected_text='Bobs reading')
        accepted = patch_line(client, 1, ALICE, corrected_text='Alices reading')
        assert accepted.status_code == 200

    def test_your_own_earlier_save_counts_as_a_change_too(self, stack):
        client, _ = stack
        first = patch_line(client, 1, ALICE, corrected_text='one', revision=0)
        assert first.status_code == 200
        stale = patch_line(client, 1, ALICE, corrected_text='two', revision=0)
        assert stale.status_code == 409
        assert stale.json()['detail']['author'] == 'alice'

    def test_elements_and_regions_are_guarded_the_same_way(self, stack):
        client, _ = stack
        client.patch('/api/elements/1', json={'checked': True}, headers=BOB)
        refused = client.patch('/api/elements/1', json={'class_name': 'Heading', 'revision': 0}, headers=ALICE)
        assert refused.status_code == 409
        assert refused.json()['detail']['current']['checked'] is True

        client.patch('/api/regions/1', json={'checked': True}, headers=BOB)
        refused = client.patch('/api/regions/1', json={'class_id': 1, 'revision': 0}, headers=ALICE)
        assert refused.status_code == 409
        assert refused.json()['detail']['current']['checked'] is True

    def test_a_refused_edit_changes_nothing(self, stack):
        client, conn = stack
        patch_line(client, 1, BOB, corrected_text='Bobs reading', checked=True)
        patch_line(client, 1, ALICE, corrected_text='Alices reading', checked=False, revision=0)
        row = conn.execute('SELECT corrected_text, checked FROM lines WHERE id = 1').fetchone()
        assert (row['corrected_text'], row['checked']) == ('Bobs reading', 1)
        # Bob's edit and the origin it logged first; Alice's refused one left nothing.
        assert conn.execute("SELECT COUNT(*) c FROM revisions WHERE target_id = 1").fetchone()['c'] == 2

    @pytest.mark.parametrize('kind, method, url, body', [
        ('line', 'PATCH', '/api/lines/1', {'corrected_text': 'mine', 'revision': 0}),
        ('line', 'DELETE', '/api/lines/1?revision=0', None),
        ('element', 'PATCH', '/api/elements/1', {'checked': True, 'revision': 0}),
        ('region', 'PATCH', '/api/regions/1', {'checked': True, 'revision': 0}),
    ])
    def test_two_saves_from_the_same_token_at_once_let_only_one_through(self, stack, tmp_path, monkeypatch,
                                                                        kind, method, url, body):
        """Each request gets its own connection, as in production, and the first write
        is held back long enough for the other request to run its check meanwhile."""
        client, conn = stack

        def own_connection():
            request_conn = store.connect(tmp_path / 'app.db')
            try:
                yield request_conn
            finally:
                request_conn.close()

        app.dependency_overrides[get_db] = own_connection
        real_ensure_origin = store.ensure_origin

        def slow_ensure_origin(*args):
            time.sleep(0.5)
            real_ensure_origin(*args)

        monkeypatch.setattr(store, 'ensure_origin', slow_ensure_origin)
        statuses = []

        def save(headers):
            statuses.append(client.request(method, url, json=body, headers=headers).status_code)

        racers = [threading.Thread(target=save, args=(headers,)) for headers in (ALICE, BOB)]
        for racer in racers:
            racer.start()
        for racer in racers:
            racer.join()

        assert sorted(statuses) == [200, 409]
        edits = conn.execute(
            "SELECT COUNT(*) c FROM revisions WHERE target_type = ? AND target_id = 1 AND action != 'origin'",
            (kind,)).fetchone()['c']
        assert edits == 1


class TestPageChanges:
    def test_reports_only_revisions_that_touch_the_page(self, stack):
        client, conn = stack
        patch_line(client, 1, BOB, corrected_text='a', checked=True)
        patch_line(client, 3, BOB, corrected_text='other page', checked=True)
        client.patch('/api/elements/1', json={'checked': True}, headers=BOB)
        client.patch('/api/regions/1', json={'checked': True}, headers=BOB)
        client.patch('/api/pages/1', json={'layout_checked': True}, headers=BOB)

        newest, changes = store.page_changes_since(conn, 1, 'j', 0)
        # Every first edit logs the row's origin ahead of itself; origins are not changes.
        # Checking the element checks line 2 with it, which is a change of that line.
        assert newest == 11
        assert [(c['kind'], c['id'], c['author']) for c in changes] == [
            ('line', 1, 'bob'), ('line', 2, 'bob'), ('element', 1, 'bob'), ('region', 1, 'bob'), ('page', 1, 'bob')]
        assert [c['revision'] for c in changes] == [2, 7, 8, 10, 11]

    def test_the_cursor_advances_past_changes_on_other_pages(self, stack):
        client, conn = stack
        patch_line(client, 3, BOB, corrected_text='other page')
        newest, changes = store.page_changes_since(conn, 1, 'j', 0)
        assert (newest, changes) == (2, [])
        assert store.page_changes_since(conn, 1, 'j', 2) == (2, [])

    def test_each_change_names_the_tab_that_sent_it(self, stack):
        """A tab skips its own echo by this id rather than by author, so the same person's
        other tab still hears it - and a write that sent none, a script's, is nobody's echo."""
        client, conn = stack
        patch_line(client, 1, {**BOB, 'X-Client-Id': 'tab-one'}, corrected_text='from tab one', checked=True)
        client.patch('/api/elements/1', json={'checked': True}, headers={**BOB, 'X-Client-Id': 'tab-two'})
        patch_line(client, 1, BOB, corrected_text='from a script')

        _, changes = store.page_changes_since(conn, 1, 'j', 0)
        assert [(c['kind'], c['id'], c['client']) for c in changes] == [
            ('line', 1, 'tab-one'), ('line', 2, 'tab-two'), ('element', 1, 'tab-two'), ('line', 1, None)]

    def test_a_client_id_that_is_not_one_is_not_recorded(self, stack):
        client, conn = stack
        patch_line(client, 1, {**BOB, 'X-Client-Id': 'x' * 65}, corrected_text='too long')
        patch_line(client, 2, {**BOB, 'X-Client-Id': 'tab one'}, corrected_text='has a space')

        _, changes = store.page_changes_since(conn, 1, 'j', 0)
        assert [(c['id'], c['client']) for c in changes] == [(1, None), (2, None)]

    # The stream never ends on its own, which the test client cannot cope with, so the
    # generator behind it is driven directly: one event, then closed like a browser would.
    def test_the_stream_delivers_a_change_with_its_revision_as_event_id(self, stack):
        client, _ = stack
        patch_line(client, 2, BOB, corrected_text='Bobs reading')
        first = asyncio.run(_first_event(page_change_events(1, 'j', 0, _Connected())))
        head, data, *rest = first.split('\n')
        assert head == 'id: 2'
        assert rest == ['', ''], 'an event ends with a blank line'
        event = json.loads(data.removeprefix('data: '))
        assert event['revision'] == 2
        assert [(c['kind'], c['id'], c['author']) for c in event['changes']] == [('line', 2, 'bob')]

    def test_the_stream_ends_once_the_browser_is_gone(self, stack):
        client, _ = stack
        patch_line(client, 2, BOB, corrected_text='Bobs reading')
        events = page_change_events(1, 'j', 0, _Gone())
        assert asyncio.run(_collect(events)) == []

    def test_the_stream_respects_dataset_access(self, stack):
        client, _ = stack
        assert client.get('/api/pages/1/events', headers=MALLORY).status_code == 404


class _Connected:
    async def is_disconnected(self) -> bool:
        return False


class _Gone:
    async def is_disconnected(self) -> bool:
        return True


async def _first_event(events) -> str:
    try:
        return await anext(events)
    finally:
        await events.aclose()


async def _collect(events) -> list[str]:
    return [event async for event in events]
