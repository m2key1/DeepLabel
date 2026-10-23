from urllib.parse import urlsplit

import httpx

from app import config


def _origin(url: str) -> tuple[str, str, int]:
    parts = urlsplit(url)
    return parts.scheme, parts.hostname or '', parts.port or (443 if parts.scheme == 'https' else 80)


def _rerouted(request: httpx.Request, public: str, internal: str) -> httpx.Request:
    """The same request sent to the internal address when it is for the public one. The
    provider builds every URL it answers with from the host it was asked on, so the public
    host and scheme travel along in the headers."""
    scheme, host, port = _origin(public)
    if (request.url.scheme, request.url.host, request.url.port or (443 if scheme == 'https' else 80)) != (scheme, host, port):
        return request
    to_scheme, to_host, to_port = _origin(internal)
    request.url = request.url.copy_with(scheme=to_scheme, host=to_host, port=to_port)
    public_host = urlsplit(public).netloc
    request.headers['Host'] = public_host
    request.headers['X-Forwarded-Host'] = public_host
    request.headers['X-Forwarded-Proto'] = scheme
    return request


class AsyncIssuerTransport(httpx.AsyncBaseTransport):
    def __init__(self, public: str, internal: str, inner: httpx.AsyncBaseTransport | None = None):
        self.public, self.internal = public, internal
        self.inner = inner or httpx.AsyncHTTPTransport()

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        return await self.inner.handle_async_request(_rerouted(request, self.public, self.internal))

    async def aclose(self) -> None:
        await self.inner.aclose()


class IssuerTransport(httpx.BaseTransport):
    def __init__(self, public: str, internal: str, inner: httpx.BaseTransport | None = None):
        self.public, self.internal = public, internal
        self.inner = inner or httpx.HTTPTransport()

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        return self.inner.handle_request(_rerouted(request, self.public, self.internal))

    def close(self) -> None:
        self.inner.close()


def async_transport() -> dict:
    """httpx client keyword arguments that route this service's calls to the provider over
    OIDC_INTERNAL_URL, or nothing when it is unset."""
    if not config.OIDC_INTERNAL_URL or not config.OIDC_ISSUER:
        return {}
    return {'transport': AsyncIssuerTransport(config.OIDC_ISSUER, config.OIDC_INTERNAL_URL)}


def transport() -> dict:
    if not config.OIDC_INTERNAL_URL or not config.OIDC_ISSUER:
        return {}
    return {'transport': IssuerTransport(config.OIDC_ISSUER, config.OIDC_INTERNAL_URL)}
