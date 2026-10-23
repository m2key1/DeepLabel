import json
import mimetypes
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

DEFAULT_TIMEOUT = 120
POLL_SECONDS = 3
FINISHED = ('done', 'error', 'cancelled')


class DeepLabelError(RuntimeError):
    def __init__(self, status: int, detail: str):
        self.status = status
        self.detail = detail
        super().__init__(f'{status}: {detail}')


class DeepLabel:
    """Talks to a DeepLabel deployment with an API token.

    Stdlib only, so it drops into any interpreter - including the minimal model venvs -
    without pulling a dependency tree behind it.
    """

    def __init__(self, url: str, token: str, timeout: int = DEFAULT_TIMEOUT):
        if not url:
            raise ValueError('no DeepLabel URL - pass url= or set DEEPLABEL_URL')
        if not token:
            raise ValueError('no API token - pass token= or set DEEPLABEL_TOKEN')
        self.url = url.rstrip('/')
        self.token = token
        self.timeout = timeout

    def _request(self, method: str, path: str, *, params: dict | None = None,
                 body: bytes | None = None, content_type: str | None = None,
                 raw: bool = False):
        target = self.url + path
        if params:
            # doseq: a repeated parameter such as model_ids is a list on this side
            # and several query parameters on the wire, which is what FastAPI reads.
            target += '?' + urllib.parse.urlencode(
                {k: v for k, v in params.items() if v is not None}, doseq=True)
        request = urllib.request.Request(target, data=body, method=method)
        request.add_header('Authorization', f'Bearer {self.token}')
        if content_type:
            request.add_header('Content-Type', content_type)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = response.read()
        except urllib.error.HTTPError as error:
            raise DeepLabelError(error.code, _detail(error.read()))
        except urllib.error.URLError as error:
            raise DeepLabelError(0, f'cannot reach {self.url}: {error.reason}')
        if raw:
            return payload
        return json.loads(payload) if payload else None

    # Datasets

    def jobs(self) -> list[dict]:
        return self._request('GET', '/api/jobs')

    def job(self, job_id: str) -> dict:
        return self._request('GET', f'/api/jobs/{job_id}')

    def upload(self, name: str, paths: list[Path], **options) -> dict:
        """Create a dataset from image files. A .txt beside an image, passed in the same
        call, is ingested as that page's transcription."""
        files = [(p, p.name) for p in _expand(paths)]
        if not files:
            raise ValueError('no files to upload')
        fields = {'name': name, **{k: _form_value(v) for k, v in options.items()}}
        body, content_type = _multipart(fields, [('files', p, n) for p, n in files])
        return self._request('POST', '/api/jobs', body=body, content_type=content_type)

    def import_export_zip(self, name: str, archive: Path, reviewed: bool = False) -> dict:
        """Import a Transkribus / eScriptorium zip: PAGE or ALTO XML plus the images."""
        body, content_type = _multipart({'name': name, 'reviewed': _form_value(reviewed)},
                                        [('file', Path(archive), Path(archive).name)])
        return self._request('POST', '/api/jobs/import', body=body, content_type=content_type)

    def export(self, job_id: str, format: str = 'json', reviewed_only: bool = False) -> bytes:
        return self._request('GET', f'/api/jobs/{job_id}/export', raw=True,
                             params={'format': format, 'checked_only': _form_value(reviewed_only)})

    def delete_job(self, job_id: str) -> None:
        self._request('DELETE', f'/api/jobs/{job_id}')

    def wait(self, job_id: str, poll: int = POLL_SECONDS, timeout: int | None = None,
             on_progress=None) -> dict:
        """Block until the dataset stops running. Returns its final state."""
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            job = self.job(job_id)
            if on_progress:
                on_progress(job)
            if job['status'] in FINISHED:
                return job
            if deadline is not None and time.monotonic() > deadline:
                raise TimeoutError(f'{job_id} still {job["status"]} after {timeout}s')
            time.sleep(poll)

    # Corpus and per-page reference text

    def documents(self, job_id: str) -> dict:
        """The corpus this dataset was uploaded with, in reading order."""
        return self._request('GET', f'/api/jobs/{job_id}/documents')

    def document(self, job_id: str, name: str) -> dict:
        return self._request('GET', f'/api/jobs/{job_id}/documents/{name}')

    def upload_documents(self, job_id: str, paths: list[Path]) -> dict:
        """Add corpus text files, or replace held ones by uploading them again. Each file
        covers one document - a letter, an entry, a chapter - however many pages it spans.
        Names need nothing in common with the scans: the cut pairs them by content."""
        files = [p for p in _expand(paths) if p.suffix.lower() == '.txt']
        if not files:
            raise ValueError('no .txt files to upload')
        body, content_type = _multipart({}, [('files', p, p.name) for p in files])
        return self._request('POST', f'/api/jobs/{job_id}/documents', body=body,
                             content_type=content_type)

    def delete_document(self, job_id: str, name: str) -> dict:
        return self._request('DELETE', f'/api/jobs/{job_id}/documents/{name}')

    def cut_reference(self, job_id: str) -> dict:
        """Cut the corpus across the dataset's pages, using what recognition read as the
        anchors. Writes only the reference columns, so no transcription is at risk."""
        return self._request('POST', f'/api/jobs/{job_id}/reference/cut')

    def reference(self, job_id: str, limit: int = 200, offset: int = 0) -> dict:
        """What each page is answerable for, with how well its cut is pinned down."""
        return self._request('GET', f'/api/jobs/{job_id}/reference',
                             params={'limit': limit, 'offset': offset})

    # Diplomatic readings, which become each page's ground truth

    def groundtruth_preview(self, job_id: str, model_ids: list[int] | None = None) -> dict:
        return self._request('GET', f'/api/jobs/{job_id}/groundtruth/preview',
                             params={'model_ids': model_ids} if model_ids else None)

    def read_groundtruth(self, job_id: str, model_ids: list[int] | None = None,
                         refresh: bool = False, page_ids: list[int] | None = None) -> dict:
        """Queue a diplomatic reading per placed page, each asked with its own span."""
        payload = {'model_ids': model_ids, 'refresh': refresh, 'page_ids': page_ids}
        return self._request('POST', f'/api/jobs/{job_id}/groundtruth/read',
                             body=json.dumps(payload).encode(),
                             content_type='application/json')

    def groundtruth_status(self, job_id: str) -> dict:
        return self._request('GET', f'/api/jobs/{job_id}/groundtruth/status')

    def wait_groundtruth(self, job_id: str, poll: int = POLL_SECONDS,
                         timeout: int | None = None, on_progress=None) -> dict:
        """Block until no diplomatic reading is left in flight."""
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            state = self.groundtruth_status(job_id)
            if on_progress:
                on_progress(state)
            if not state['pending'] and not state['running']:
                return state
            if deadline is not None and time.monotonic() > deadline:
                raise TimeoutError(f'{job_id} still reading after {timeout}s')
            time.sleep(poll)

    # Models and training

    def models(self) -> dict:
        return self._request('GET', '/api/models')

    def trainings(self) -> dict:
        return self._request('GET', '/api/trainings')


def _detail(body: bytes) -> str:
    try:
        return json.loads(body).get('detail') or body.decode('utf-8', 'replace')
    except (ValueError, AttributeError):
        return body.decode('utf-8', 'replace')


def _form_value(value) -> str:
    return str(value).lower() if isinstance(value, bool) else str(value)


def _expand(paths: list[Path]) -> list[Path]:
    """Directories contribute their files, so a caller can hand over a folder of scans."""
    found = []
    for path in paths:
        path = Path(path)
        found.extend(sorted(p for p in path.iterdir() if p.is_file()) if path.is_dir() else [path])
    return found


def _multipart(fields: dict, files: list[tuple[str, Path, str]]) -> tuple[bytes, str]:
    boundary = uuid.uuid4().hex
    parts = []
    for name, value in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n'
                     f'{value}\r\n'.encode())
    for name, path, filename in files:
        mime = mimetypes.guess_type(filename)[0] or 'application/octet-stream'
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; '
                     f'filename="{filename}"\r\nContent-Type: {mime}\r\n\r\n'.encode())
        parts.append(Path(path).read_bytes())
        parts.append(b'\r\n')
    parts.append(f'--{boundary}--\r\n'.encode())
    return b''.join(parts), f'multipart/form-data; boundary={boundary}'
