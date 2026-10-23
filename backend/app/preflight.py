import bisect
import heapq
import json
import math
import statistics
import threading
import unicodedata
from collections import defaultdict
from functools import partial
from itertools import combinations

from app import (augmentations, characters, config, layout_templates, linecrop, registry, remote_training, store,
                 train_snapshot, trainer)
from app.backend_client import BackendError
from app.training import MIN_SIDE

SPLITS = ('train', 'val', 'test')
UNITS = {'ocr': 'lines', 'layout': 'boxes', 'lines': 'lines'}

RARE_BELOW = 5
# A line holding this many times the median text per crop length is two lines' text on
# one crop, or a crop cut short.
RUN_ON_FACTOR = 3
EXAMPLES = 10
LINES_PER_BIN = 8
DUPLICATES_SHOWN = 20

HEIGHT_EDGES = [8, 16, 24, 32, 48, 64, 96, 128, 192, 256]
WIDTH_EDGES = [64, 128, 256, 512, 1024, 2048, 4096]
ASPECT_EDGES = [1, 2, 4, 8, 16, 32, 64]
CHARS_EDGES = [1, 5, 10, 20, 40, 60, 80, 120]
LINE_EDGES = {'height': HEIGHT_EDGES, 'width': WIDTH_EDGES, 'aspect': ASPECT_EDGES,
              'chars_per_line': CHARS_EDGES}

FLAG_ORDER = ('rare', 'split_only', 'lookalike', 'odd', 'mixed_forms', 'new_to_base')

# Cyrillic and Greek letters drawn like a Latin one. Flagged only where the Latin letter
# also occurs, so a corpus written in Cyrillic is not flagged throughout.
CONFUSABLES = {
    'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H',
    'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'І': 'I',
    'Ј': 'J', 'Ѕ': 'S', 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p',
    'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's',
    'ԁ': 'd', 'һ': 'h', 'ԛ': 'q', 'ԝ': 'w',
    'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I',
    'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T',
    'Υ': 'Y', 'Χ': 'X', 'ο': 'o', 'ν': 'v',
}

ODD_CATEGORIES = {
    'Cc': 'a control character - remove it',
    'Cf': 'an invisible formatting character - remove it',
    'Co': 'a private-use codepoint, which fonts draw differently - map it to a standard character',
    'Cn': 'an unassigned codepoint - replace it',
    'Cs': 'a lone surrogate - replace it',
}


def input_size(conn, request: dict) -> tuple[int | None, int | None]:
    """The height an OCR model scales a crop to and the widest it takes, as its backend
    reported them: the base model's, else the task's default model's."""
    if request.get('task', 'ocr') != 'ocr':
        return None, None
    base = registry.get_model(conn, request['base_model_id']) if request.get('base_model_id') else None
    for model in (base, registry.default_model(conn, 'ocr')):
        if model is not None and model['target_height'] and model['max_width']:
            return model['target_height'], model['max_width']
    return None, None


def default_epochs(conn, task: str, base_model_id: int | None) -> int | None:
    """The epochs an untuned run trains for, as its model backend declares them."""
    try:
        client = remote_training.training_backend(conn, {'task': task, 'base_model_id': base_model_id})
        return client.info()['train'].get('default_epochs')
    except (remote_training.CannotTrain, BackendError):
        return None


def train_counts(conn, model_id: int | None) -> dict[str, int] | None:
    """How often each character occurred in the material the model was trained on, from
    the pre-flight of the run that made it; None when it was not trained here or its run
    kept none."""
    if not model_id:
        return None
    row = conn.execute(
        'SELECT p.result FROM trainings t JOIN training_preflights p ON p.id = t.preflight_id '
        "WHERE t.model_id = ? AND p.status = 'done' ORDER BY t.id DESC LIMIT 1",
        (model_id,)).fetchone()
    if row is None or not row['result']:
        return None
    table = (json.loads(row['result']).get('text') or {}).get('characters') or []
    return {c['char']: c['train'] for c in table if c.get('train')}


def base_charset(conn, base_model_id: int | None) -> set[str] | None:
    """What the base model was trained on, when that is known."""
    counts = train_counts(conn, base_model_id)
    return None if counts is None else set(counts)


def plural(n: int, one: str, many: str | None = None) -> str:
    return f'{n} {one if n == 1 else (many or one + "s")}'


class Binned:
    """Each line's bar in every distribution it was measured for, kept as counts per pair
    of bars plus the first few lines of each bar - so a bar shows which lines it holds and
    where those fall in the others, in a size that does not grow with the corpus."""

    def __init__(self, edges: dict[str, list[float]]):
        self.edges = edges
        self.values: dict[str, list[float]] = {name: [] for name in edges}
        self.members: dict[str, list[list[dict]]] = {
            name: [[] for _ in range(len(e) + 1)] for name, e in edges.items()}
        self.pairs = {(a, b): [[0] * (len(edges[b]) + 1) for _ in range(len(edges[a]) + 1)]
                      for a, b in combinations(edges, 2)}

    def add(self, where: dict, values: dict[str, float]):
        bins = {}
        for name, value in values.items():
            bins[name] = bisect.bisect_right(self.edges[name], value)
            self.values[name].append(value)
            self.members[name][bins[name]].append(where)
        for (a, b), counts in self.pairs.items():
            if a in bins and b in bins:
                counts[bins[a]][bins[b]] += 1

    def distribution(self, name: str) -> dict | None:
        values = self.values[name]
        if not values:
            return None
        bounds = [0, *self.edges[name], None]
        return {'min': round(min(values), 2), 'median': round(statistics.median(values), 2),
                'max': round(max(values), 2),
                'bins': [{'lo': bounds[i], 'hi': bounds[i + 1], 'n': len(lines),
                          'examples': heapq.nsmallest(LINES_PER_BIN, lines, key=lambda w: w['line_id'])}
                         for i, lines in enumerate(self.members[name])]}

    def joint(self) -> dict[str, dict[str, list[list[int]]]]:
        joint: dict[str, dict] = defaultdict(dict)
        for (a, b), counts in self.pairs.items():
            joint[a][b] = counts
        return dict(joint)


def codepoints(text: str) -> list[str]:
    return [f'U+{ord(c):04X}' for c in text]


def odd_reason(cluster: str) -> str | None:
    if unicodedata.combining(cluster[0]):
        return 'a combining mark with no letter before it - attach it or remove it'
    for char in cluster:
        category = unicodedata.category(char)
        if category in ODD_CATEGORIES:
            return ODD_CATEGORIES[category]
        if category in ('Zs', 'Zl', 'Zp') and char != ' ':
            return 'an unusual space - replace it with an ordinary one'
    return None


class Tally:
    """Lines and pages per dataset and split, and which splits every scan landed in."""

    def __init__(self):
        self.rows: dict[str, dict] = {}
        self.scans: dict[str, dict] = {}

    def add(self, job_id: str, part: str, items: int, page_id: int, content_hash, filename):
        row = self.rows.setdefault(job_id, {s: {'pages': 0, 'items': 0} for s in SPLITS})
        row[part]['pages'] += 1
        row[part]['items'] += items
        if content_hash:
            self.scans.setdefault(content_hash, {'splits': set(), 'pages': []})
            self.scans[content_hash]['splits'].add(part)
            self.scans[content_hash]['pages'].append(
                {'job_id': job_id, 'page_id': page_id, 'filename': filename})

    def section(self, job_order: list[str]) -> dict:
        datasets = [{'job_id': job_id, **self.rows.get(job_id, {s: {'pages': 0, 'items': 0} for s in SPLITS})}
                    for job_id in job_order]
        totals = {s: {'pages': sum(d[s]['pages'] for d in datasets),
                      'items': sum(d[s]['items'] for d in datasets)} for s in SPLITS}
        duplicates = [{'content_hash': content_hash,
                       'splits': [s for s in SPLITS if s in scan['splits']],
                       'pages': scan['pages']}
                      for content_hash, scan in sorted(self.scans.items())
                      if len(scan['splits']) > 1]
        return {'datasets': datasets, 'totals': totals, 'duplicates': duplicates[:DUPLICATES_SHOWN],
                'duplicate_count': len(duplicates)}


class Flagged:
    """A count and the first few lines it counted, so they can be found."""

    def __init__(self):
        self.count = 0
        self.examples: list[dict] = []

    def add(self, example: dict):
        self.count += 1
        if len(self.examples) < EXAMPLES:
            self.examples.append(example)

    def out(self) -> dict:
        return {'count': self.count, 'examples': self.examples}


def job_order(request: dict) -> list[str]:
    order = []
    for field in ('dataset_job_ids', 'valid_job_ids', 'test_job_ids'):
        for job_id in request.get(field) or []:
            if job_id not in order:
                order.append(job_id)
    return order


def _material(conn, request: dict, reader):
    """The run's own selection and split, then its test datasets, through one of the
    snapshot's readers - so the review covers exactly what the cut would take."""
    task = request['task']
    split, job_ids = train_snapshot.splitter(
        conn, task, list(request['dataset_job_ids']), request.get('val_fraction', 0.1),
        request.get('split_strategy', 'uniform'), request.get('valid_job_ids') or [],
        bool(request.get('human_checked_only')))
    yield from reader(conn, job_ids, split)
    yield from reader(conn, request.get('test_job_ids') or [], lambda job_id, key: 'test')


def _ocr_sections(conn, request: dict, tally: Tally) -> tuple[dict, dict, dict, list]:
    target_height, max_width = input_size(conn, request)
    reader = partial(train_snapshot.ocr_pages, human_checked_only=bool(request.get('human_checked_only')))
    binned = Binned(LINE_EDGES)
    densities: list[tuple[float, dict]] = []
    tiny, degenerate, too_wide, empty, run_on = Flagged(), Flagged(), Flagged(), Flagged(), Flagged()
    unknown = 0
    sources = {'person': 0, 'transcription': 0, 'models': 0}
    counts: dict[str, dict] = defaultdict(lambda: dict.fromkeys(SPLITS, 0))
    forms: dict[str, set] = defaultdict(set)

    for job_id, page, part, lines in _material(conn, request, reader):
        included = 0
        for line in lines:
            where = {'job_id': job_id, 'page_id': page['id'], 'line_id': line['id'],
                     'text': line['stored'][:80]}
            if not line['target'].strip():
                empty.add(where)
            if not line['target']:
                continue
            size = None
            if page['width'] and page['height']:
                polygon = [[x * page['width'], y * page['height']] for x, y in json.loads(line['polygon'])]
                size = linecrop.crop_size(polygon, line['orientation'])
                if size is None:
                    degenerate.add(where)
                    continue
            else:
                unknown += 1
            included += 1
            clusters = list(characters.clusters(line['target']))
            sources[{'align': 'transcription', 'llm': 'models'}.get(line['check_source'], 'person')] += 1
            for cluster in clusters:
                key = unicodedata.normalize('NFC', cluster)
                counts[key][part] += 1
                forms[key].add(cluster)
            if size is None:
                binned.add(where, {'chars_per_line': len(clusters)})
                continue
            width, height = size
            binned.add(where, {'height': height, 'width': width, 'aspect': width / height,
                               'chars_per_line': len(clusters)})
            densities.append((len(clusters) * height / width, where))
            if min(width, height) < MIN_SIDE:
                tiny.add(where)
            if target_height and max_width and width * target_height / height > max_width:
                too_wide.add(where)
        if included:
            tally.add(job_id, part, included, page['id'], page['content_hash'], page['filename'])

    if densities:
        usual = statistics.median(d for d, _ in densities)
        for density, where in densities:
            if usual > 0 and density > RUN_ON_FACTOR * usual:
                run_on.add(where)

    crops = {'measured': len(binned.values['height']), 'unknown': unknown,
             'height': binned.distribution('height'), 'width': binned.distribution('width'),
             'aspect': binned.distribution('aspect'),
             'tiny': tiny.out(), 'degenerate': degenerate.out(),
             'too_wide': ({**too_wide.out(), 'target_height': target_height, 'max_width': max_width}
                          if target_height and max_width else None)}
    known = base_charset(conn, request.get('base_model_id'))
    table = _characters(counts, forms, known)
    text = {'chars_per_line': binned.distribution('chars_per_line'), 'empty': empty.out(),
            'run_on': run_on.out(), 'sources': sources, 'characters': table,
            'base_charset_known': known is not None}
    findings = [
        *_flag(degenerate.count, 'degenerate', 'warn',
               f'{plural(degenerate.count, "checked line has", "checked lines have")} a polygon no crop '
               'can be cut from - the snapshot leaves them out'),
        *_flag(tiny.count, 'tiny', 'warn',
               f'{plural(tiny.count, "crop is", "crops are")} under {MIN_SIDE} px on a side - '
               'DeepOCR drops them when it prepares the data'),
        *_flag(too_wide.count, 'too_wide', 'warn',
               f'{plural(too_wide.count, "crop is", "crops are")} wider than the {max_width} px the model '
               f'takes at its {target_height} px input height'),
        *_flag(unknown, 'unmeasured', 'info',
               f'{plural(unknown, "line sits", "lines sit")} on pages of unknown size, so '
               'their crops were not measured'),
        *_flag(empty.count, 'empty_lines', 'warn',
               f'{plural(empty.count, "checked line has", "checked lines have")} no text to train on'),
        *_flag(run_on.count, 'run_on', 'warn',
               f'{plural(run_on.count, "line holds", "lines hold")} over {RUN_ON_FACTOR}x the usual text '
               "for its crop's length - two lines' text on one crop, or a crop cut short"),
    ]
    findings += _character_findings(table)
    return crops, text, binned.joint(), findings


def _characters(counts: dict, forms: dict, known: set | None) -> list[dict]:
    present = set(counts)
    table = []
    for key, per_split in counts.items():
        flags, hints = set(), []
        if 0 < per_split['train'] < RARE_BELOW:
            flags.add('rare')
        if per_split['train'] == 0:
            flags.add('split_only')
            hints.append('valid or test holds it but train never does, so the model cannot learn it')
        latin = CONFUSABLES.get(key)
        if latin and latin in present:
            flags.add('lookalike')
            hints.append(f'looks like Latin {latin} ({codepoints(latin)[0]}) - '
                         'replace it if the hand wrote Latin')
        compatible = unicodedata.normalize('NFKC', key)
        if compatible != key:
            flags.add('lookalike')
            hints.append(f'NFKC: {compatible} ({" ".join(codepoints(compatible))}) - '
                         'replace it if the hand wrote the plain form')
        reason = odd_reason(key)
        if reason:
            flags.add('odd')
            hints.append(reason)
        if len(forms[key]) > 1:
            flags.add('mixed_forms')
            hints.append('stored both precomposed and decomposed - normalise the datasets to one '
                         'form so both count as one character')
        if known is not None and key not in known:
            flags.add('new_to_base')
            hints.append('the base model never trained on it')
        table.append({'char': key, 'codepoints': codepoints(key),
                      'name': ' + '.join(unicodedata.name(c, 'unnamed') for c in key),
                      'total': sum(per_split.values()), **per_split,
                      'flags': [f for f in FLAG_ORDER if f in flags], 'hint': '; '.join(hints)})
    table.sort(key=lambda row: (-row['total'], row['char']))
    return table


def _character_findings(table: list[dict]) -> list[dict]:
    def flagged(flag):
        return sum(flag in row['flags'] for row in table)
    messages = {
        'split_only': ('warn', 'only valid or test holds {n}, so the model never sees {them} in training'),
        'lookalike': ('warn', '{n} look{s} like a plain letter or digit but {are} not - usually a keyboard or OCR slip'),
        'odd': ('warn', '{n} {are} control, invisible, private-use or unusual space codepoints'),
        'mixed_forms': ('warn', '{n} {are} stored both precomposed and decomposed'),
        'new_to_base': ('warn', "{n} never appeared in the base model's training material"),
        'rare': ('info', f'{{n}} appear{{s}} fewer than {RARE_BELOW} times in training'),
    }
    findings = []
    for code, (level, message) in messages.items():
        n = flagged(code)
        words = {'n': plural(n, 'character'), 's': 's' if n == 1 else '',
                 'are': 'is' if n == 1 else 'are', 'them': 'it' if n == 1 else 'them'}
        findings += _flag(n, code, level, message.format(**words))
    return findings


def _flag(count: int, code: str, level: str, message: str) -> list[dict]:
    return [{'code': code, 'level': level, 'message': message[0].upper() + message[1:]}] if count else []


def _layout_classes(conn, request: dict, tally: Tally) -> tuple[list, list]:
    job_ids = list(dict.fromkeys([*request['dataset_job_ids'], *(request.get('test_job_ids') or [])]))
    categories, remap = layout_templates.training_classes(conn, job_ids)
    names = {c['id']: c['name'] for c in categories}
    counts: dict[str, dict] = defaultdict(lambda: dict.fromkeys(SPLITS, 0))
    reader = partial(train_snapshot.layout_images, remap=remap)
    for job_id, part, img, annos, _source, page in _material(conn, request, reader):
        for anno in annos:
            counts[names[anno['category_id']]][part] += 1
        tally.add(job_id, part, len(annos), page['id'] if page else None,
                  page['content_hash'] if page else None, img['file_name'])
    validated = any(row['val'] for row in counts.values())
    classes = []
    for name in sorted(counts, key=lambda n: (-sum(counts[n].values()), n)):
        row = counts[name]
        flags = (['split_only'] if row['train'] == 0
                 else ['unvalidated'] if validated and row['val'] == 0 else [])
        classes.append({'name': name, **row, 'flags': flags})
    split_only = sum('split_only' in c['flags'] for c in classes)
    unvalidated = sum('unvalidated' in c['flags'] for c in classes)
    findings = [
        *_flag(split_only, 'split_only', 'warn',
               f'{plural(split_only, "class appears", "classes appear")} in valid or test but never in train'),
        *_flag(unvalidated, 'unvalidated', 'info',
               f'{plural(unvalidated, "class has", "classes have")} no box in the valid split, so its '
               'score is never measured'),
        *_fresh_head(conn, request, [c['name'] for c in categories]),
    ]
    return classes, findings


def _fresh_head(conn, request: dict, trained: list[str]) -> list[dict]:
    """A base model trained on other classes keeps what it learned of finding regions, but
    not of telling them apart: its classification head starts afresh."""
    if not request.get('base_model_id'):
        return []
    try:
        known = layout_templates.model_classes(conn, request['base_model_id'])
    except Exception:
        return []
    if not known or known == trained:
        return []
    gained = [n for n in trained if n not in known]
    lost = [n for n in known if n not in trained]
    detail = '; '.join(part for part in (
        f'new to it: {", ".join(gained)}' if gained else '',
        f'not in these datasets: {", ".join(lost)}' if lost else '',
        'the same classes in another order' if not gained and not lost else '') if part)
    return [{'code': 'fresh_head', 'level': 'warn',
             'message': 'The base model was trained on other layout classes than these datasets have '
                        f'({detail}). It keeps what it learned of finding regions, but its classification '
                        'head starts afresh: what it knew of telling its own classes apart does not carry over, '
                        'so expect it to need more epochs than a fine-tune on its own classes.'}]


def _segmentation(conn, request: dict, tally: Tally) -> None:
    for job_id, page, part, polys in _material(conn, request, train_snapshot.segmentation_pages):
        tally.add(job_id, part, len(polys), page['id'], page['content_hash'], page['filename'])


def _augmentation_label(conn, request: dict) -> str:
    if request.get('augmentation_pipeline_id') is not None:
        pipeline = augmentations.get_pipeline(conn, request['augmentation_pipeline_id'])
        return pipeline['name'] if pipeline else 'a pipeline that is gone'
    spec = request.get('augmentation')
    if spec is None:
        return "the model's own"
    return 'none' if not (spec.get('transform') or {}).get('transforms') else 'custom'


def _settings(conn, request: dict, train_samples: int) -> dict:
    task = request['task']
    target = request.get('target') or 'local'
    devices = (request.get('gpu_count') or 1) if target == 'slurm' else 1
    scaling = trainer.run_scaling(conn, task, target, request.get('gpu_type'), devices,
                                  request.get('base_model_id'), request.get('batch_size'), request.get('hyperparams'))
    batch = scaling['batch_size']
    epochs = request.get('epochs') or default_epochs(conn, task, request.get('base_model_id'))
    steps = math.ceil(train_samples / (batch * devices * (scaling['grad_accum_steps'] or 1))) if train_samples else 0
    base = registry.get_model(conn, request['base_model_id']) if request.get('base_model_id') else None
    if request.get('split_strategy') == 'holdout':
        validation = f"holdout on {plural(len(request.get('valid_job_ids') or []), 'dataset')}"
    else:
        strategy = 'per dataset' if request.get('split_strategy') == 'stratified' else 'random'
        validation = f"{round(request.get('val_fraction', 0.1) * 100)}% {strategy}"
    return {'base_model': base['name'] if base else None, 'target': target,
            'gpu_type': request.get('gpu_type'), 'devices': devices,
            'batch_size': batch, 'batch_is_default': not request.get('batch_size'),
            'grad_accum_steps': scaling['grad_accum_steps'], 'lr_scale': scaling['lr_scale'],
            'effective_batch': scaling['effective_batch'],
            'epochs': epochs, 'epochs_is_default': not request.get('epochs'),
            'steps_per_epoch': steps, 'total_steps': steps * epochs if epochs else None,
            'validation': validation, 'test_datasets': len(request.get('test_job_ids') or []),
            'human_checked_only': bool(request.get('human_checked_only')),
            'build_lm': bool(request.get('build_lm')),
            'line_shape': trainer.line_shape_for(conn, task, request.get('base_model_id'), request.get('line_shape')),
            'augmentation': _augmentation_label(conn, request),
            'tuned': sorted((request.get('hyperparams') or {}).keys())}


def _split_findings(split: dict, request: dict) -> list[dict]:
    totals = split['totals']
    findings = [
        *_flag(totals['train']['items'] == 0, 'empty_split', 'warn',
               'The train split is empty - there is nothing to train on'),
        *_flag(totals['val']['items'] == 0, 'empty_split', 'warn',
               'The valid split is empty - early stopping has nothing to watch and the '
               'baseline and result evaluations are skipped'),
        *_flag(bool(request.get('test_job_ids')) and totals['test']['items'] == 0, 'empty_split', 'warn',
               'The test datasets hold no checked material for this task'),
    ]
    n = split['duplicate_count']
    return findings + _flag(n, 'duplicates', 'warn',
                            f'{plural(n, "scan sits", "scans sit")} in more than one split, so a score '
                            'is measured on images the model trained on')


def compute(conn, request: dict) -> dict:
    """Everything worth checking before a run starts, over the material it would train
    on. Findings only warn; deciding stays with the person."""
    task = request['task']
    tally = Tally()
    crops = text = classes = joint = None
    findings: list[dict] = []
    if task == 'ocr':
        crops, text, joint, findings = _ocr_sections(conn, request, tally)
    elif task == 'layout':
        classes, findings = _layout_classes(conn, request, tally)
    else:
        _segmentation(conn, request, tally)
    split = tally.section(job_order(request))
    # A recognizer batches line crops; the layout and line models batch whole pages.
    batched = 'items' if task == 'ocr' else 'pages'
    return {'task': task, 'unit': UNITS[task], 'split': split, 'crops': crops, 'text': text,
            'joint': joint, 'classes': classes, 'settings': _settings(conn, request, split['totals']['train'][batched]),
            'findings': _split_findings(split, request) + findings}


_running: set[int] = set()
_running_lock = threading.Lock()
# A form recomputes as settings change, so a burst of requests queues here rather than
# reading the whole corpus several times over at once.
_slots = threading.Semaphore(2)


def _superseded(conn, preflight_id: int) -> bool:
    """A form's review its owner has since replaced with a newer one. A run's own review
    is never replaced: its page shows it."""
    return conn.execute(
        'SELECT 1 FROM training_preflights p JOIN training_preflights newer '
        'ON newer.owner = p.owner AND newer.id > p.id WHERE p.id = ? AND p.id NOT IN '
        '(SELECT preflight_id FROM trainings WHERE preflight_id IS NOT NULL)',
        (preflight_id,)).fetchone() is not None


def _run(preflight_id: int, kept: bool) -> None:
    try:
        with _slots:
            conn = store.connect(config.DB_PATH)
            try:
                row = conn.execute('SELECT request FROM training_preflights WHERE id = ?',
                                   (preflight_id,)).fetchone()
                if not kept and _superseded(conn, preflight_id):
                    conn.execute("UPDATE training_preflights SET status = 'error', error = ? WHERE id = ?",
                                 ('superseded by a newer review', preflight_id))
                    conn.commit()
                    return
                try:
                    result = compute(conn, json.loads(row['request']))
                except Exception as exc:
                    conn.execute("UPDATE training_preflights SET status = 'error', error = ? WHERE id = ?",
                                 (f'{type(exc).__name__}: {exc}', preflight_id))
                else:
                    conn.execute("UPDATE training_preflights SET status = 'done', result = ? WHERE id = ?",
                                 (json.dumps(result), preflight_id))
                conn.commit()
            finally:
                conn.close()
    finally:
        with _running_lock:
            _running.discard(preflight_id)


def request_key(request: dict) -> str:
    return json.dumps(request, sort_keys=True)


def begin(conn, owner: str, request: dict, kept: bool = False) -> int:
    """Store a pre-flight for these settings and compute it in a thread of its own. A kept
    one belongs to a run about to be stored, and is computed whatever review follows it."""
    # Superseded reviews pile up as a form is edited; a day later nobody is reading them.
    conn.execute("DELETE FROM training_preflights WHERE owner = ? AND status != 'running' "
                 "AND created_at < datetime('now', '-1 day') AND id NOT IN "
                 '(SELECT preflight_id FROM trainings WHERE preflight_id IS NOT NULL)', (owner,))
    preflight_id = conn.execute(
        'INSERT INTO training_preflights (owner, task, request) VALUES (?, ?, ?)',
        (owner, request['task'], request_key(request))).lastrowid
    conn.commit()
    with _running_lock:
        _running.add(preflight_id)
    threading.Thread(target=_run, args=(preflight_id, kept), daemon=True).start()
    return preflight_id


def get(conn, preflight_id: int) -> dict | None:
    """The stored pre-flight. One still marked running that no thread here is computing
    was cut off by a restart, and says so rather than spinning forever."""
    row = conn.execute('SELECT * FROM training_preflights WHERE id = ?', (preflight_id,)).fetchone()
    if row is None:
        return None
    with _running_lock:
        orphaned = row['status'] == 'running' and preflight_id not in _running
    if orphaned:
        conn.execute("UPDATE training_preflights SET status = 'error', error = ? WHERE id = ? "
                     "AND status = 'running'",
                     ('interrupted by a restart - go back and review again', preflight_id))
        conn.commit()
        row = conn.execute('SELECT * FROM training_preflights WHERE id = ?', (preflight_id,)).fetchone()
    found = dict(row)
    found['result'] = json.loads(found['result']) if found['result'] else None
    found['request'] = json.loads(found['request'])
    return found


def adopt(conn, preflight_id: int | None, owner: str, request: dict) -> int | None:
    """The pre-flight the form showed, if it was computed for exactly these settings."""
    if preflight_id is None:
        return None
    row = conn.execute('SELECT owner, request, status FROM training_preflights WHERE id = ?',
                       (preflight_id,)).fetchone()
    if row is None or row['owner'] != owner or row['status'] == 'error':
        return None
    return preflight_id if row['request'] == request_key(request) else None
