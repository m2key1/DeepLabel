"""Presence tells annotators who else has a page open. The registry forgets a tab that
stops sending heartbeats, and the routes apply the same access rules as everything
else: you cannot announce yourself inside a dataset you cannot open, and you never
learn where someone is inside one.
"""
import pytest
from fastapi.testclient import TestClient

from app import store
from app.deps import get_db
from app.main import app
from app.presence import Location, PresenceRegistry
from app.routes.presence import _registry

SECRET = 'test-secret'


def headers(username: str, role: str = 'member') -> dict:
    return {'X-Frontend-Secret': SECRET, 'X-Auth-User': username, 'X-Auth-Role': role}


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class TestRegistry:
    def test_a_heartbeat_makes_a_tab_visible_until_it_goes_stale(self):
        clock = FakeClock()
        registry = PresenceRegistry(ttl_seconds=60, clock=clock)
        registry.beat('alice', 'tab-1', Location(job_id='j1'))
        assert [e.tab for e in registry.online()] == ['tab-1']
        clock.now += 59
        assert len(registry.online()) == 1
        clock.now += 2
        assert registry.online() == []

    def test_a_fresh_heartbeat_resets_the_clock_and_moves_the_tab(self):
        clock = FakeClock()
        registry = PresenceRegistry(ttl_seconds=60, clock=clock)
        registry.beat('alice', 'tab-1', Location(job_id='j1', page_id=1))
        clock.now += 50
        registry.beat('alice', 'tab-1', Location(job_id='j1', page_id=2))
        clock.now += 50
        [entry] = registry.online()
        assert entry.location.page_id == 2
        assert registry.seconds_since(entry) == 50

    def test_tabs_are_tracked_separately_per_person(self):
        registry = PresenceRegistry(clock=FakeClock())
        registry.beat('alice', 'tab-1', Location(job_id='j1'))
        registry.beat('alice', 'tab-2', Location(job_id='j2'))
        registry.beat('bob', 'tab-1', Location())
        assert {(e.username, e.tab) for e in registry.online()} == {('alice', 'tab-1'), ('alice', 'tab-2'), ('bob', 'tab-1')}
        registry.leave('alice', 'tab-1')
        assert {(e.username, e.tab) for e in registry.online()} == {('alice', 'tab-2'), ('bob', 'tab-1')}

    def test_leaving_an_unknown_tab_is_harmless(self):
        registry = PresenceRegistry(clock=FakeClock())
        registry.leave('nobody', 'tab-x')
        assert registry.online() == []


@pytest.fixture
def stack(tmp_path, monkeypatch):
    """Alice owns a two-page dataset shared with Bob. Mallory owns her own and has no
    business in Alice's. Each test gets its own registry."""
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    conn = store.connect(tmp_path / 'app.db')
    conn.execute("INSERT INTO jobs (id, name, owner, status) VALUES ('alice-job', 'Schematismus', 'alice', 'done')")
    conn.execute("INSERT INTO jobs (id, name, owner, status) VALUES ('mallory-job', 'Secret', 'mallory', 'done')")
    conn.execute("INSERT INTO job_assignees (job_id, username) VALUES ('alice-job', 'bob')")
    conn.executemany('INSERT INTO pages (id, job_id, idx, filename, source_file) VALUES (?, ?, ?, ?, ?)', [
        (1, 'alice-job', 0, 'a1.png', '/x/a1.png'),
        (2, 'alice-job', 1, 'a2.png', '/x/a2.png'),
        (3, 'mallory-job', 0, 'm1.png', '/x/m1.png'),
    ])
    conn.commit()
    registry = PresenceRegistry(clock=FakeClock())
    app.dependency_overrides[get_db] = lambda: conn
    app.dependency_overrides[_registry] = lambda: registry
    yield TestClient(app), registry
    app.dependency_overrides.clear()
    conn.close()


def beat(client, username, **body):
    return client.post('/api/presence', json={'tab': 't1', **body}, headers=headers(username))


def online(client, username, role='member'):
    return client.get('/api/presence', headers=headers(username, role)).json()['users']


class TestHeartbeat:
    def test_announces_a_page_in_a_shared_dataset(self, stack):
        client, registry = stack
        response = beat(client, 'bob', job_id='alice-job', page_id=2, target={'kind': 'line', 'id': 7}, editing=True)
        assert response.status_code == 200
        [entry] = registry.online()
        assert entry.location == Location(job_id='alice-job', page_id=2, target_kind='line', target_id=7, editing=True)

    def test_refuses_a_dataset_the_caller_cannot_open(self, stack):
        client, registry = stack
        assert beat(client, 'mallory', job_id='alice-job').status_code == 404
        assert registry.online() == []

    def test_a_page_must_belong_to_the_dataset_named(self, stack):
        client, _ = stack
        assert beat(client, 'alice', job_id='alice-job', page_id=3).status_code == 400
        assert beat(client, 'alice', page_id=1).status_code == 400

    def test_refuses_a_dataset_that_does_not_exist_even_for_an_admin(self, stack):
        client, registry = stack
        response = client.post('/api/presence', json={'tab': 't1', 'job_id': 'gone'},
                               headers=headers('root', 'admin'))
        assert response.status_code == 404
        assert registry.online() == []

    def test_rejects_nonsense(self, stack):
        client, _ = stack
        assert beat(client, 'alice', job_id='alice-job', target={'kind': 'cursor', 'id': 1}).status_code == 400
        assert client.post('/api/presence', json={'tab': ' '}, headers=headers('alice')).status_code == 400

    def test_viewers_cannot_announce_themselves(self, stack):
        client, _ = stack
        response = client.post('/api/presence', json={'tab': 't1'}, headers=headers('eve', 'viewer'))
        assert response.status_code == 403


class TestOnline:
    def test_shows_where_people_are_inside_datasets_you_can_open(self, stack):
        client, _ = stack
        beat(client, 'bob', job_id='alice-job', page_id=2, target={'kind': 'line', 'id': 7}, editing=True)
        [entry] = online(client, 'alice')
        assert entry == {
            'username': 'bob', 'tab': 't1', 'seen_seconds_ago': 0,
            'job_id': 'alice-job', 'job_name': 'Schematismus', 'job_task': 'text', 'page_id': 2, 'page_idx': 1,
            'target': {'kind': 'line', 'id': 7}, 'editing': True, 'accessible': True,
        }

    def test_hides_the_place_but_not_the_person_elsewhere(self, stack):
        client, _ = stack
        beat(client, 'mallory', job_id='mallory-job', page_id=3, editing=True)
        [entry] = online(client, 'alice')
        assert entry['username'] == 'mallory'
        assert entry['accessible'] is False
        withheld = (entry['job_id'], entry['job_name'], entry['job_task'], entry['page_id'], entry['page_idx'], entry['target'])
        assert withheld == (None,) * 6
        assert entry['editing'] is False

    def test_admins_see_every_place(self, stack):
        client, _ = stack
        beat(client, 'mallory', job_id='mallory-job', page_id=3)
        [entry] = online(client, 'root', 'admin')
        assert (entry['job_name'], entry['page_idx'], entry['accessible']) == ('Secret', 0, True)

    @pytest.mark.parametrize('role', ['admin', 'member'])
    def test_a_dataset_deleted_under_someone_leaves_them_simply_online(self, stack, role):
        client, _ = stack
        beat(client, 'bob', job_id='alice-job', page_id=2, editing=True)
        conn = app.dependency_overrides[get_db]()
        conn.execute("DELETE FROM jobs WHERE id = 'alice-job'")
        conn.commit()
        [entry] = online(client, 'alice', role)
        assert entry == {
            'username': 'bob', 'tab': 't1', 'seen_seconds_ago': 0,
            'job_id': None, 'job_name': None, 'job_task': None, 'page_id': None, 'page_idx': None,
            'target': None, 'editing': False, 'accessible': True,
        }

    def test_someone_on_no_dataset_is_simply_online(self, stack):
        client, _ = stack
        beat(client, 'bob')
        [entry] = online(client, 'alice')
        assert (entry['job_id'], entry['accessible']) == (None, True)

    def test_leaving_removes_the_tab_at_once(self, stack):
        client, _ = stack
        beat(client, 'bob', job_id='alice-job')
        assert len(online(client, 'alice')) == 1
        assert client.post('/api/presence/leave', json={'tab': 't1'}, headers=headers('bob')).status_code == 200
        assert online(client, 'alice') == []

    def test_your_own_tabs_are_listed_too(self, stack):
        client, _ = stack
        beat(client, 'alice', job_id='alice-job')
        assert [e['username'] for e in online(client, 'alice')] == ['alice']
