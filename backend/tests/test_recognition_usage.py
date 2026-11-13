"""What the recognition API counts per account, and the monthly cap on lines read."""
import io
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import recognize, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member', 'X-Auth-Caps': 'recognize'}
ZERO = {'requests': 0, 'pages': 0, 'lines': 0, 'seconds': 0.0}


def _month(offset: int = 0) -> str:
    now = datetime.now(timezone.utc)
    year, month = divmod(now.year * 12 + now.month - 1 + offset, 12)
    return f'{year:04d}-{month + 1:02d}'


@pytest.fixture
def conn(tmp_path):
    connection = store.connect(tmp_path / 'app.db')
    yield connection
    connection.close()


@pytest.fixture
def client(conn, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.MODEL_BACKENDS', {})
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_a_fresh_database_has_the_usage_tables(conn):
    assert {r[1] for r in conn.execute('PRAGMA table_info(recognition_usage)')} == \
        {'account', 'day', 'requests', 'pages', 'lines', 'seconds'}
    assert {r[1] for r in conn.execute('PRAGMA table_info(recognition_caps)')} == {'account', 'monthly_lines'}


def test_an_answered_request_adds_to_its_accounts_day(conn):
    recognize.record_usage(conn, 'alice', pages=2, lines=12, seconds=1.5, day='2026-11-13')
    recognize.record_usage(conn, 'alice', pages=0, lines=3, seconds=0.5, day='2026-11-13')
    recognize.record_usage(conn, 'alice', pages=1, lines=6, seconds=1.0, day='2026-10-31')

    assert recognize.month_usage(conn, 'alice', '2026-11') == {'requests': 2, 'pages': 2, 'lines': 15, 'seconds': 2.0}
    assert recognize.month_usage(conn, 'alice', '2026-10') == {'requests': 1, 'pages': 1, 'lines': 6, 'seconds': 1.0}
    assert recognize.month_usage(conn, 'bob', '2026-11') == ZERO


AT = datetime(2026, 11, 13, 10, 0, tzinfo=timezone.utc)


def test_an_account_at_its_cap_is_refused_until_the_first_of_next_month(conn):
    recognize.set_cap(conn, 'alice', 15)
    recognize.record_usage(conn, 'alice', pages=2, lines=15, seconds=1.0, day='2026-11-02')

    with pytest.raises(recognize.Refused) as refused:
        recognize.check_cap(conn, 'alice', now=AT)
    assert refused.value.status == 429
    assert refused.value.message == 'this account has read its 15 lines for this month; it can read again from 2026-12-01'
    assert refused.value.retry_after == int((datetime(2026, 12, 1, tzinfo=timezone.utc) - AT).total_seconds())


def test_below_its_cap_or_without_one_an_account_reads(conn):
    recognize.record_usage(conn, 'alice', pages=2, lines=15, seconds=1.0, day='2026-11-02')
    recognize.check_cap(conn, 'alice', now=AT)
    recognize.set_cap(conn, 'alice', 16)
    recognize.check_cap(conn, 'alice', now=AT)
    # Last month's reading does not count against this one.
    recognize.set_cap(conn, 'alice', 15)
    recognize.check_cap(conn, 'alice', now=datetime(2026, 12, 1, 0, 0, tzinfo=timezone.utc))


def test_a_cap_in_december_resets_on_the_first_of_january(conn):
    recognize.set_cap(conn, 'alice', 1)
    recognize.record_usage(conn, 'alice', pages=0, lines=1, seconds=0.1, day='2026-12-31')
    with pytest.raises(recognize.Refused) as refused:
        recognize.check_cap(conn, 'alice', now=datetime(2026, 12, 31, 23, 0, tzinfo=timezone.utc))
    assert refused.value.message.endswith('it can read again from 2027-01-01')
    assert refused.value.retry_after == 3600


def test_admins_read_every_accounts_usage_this_month_and_last(client, conn):
    recognize.record_usage(conn, 'alice', pages=2, lines=12, seconds=1.5, day=f'{_month()}-01')
    recognize.record_usage(conn, 'alice', pages=1, lines=6, seconds=1.0, day=f'{_month(-1)}-15')
    recognize.record_usage(conn, 'bob', pages=0, lines=3, seconds=0.25, day=f'{_month(-1)}-02')
    recognize.record_usage(conn, 'carol', pages=1, lines=1, seconds=0.1, day=f'{_month(-2)}-02')
    recognize.set_cap(conn, 'bob', 500)
    # A cap set before an account's first request shows, so it can be seen and lifted.
    recognize.set_cap(conn, 'dave', 10)

    answer = client.get('/api/recognition-usage', headers=ADMIN)

    assert answer.status_code == 200
    assert answer.json() == {'month': _month(), 'last_month': _month(-1), 'accounts': [
        {'account': 'alice', 'cap': None, 'this_month': {'requests': 1, 'pages': 2, 'lines': 12, 'seconds': 1.5},
         'last_month': {'requests': 1, 'pages': 1, 'lines': 6, 'seconds': 1.0}},
        {'account': 'bob', 'cap': 500, 'this_month': ZERO,
         'last_month': {'requests': 1, 'pages': 0, 'lines': 3, 'seconds': 0.25}},
        {'account': 'dave', 'cap': 10, 'this_month': ZERO, 'last_month': ZERO},
    ]}


def test_an_admin_sets_and_lifts_a_cap(client, conn):
    assert client.put('/api/recognition-caps', headers=ADMIN, json={'account': 'alice', 'monthly_lines': 500}).status_code == 200
    assert recognize.cap_of(conn, 'alice') == 500
    assert client.put('/api/recognition-caps', headers=ADMIN, json={'account': 'alice', 'monthly_lines': None}).status_code == 200
    assert recognize.cap_of(conn, 'alice') is None
    refused = client.put('/api/recognition-caps', headers=ADMIN, json={'account': 'alice', 'monthly_lines': -1})
    assert refused.status_code == 400
    assert refused.json()['detail'] == 'a cap is a number of lines, 0 or more'


def test_only_admins_read_usage_or_set_caps_and_never_with_a_recognition_only_token(client):
    assert client.get('/api/recognition-usage', headers=ALICE).status_code == 403
    assert client.put('/api/recognition-caps', headers=ALICE, json={'account': 'alice', 'monthly_lines': None}).status_code == 403
    scoped = {**ADMIN, 'X-Auth-Scope': 'recognize'}
    for response in (client.get('/api/recognition-usage', headers=scoped),
                     client.put('/api/recognition-caps', headers=scoped, json={'account': 'x', 'monthly_lines': None})):
        assert response.status_code == 403
        assert response.json()['detail'] == 'recognition-only API token'


def test_an_account_sees_its_own_month_in_what_is_offered(client, conn):
    recognize.record_usage(conn, 'alice', pages=1, lines=9, seconds=1.0, day=f'{_month()}-01')
    recognize.record_usage(conn, 'root', pages=1, lines=40, seconds=1.0, day=f'{_month()}-01')
    recognize.set_cap(conn, 'alice', 100)

    assert client.get('/api/recognize', headers=ALICE).json()['usage'] == {'month': _month(), 'lines': 9, 'cap': 100}


def test_a_request_at_the_cap_is_refused_with_the_reset_date_before_anything_is_read(client, conn):
    recognize.set_cap(conn, 'alice', 9)
    recognize.record_usage(conn, 'alice', pages=1, lines=9, seconds=1.0)
    png = io.BytesIO()
    Image.new('RGB', (40, 10), 'white').save(png, format='PNG')

    refused = client.post('/api/recognize/lines', headers=ALICE, files=[('files', ('l.png', png.getvalue(), 'image/png'))])

    assert refused.status_code == 429
    assert refused.json()['detail'].startswith('this account has read its 9 lines for this month; it can read again from ')
    assert int(refused.headers['retry-after']) > 0
