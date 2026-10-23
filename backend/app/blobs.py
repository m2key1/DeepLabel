"""Content-addressed sharing of ingested images across datasets. The bytes live once
under DATA_DIR/blobs and every dataset's own path is a hard link to that copy, so the
rest of the app keeps reading job-local paths while identical uploads cost the disk
nothing extra. Rows are the pointers: deleting or purging a dataset drops its links,
and release() unlinks a blob once the store holds the only link left. Path-ingested
files outside the job directory belong to the user and are never adopted.

Deliberately config-free (the store's location arrives as an argument), so the map
runner's minimal venv can import this via map_ingest without pulling in app.config.
"""
import os
from pathlib import Path


def blob_path(blobs_dir: Path, digest: str, suffix: str) -> Path:
    return blobs_dir / digest[:2] / f'{digest}{suffix.lower()}'


def share(source_file: str, digest: str, job_path: Path, blobs_dir: Path | None):
    """Adopt a freshly hashed, job-owned file into the store: register its bytes, or
    replace the file with a link to the already-stored copy. Best effort - on a
    filesystem without hard links the dataset simply keeps its plain copy."""
    if blobs_dir is None:
        return
    source = Path(source_file)
    if not (source.is_absolute() and source.resolve().is_relative_to(Path(job_path).resolve())):
        return
    dest = blob_path(blobs_dir, digest, source.suffix)
    try:
        if dest.exists():
            if not source.samefile(dest):
                source.unlink()
                os.link(dest, source)
        else:
            dest.parent.mkdir(parents=True, exist_ok=True)
            os.link(source, dest)
    except OSError:
        pass


def release(candidates: list[tuple[str | None, str]], blobs_dir: Path):
    """Drop blobs no dataset links any more. Candidates are (content_hash, source_file)
    pairs of rows whose files just went away; a blob is deleted once the store's own
    link is the only one remaining."""
    for digest, source in set(candidates):
        if not digest:
            continue
        path = blob_path(blobs_dir, digest, Path(source).suffix)
        try:
            if path.exists() and path.stat().st_nlink <= 1:
                path.unlink()
        except OSError:
            pass
