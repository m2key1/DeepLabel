# Security

Please report a vulnerability privately through GitHub's
[private vulnerability reporting](https://github.com/m2key1/DeepLabel/security/advisories/new),
not as a public issue.

DeepLabel's security rests on a few boundaries worth knowing when you look:

- The backend trusts the identity headers nginx adds and the shared `FRONTEND_SECRET`, so
  its port must only be reachable by the frontend (`BACKEND_BIND`).
- Login is Authentik over OIDC; sessions live in the auth service.
- API tokens act as their owner and never more; a read-only token refuses every write.
