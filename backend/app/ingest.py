import codecs
import os
import re
import shutil
import unicodedata
from pathlib import Path, PurePosixPath

from fastapi import HTTPException
from PIL import Image

from app import config, pdf, store

LINE_MODES = {'per_crop', 'per_page'}
# 'map_lines' traces boundary polylines on tiles; 'map_segmentation' fills class polygons.
# Both annotate pre-cut (or tiled) map images, so every ingest/tiling/class/export gate
# below keys on TILE_TASKS — polygon-vs-line behaviour keys on regions.kind instead.
TILE_TASKS = {'map_segmentation', 'map_lines'}
TASKS = {'text'} | TILE_TASKS


class IngestError(Exception):
    status_code = 400

    def __init__(self, detail: str):
        self.detail = detail


class UploadTooLarge(IngestError):
    status_code = 413


def readable_size(n_bytes: float) -> str:
    for unit, scale in (('GB', 1e9), ('MB', 1e6)):
        if n_bytes >= scale:
            return f'{n_bytes / scale:.1f} {unit}'
    return f'{n_bytes / 1e3:.1f} KB'


def require_zip_within_limit(archive) -> None:
    """Refuses an archive by the sizes its own index declares, before a byte is written;
    zipfile never inflates a member past its declared size, so the sum is a hard bound."""
    limit = config.MAX_ZIP_EXTRACT_GB * 1e9
    unpacked = sum(info.file_size for info in archive.infolist())
    if limit and unpacked > limit:
        raise UploadTooLarge(f'the zip unpacks to {readable_size(unpacked)}, over this server\'s '
                             f'limit of {readable_size(limit)} (MAX_ZIP_EXTRACT_GB)')


def require_size_within_limit(width: int, height: int, display: str) -> None:
    limit = config.MAX_IMAGE_PIXELS
    if limit and width * height > limit:
        raise UploadTooLarge(f'{display} is {width} x {height} = {width * height:,} pixels, '
                             f'over this server\'s limit of {limit:,} (MAX_IMAGE_PIXELS)')


def require_pixels_within_limit(path, display: str) -> None:
    """Reads only the image header. A file Pillow cannot read is let through here: the
    ingest phase marks that page unreadable, with the reason, and carries on."""
    if not config.MAX_IMAGE_PIXELS:
        return
    try:
        with Image.open(path) as img:
            width, height = img.size
    except (OSError, ValueError, Image.DecompressionBombError):
        return
    require_size_within_limit(width, height, display)


def valid_line_mode(mode: str) -> str:
    if mode not in LINE_MODES:
        raise HTTPException(400, f'line_mode must be one of {sorted(LINE_MODES)}')
    return mode


def coherent_phases(run_layout: bool, run_lines: bool, run_ocr: bool,
                    line_mode: str) -> tuple[bool, bool, bool, str]:
    """The text phases as they can actually run. OCR reads line crops, so it needs line
    detection; per-crop line detection segments inside layout elements, so without layout
    there is nothing to segment inside. Shared by dataset creation and by the settings
    patch, which would otherwise be free to write a combination the runner cannot honour."""
    return run_layout, run_lines, run_ocr and run_lines, line_mode if run_layout else 'per_page'


def valid_task(task: str) -> str:
    """Gate on creation only. A task switched off in this deployment's .env is refused
    here, but jobs of that kind created earlier keep working everywhere else - disabling
    a task hides the door, it does not strand what is already behind it."""
    if task not in TASKS:
        raise HTTPException(400, f'task must be one of {sorted(TASKS)}')
    enabled = config.enabled_tasks()
    if task not in enabled:
        raise HTTPException(400, f'task "{task}" is disabled on this deployment '
                                 f'(enabled: {", ".join(enabled) or "none"})')
    return task


def is_tile_task(task: str | None) -> bool:
    """True for the tile-annotation tasks (map_segmentation, map_lines)."""
    return task in TILE_TASKS


def _name_key(name: str) -> str:
    return unicodedata.normalize('NFC', name.strip()).casefold()


def require_unique_name(conn, name: str, exclude_id: str | None = None) -> str:
    """The name trimmed, refused when blank or when another dataset has it in any letter
    case. Compared here rather than with SQLite's lower(), which folds ASCII only and so
    let "Äpfel" stand beside "äpfel"."""
    name = name.strip()
    if not name:
        raise HTTPException(400, 'a dataset needs a name')
    key = _name_key(name)
    for row in conn.execute('SELECT name FROM jobs WHERE id IS NOT ?', (exclude_id,)):
        if _name_key(row['name']) == key:
            raise HTTPException(409, f'a dataset named "{name}" already exists')
    return name


def page_count(conn, job_id: str) -> int:
    # Counts soft-deleted too, so an append's filename prefixes are never reused.
    return conn.execute('SELECT COUNT(*) c FROM pages WHERE job_id = ?', (job_id,)).fetchone()['c']


def insert_pages(conn, job_id: str, files: list[tuple], as_test: bool | None = None) -> dict[str, int]:
    """Pages in the order given, which is reading order. idx continues past any existing
    pages so appending to a job never collides. They are test pages when `as_test` says
    so, or else when the dataset's new pages are. Returns the new page ids by source."""
    if as_test is None:
        as_test = bool(conn.execute('SELECT new_pages_test FROM jobs WHERE id = ?',
                                    (job_id,)).fetchone()['new_pages_test'])
    base = conn.execute(
        'SELECT COALESCE(MAX(idx), -1) + 1 n FROM pages WHERE job_id = ?', (job_id,)).fetchone()['n']
    page_ids = {}
    for offset, entry in enumerate(files):
        filename, source = entry[0], entry[1]
        source_pdf, source_page = (entry[2], entry[3]) if len(entry) > 2 else (None, None)
        page_ids[source] = conn.execute(
            'INSERT INTO pages (job_id, idx, filename, source_file, source_pdf, source_page, is_test) '
            'VALUES (?,?,?,?,?,?,?)',
            (job_id, base + offset, filename, source, source_pdf, source_page, int(as_test))).lastrowid
    store.recount_pages(conn, job_id, commit=False)
    return page_ids


def map_count(conn, job_id: str) -> int:
    # Counts soft-deleted too, so an append's idx/prefix continuity never collides.
    return conn.execute('SELECT COUNT(*) c FROM job_maps WHERE job_id = ?', (job_id,)).fetchone()['c']


def insert_maps(conn, job_id: str, files: list[tuple]):
    """Register uploaded full maps for the tiling phase. `files` are (filename, source)
    2-tuples (map jobs reject PDFs, so there is no expand_pdf interaction)."""
    base = conn.execute(
        'SELECT COALESCE(MAX(idx), -1) + 1 n FROM job_maps WHERE job_id = ?', (job_id,)).fetchone()['n']
    for offset, (filename, source) in enumerate(files):
        conn.execute('INSERT INTO job_maps (job_id, idx, filename, source_file) VALUES (?,?,?,?)',
                     (job_id, base + offset, filename, source))
    store.recount_pages(conn, job_id, commit=False)


def expand_pdf(job_id: str, source: Path, display: str, prefix: str) -> list[tuple]:
    """One entry per PDF page. The images are materialized later, in the runner;
    here we only need the page count and the extract/render decision."""
    specs = pdf.probe(source)
    for spec in specs:
        require_size_within_limit(spec.width, spec.height, f'{display} page {spec.page}')
    stem = Path(display).stem
    pages_dir = config.job_dir(job_id) / 'pages'
    return [(f'{stem}_p{s.page:04d}{s.ext}',
             str(pages_dir / f'{prefix}_{stem}_p{s.page:04d}{s.ext}'),
             str(source), s.page)
            for s in specs]


MAX_NAME_BYTES = 200


def natural_key(name: str) -> tuple:
    """Numbers compared as numbers and letters whatever their case, so scan_2 comes before
    scan_10; the name itself breaks a tie, so the order never depends on arrival."""
    parts = re.split(r'(\d+)', name.casefold())
    return tuple(int(part) if i % 2 else part for i, part in enumerate(parts)), name


def require_short_name(filename: str) -> None:
    """A page keeps its file name in exports and pairs with its transcription by it, so a
    name too long to store beside its prefix is refused rather than shortened."""
    size = len(filename.encode('utf-8'))
    if size > MAX_NAME_BYTES:
        shown = filename if len(filename) <= 48 else f'{filename[:40]}...{Path(filename).suffix}'
        raise IngestError(f'"{shown}" has a file name of {size} bytes, longer than the '
                          f'{MAX_NAME_BYTES} a page name may be - shorten it and try again')


def in_reading_order(documents: list[tuple]) -> list:
    """Each document's pages - one for an image, every page of a PDF - kept together,
    the documents in natural order of their names, two of one name in the order chosen."""
    ordered = sorted(documents, key=lambda doc: (natural_key(doc[0]), doc[1]))
    return [entry for _name, _position, entries in ordered for entry in entries]


def save_uploads(job_id: str, files, offset: int, extensions=None) -> tuple[list, list]:
    extensions = extensions or config.INGEST_EXTENSIONS
    chosen, skipped = [], []
    for i, file in enumerate(files):
        filename = Path(file.filename or f'file_{offset + i}').name
        if Path(filename).suffix.lower() not in extensions:
            skipped.append(filename)
            continue
        require_short_name(filename)
        chosen.append((i, filename, file))
    uploads = config.job_dir(job_id) / 'uploads'
    uploads.mkdir(parents=True, exist_ok=True)
    documents, written = [], []
    try:
        for i, filename, file in chosen:
            prefix = f'{offset + i:05d}'
            dest = uploads / f'{prefix}_{filename}'
            written.append(dest)
            with open(dest, 'wb') as out:
                shutil.copyfileobj(file.file, out, length=1 << 20)
            if is_pdf(filename):
                try:
                    documents.append((filename, i, expand_pdf(job_id, dest, filename, prefix)))
                except pdf.PdfError as e:
                    raise IngestError(f'{filename}: {e}')
            else:
                documents.append((filename, i, [(filename, str(dest))]))
                require_pixels_within_limit(dest, filename)
    except Exception:
        # Appending has no job folder of its own to throw away, so what this call wrote goes.
        for path in written:
            path.unlink(missing_ok=True)
        raise
    # A browser sends files in no particular order, so name order is reading order.
    return in_reading_order(documents), skipped


def is_pdf(path) -> bool:
    return Path(path).suffix.lower() in config.PDF_EXTENSIONS


def collect_path(job_id: str, sources, offset: int) -> list:
    entries = []
    for i, src in enumerate(sources):
        require_short_name(src.name)
        if is_pdf(src):
            # Expanded pages land in job_dir; the user's directory is never written to.
            try:
                entries.extend(expand_pdf(job_id, src, src.name, f'{offset + i:05d}'))
            except pdf.PdfError as e:
                raise IngestError(f'{src.name}: {e}')
        else:
            require_pixels_within_limit(src, src.name)
            entries.append((src.name, str(src)))
    return entries


def read_path(job_id: str, root: Path, sources: list, offset: int,
              gt_from_pdf: bool) -> tuple[list, dict, dict]:
    """A directory's pages, the ground truth beside them, and the corpus documents
    among them - for creating a dataset from it and for appending it alike."""
    entries = collect_path(job_id, sources, offset)
    text_files = transcription_files(root)
    gt_texts = ground_truth_texts(entries, sibling_transcriptions(root, sources, text_files),
                                  gt_from_pdf)
    return entries, gt_texts, path_documents(root, sources, text_files)


SYSTEM_ENTRIES = {'@eadir', '#recycle', '#snapshot', '$recycle.bin', '__macosx',
                  'system volume information', 'thumbs.db', 'desktop.ini'}


def is_system_entry(relative) -> bool:
    """What a file manager or a NAS keeps beside the scans: hidden entries (macOS ._ twins,
    .DS_Store), Synology @eaDir thumbnails, recycle bins. Judged on the path below the
    folder being read, so a folder that itself sits inside a hidden one is still read."""
    return any(part.startswith('.') or part.casefold() in SYSTEM_ENTRIES
               for part in PurePosixPath(relative).parts)


def within_ingest_roots(path: Path) -> bool:
    return not config.INGEST_ROOTS or any(
        path.resolve().is_relative_to(root) for root in config.INGEST_ROOTS)


def visible_files(root: Path) -> tuple[list[Path], list[str]]:
    """Every file below root that is no system entry, and the symbolic links passed over
    by their path below root. A link to a folder is never followed - it may loop, or bring
    in a whole other volume - and while INGEST_ROOTS is set, neither is a link to a file
    outside them."""
    files, skipped_symlinks = [], []
    for folder, dirs, names in os.walk(root):
        folder = Path(folder)
        dirs[:] = [d for d in dirs if not is_system_entry(d)]
        skipped_symlinks += [(folder / d).relative_to(root).as_posix()
                             for d in dirs if (folder / d).is_symlink()]
        for name in names:
            path = folder / name
            if is_system_entry(name):
                continue
            if path.is_symlink() and not within_ingest_roots(path):
                skipped_symlinks.append(path.relative_to(root).as_posix())
            elif path.is_file():
                files.append(path)
    return files, sorted(skipped_symlinks)


def scan_path(server_path: str, extensions=None) -> tuple[Path, list, list[str]]:
    extensions = extensions or config.INGEST_EXTENSIONS
    root = Path(server_path)
    if not root.is_absolute():
        raise HTTPException(400, f'the server path must be absolute: {server_path}')
    if not within_ingest_roots(root):
        allowed = ', '.join(str(folder) for folder in config.INGEST_ROOTS)
        raise HTTPException(400, f'{root} is outside the folders this server reads from '
                                 f'(INGEST_ROOTS: {allowed})')
    if not root.is_dir():
        raise HTTPException(400, f'not a directory: {root}')
    files, skipped_symlinks = visible_files(root)
    sources = sorted((p for p in files if p.suffix.lower() in extensions),
                     key=lambda p: natural_key(p.relative_to(root).as_posix()))
    if not sources:
        raise HTTPException(400, 'no matching image or PDF files found under path')
    return root, sources, skipped_symlinks


def split_transcriptions(files) -> tuple[list, dict[str, str]]:
    """Transcription siblings ride along in the same upload: same name as the image,
    .txt extension, full page text with newlines preserved. Returns the images to
    ingest and the transcriptions keyed by stem."""
    images, texts = [], {}
    for file in files:
        name = Path(file.filename or '')
        if name.suffix.lower() == '.txt':
            texts[name.stem] = decode_text(file.file.read(), name.name)
        else:
            images.append(file)
    return images, texts


def partition_transcriptions(entries: list[tuple], texts: dict[str, str]) -> tuple[dict, dict]:
    """Per-page sidecars, keyed by the source of the page they transcribe, against corpus
    documents keyed by name.

    A .txt named after an image in the same upload transcribes that page, as it always
    has. A .txt named after nothing in the upload is a document of the corpus: a letter,
    an entry, a chapter, covering however many leaves its text turns out to span. That is
    what lets a transcribed corpus be uploaded beside a bag of scans with no naming in
    common - which is the usual case, since the two were produced by different people
    decades apart.
    """
    stems = {Path(entry[0]).stem.casefold() for entry in entries}
    by_stem = {stem.casefold(): text for stem, text in texts.items()}
    sidecars = {entry[1]: by_stem[Path(entry[0]).stem.casefold()] for entry in entries
                if Path(entry[0]).stem.casefold() in by_stem}
    documents = {stem: text for stem, text in texts.items() if stem.casefold() not in stems}
    return sidecars, documents


def decode_text(raw: bytes, display: str) -> str:
    """UTF-8 with or without a byte-order mark, or UTF-16 with one. Anything else is
    refused rather than read with its accented letters replaced."""
    encoding = 'utf-16' if raw.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)) else 'utf-8-sig'
    try:
        return raw.decode(encoding)
    except UnicodeDecodeError:
        raise IngestError(f'{display} is not UTF-8 text - save it as UTF-8 and add it again')


def transcription_files(root: Path) -> list[Path]:
    return sorted(p for p in visible_files(root)[0] if p.suffix.lower() == '.txt')


def _scan_key(path) -> tuple[Path, str]:
    """A scan and its transcription share a folder and a name, whatever the case of either."""
    path = Path(path)
    return path.parent, path.stem.casefold()


def _read_text_file(root: Path, path: Path) -> str:
    return decode_text(path.read_bytes(), path.relative_to(root).as_posix())


def path_documents(root: Path, sources: list, text_files: list[Path]) -> dict[str, str]:
    """Corpus documents lying in an ingested directory: text files named after no image
    beside them, each named by its path below the root so that namesakes in different
    folders stay apart. One named after an image in its own folder is that page's
    transcription, and sibling_transcriptions has already taken it. A PDF's pages are
    named after it plus a page number, so a .txt named after the PDF transcribes none
    of them."""
    paired = {_scan_key(src) for src in sources if not is_pdf(src)}
    return {path.relative_to(root).with_suffix('').as_posix(): _read_text_file(root, path)
            for path in text_files if _scan_key(path) not in paired}


def sibling_transcriptions(root: Path, sources: list, text_files: list[Path]) -> dict[str, str]:
    """Page-level ground truth keyed by source: a .txt next to an image, same name."""
    by_key = {_scan_key(path): path for path in text_files}
    return {str(src): _read_text_file(root, by_key[_scan_key(src)]) for src in sources
            if not is_pdf(src) and _scan_key(src) in by_key}


def pdf_transcriptions(entries: list[tuple]) -> dict[str, str]:
    """Page-level ground truth from an ingested PDF's own text layer, keyed by the
    page source expand_pdf generated - so attach_ground_truth pairs it exactly like
    a sibling .txt. Entries that did not come from a PDF are ignored."""
    by_pdf: dict[str, list] = {}
    for entry in entries:
        if len(entry) > 3 and entry[2]:
            by_pdf.setdefault(entry[2], []).append(entry)
    texts = {}
    for source_pdf, pages in by_pdf.items():
        try:
            extracted = pdf.page_texts(Path(source_pdf))
        except pdf.PdfError as e:
            raise IngestError(f'{Path(source_pdf).name}: {e}')
        for _filename, dest, _source, page_number in pages:
            text = extracted.get(page_number, '')
            if text.strip():
                texts[dest] = text
    return texts


def ground_truth_texts(entries: list[tuple], sidecars: dict[str, str],
                       from_pdf: bool) -> dict[str, tuple[str, str]]:
    """{page source: (text, origin)}. Sidecar transcriptions win over a PDF's own text layer:
    a .txt beside the image is a deliberate act, an embedded layer is whatever the
    document happened to carry."""
    texts: dict[str, tuple[str, str]] = {}
    if from_pdf:
        texts = {source: (text, 'pdf') for source, text in pdf_transcriptions(entries).items()}
    texts.update({source: (text, 'sidecar') for source, text in sidecars.items()})
    return texts


def attach_ground_truth(conn, page_ids: dict[str, int], texts: dict[str, tuple[str, str]]) -> int:
    """Pairs transcriptions to the pages just inserted (insert_pages' ids by source),
    recording where each came from; returns how many paired. Only those pages: an older
    page of the same name keeps the text that came with it."""
    matched = 0
    for source, (text, origin) in texts.items():
        if source in page_ids and text.strip():
            conn.execute('UPDATE pages SET gt_text = ?, gt_source = ? WHERE id = ?',
                         (text, origin, page_ids[source]))
            matched += 1
    return matched
