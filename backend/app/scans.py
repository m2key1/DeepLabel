from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

from app import blobs, renditions

ORIENTATION_TAG = 0x0112
HIGH_BIT_MODES = {'I', 'I;16', 'I;16B', 'I;16L', 'I;16N'}
ALPHA_MODES = {'RGBA', 'LA', 'PA', 'RGBa', 'La'}
SIXTEEN_TO_EIGHT = 1 / 257
# A phone's JPEG opens as a multi-picture file; its normalised copy is the one picture.
SAVE_AS = {'MPO': 'JPEG'}
SAVE_OPTIONS = {'JPEG': {'quality': 95}, 'WEBP': {'lossless': True}, 'TIFF': {'compression': 'tiff_lzw'}}


class UnreadableScan(Exception):
    """A scan that cannot be read as an image, carrying the sentence that says why."""


def _has_alpha(img: Image.Image) -> bool:
    return img.mode in ALPHA_MODES or 'transparency' in img.info


def _needs_normalising(img: Image.Image) -> bool:
    orientation = img.getexif().get(ORIENTATION_TAG)
    return orientation not in (None, 1) or img.mode in HIGH_BIT_MODES or _has_alpha(img)


def normalised(img: Image.Image) -> Image.Image:
    """Upright, 8-bit, opaque RGB. A 16-bit scan is scaled down rather than clipped, which
    would turn nearly all of it white, and a transparent background is laid on white
    rather than on the black a plain conversion gives it, which would swallow dark ink."""
    img = ImageOps.exif_transpose(img)
    if img.mode in HIGH_BIT_MODES:
        img = img.convert('I').point(lambda v: v * SIXTEEN_TO_EIGHT).convert('L')
    if _has_alpha(img):
        rgba = img.convert('RGBA')
        img = Image.alpha_composite(Image.new('RGBA', rgba.size, 'white'), rgba)
    return img.convert('RGB')


def _reason(path: Path, error: Exception) -> str:
    if not path.exists():
        return 'the file is missing'
    if path.stat().st_size == 0:
        return 'the file is empty'
    if isinstance(error, UnidentifiedImageError):
        return 'it is not an image in a format this server reads'
    return str(error)


def open_scan(source: str, display: str) -> tuple[Image.Image, str | None]:
    """The scan as pages read it, and the format to write a normalised copy in - None when
    the file is already what every later step would make of it."""
    path = Path(source)
    try:
        with Image.open(path) as img:
            img.load()
            rewrite = SAVE_AS.get(img.format, img.format) if _needs_normalising(img) else None
            return normalised(img), rewrite
    except (OSError, ValueError, SyntaxError) as error:
        raise UnreadableScan(f'{display} could not be read: {_reason(path, error)}') from error


def mark_unreadable(conn, page_id: int, message: str) -> None:
    conn.execute("UPDATE pages SET status = 'unreadable', error = ? WHERE id = ?", (message, page_id))
    conn.commit()


def ingest_page(conn, page, job_path: Path, seen: set, blobs_dir: Path | None, status: str) -> str:
    """Hash, deduplicate, normalise, share and render one pending page, for both runners'
    ingest; returns what became of it: the status it reached, 'duplicate' or 'unreadable'.

    A scan that needed normalising is written out as a copy in its own format and the page
    points at it, so the crop, the training pair and the export read the pixels the boxes
    are drawn on without normalising again. Only pending pages come through here, so a
    page ingested earlier keeps the image its geometry was drawn on. A scan is a duplicate
    by the file as it arrived and by its normalised copy alike, so two uploads of one
    turned photo are one scan. Config-free, for the map runner's minimal venv."""
    source = page['source_file']
    try:
        digest = renditions.file_hash(source)
    except OSError as error:
        mark_unreadable(conn, page['id'], f"{page['filename']} could not be read: "
                                          f'{_reason(Path(source), error)}')
        return 'unreadable'
    if digest in seen:
        return _mark_duplicate(conn, page['id'], digest)
    try:
        img, rewrite = open_scan(source, page['filename'])
    except UnreadableScan as error:
        mark_unreadable(conn, page['id'], str(error))
        return 'unreadable'
    if rewrite:
        source = str(_write_normalised(img, rewrite, job_path / 'normalised', page['id'], Path(source).suffix))
        digest = renditions.file_hash(source)
        if digest in seen:
            Path(source).unlink(missing_ok=True)
            return _mark_duplicate(conn, page['id'], digest)
    seen.add(digest)
    blobs.share(source, digest, job_path, blobs_dir)
    renditions.write(img, job_path / 'renditions', page['id'])
    conn.execute('UPDATE pages SET status = ?, source_file = ?, content_hash = ?, width = ?, height = ?, '
                 'error = NULL WHERE id = ?',
                 (status, source, digest, img.width, img.height, page['id']))
    conn.commit()
    return status


def _mark_duplicate(conn, page_id: int, digest: str) -> str:
    conn.execute("UPDATE pages SET status = 'duplicate', content_hash = ? WHERE id = ?", (digest, page_id))
    conn.commit()
    return 'duplicate'


def normalised_map(source: str, display: str, job_path: Path, map_id: int) -> str:
    """The file a full map is cut into tiles from: the map itself when it is already
    upright, 8-bit and opaque, else a normalised copy, so the tiles, their geometry and the
    fused export all stand on what a page scan would have become. A map can be far larger
    than a page, so it is only read whole when it needs normalising, and one this server
    cannot open is left to the tiler's own reader."""
    try:
        with Image.open(source) as img:
            if not _needs_normalising(img):
                return source
    except (OSError, ValueError, SyntaxError):
        return source
    img, rewrite = open_scan(source, display)
    return str(_write_normalised(img, rewrite, job_path / 'normalised' / 'maps', map_id, Path(source).suffix))


def _write_normalised(img: Image.Image, fmt: str, directory: Path, row_id: int, suffix: str) -> Path:
    """Beside the dataset's other files and never over the original, which may be a link
    into the blob store or a file in the user's own folder."""
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / f'{row_id}{suffix.lower()}'
    target.unlink(missing_ok=True)
    img.save(target, format=fmt, **SAVE_OPTIONS.get(fmt, {}))
    return target
