import json

from app.align import edit_distance


def corpus_scores(references: list[str], hypotheses: list[str]) -> tuple[float, float]:
    """Corpus-level CER and WER: summed edit distances over summed reference lengths."""
    char_dist = char_len = word_dist = word_len = 0
    for ref, hyp in zip(references, hypotheses):
        char_dist += edit_distance(list(ref), list(hyp))
        char_len += len(ref)
        word_dist += edit_distance(ref.split(), hyp.split())
        word_len += len(ref.split())
    cer = char_dist / char_len if char_len else 0.0
    wer = word_dist / word_len if word_len else 0.0
    return cer, wer


def group_breakdown(references: list[str], hypotheses: list[str], groups: list[str]) -> str | None:
    """Per-dataset scores as JSON, when the scored material spans more than one dataset."""
    named = sorted({g for g in groups if g})
    if len(named) < 2:
        return None
    breakdown = {}
    for group in named:
        idx = [i for i, g in enumerate(groups) if g == group]
        cer, wer = corpus_scores([references[i] for i in idx], [hypotheses[i] for i in idx])
        breakdown[group] = {'cer': cer, 'wer': wer, 'lines': len(idx)}
    return json.dumps(breakdown)
