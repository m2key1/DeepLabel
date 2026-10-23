"""The figures an evaluation page shows, computed from its per-line records.

Free of every dependency, config included: the runner imports line_record inside the
model venv, and the app computes everything else from the stored rows."""
import json
import math
import unicodedata
from collections import Counter

from app.characters import clusters

LENGTH_BUCKETS = ((0, 9), (10, 19), (20, 39), (40, 79), (80, None))
CONFUSION_LIMIT = 50


def _alignment(ref, hyp) -> list[tuple[str, object, object]]:
    """One minimal edit script, element by element. On a tie a substitution wins over a
    deletion over an insertion, so the same pair always aligns the same way."""
    rows, cols = len(ref), len(hyp)
    cost = [[0] * (cols + 1) for _ in range(rows + 1)]
    for i in range(rows + 1):
        cost[i][0] = i
    for j in range(cols + 1):
        cost[0][j] = j
    for i in range(1, rows + 1):
        for j in range(1, cols + 1):
            cost[i][j] = min(cost[i - 1][j - 1] + (ref[i - 1] != hyp[j - 1]),
                             cost[i - 1][j] + 1, cost[i][j - 1] + 1)
    ops = []
    i, j = rows, cols
    while i or j:
        if i and j and cost[i][j] == cost[i - 1][j - 1] + (ref[i - 1] != hyp[j - 1]):
            ops.append(('=' if ref[i - 1] == hyp[j - 1] else 's', ref[i - 1], hyp[j - 1]))
            i, j = i - 1, j - 1
        elif i and cost[i][j] == cost[i - 1][j] + 1:
            ops.append(('d', ref[i - 1], None))
            i -= 1
        else:
            ops.append(('i', None, hyp[j - 1]))
            j -= 1
    return ops[::-1]


def _distance(ref, hyp) -> int:
    return sum(op != '=' for op, _, _ in _alignment(ref, hyp))


def char_ops(ref: str, hyp: str) -> list[list[str]]:
    """The character-level diff as [kind, truth, read] segments: runs of agreement merged,
    every edit its own segment so it can be counted and coloured."""
    segments: list[list[str]] = []
    for op, r, h in _alignment(ref, hyp):
        if op == '=' and segments and segments[-1][0] == '=':
            segments[-1][1] += r
            segments[-1][2] += h
        else:
            segments.append([op, r or '', h or ''])
    return segments


def line_record(line_id, job_id, page_id, decode: str, ground_truth: str, prediction: str,
                confidence: float | None) -> dict:
    """What the evaluator writes per scored line, its diff included so nothing aligns twice.
    Both sides are compared composed, so an accent is one character on either side."""
    ground_truth, prediction = unicodedata.normalize('NFC', ground_truth), unicodedata.normalize('NFC', prediction)
    ops = char_ops(ground_truth, prediction)
    distance = sum(op != '=' for op, _, _ in ops)
    length = len(ground_truth)
    cer = distance / length if length else float(distance > 0)
    return {'line_id': line_id, 'job_id': job_id, 'page_id': page_id, 'decode': decode,
            'ground_truth': ground_truth, 'prediction': prediction, 'cer': cer,
            'distance': distance, 'length': length, 'confidence': confidence, 'ops': ops}


def scored_row(record: dict) -> dict:
    """A record with its diff, as it is stored and read back."""
    ops = record.get('ops')
    if isinstance(ops, str):
        ops = json.loads(ops)
    if ops is None:
        ops = char_ops(record['ground_truth'], record['prediction'])
    return {**record, 'ops': ops}


def _ratio(part, whole) -> float | None:
    return part / whole if whole else None


def bag_of_words_errors(ref: str, hyp: str) -> int:
    """Word errors with order ignored: the larger of the words missing and the words added."""
    truth, read = Counter(ref.split()), Counter(hyp.split())
    return max(sum((truth - read).values()), sum((read - truth).values()))


def char_class(char: str) -> str:
    if char.isspace():
        return 'whitespace'
    if char.isdigit():
        return 'digits'
    if char.isalpha() or unicodedata.combining(char):
        return 'letters'
    if unicodedata.category(char)[0] in 'PS':
        return 'punctuation'
    return 'other'


def _edits(rows):
    for row in rows:
        for op, r, h in row['ops']:
            if op != '=':
                yield op, r, h, row


def headline(rows: list[dict]) -> dict:
    chars = sum(row['length'] for row in rows)
    distance = sum(row['distance'] for row in rows)
    words = read_words = word_errors = bow_errors = bow_matched = 0
    for row in rows:
        truth, read = row['ground_truth'].split(), row['prediction'].split()
        words += len(truth)
        read_words += len(read)
        word_errors += _distance(truth, read)
        bow_errors += bag_of_words_errors(row['ground_truth'], row['prediction'])
        bow_matched += sum((Counter(truth) & Counter(read)).values())
    counts = Counter()
    case = 0
    for op, r, h, _ in _edits(rows):
        counts[op] += 1
        if op == 's' and r.lower() == h.lower():
            case += 1
    total = sum(counts.values())
    named = {'substitutions': counts['s'], 'insertions': counts['i'], 'deletions': counts['d']}
    return {
        'lines': len(rows), 'chars': chars, 'words': words,
        'cer': _ratio(distance, chars), 'wer': _ratio(word_errors, words),
        'bow_wer': _ratio(bow_errors, words),
        'bow_precision': _ratio(bow_matched, read_words), 'bow_recall': _ratio(bow_matched, words),
        'edits': {**named, 'total': total,
                  'shares': {k: (v / total if total else 0.0) for k, v in named.items()}},
        'classes': _classes(rows),
        'case_errors': {'count': case, 'share': _ratio(case, counts['s']) or 0.0},
    }


def _classes(rows) -> list[dict]:
    totals, correct = Counter(), Counter()
    for row in rows:
        for op, r, _ in row['ops']:
            for char in r:
                name = char_class(char)
                totals[name] += 1
                correct[name] += op == '='
    order = ('letters', 'digits', 'punctuation', 'whitespace', 'other')
    return [{'name': name, 'total': totals[name], 'correct': correct[name],
             'accuracy': correct[name] / totals[name]} for name in order if totals[name]]


def _example(row) -> dict:
    return {'line_id': row['line_id'], 'job_id': row['job_id'], 'page_id': row['page_id'],
            'ground_truth': row['ground_truth'], 'prediction': row['prediction'],
            'ops': row['ops']}


def confusions(rows: list[dict], limit: int = CONFUSION_LIMIT) -> dict:
    """The most frequent substitutions, insertions and deletions, each with the first line
    it was met on."""
    found = {'s': Counter(), 'i': Counter(), 'd': Counter()}
    examples = {}
    for op, r, h, row in sorted(_edits(rows), key=lambda e: e[3]['line_id']):
        found[op][(r, h)] += 1
        examples.setdefault((op, r, h), row)

    def ranked(op):
        return [{'ref': r, 'hyp': h, 'count': n, 'example': _example(examples[(op, r, h)])}
                for (r, h), n in sorted(found[op].items(), key=lambda kv: (-kv[1], kv[0]))[:limit]]
    return {'substitutions': ranked('s'), 'insertions': ranked('i'), 'deletions': ranked('d')}


def characters(rows: list[dict]) -> list[dict]:
    """Every glyph's error rate beside its frequency in the ground truth. A glyph the model
    wrote where none stood counts as inserted, apart from its rate."""
    totals, errors, inserted = Counter(), Counter(), Counter()
    for row in rows:
        for op, r, h in row['ops']:
            for char in r:
                totals[char] += 1
                errors[char] += op != '='
            if op == 'i':
                inserted.update(h)
    table = [{'char': char, 'class': char_class(char), 'total': totals[char],
              'errors': errors[char], 'rate': _ratio(errors[char], totals[char]),
              'inserted': inserted[char]}
             for char in set(totals) | set(inserted)]
    table.sort(key=lambda c: (-c['errors'], -(c['rate'] or 0), -c['inserted'], c['char']))
    return table


def _scores(rows) -> dict:
    chars = sum(row['length'] for row in rows)
    return {'lines': len(rows), 'chars': chars,
            'cer': _ratio(sum(row['distance'] for row in rows), chars) or 0.0}


def by_length(rows: list[dict]) -> list[dict]:
    buckets = []
    for low, high in LENGTH_BUCKETS:
        held = [row for row in rows if row['length'] >= low and (high is None or row['length'] <= high)]
        if held:
            buckets.append({'bucket': f'{low}-{high}' if high is not None else f'{low}+',
                            **_scores(held)})
    return buckets


def grouped(rows: list[dict], key: str) -> list[dict]:
    groups: dict = {}
    for row in rows:
        groups.setdefault(row[key], []).append(row)
    return sorted(({'key': value, **_scores(held)} for value, held in groups.items()),
                  key=lambda g: (-g['cer'], str(g['key'])))


def calibration(rows: list[dict]) -> list[dict]:
    """Confidence in tenths against how often the line was read exactly."""
    bins: dict = {}
    for row in rows:
        if row['confidence'] is None:
            continue
        tenth = min(9, max(0, math.floor(row['confidence'] * 10 + 1e-9)))
        bins.setdefault(tenth, []).append(row)
    out = []
    for tenth, held in sorted(bins.items()):
        exact = sum(row['distance'] == 0 for row in held)
        out.append({'bin': tenth / 10, **_scores(held), 'exact': exact,
                    'exact_share': exact / len(held),
                    'mean_confidence': sum(row['confidence'] for row in held) / len(held)})
    return out


def frequency(rows: list[dict], train_counts: dict[str, int] | None) -> list[dict]:
    """The test material's characters against the training data's, as shares of each.
    Counted as clusters, the way the training pre-flight counts them."""
    test = Counter()
    for row in rows:
        test.update(clusters(row['ground_truth']))
    test_total = sum(test.values())
    train_total = sum(train_counts.values()) if train_counts else 0
    chars = set(test) | set(train_counts or {})
    table = [{'char': char, 'test': test[char], 'test_share': _ratio(test[char], test_total) or 0.0,
              'train': None if train_counts is None else train_counts.get(char, 0),
              'train_share': None if train_counts is None else (_ratio(train_counts.get(char, 0), train_total) or 0.0)}
             for char in chars]
    table.sort(key=lambda r: (-r['test'], -(r['train'] or 0), r['char']))
    return table
