"""How a run turns CTC output into text.

Kept free of every dependency, config included, so the runner can import it inside the
minimal model venv. The mode is a choice, not a consequence: it used to be decided by
whether an LM happened to be configured, which meant a model carrying one ran beam
search while the job, the evaluation and the UI all reported 'rescored'.
"""

# beam    - CTC beam search with the model's KenLM fused in. Needs an LM.
# rescored- CTC beam n-best, reranked by the AR decoder head. Needs a decoder.
# greedy  - CTC argmax. Always available, and the fallback for everything else.
# decoder - the decoder head reads the line itself, its beams reranked by the CTC head. What a
#           subword (token) decoder was trained for. Needs a decoder.
OCR_DECODES = ('beam', 'rescored', 'greedy', 'decoder')

DEFAULT_DECODE = 'beam'

# A dataset may also stand on 'auto': whichever of these suits its model, worked out each
# time it is read (app.auto_decode), so a dataset following the default model reads the
# next default its own best way too. A score is always of one mode, so evaluations never take it.
DATASET_DECODES = ('auto', *OCR_DECODES)
DATASET_DEFAULT = 'auto'


def resolve(decode: str, lm_on: bool, use_decoder: bool) -> str:
    """The mode that will actually run, given what this model carries. A mode whose
    machinery is missing degrades rather than failing, but never silently into
    something the caller could have asked for by name."""
    if decode == 'beam' and not lm_on:
        return 'rescored' if use_decoder else 'greedy'
    if decode in ('rescored', 'decoder') and not use_decoder:
        return 'beam' if lm_on else 'greedy'
    return decode if decode in OCR_DECODES else 'greedy'
