# API and CLI

Every endpoint the interface uses is open to scripts. The [feature reference](FEATURES.md#api) says what a token may and may not do.

## Tokens and the schema

Mint a token on **your profile → API tokens** - your own, and nobody else's, whatever your
role - then use the same endpoints the interface does:

```bash
export DEEPLABEL_URL=https://deeplabel.example.org
export DEEPLABEL_TOKEN=dlp_...

curl -H "Authorization: Bearer $DEEPLABEL_TOKEN" $DEEPLABEL_URL/api/jobs
```

`GET /docs` renders the full schema grouped by area (datasets, pages, lines, exports,
pipeline, maps, models, training, augmentations, recognition), `GET /openapi.json` is the machine-readable form -
both behind the same login as everything else. Every operation carries a one-line
summary; the endpoints a script leans on (`/api/jobs`, `/api/jobs/{id}`, `/api/models`)
also declare their response shape, and a test keeps those declarations honest against
what the endpoints actually return.

The `client/` directory holds a stdlib-only Python client and its CLI (`pip install -e
client`, or copy `client/deeplabel/client.py` into whatever venv you have):

```bash
deeplabel upload "My volume" ./scans --wait     # images, plus any .txt siblings
deeplabel jobs
deeplabel export <job-id> --format txt -o transcript.txt
deeplabel import "My export" export.zip         # PAGE/ALTO zip

deeplabel corpus-add <job-id> ./transcriptions   # whole-document .txt, any naming
deeplabel cut <job-id>                           # cut the corpus onto the pages
deeplabel reference <job-id>                     # what each page is answerable for
deeplabel groundtruth <job-id> --wait            # read each page against its span
```

```python
import os
from pathlib import Path

from deeplabel import DeepLabel

dl = DeepLabel(os.environ['DEEPLABEL_URL'], os.environ['DEEPLABEL_TOKEN'])
job_id = dl.upload('My volume', [Path('scans')])['job_id']
dl.wait(job_id)
Path('transcript.json').write_bytes(dl.export(job_id, reviewed_only=True))
```

`POST /api/lines/texts` corrects many lines in one request (up to 5000), each as a single
edit would; the lines it could not write come back with the reason:

```bash
curl -H "Authorization: Bearer $DEEPLABEL_TOKEN" -H 'Content-Type: application/json' \
  -d '[{"id": 812, "text": "Lieber Herr Doctor!", "checked": true}, {"id": 813, "text": "Ihr Brief", "revision": 4}]' \
  $DEEPLABEL_URL/api/lines/texts
# {"written": [812], "failed": [{"id": 813, "reason": "edited since revision 4"}]}
```

A read-only token refuses every write with `403 read-only API token`, so it is the safe
thing to paste into a notebook or a CI job. Managing tokens and administering accounts answer
`403 needs a signed-in session, not an API token` whatever the token's owner may do.

## Recognition

Scans in, lines and text out, without a dataset: nothing of a request is stored unless it
asks to keep its pages, or is async and waits on disk for its turn. It needs the **recognize** permission, which admins have and grant
per person - to a viewer too, since it writes nothing. A token made with the access **Recognition only** reaches these routes and
nothing else, which makes it the one to give a service outside; a read-only token may call
them too, as they write nothing, but cannot keep.

- `POST /api/recognize/pages` - whole pages as `files` parts. Each comes back with the
  lines found on it, in reading order, each with its text, confidence and outline in pixels
  of the image (upright, as its EXIF orientation says). `lines` (JSON, by file name) gives
  a page its own outlines to read instead, in the order given.
- `POST /api/recognize/lines` - line images as `files` parts, read as they are, in the
  order sent.
- `GET /api/recognize` - the layout, line and OCR models a request can name (each layout
  model with the template it reads by), the OCR models' decodes and conventions, the
  formats, the limits, and your async requests.
- `GET /api/recognize/{id}` and `DELETE /api/recognize/{id}` - an async request (below).
- `GET /api/recognize/reading` - your request answered at once while it runs, as the Queue
  shows it (`state`: finding regions, finding lines, reading or waiting for the GPU, with
  `lines_read` of `lines_total`), or `null`.

Both take `ocr_model`, `decode` and `convention` (comma-separated); pages also take
`lines_model` and `format`: `page`, `alto`, `hocr` or `txt` add each page's document beside
its lines. Without them the deployment's default models read, the way a new dataset would.

```bash
curl -H "Authorization: Bearer $DEEPLABEL_TOKEN" \
  -F files=@folio_1.jpg -F files=@folio_2.jpg -F format=page \
  $DEEPLABEL_URL/api/recognize/pages
# {"models": {"lines": {"id": 12, "name": "..."}, "ocr": {"id": 38, "name": "...", "decode": "rescored"}},
#  "pages": [{"id": "folio_1.jpg", "width": 2480, "height": 3508, "document": "<?xml ...",
#             "lines": [{"polygon": [[112, 340], [1890, 338], [1891, 402], [113, 404]],
#                        "text": "...", "confidence": 0.97}, ...]}, ...]}
```

With `characters=true`, on either route, each line read also carries the confidence bands
the OCR model read it with, so the doubtful stretches of a line can be marked on its image:
`"characters": [{"x0": 0.12, "x1": 0.15, "confidence": 0.43}, ...]`. A band runs from `x0`
to `x1`, fractions of the line from its start (0) to its end (1) in the direction it was
read, and its confidence is on the line's 0-1 scale. Bands are not paired with the text's
letters - a model may score an accented letter as two - and a model that gives none answers
`null`. The documents stay as they are.

Pages sent with `layout_model=<id>` have their regions found first, by that layout model:
the lines are then found inside each content region and read as that region's. A page
reads as a dataset running that model reads it: by the template the model belongs to,
which says which classes are containers and how the page is ordered - or, for a model
without one, by the default template's classes in the page's own order of leaves and
columns. Each page gains `regions`, the content regions in reading order and then the
containers, and each line the index of the region it was found in; the documents nest
the lines in their regions. Text outside every region is not read, unless the page has
no content region at all: then its lines are found on the whole page, with
`"region": null`. A page the layout model cannot read comes back as an error, like an
unreadable image. `lines` and `layout_model` are not sent together.

```bash
#  "regions": [{"class": "Header", "role": "content", "confidence": 0.94,
#               "polygon": [[110, 210], [1900, 210], [1900, 330], [110, 330]]}, ...],
#  "lines": [{"polygon": [...], "text": "...", "confidence": 0.97, "region": 0}, ...]
```

Pages sent with `keep=<name>` are also filed into your dataset of that name (in any letter
case), or into a new one if no dataset has the name, so their lines can be corrected there
and used for training. They arrive read and unchecked, as a dataset that skips layout holds
them, and nothing of the pipeline runs on them; a new dataset takes the request's models,
decode and convention, so pages added to it in the app later are read the same way. With
`layout_model`, each region is kept as a layout box of the dataset's class for its label,
with its lines, and a new dataset takes the model's template; a region whose label the
dataset has no class for is left out, and its lines go to Unassigned. A scan
the dataset holds already lands as a duplicate, without its lines. The answer says where:
`"kept": {"dataset": "3f9c...", "name": "Letters 1848", "created": true, "pages": 2,
"duplicates": []}`. A name another account holds is refused `409`, as is a dataset that is
queued or running; keeping needs an account that may make datasets and a token that is not
read-only (`403`). Line images have no page to keep.

An image that cannot be read comes back as `{"id": ..., "error": ...}` and the rest of the
request is still answered. One request carries at most 10 pages, 500 lines and 100 MB by
default (`RECOGNIZE_MAX_*` in `.env`), and an account runs one request at a time: a second
is answered `429` with `Retry-After`. The request takes the GPU between the batches of
whatever else runs and shows on the **Queue** page while it does, without its owner.

Each answered request counts towards its account's month: requests, pages, lines read and
GPU time, kept as counts only. An admin can cap an account's lines read per month on the
Admin page's **API usage** tab; once the cap is reached, requests are answered `429` with
the date reading resumes (the 1st of next month, UTC) and `Retry-After` until then. A
request that starts below the cap finishes. `GET /api/recognize` says where the caller
stands: `"usage": {"month": "2026-11", "lines": 1240, "cap": 5000}`.

### Async requests

With `async=true`, either route answers `202` as soon as the files are on the backend's
disk, with the request's id (and a `Location` header to it), and the request waits its turn
in the **Queue** behind the datasets, trainings and evaluations sent before it. It then has
the GPU to itself, reading in batches of the size above, while requests answered at once
still take turns with it batch by batch. Everything an answer at once would refuse - an
unknown model, a bad `lines`, a `keep` name of another account's - is refused when it is
sent. An async request may be larger: 1000 pages, 20000 lines and 2048 MB by default
(`RECOGNIZE_ASYNC_MAX_*`), and an account may have 5 waiting or reading at once
(`RECOGNIZE_ASYNC_PER_ACCOUNT`; one more is answered `429` with `Retry-After`). Requests
answered at once are not held up by an account's async ones.

```bash
curl -H "Authorization: Bearer $DEEPLABEL_TOKEN" \
  -F async=true -F files=@folio_1.jpg -F files=@folio_2.jpg $DEEPLABEL_URL/api/recognize/pages
# 202 {"id": "4be0c1a9d2f3", "status": "queued", "place": 3, "files": 2, "done": 0,
#      "submitted_at": "2026-11-15 10:00:00"}
curl -H "Authorization: Bearer $DEEPLABEL_TOKEN" $DEEPLABEL_URL/api/recognize/4be0c1a9d2f3
# 202 {"id": "4be0c1a9d2f3", "status": "running", "files": 2, "done": 0, ...}
# 200 {"id": "4be0c1a9d2f3", "status": "done", "files": 2, "done": 2, "submitted_at": "...",
#      "started_at": "...", "finished_at": "...", "expires_at": "...", "models": {...}, "pages": [...]}
```

`GET /api/recognize/{id}` answers `202` while the request waits (with its `place` in the
queue) or reads (with the files `done`), and `200` once it finished: with the answer the
same request answered at once would have given, or `"status": "error"` and the `error` that
stopped it. Poll it; nothing calls back. Its scans are deleted once read, and its answer
24 hours after it finished (`RECOGNIZE_KEEP_HOURS`); fetching it does not delete it.
`DELETE` takes a request off the queue, stops one that is reading after the batch it is
on, or deletes a finished one's answer; its owner may, and an admin. A request the backend
stopped under while it read goes on after its last finished batch. The cap is checked when
an async request is sent and again when it starts.

The client splits any number of files into requests of the allowed size and sends them one
after another; with `--async` (`queued=True`) it sends them as async requests of the async
size, as many at a time as the account may have, and waits for them:

```bash
deeplabel recognize pages ./scans --format page -o page-xml/   # one PAGE XML per scan
deeplabel recognize lines ./line-images -o lines.json
deeplabel recognize pages ./volume --async -o volume.json      # waits its turn in the queue
```

```python
answer = dl.recognize_pages([Path('scans')], format='alto')
for page in answer['pages']:
    print(page['id'], len(page['lines']))

sent = dl.submit_pages([Path('volume')])        # one async request: {"id": ..., "place": ...}
answer = dl.wait_recognition(sent['id'])        # its state and, once done, its answer
```
