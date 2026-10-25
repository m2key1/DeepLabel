import json
import mimetypes
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

DEFAULT_TIMEOUT = 120
# A batch is answered once the server has stored and probed every file in it.
UPLOAD_TIMEOUT = 900
BATCH_SCANS = 200
BATCH_BYTES = 512 * 1024 * 1024
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
                 raw: bool = False, timeout: int | None = None):
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
            with urllib.request.urlopen(request, timeout=timeout or self.timeout) as response:
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

    def upload(self, name: str, paths: list[Path], *, batch_size: int = BATCH_SCANS,
               resume: bool = False, on_progress=None, **options) -> dict:
        """Create a dataset from image files. A .txt beside an image, passed in the same
        call, is ingested as that page's transcription.

        More scans than one batch holds are sent in parts: the dataset waits as
        'uploading' until the last part is in, and is started then. `resume` finishes
        such an upload by the dataset's name, sending only the files it lacks.
        `on_progress(files_sent, files_total)` is called after every part."""
        groups = _scan_groups(_expand(paths))
        if not groups:
            raise ValueError('no files to upload')
        job_id = None
        if resume:
            job_id = self._held_upload(name)
            have = {page['filename'] for page in self.job(job_id).get('pages', [])}
            groups = [g for g in groups if not _already_uploaded(g[0], have)]
        batches = _batches(groups, batch_size)
        total = sum(len(batch) for batch in batches)
        sent = documents = 0
        for batch in batches:
            if job_id is None:
                fields = {'name': name, **{k: _form_value(v) for k, v in options.items()}}
                if len(batches) > 1:
                    fields['hold'] = 'true'
                answer = self._send_files('/api/jobs', fields, batch)
                job_id = answer['job_id']
            else:
                answer = self._send_files(f'/api/jobs/{job_id}/pages/upload', {}, batch)
            documents += answer.get('documents', 0)
            sent += len(batch)
            if on_progress:
                on_progress(sent, total)
        if resume or len(batches) > 1:
            self._request('POST', f'/api/jobs/{job_id}/start')
        return {'job_id': job_id, 'documents': documents}

    def _send_files(self, path: str, fields: dict, files: list[Path]) -> dict:
        body, content_type = _multipart(fields, [('files', p, p.name) for p in files])
        return self._request('POST', path, body=body, content_type=content_type,
                             timeout=max(self.timeout, UPLOAD_TIMEOUT))

    def _held_upload(self, name: str) -> str:
        for job in self.jobs():
            if job['name'] == name and job['status'] == 'uploading':
                return job['id']
        raise ValueError(f'no dataset "{name}" is waiting for its upload')

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


def _scan_groups(files: list[Path]) -> list[list[Path]]:
    """Each scan with the transcription beside it, which the server pairs only within one
    request. A text file without a scan is a corpus document and travels on its own."""
    scans = {(f.parent, f.stem): [f] for f in files if f.suffix.lower() != '.txt'}
    groups = list(scans.values())
    for f in files:
        if f.suffix.lower() == '.txt':
            scan = scans.get((f.parent, f.stem))
            if scan:
                scan.append(f)
            else:
                groups.append([f])
    order = {f: i for i, f in enumerate(files)}
    return sorted(groups, key=lambda g: order[g[0]])


def _batches(groups: list[list[Path]], scans_per_batch: int) -> list[list[Path]]:
    batches, batch, scans, size = [], [], 0, 0
    for group in groups:
        group_size = sum(f.stat().st_size for f in group)
        if batch and (scans >= scans_per_batch or size + group_size > BATCH_BYTES):
            batches.append(batch)
            batch, scans, size = [], 0, 0
        batch += group
        scans += 1
        size += group_size
    return batches + [batch] if batch else batches


def _already_uploaded(source: Path, page_names: set[str]) -> bool:
    """A PDF is cut into pages named <stem>_p0001 and on, all in the request that sent it."""
    if source.suffix.lower() == '.pdf':
        pattern = re.compile(rf'{re.escape(source.stem)}_p\d{{4}}\.')
        return any(pattern.match(name) for name in page_names)
    return source.name in page_names


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
