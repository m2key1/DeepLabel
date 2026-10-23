import time
from dataclasses import dataclass
from threading import Lock

# Who has which page open right now. Each browser tab sends a heartbeat while it is
# visible; an entry that stops being refreshed drops out after TTL_SECONDS, so a closed
# laptop never shows up as "editing page 12" for the rest of the afternoon. Purely in
# memory: the API runs as one process, and presence has no value across a restart.

TTL_SECONDS = 60


@dataclass(frozen=True)
class Location:
    job_id: str | None = None
    page_id: int | None = None
    target_kind: str | None = None
    target_id: int | None = None
    editing: bool = False


@dataclass
class Presence:
    username: str
    tab: str
    location: Location
    seen_at: float


class PresenceRegistry:
    def __init__(self, ttl_seconds: float = TTL_SECONDS, clock=time.monotonic):
        self._ttl = ttl_seconds
        self._clock = clock
        self._entries: dict[tuple[str, str], Presence] = {}
        self._lock = Lock()

    def beat(self, username: str, tab: str, location: Location) -> None:
        with self._lock:
            self._entries[(username, tab)] = Presence(username, tab, location, self._clock())

    def leave(self, username: str, tab: str) -> None:
        with self._lock:
            self._entries.pop((username, tab), None)

    def online(self) -> list[Presence]:
        """Every live tab, oldest heartbeat first; stale ones are dropped on the way."""
        now = self._clock()
        with self._lock:
            stale = [key for key, entry in self._entries.items() if now - entry.seen_at > self._ttl]
            for key in stale:
                del self._entries[key]
            return sorted(self._entries.values(), key=lambda entry: entry.seen_at)

    def seconds_since(self, entry: Presence) -> int:
        return max(0, int(self._clock() - entry.seen_at))


registry = PresenceRegistry()
