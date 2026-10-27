"""Talking to an OpenAI-compatible endpoint. One client covers self-hosted vLLM, Ollama,
LM Studio, OpenRouter, Azure and the compatibility endpoints the large providers publish,
so nothing here knows which vendor is on the other side.

Every failure becomes an LlmError carrying a sentence a person can act on: the message is
shown in the UI and stored on the failed read, so "connection refused" must not surface as
a stack trace.
"""
import base64
from collections.abc import Sequence
import json

import httpx

from app import config

PROBE_TIMEOUT = 15.0


class LlmError(RuntimeError):
    """The endpoint could not be reached, refused us, or answered with something that is
    not a transcription."""


def _headers(api_key: str | None) -> dict:
    return {'Authorization': f'Bearer {api_key}'} if api_key else {}


def _said(response: httpx.Response) -> str:
    body = response.text.strip().replace('\n', ' ')
    return f': {body[:200]}' if body else ''


def _describe(exc: Exception, model: str | None = None) -> str:
    """Why a call failed, in a sentence naming what to change.

    A 404 or 403 means something different once a model is named: the path is known to
    work, because the same connection lists models and reads pages with others, so it is
    that one model the endpoint does not serve or will not let this key use."""
    if isinstance(exc, httpx.TimeoutException):
        return ('the endpoint did not answer in time - a reasoning model can spend the whole '
                'budget thinking, so try turning thinking off in its extra request fields '
                'or raise LLM_TIMEOUT')
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        said = _said(exc.response)
        if status == 403 and model:
            return f'this key may not use {model} - the model needs its own permission (403){said}'
        if status in (401, 403):
            return f'the endpoint rejected the API key ({status}){said}'
        if status == 404 and model:
            return f'the endpoint serves no model called {model} (404){said}'
        if status == 404:
            return 'the endpoint has no such path - check the base URL ends at /v1'
        if status == 429:
            return 'the endpoint is rate limiting this key (429)'
        if status >= 500:
            return f'the provider had a temporary failure ({status}) - try again later{said}'
        return f'the endpoint answered {status}{said}'
    return f'{type(exc).__name__}: {exc}'


NOT_A_MODEL_LIST = 'the endpoint answered something that is not an OpenAI model list'


def probe_failure(exc: Exception) -> str:
    """Why the probe failed, from the status and the exception alone. Any address may be
    probed, so repeating what the endpoint answered would read out internal services."""
    if isinstance(exc, httpx.TimeoutException):
        return 'the endpoint did not answer in time'
    if isinstance(exc, (httpx.UnsupportedProtocol, httpx.InvalidURL)):
        return 'the address is not an http or https URL'
    if isinstance(exc, httpx.TransportError):
        return 'could not connect - check the address'
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        if status in (401, 403):
            return f'the key was refused ({status})'
        if status == 429:
            return 'the endpoint is rate limiting this key (429)'
        if status in (404, 405):
            return f'the endpoint answered {status} - check the address ends at /v1'
        if status >= 500:
            return f'the endpoint answered {status} - the server failed'
        return f'the endpoint answered {status}'
    if isinstance(exc, ValueError):
        return NOT_A_MODEL_LIST
    return 'the probe failed'


def list_models(base_url: str, api_key: str | None) -> list[str]:
    """Model ids the endpoint offers, so the UI can present real choices instead of a
    free-text field. Doubles as the connection test."""
    try:
        response = httpx.get(f'{base_url}/models', headers=_headers(api_key), timeout=PROBE_TIMEOUT)
        response.raise_for_status()
        payload = response.json()
    except Exception as exc:
        raise LlmError(probe_failure(exc)) from exc
    data = payload.get('data') if isinstance(payload, dict) else None
    if not isinstance(data, list):
        raise LlmError(NOT_A_MODEL_LIST)
    return sorted({entry['id'] for entry in data
                   if isinstance(entry, dict) and isinstance(entry.get('id'), str)})


def timeout() -> httpx.Timeout:
    """One page is a large upload and a long generation, so only the connect phase is
    held to a short leash."""
    return httpx.Timeout(config.LLM_TIMEOUT, connect=15.0)


def _content(payload: dict, quietened: bool = True) -> str:
    try:
        choice = payload['choices'][0]
        message = choice['message']
    except (KeyError, IndexError, TypeError) as exc:
        raise LlmError('the endpoint answered without a message') from exc
    content = message.get('content') or ''
    if content:
        return content
    # A reasoning model that has not finished thinking answers with an empty content and
    # its working in a field of its own. Saying so beats storing a blank transcription.
    if message.get('reasoning') or message.get('reasoning_content'):
        # Only worth suggesting where it has not already been tried: an endpoint that
        # refused the switch has had it taken back out, and saying to turn thinking off
        # names the one thing that cannot be done here.
        raise LlmError('the model answered with its reasoning and no transcription - give it '
                       'a higher token ceiling'
                       + (', or turn thinking off in its extra request fields (Qwen and '
                          'vLLM: {"chat_template_kwargs": {"enable_thinking": false}})'
                          if quietened else
                          ': this endpoint refuses to have its thinking turned off, so the '
                          'budget has to cover the thinking as well as the page'))
    if choice.get('finish_reason') == 'length':
        raise LlmError('the answer was cut off at the token ceiling before any text arrived')
    raise LlmError('the endpoint answered with an empty transcription')


# Asked to transcribe a page, a reasoning model answers with its working first and bills
# every token of it. Both spellings are sent: the one a router understands, and the one a
# chat template takes. A model that wants its reasoning back sets the field itself; one
# whose endpoint refuses the field at all sets it to null, which removes it.
NO_REASONING = {'reasoning': {'enabled': False},
                'chat_template_kwargs': {'enable_thinking': False}}


def _merged(body: dict, extra: dict | None) -> dict:
    """The request with a model's own fields folded in. Nothing may displace what the call
    is about - the model, the image and the prompt are not the endpoint's to reinterpret -
    and a field set to null is one the model is saying not to send at all."""
    protected = {'model', 'messages', 'stream'}
    for key, value in (extra or {}).items():
        if key in protected:
            continue
        if value is None:
            body.pop(key, None)
        else:
            body[key] = value
    return body


class _RefusedTheSwitch(Exception):
    """The endpoint rejected the request over the fields that turn reasoning off."""


def _about_reasoning(text: str) -> bool:
    said = text.lower()
    return any(field in said for field in ('reasoning', 'enable_thinking', 'chat_template_kwargs'))


def _ask(base_url: str, api_key: str | None, body: dict) -> dict:
    try:
        response = httpx.post(f'{base_url}/chat/completions', json=body,
                              headers=_headers(api_key), timeout=timeout())
        if (response.status_code == 400 and _about_reasoning(response.text)
                and 'reasoning' in body):
            raise _RefusedTheSwitch(response.text)
        response.raise_for_status()
        return response.json()
    except _RefusedTheSwitch:
        raise
    except Exception as exc:
        raise LlmError(_describe(exc, body.get('model'))) from exc


def _picture(mime: str, data: bytes) -> dict:
    return {'type': 'image_url',
            'image_url': {'url': f'data:{mime};base64,' + base64.b64encode(data).decode()}}


def transcribe(base_url: str, api_key: str | None, model: str, prompt: str,
               image: bytes, temperature: float = 0.0, max_tokens: int | None = None,
               extra: dict | None = None,
               references: Sequence[tuple[str, bytes]] = ()) -> dict:
    """One page, one model, one call. Returns the raw message and what it cost, and never
    interprets the text - parsing into lines is the caller's business, so the exact answer
    is what gets stored.

    Anything the model is being shown - a chart of the glyphs a corpus prints, a specimen
    alphabet - goes between the wording and the page, so a prompt may say 'the first image
    is a reference chart' and be describing where they actually landed.
    """
    message = {
        'role': 'user',
        'content': [
            {'type': 'text', 'text': prompt},
            *(_picture(mime, data) for mime, data in references),
            _picture('image/jpeg', image),
        ],
    }
    body = {'model': model, 'messages': [message], 'temperature': temperature}
    if max_tokens:
        body['max_tokens'] = max_tokens
    quiet = _merged(_merged(dict(body), NO_REASONING), extra)
    quietened = True
    try:
        payload = _ask(base_url, api_key, quiet)
    except _RefusedTheSwitch:
        # Some endpoints serve a model that cannot be quietened and answer 400 rather than
        # ignoring the field. Asking again without it costs nothing - a refused request
        # generates no tokens - and is better than failing a reading over a saving.
        payload = _ask(base_url, api_key, _merged(dict(body), extra))
        quietened = False
    usage = payload.get('usage') or {}
    return {'text': _content(payload, quietened),
            'prompt_tokens': usage.get('prompt_tokens'),
            'completion_tokens': usage.get('completion_tokens')}


FENCE = '```'


def _plain_lines(text: str) -> list[str]:
    return [line.strip() for line in text.splitlines() if line.strip()]


def parse_lines(content: str) -> list[str]:
    """One line of the page per line of the answer, which is what the prompt asks for. A
    JSON array or a {"lines": [...]} object is accepted too, because that is what a model
    returns when it decides to be helpful, and JSON that is neither yields nothing rather
    than a guess."""
    text = content.strip()
    if text.startswith(FENCE):
        # ```json ... ``` - the fence and its language tag are not part of the answer.
        body = text[len(FENCE):].split(FENCE, 1)[0]
        text = body.split('\n', 1)[1].strip() if '\n' in body else body.strip()
    if not text.startswith(('[', '{')):
        # Only a container can be the JSON form. Handing the rest to a JSON parser turns a
        # page whose one line reads "1817" into a number, and then into no lines at all.
        return _plain_lines(text)
    try:
        parsed = json.loads(text)
    except ValueError:
        return _plain_lines(text)
    if isinstance(parsed, dict):
        parsed = parsed.get('lines')
    if not isinstance(parsed, list):
        return []
    return [str(item).strip() for item in parsed if str(item).strip()]
