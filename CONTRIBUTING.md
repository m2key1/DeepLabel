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
  `.env.*.example` template and passed through by its compose file. A user-visible change
  also adds its line to the Unreleased section of [CHANGELOG.md](CHANGELOG.md), under
  Added, Changed, Fixed or Removed, with its issue number.
- **Keep the services apart.** The frontend, auth service and backend talk only over HTTP,
  and models run on model backends
  ([deeplabel-backends](https://github.com/m2key1/deeplabel-backends)), never inside the
  backend.
- **Commit messages** are a single imperative subject line ("Keep checked lines when
  re-detecting"), with a short body only when the reason is not obvious from the diff.

## Releasing

Versions follow [semantic versioning](https://semver.org): the major number rises for a
change that needs action from whoever runs or calls DeepLabel (an API or data change that is
not automatic), the minor for new features, the patch for fixes only. To release `X.Y.Z`
from `dev`:

1. Set the version in `backend/pyproject.toml` and `frontend/package.json` (`npm version
   X.Y.Z --no-git-tag-version` in `frontend/` updates the lockfile too); a test fails while
   they differ.
2. In `CHANGELOG.md`, rename Unreleased to `[X.Y.Z] - <date>`, open a new empty Unreleased
   above it, and update the two link references at the bottom.
3. Commit, merge into `main`, tag `vX.Y.Z` and push the tag.
4. Publish the GitHub release with that section as its notes:
   `gh release create vX.Y.Z --title vX.Y.Z --notes-file <the section>`.

## Running the tests

```bash
cd backend && uv run --group dev pytest       # backend unit tests
cd auth && uv run --group dev pytest          # auth service tests
cd client && uv run --group dev pytest        # Python client tests
cd frontend && npm install && npx tsc -b && npx vitest run   # type-check and unit tests
cd e2e && npm install && npx playwright install chromium && npm run e2e   # end-to-end, on the stub stack
```

See [e2e/README.md](e2e/README.md) for running the end-to-end suite beside another stack.
