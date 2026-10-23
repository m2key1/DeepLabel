# Contributing

Issues and pull requests are welcome. For anything larger than a small fix, open an issue
first so the approach can be agreed before the work starts.

- **Branch off `dev`.** `main` is what is deployed and only moves with a release; pull
  requests go to `dev`.
- **Tests in the same change.** A bug fix comes with a regression test that fails without
  it. Pure backend logic gets pytest tests (`backend/tests`, `auth/tests`); user journeys
  get Playwright tests in `e2e/tests`. The commands are below.
- **Docs in the same change.** A user-visible feature is described in
  [docs/FEATURES.md](docs/FEATURES.md); new configuration is explained in the matching
  `.env.*.example` template and passed through by its compose file.
- **Keep the services apart.** The frontend, auth service and backend talk only over HTTP,
  and models run on model backends
  ([deeplabel-backends](https://github.com/m2key1/deeplabel-backends)), never inside the
  backend.
- **Commit messages** are a single imperative subject line ("Keep checked lines when
  re-detecting"), with a short body only when the reason is not obvious from the diff.

## Running the tests

```bash
cd backend && uv run --group dev pytest       # backend unit tests
cd auth && uv run --group dev pytest          # auth service tests
cd client && uv run --group dev pytest        # Python client tests
cd frontend && npm install && npx tsc -b && npx vitest run   # type-check and unit tests
cd e2e && npm install && npx playwright install chromium && npm run e2e   # end-to-end, on the stub stack
```

See [e2e/README.md](e2e/README.md) for running the end-to-end suite beside another stack.
