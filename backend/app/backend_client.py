import hashlib
import io
import json
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass

from PIL import Image

from app import config, weights

CONNECT_TIMEOUT = 10
LOAD_POLL_SECONDS = 2.0
SECRET_HEADER = 'X-Model-Backend-Secret'


class BackendError(Exception):
    """A model backend refused or failed a call, in the contract's own terms (3.7)."""

    def __init__(self, code: str, message: str, retryable: bool = False, status: int | None = None):
        super().__init__(f'{code}: {message}')
        self.code = code
        self.message = message
        self.retryable = retryable
        self.status = status


@dataclass(frozen=True)
class Encoded:
    """An image already in a format the contract takes, sent as it is (4.2): a JPEG scan
    passes through rather than being decoded and written again as a far larger PNG."""
    data: bytes
    mime: str


@dataclass(frozen=True)
class Item:
    id: str
    image: Image.Image | Encoded
    context: dict | None = None


def _encode(image: Image.Image | Encoded) -> Encoded:
    if isinstance(image, Encoded):
        return image
    out = io.BytesIO()
    image.save(out, format='PNG')
    return Encoded(out.getvalue(), 'image/png')


def _multipart(request: dict, images: dict[str, Encoded]) -> tuple[bytes, str]:
    boundary = uuid.uuid4().hex
    parts = [(f'--{boundary}\r\nContent-Disposition: form-data; name="request"; filename="request.json"\r\n'
              'Content-Type: application/json\r\n\r\n').encode() + json.dumps(request).encode() + b'\r\n']
    for name, image in images.items():
        suffix = 'jpg' if image.mime == 'image/jpeg' else 'png'
        parts.append((f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{name}.{suffix}"\r\n'
                      f'Content-Type: {image.mime}\r\n\r\n').encode() + image.data + b'\r\n')
    parts.append(f'--{boundary}--\r\n'.encode())
    return b''.join(parts), f'multipart/form-data; boundary={boundary}'


class BackendClient:
    """One configured model backend, spoken to over the contract in docs/MODEL-BACKENDS.md.

    Standard library only, so it loads in the app's interpreter and in any model venv alike."""

    def __init__(self, backend: config.ModelBackend):
        self.backend = backend
        self._info: dict | None = None

    def _call(self, method: str, path: str, body: bytes | None = None, content_type: str | None = None,
              timeout: float = CONNECT_TIMEOUT) -> dict:
        headers = {SECRET_HEADER: self.backend.secret, 'Accept': 'application/json'}
        if content_type:
            headers['Content-Type'] = content_type
        request = urllib.request.Request(f'{self.backend.url}{path}', data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read() or b'{}')
        except urllib.error.HTTPError as error:
            try:
                detail = json.loads(error.read()).get('error') or {}
            except ValueError:
                detail = {}
            raise BackendError(detail.get('code', 'internal'), detail.get('message', str(error)),
                               bool(detail.get('retryable', error.code == 503)), error.code) from None
        except (urllib.error.URLError, OSError) as error:
            reason = getattr(error, 'reason', error)
            raise BackendError('unreachable', f'model backend "{self.backend.name}" at {self.backend.url}: {reason}',
                               retryable=True) from None

    def info(self) -> dict:
        if self._info is None:
            self._info = self._call('GET', '/v1/info')
        return self._info

    def max_items(self, task: str) -> int:
        return int(self.info().get('tasks_detail', {}).get(task, {}).get('batch', {}).get('max_items') or 64)

    def max_request_bytes(self) -> int:
        # Headroom under the backend's ceiling for the request part and the multipart framing.
        return int((self.info().get('max_request_mb') or 64) * (1 << 20) * 0.9)

    def free_card(self) -> None:
        """Unload whatever the other backends on this one's GPU group hold, so the card is
        this backend's alone (3.9). A neighbour that does not answer holds nothing to free;
        one at this backend's own address is this server, which manages its own memory."""
        for neighbour in config.MODEL_BACKENDS.values():
            if neighbour.url and neighbour.url != self.backend.url and neighbour.gpu_group == self.backend.gpu_group:
                try:
                    BackendClient(neighbour)._call('POST', '/v1/weights/unload', b'{}', 'application/json')
                except BackendError:
                    pass

    def load(self, conn, model_id: int) -> tuple[dict | None, dict]:
        """Make a model's weights ready on the backend. Returns the weights block predict
        requests carry (None for a backend with builtin weights and no files stored) and the
        facts the backend reports about them."""
        self.free_card()
        files = weights.model_files(conn, model_id)
        weights_file = next((f for f in files if f['role'] == 'weights'), None)
        if weights_file is None:
            if self.info().get('weights', {}).get('builtin'):
                return None, self._call('GET', '/v1/weights/builtin').get('facts') or {}
            raise BackendError('weights_unavailable',
                               f'model {model_id} has no files in the weight store - run python -m app.weights '
                               'import-existing')
        sha = weights_file['sha256']
        row = conn.execute('SELECT model_type FROM models WHERE id = ?', (model_id,)).fetchone()
        request = {'sha256': sha, 'model_type': (row['model_type'] if row else None) or self.info().get('model_type'),
                   'files': {f['role']: {'sha256': f['sha256'], 'size': f['size'], 'url': weights.file_url(f['sha256'])}
                             for f in files}}
        state = self._call('POST', '/v1/weights/load', json.dumps(request).encode(), 'application/json', timeout=30)
        deadline = time.monotonic() + config.MODEL_BACKEND_LOAD_TIMEOUT
        while state.get('state') != 'loaded':
            if state.get('state') == 'error':
                error = state.get('error') or {}
                raise BackendError(error.get('code', 'weights_unavailable'), error.get('message', 'loading failed'))
            if time.monotonic() > deadline:
                raise BackendError('timeout', f'weights {sha[:12]} not loaded after '
                                              f'{config.MODEL_BACKEND_LOAD_TIMEOUT:.0f} s')
            time.sleep(LOAD_POLL_SECONDS)
            state = self._call('GET', f'/v1/weights/{sha}')
        return {'sha256': sha, 'files': {f['role']: f['sha256'] for f in files if f['role'] != 'weights'}}, \
            state.get('facts') or {}

    def predict(self, task: str, weights_block: dict | None, params: dict, items: list[Item]) -> dict:
        """One batch. Retried once on a connection error or a transient refusal, since a
        predict changes nothing on the backend (3.6)."""
        encoded: dict[int, Encoded] = {}
        for item in items:
            if id(item.image) not in encoded:
                encoded[id(item.image)] = _encode(item.image)
        return self._predict(task, weights_block, params, items, encoded)

    def predict_all(self, task: str, weights_block: dict | None, params: dict, items: list[Item]) -> dict:
        """Any number of items, split into requests by the backend's item and byte limits.
        The results come back as one list in the items' order; the other fields of the
        response are the last request's."""
        encoded = {id(item.image): _encode(item.image) for item in items}
        limit, budget = self.max_items(task), self.max_request_bytes()
        response: dict = {'results': []}
        batch: list[Item] = []
        size = 0

        def send():
            nonlocal response
            answer = self._predict(task, weights_block, params, batch, encoded)
            response = {**answer, 'results': response['results'] + answer['results']}

        for item in items:
            cost = len(encoded[id(item.image)].data)
            if batch and (len(batch) >= limit or size + cost > budget):
                send()
                batch, size = [], 0
            batch.append(item)
            size += cost
        if batch:
            send()
        return response

    def _predict(self, task: str, weights_block: dict | None, params: dict, items: list[Item],
                 encoded: dict[int, Encoded]) -> dict:
        images, names = {}, {}
        for item in items:
            key = id(item.image)
            if key not in names:
                names[key] = f'img{len(names)}'
                images[names[key]] = encoded[key]
        request = {'weights': weights_block, 'params': params,
                   'items': [{'id': item.id, 'image': names[id(item.image)],
                              **({'context': item.context} if item.context else {})} for item in items]}
        body, content_type = _multipart(request, images)
        for attempt in (1, 2):
            try:
                return self._call('POST', f'/v1/predict/{task}', body, content_type,
                                  timeout=config.MODEL_BACKEND_PREDICT_TIMEOUT)
            except BackendError as error:
                if error.status == 429 and attempt == 1:
                    time.sleep(LOAD_POLL_SECONDS)
                    continue
                if not error.retryable or attempt == 2:
                    raise
        raise AssertionError('unreachable')


class Training:
    """One training run on a backend (6.5), spoken to by its id there."""

    def __init__(self, client: BackendClient, train_id: str):
        self.client = client
        self.id = train_id

    def state(self) -> dict:
        return self.client._call('GET', f'/v1/train/{self.id}')

    def progress(self, start: int) -> list[dict]:
        request = urllib.request.Request(f'{self.client.backend.url}/v1/train/{self.id}/progress?from={start}',
                                         headers={SECRET_HEADER: self.client.backend.secret})
        try:
            with urllib.request.urlopen(request, timeout=CONNECT_TIMEOUT) as response:
                lines = response.read().decode('utf-8', errors='replace').splitlines()
        except (urllib.error.URLError, OSError) as error:
            raise BackendError('unreachable', f'model backend "{self.client.backend.name}": {error}',
                               retryable=True) from None
        return [line for line in lines if line.strip()]

    def cancel(self) -> None:
        self.client._call('POST', f'/v1/train/{self.id}/cancel', b'{}', 'application/json')

    def artifacts(self) -> dict:
        return self.client._call('GET', f'/v1/train/{self.id}/artifacts')

    def read(self, name: str) -> bytes:
        """A small artifact, whole: the metrics the run ended on."""
        request = urllib.request.Request(f'{self.client.backend.url}/v1/train/{self.id}/artifacts/{name}',
                                         headers={SECRET_HEADER: self.client.backend.secret})
        try:
            with urllib.request.urlopen(request, timeout=CONNECT_TIMEOUT) as response:
                return response.read()
        except (urllib.error.URLError, OSError) as error:
            raise BackendError('not_found', f'artifact {name}: {error}') from None

    def download(self, name: str, target, sha256: str) -> None:
        """One artifact, written beside its target and moved into place once its hash
        is the one the backend listed."""
        request = urllib.request.Request(f'{self.client.backend.url}/v1/train/{self.id}/artifacts/{name}',
                                         headers={SECRET_HEADER: self.client.backend.secret})
        partial = target.with_name(target.name + '.part')
        digest = hashlib.sha256()
        target.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(request, timeout=config.MODEL_BACKEND_PREDICT_TIMEOUT) as response, \
                open(partial, 'wb') as out:
            for block in iter(lambda: response.read(1 << 20), b''):
                digest.update(block)
                out.write(block)
        if digest.hexdigest() != sha256:
            partial.unlink(missing_ok=True)
            raise BackendError('checksum_mismatch', f'artifact {name} does not hash to what the backend listed')
        partial.replace(target)

    def delete(self) -> None:
        self.client._call('DELETE', f'/v1/train/{self.id}')


def start_training(client: BackendClient, request: dict) -> Training:
    client.free_card()
    answer = client._call('POST', '/v1/train', json.dumps(request).encode(), 'application/json', timeout=30)
    return Training(client, answer['train_id'])


def preview_augmentations(client: BackendClient, spec: dict, images: list[Image.Image], seed: int,
                          draws: int = 1) -> list[str]:
    """A stack applied to the images by the backend's own trainer (6.2), one augmented
    image per input as a data URL - over several draws, the one that strayed furthest."""
    encoded = {f'img{i}': _encode(image) for i, image in enumerate(images)}
    body, content_type = _multipart({'spec': spec, 'seed': seed, 'draws': draws}, encoded)
    return client._call('POST', '/v1/train/augmentations/preview', body, content_type,
                        timeout=config.MODEL_BACKEND_PREDICT_TIMEOUT)['images']


def client_for(conn, model_id: int | None) -> BackendClient | None:
    """A client for the backend a model is predicted on, or None while it runs in-process."""
    if model_id is None:
        return None
    row = conn.execute('SELECT task, backend FROM models WHERE id = ?', (model_id,)).fetchone()
    name = weights.serving_backend(row) if row else None
    return BackendClient(config.MODEL_BACKENDS[name]) if name else None
