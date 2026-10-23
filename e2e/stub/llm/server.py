"""A deterministic OpenAI-compatible endpoint for the e2e stack, standing in for a real
provider the way the stub model backend stands in for the models.

What it answers is decided entirely by the model id, so a scenario picks the behaviour it
needs by naming a model: an exact transcription, one with a single word wrong, one with a
line the segmentation never found, a plain-text answer instead of JSON, or a failure.

It also counts the calls it received (GET /_stats, POST /_reset). That is what lets a test
prove a re-alignment cost no API call - the whole point of keeping raw reads.
"""
import json
import threading
import time
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Exactly what the stub runner reads every page as, in element then line order.
OCR_LINES = [f'Sample {cls} line {i}' for cls in ('Header', 'Paragraph') for i in (1, 2, 3)]

TYPO_LINES = [line.replace('Paragraph line 2', 'Paragraf line 2') for line in OCR_LINES]
EXTRA_LINES = [*OCR_LINES, 'Marginal note the segmenter missed']

# The same words in the two Unicode forms a provider may answer in: 'a' with a combining
# mark, and the composed character. Agreement folds that away, and so must anything that
# shows a person where the readers differ.
ACCENTED_LINES = [line.replace('Sample', 'S\u00e4mple') for line in OCR_LINES]
DECOMPOSED_LINES = [unicodedata.normalize('NFD', line) for line in ACCENTED_LINES]

# model id -> (http status, message content). A JSON array is what the prompt asks for;
# 'stub-plain' answers in bare lines instead, which the reader must still understand.
BEHAVIOURS = {
    'stub-perfect': (200, json.dumps(OCR_LINES)),
    'stub-second': (200, json.dumps(OCR_LINES)),
    'stub-typo': (200, json.dumps(TYPO_LINES)),
    'stub-extra': (200, json.dumps(EXTRA_LINES)),
    'stub-composed': (200, json.dumps(ACCENTED_LINES)),
    'stub-decomposed': (200, json.dumps(DECOMPOSED_LINES)),
    'stub-plain': (200, '\n'.join(OCR_LINES)),
    # Reads correctly, but slowly enough that a scenario can watch a run while it is
    # still in flight. Anything about a reading in progress is otherwise untestable:
    # every other model answers before the assertion is made.
    'stub-slow': (200, json.dumps(OCR_LINES)),
    'stub-error': (500, 'the model is overloaded'),
    # Answers with the prompt it was given, so a scenario can assert exactly which wording
    # reached the provider - the only oracle for whose prompt won.
    'stub-echo': (200, ''),
    # A reasoning model: it answers with its working and no transcription until the request
    # turns thinking off, which is what per-model extra fields exist for.
    'stub-thinking': (200, ''),
    # An endpoint whose reasoning cannot be turned off, and which says so with a 400 rather
    # than ignoring the field - what OpenRouter does with Gemini's thinking models.
    'stub-mandatory-reasoning': (200, ''),
}

BAD_KEY = 'bad-key'
SLOW_SECONDS = 15

_lock = threading.Lock()
_calls: dict[str, int] = {}
# What each model was last shown, so a scenario can prove a reference chart reached the
# provider ahead of the page rather than trusting that the client meant to send it.
_images: dict[str, list[str]] = {}


def _thinking_off(request: dict) -> bool:
    """Whether the request carries the switch that quietens a reasoning model. Qwen and
    vLLM spell it this way; the point is that the client passed it through untouched."""
    kwargs = request.get('chat_template_kwargs') or {}
    return isinstance(kwargs, dict) and kwargs.get('enable_thinking') is False


def _images_of(request: dict) -> list[str]:
    """The media types of the pictures in the one user message, in the order sent. The
    page is always the last of them; anything before it is a reference.""" 
    kinds = []
    for message in request.get('messages', []):
        for part in message.get('content', []):
            if isinstance(part, dict) and part.get('type') == 'image_url':
                url = (part.get('image_url') or {}).get('url', '')
                kinds.append(url.split(';', 1)[0].removeprefix('data:'))
    return kinds


def _prompt_of(request: dict) -> str:
    """The text part of the one user message, which is the prompt as sent."""
    for message in request.get('messages', []):
        for part in message.get('content', []):
            if isinstance(part, dict) and part.get('type') == 'text':
                return part.get('text', '')
    return ''


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):  # noqa: A003 - quiet, the container log is for failures
        pass

    def _send(self, status: int, payload: dict):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/_stats':
            with _lock:
                self._send(200, {'calls': dict(_calls), 'total': sum(_calls.values()),
                                 'images': {model: list(kinds)
                                            for model, kinds in _images.items()}})
        elif self.path.rstrip('/') == '/v1/models':
            self._send(200, {'object': 'list',
                             'data': [{'id': name, 'object': 'model'} for name in sorted(BEHAVIOURS)]})
        else:
            self._send(404, {'error': {'message': f'no such path: {self.path}'}})

    def do_POST(self):
        if self.path == '/_reset':
            with _lock:
                _calls.clear()
                _images.clear()
            self._send(200, {'ok': True})
            return
        if self.path.rstrip('/') != '/v1/chat/completions':
            self._send(404, {'error': {'message': f'no such path: {self.path}'}})
            return

        length = int(self.headers.get('Content-Length') or 0)
        request = json.loads(self.rfile.read(length) or b'{}')
        if self.headers.get('Authorization', '').removeprefix('Bearer ') == BAD_KEY:
            self._send(401, {'error': {'message': 'invalid api key'}})
            return

        model = request.get('model', '')
        with _lock:
            _calls[model] = _calls.get(model, 0) + 1
            _images[model] = _images_of(request)
        status, content = BEHAVIOURS.get(model, (400, f'unknown model: {model}'))
        if model == 'stub-slow':
            time.sleep(SLOW_SECONDS)
        if model == 'stub-echo':
            content = json.dumps([_prompt_of(request)])
        if model == 'stub-mandatory-reasoning':
            if 'reasoning' in request:
                self._send(400, {'error': {
                    'message': 'Reasoning is mandatory for this endpoint and cannot be disabled.',
                    'code': 400}})
                return
            content = json.dumps(OCR_LINES)
            self._send(200, {
                'id': 'stub-completion', 'object': 'chat.completion', 'model': model,
                'choices': [{'index': 0, 'finish_reason': 'stop',
                             'message': {'role': 'assistant', 'content': content}}],
                'usage': {'prompt_tokens': 100, 'completion_tokens': 20, 'total_tokens': 120},
            })
            return
        if model == 'stub-thinking' and not _thinking_off(request):
            # Content empty, working in a field of its own - exactly what a vLLM-served
            # reasoning model returns while it is still thinking.
            self._send(200, {
                'id': 'stub-completion', 'object': 'chat.completion', 'model': model,
                'choices': [{'index': 0, 'finish_reason': 'length', 'message': {
                    'role': 'assistant', 'content': None,
                    'reasoning': 'Thinking Process:\n\n1. The user wants a transcription.'}}],
                'usage': {'prompt_tokens': 100, 'completion_tokens': 12, 'total_tokens': 112},
            })
            return
        if model == 'stub-thinking':
            content = json.dumps(OCR_LINES)
        if status != 200:
            self._send(status, {'error': {'message': content}})
            return
        self._send(200, {
            'id': 'stub-completion',
            'object': 'chat.completion',
            'model': model,
            'choices': [{'index': 0, 'finish_reason': 'stop',
                         'message': {'role': 'assistant', 'content': content}}],
            'usage': {'prompt_tokens': 100, 'completion_tokens': len(content.split()), 'total_tokens': 0},
        })


if __name__ == '__main__':
    # Threaded: a scenario polling the call counter must never block the backend's
    # own request, and keep-alive connections make that easy to do by accident.
    ThreadingHTTPServer(('0.0.0.0', 8000), Handler).serve_forever()
