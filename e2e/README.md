# End-to-end tests

Scenario-based Playwright tests that drive the real stack: the nginx frontend, the
auth service (dev bypass), and the real backend with its queue, database and SSE
streams. Only the models are replaced, by a stub model backend and a stub language model.

## Running

```bash
cd e2e
npm install
npx playwright install chromium

npm run e2e          # headless
npm run e2e:headed   # watch a real browser execute each scenario
npm run e2e:ui       # Playwright UI mode: pick tests, watch live, time-travel steps
```

Every run starts the stack fresh (`compose.e2e.yml`, ports 8090/8001, isolated
volumes) and tears it down afterwards. Set `E2E_KEEP_STACK=1` to keep it running
for faster iteration; `npm run stack:down` removes it.

Running a second stack beside it (two people, or two agents, on one machine) means
remapping its ports, and three variables carry that: `E2E_FRONTEND_URL`,
`E2E_BACKEND_PORT` and `E2E_LLM_PORT`. Set all three - a spec that signs in with a
session cookie has to go through the frontend, so a stale `E2E_FRONTEND_URL` makes
those specs fail against whatever is on 8090 instead of the stack under test.

## How the pipeline runs without a GPU

Every model runs on the stub model backend from the `deeplabel-backends` repository
(`stub/`), built from the clone beside this one (`DEEPLABEL_BACKENDS_ROOT` in `.env` says
where else). It speaks the real contract, so DeepLabel's own pipeline runs: ingest,
renditions, reading order, crops and alignment are the real ones, and only the readings are
stand-ins. The stub finds a Header and a Paragraph box, three lines in each, and reads every
line as `Sample <class> line <n>` with fixed confidences. A page without layout gets the
lines of both boxes, classed Unassigned.

Layout, lines and OCR each have a stub container of their own, because a backend trains one
snapshot kind (`STUB_TRAIN_SNAPSHOT`); each waits 0.3 s per request, so a job's phases can
be watched. A scenario that needs a slower or worse reader imports one with
`importStubModel`: weights reading `stub-slow` take 15 s over every request, `stub-misread`
reads OCR with a fixed cycle of four errors. A dataset named `[slow]` gets the slow reader
from `createJob`, which lets scenarios catch it mid-run (cancel, progress), and a training
run named `[slow]` waits before it starts.

Ingest files a scan another page of the dataset already has as a duplicate, so the helpers
give every seeded page a scan of its own (`scanPng`'s `variant`).

Map jobs are seeded annotation-only (`helpers/map.ts`): with neither tiling nor
prediction enabled, the backend ingests the uploaded tiles in its own worker thread
with pure Pillow, so the tile editor and mask export need no stub runner and no GPU.
Tiling and prediction themselves have no stub yet and are not exercised here; their
geometry, export and migration logic is covered by pytest in `backend/tests/`.

## How LLM pre-annotation runs without a provider

`e2e/stub/llm/server.py` is a deterministic OpenAI-compatible endpoint, published on
port 8002 and reached by the backend as `http://llm:8000/v1`. It runs under the backend
image - the stub is pure stdlib. What it
answers is decided by the model id alone, so a scenario picks the behaviour it needs by
naming a model: `stub-perfect` and `stub-second` return the stub runner's own six lines
verbatim, `stub-typo` gets one word wrong, `stub-extra` adds a line the segmentation
never found, `stub-plain` answers in bare lines instead of JSON, and `stub-error` fails.
`stub-echo` answers with the prompt it was given, which is the only honest oracle for
which wording won, and `stub-thinking` answers with its working and no transcription until
the request carries `chat_template_kwargs.enable_thinking = false`, standing in for a
reasoning model. `stub-slow` reads correctly but takes 15 seconds over it, which is the
only way to look at a run while it is still happening - every other model answers before
the assertion is made. `Bearer bad-key` is rejected with a 401.

It also counts the completions it served (`GET /_stats`, `POST /_reset`), which is how a
scenario proves that re-matching stored reads cost no API call.

## Conventions

- One user journey per spec file; each test seeds its own uniquely named dataset
  through the backend API (`helpers/api.ts`) and never depends on another test.
- Tests authenticate via a session created once in `global-setup.ts`; only
  `auth.spec.ts` starts logged out, because the login bounce is what it tests.
- Fixture scans are generated in-process (`helpers/image.ts`), no binary files in git.
