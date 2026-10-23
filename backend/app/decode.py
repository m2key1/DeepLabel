"""How a run turns CTC output into text.

Kept free of every dependency, config included, so the runner can import it inside the
minimal model venv. The mode is a choice, not a consequence: it used to be decided by
whether an LM happened to be configured, which meant a model carrying one ran beam
search while the job, the evaluation and the UI all reported 'rescored'.
"""

# beam    - CTC beam search with the model's KenLM fused in. Needs an LM.
# rescored- CTC beam n-best, reranked by the AR decoder head. Needs a decoder.
# greedy  - CTC argmax. Always available, and the fallback for everything else.
OCR_DECODES = ('beam', 'rescored', 'greedy')

DEFAULT_DECODE = 'beam'


def resolve(decode: str, lm_on: bool, use_decoder: bool) -> str:
    """The mode that will actually run, given what this model carries. A mode whose
    machinery is missing degrades rather than failing, but never silently into
    something the caller could have asked for by name."""
    if decode == 'beam' and not lm_on:
        return 'rescored' if use_decoder else 'greedy'
    if decode == 'rescored' and not use_decoder:
        return 'beam' if lm_on else 'greedy'
    return decode if decode in OCR_DECODES else 'greedy'
