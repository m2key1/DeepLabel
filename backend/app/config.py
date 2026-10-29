import os
import tomllib
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

APP_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(APP_ROOT / '.env')

VERSION = tomllib.loads((Path(__file__).resolve().parents[1] / 'pyproject.toml').read_text())['project']['version']
GIT_COMMIT = (os.environ.get('GIT_COMMIT') or '').strip()

DATA_DIR = Path(os.environ.get('DATA_DIR', APP_ROOT / 'data')).resolve()
DB_PATH = DATA_DIR / 'app.db'
JOBS_DIR = DATA_DIR / 'jobs'
BLOBS_DIR = DATA_DIR / 'blobs'
CORRECTIONS_DIR = Path(os.environ.get('CORRECTIONS_DIR', DATA_DIR / 'corrections'))


def _flag(name: str, default: str = 'true') -> bool:
    return (os.environ.get(name) or default).strip().lower() not in ('0', 'false', 'no', 'off')


def _number(name: str, default, parse=float):
    """A numeric setting, where empty means "not configured".

    Settings arrive through compose, which passes an unset variable as an empty string
    rather than leaving it out - and os.environ.get(name, default) only falls back when the
    key is absent. float('') then ends the process at import, which is how a deployment
    crash-looped on 2026-09-11."""
    raw = (os.environ.get(name) or '').strip()
    return parse(raw) if raw else default


def _folders(name: str) -> tuple[Path, ...]:
    """Comma-separated absolute folders, resolved so a symlinked root is compared by where
    it really is. A relative one ends the process: it would mean wherever the backend
    happened to start, which is no limit at all."""
    folders = []
    for entry in (os.environ.get(name) or '').split(','):
        entry = entry.strip()
        if not entry:
            continue
        if not Path(entry).is_absolute():
            raise ValueError(f'{name} must list absolute folders, not "{entry}"')
        folders.append(Path(entry).resolve())
    return tuple(folders)


SAVE_OCR_DATA = _flag('SAVE_OCR_DATA')

# Which job kinds this deployment offers. Disabling one hides it in the New job picker
# and refuses creation; jobs of that kind that already exist stay fully usable, so
# turning a task off never strands data. All on by default.
ENABLE_TEXT = _flag('ENABLE_TEXT')
ENABLE_MAP_SEGMENTATION = _flag('ENABLE_MAP_SEGMENTATION')
ENABLE_MAP_LINES = _flag('ENABLE_MAP_LINES')


def enabled_tasks() -> list[str]:
    """Task ids this deployment accepts, in the order the picker shows them."""
    return [t for t, on in (('text', ENABLE_TEXT),
                            ('map_segmentation', ENABLE_MAP_SEGMENTATION),
                            ('map_lines', ENABLE_MAP_LINES)) if on]

IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp', '.webp'}
PDF_EXTENSIONS = {'.pdf'}
INGEST_EXTENSIONS = IMAGE_EXTENSIONS | PDF_EXTENSIONS

PDF_RENDER_DPI = _number('PDF_RENDER_DPI', 400, int)
# Upload guards against a runaway file; 0 switches one off. See .env.backend.example.
MAX_ZIP_EXTRACT_GB = _number('MAX_ZIP_EXTRACT_GB', 50, float)
MAX_IMAGE_PIXELS = _number('MAX_IMAGE_PIXELS', 1_000_000_000, int)
# Where a server-path dataset may be read from; empty means anywhere. See .env.backend.example.
INGEST_ROOTS = _folders('INGEST_ROOTS')
PDF_EXTRACT_COVERAGE = _number('PDF_EXTRACT_COVERAGE', 0.9, float)
# IIIF imports; see .env.backend.example.
IIIF_MAX_WIDTH = _number('IIIF_MAX_WIDTH', 6000, int)
IIIF_MAX_PAGES = _number('IIIF_MAX_PAGES', 2000, int)
IIIF_MAX_MB = _number('IIIF_MAX_MB', 50, float)
IIIF_ALLOWED_HOSTS = frozenset(h.strip().lower() for h in (os.environ.get('IIIF_ALLOWED_HOSTS') or '').split(',')
                               if h.strip())

FRONTEND_SECRET = os.environ.get('FRONTEND_SECRET', '')

COCO_EXPORT_DIR = Path(os.environ.get('COCO_EXPORT_DIR', DATA_DIR / 'coco'))
MASK_EXPORT_DIR = Path(os.environ.get('MASK_EXPORT_DIR', DATA_DIR / 'masks'))

LAYOUT_BATCH_SIZE = _number('LAYOUT_BATCH_SIZE', 4, int)
OCR_CHUNK_LINES = _number('OCR_CHUNK_LINES', 512, int)

# Paint out everything outside a line's own polygon before cropping it. A minimum-area
# rectangle is not the line: where the polygon is not a tight rectangle its corners hold the
# neighbours' ink, and the model is handed the row above as part of this line. Measured over
# 379,728 reviewed lines, that is 0.6% of them - the hand-traced polygons, which are also the
# most careful ground truth there is. For the rest the crop comes out byte-identical, and on
# the corpora that do have them it read better or the same, so it is on.
LINE_CROP_MASK = _flag('LINE_CROP_MASK')

# --- LLM pre-annotation -----------------------------------------------------------
# OpenAI-compatible endpoints people register under Settings, used to pre-transcribe
# whole pages. Off removes the feature from the UI and refuses its routes, so a
# deployment holding restricted material can never hand a scan to a third party.
ENABLE_LLM_OCR = _flag('ENABLE_LLM_OCR')
# Encrypts the API keys kept in app.db. Any string - the Fernet key is derived from it.
# Unset means no key can be stored: a keyless endpoint (a self-hosted vLLM, say) still
# works, and anything needing a credential is refused with a clear message rather than
# writing a secret to disk in the clear.
LLM_SECRET_KEY = os.environ.get('LLM_SECRET_KEY', '')
# One page read is a large image and a long generation, and a model routed through a
# broker can sit in its queue for minutes before it starts, so the ceiling is generous.
LLM_TIMEOUT = _number('LLM_TIMEOUT', 600, float)
# Pages read in parallel. Raising it hits provider rate limits before it hits the box.
LLM_MAX_CONCURRENCY = _number('LLM_MAX_CONCURRENCY', 4, int)

TRAININGS_DIR = Path(os.environ.get('TRAININGS_DIR', DATA_DIR / 'trainings'))
EVALS_DIR = Path(os.environ.get('EVALS_DIR', DATA_DIR / 'evaluations'))

# External SLURM cluster for training runs. Unset SLURM_HOST disables the target.
SLURM_HOST = os.environ.get('SLURM_HOST', '')
SLURM_USER = os.environ.get('SLURM_USER', '')
SLURM_PARTITION = os.environ.get('SLURM_PARTITION', '')
SLURM_REMOTE_DIR = os.environ.get('SLURM_REMOTE_DIR', 'deeplabel-trainings')
SLURM_SSH_KEY = os.environ.get('SLURM_SSH_KEY', '')
# Socket for the multiplexed ssh master. A cluster that demands a second factor is
# unlocked once from the training dialog; every later call rides this socket. Empty
# disables multiplexing, which only works where the key alone is accepted.
SLURM_CONTROL_PATH = os.environ.get('SLURM_CONTROL_PATH', '/tmp/deeplabel-slurm.sock')
SLURM_ACCOUNT = os.environ.get('SLURM_ACCOUNT', '')
# A snapshot is hundreds of gigabytes of crops and the cluster is reached over the same
# uplink as everything else. Unthrottled, the push takes the host off the network with it -
# on 2026-09-11 a 160 GB transfer made the machine unreachable to ssh and to the browser.
# rsync's own syntax: '5m' for 5 MiB/s, '1000k', or empty for no limit.
SLURM_RSYNC_BWLIMIT = os.environ.get('SLURM_RSYNC_BWLIMIT', '')
# A ceiling on what one evaluation may hold, enforced by the app rather than by the kernel:
# an unbounded run reached 54 GB on 2026-09-11 and the OOM killer took the machine's
# usability with it. Half the host's memory by default, so the box survives its own jobs.
EVAL_MEMORY_LIMIT_GB = _number('EVAL_MEMORY_LIMIT_GB', 0, float) or None
# Kills a transfer that has stopped moving, not one that is merely long: rsync's --timeout
# counts seconds without I/O, while the wall clock only has to be larger than the biggest
# snapshot a slow link can carry.
SLURM_RSYNC_STALL = _number('SLURM_RSYNC_STALL', 600, int)
SLURM_RSYNC_TIMEOUT = _number('SLURM_RSYNC_TIMEOUT', 86400, float)
SLURM_GRES = os.environ.get('SLURM_GRES', 'gpu:1')


def slurm_gpus(raw: str) -> dict[str, tuple[int, str | None]]:
    """SLURM_GPUS: the cards a run may pick, as name:max[:partition] - the largest count one
    node has, and the partition the card lives on when it is not SLURM_PARTITION."""
    cards = {}
    for entry in filter(None, (part.strip() for part in raw.split(','))):
        fields = entry.split(':')
        if len(fields) not in (2, 3) or not fields[1].isdigit() or int(fields[1]) < 1:
            raise ValueError(f'SLURM_GPUS entry {entry!r} is not name:max[:partition]')
        cards[fields[0]] = (int(fields[1]), fields[2] if len(fields) == 3 else None)
    return cards


SLURM_GPUS = slurm_gpus(os.environ.get('SLURM_GPUS', ''))
SLURM_TIME = os.environ.get('SLURM_TIME', '')
# How often a cluster run on a model backend that can resume is resubmitted from its last
# checkpoint after hitting SLURM_TIME, before it fails as a timeout.
SLURM_MAX_RESUMES = _number('SLURM_MAX_RESUMES', 3, int)
# The most one job may ask for, whatever its GPU count.
SLURM_CPUS = os.environ.get('SLURM_CPUS', '16')
SLURM_MEM = os.environ.get('SLURM_MEM', '64G')
# What one GPU's rank actually needs. The cluster charges for what a job requests, so
# asking every run for the largest run's share makes a two-GPU job pay for eight GPUs'
# cores and memory. Ranks are what multiply the dataloader workers and the samples they
# stage, so both scale with the GPU count up to the ceilings above.
# A model backend's declared need per GPU replaces these for its runs.
SLURM_CPUS_PER_GPU = _number('SLURM_CPUS_PER_GPU', 12, int)
SLURM_MEM_PER_GPU = os.environ.get('SLURM_MEM_PER_GPU', '128G')

# Map-segmentation pre-annotation model (runner/run_map_job.py). The model code lives in
# the sibling cadastre_segmentation repo (its inference/ package), like the text pipeline's
# Schematismus / DeepOCR / DeepSegment; _spawn_map_runner puts this root on the child's
# PYTHONPATH. Default is the container mount point.
MAPSEG_ROOT = Path(os.environ.get('MAPSEG_ROOT', '/Mapseg')).resolve()
# Torch/SMP/transformers live in a separate interpreter (the app venv is torch-free);
# MAPSEG_PYTHON is None when unset, which the worker reads as "prediction unavailable on
# this host". The venv need not live inside the model repo.
MAPSEG_PYTHON = Path(os.environ['MAPSEG_PYTHON']) if os.environ.get('MAPSEG_PYTHON') else None
# Model registry (models/mapseg/registry.json): the available checkpoints + their class
# vocabularies. A job records which model it used; MAPSEG_CHECKPOINT below is only the
# fallback when the registry is absent or a job has no model.
MAPSEG_REGISTRY = Path(os.environ.get('MAPSEG_REGISTRY', APP_ROOT / 'models' / 'mapseg' / 'registry.json'))
MAPSEG_CHECKPOINT = os.environ.get('MAPSEG_CHECKPOINT',
                                   str(APP_ROOT / 'models' / 'mapseg' / 'cadastre_upernet.pth'))
MAPSEG_BATCH_SIZE = _number('MAPSEG_BATCH_SIZE', 4, int)
MAPSEG_EPSILON = _number('MAPSEG_EPSILON', 2.0, float)    # approxPolyDP tolerance, px
MAPSEG_MIN_AREA = _number('MAPSEG_MIN_AREA', 12, int)     # drop specks below this area, px

# Edge detection for the tile editor's area-detect tool: the annotator selects part of a
# tile and gets traced polylines back. The methods live in the sibling edge_detection_repo
# (its detect/ package) because they need OpenCV and numpy, which this venv does not have;
# the detect route puts this root on the child's PYTHONPATH, like _spawn_map_runner does.
EDGE_DETECT_ROOT = Path(os.environ.get('EDGE_DETECT_ROOT', APP_ROOT / 'edge_detection_repo')).resolve()
# None when unset = "edge detection unavailable on this host" (the MAPSEG_PYTHON convention);
# the tool then says so in the UI instead of failing at the first click.
EDGE_DETECT_PYTHON = Path(os.environ['EDGE_DETECT_PYTHON']) if os.environ.get('EDGE_DETECT_PYTHON') else None
# Which methods exist and what parameters they take (models/edge/registry.json).
EDGE_REGISTRY = Path(os.environ.get('EDGE_REGISTRY', APP_ROOT / 'models' / 'edge' / 'registry.json'))
# One detection is interactive, so it is bounded rather than left to run: the classical
# methods answer in a fraction of a second, and anything needing longer than this is queue
# work rather than a click.
EDGE_DETECT_TIMEOUT = _number('EDGE_DETECT_TIMEOUT', 30, float)


# Model backends (docs/MODEL-BACKENDS.md): every model moves behind HTTP, one service per
# model type. A backend is named here and known by its URL and its own secret, which is
# also what it presents when it fetches weights from this API.
WEIGHTS_DIR = Path(os.environ.get('WEIGHTS_DIR') or DATA_DIR / 'weights')
MODEL_BACKEND_FETCH_URL = (os.environ.get('MODEL_BACKEND_FETCH_URL') or '').rstrip('/')
MODEL_BACKEND_LOAD_TIMEOUT = _number('MODEL_BACKEND_LOAD_TIMEOUT', 1800, float)
MODEL_BACKEND_PREDICT_TIMEOUT = _number('MODEL_BACKEND_PREDICT_TIMEOUT', 600, float)


@dataclass(frozen=True)
class ModelBackend:
    name: str
    url: str
    secret: str
    gpu_group: str
    # The enroot image the backend's training entrypoint runs in on the cluster (6.7),
    # placed there by hand; empty where it does not train on the cluster.
    cluster_image: str = ''


def _model_backends() -> dict[str, ModelBackend]:
    backends = {}
    for name in (os.environ.get('MODEL_BACKENDS') or '').split(','):
        name = name.strip().lower()
        if not name:
            continue
        key = name.upper().replace('-', '_')
        secret = os.environ.get(f'MODEL_BACKEND_{key}_SECRET') or ''
        if not secret:
            raise ValueError(f'MODEL_BACKEND_{key}_SECRET must be set for model backend "{name}"')
        backends[name] = ModelBackend(name, (os.environ.get(f'MODEL_BACKEND_{key}_URL') or '').rstrip('/'),
                                      secret, os.environ.get(f'MODEL_BACKEND_{key}_GPU_GROUP') or 'default',
                                      os.environ.get(f'MODEL_BACKEND_{key}_CLUSTER_IMAGE') or '')
    return backends


MODEL_BACKENDS = _model_backends()


def job_dir(job_id: str) -> Path:
    return JOBS_DIR / job_id


def training_dir(training_id: int) -> Path:
    return TRAININGS_DIR / str(training_id)