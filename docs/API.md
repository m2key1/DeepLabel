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

Scans in, lines and text out, without a dataset: nothing of a request is stored. It needs
the **recognize** permission, which admins have and grant per person. A token made with
the access **Recognition only** reaches these routes and nothing else, which makes it the
one to give a service outside; a read-only token may call them too, as they write nothing.

- `POST /api/recognize/pages` - whole pages as `files` parts. Each comes back with the
  lines found on it, in reading order, each with its text, confidence and outline in pixels
  of the image (upright, as its EXIF orientation says). `lines` (JSON, by file name) gives
  a page its own outlines to read instead, in the order given.
- `POST /api/recognize/lines` - line images as `files` parts, read as they are, in the
  order sent.
- `GET /api/recognize` - the line and OCR models a request can name, their decodes and
  conventions, the formats, and the limits.

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

The client splits any number of files into requests of the allowed size and sends them one
after another:

```bash
deeplabel recognize pages ./scans --format page -o page-xml/   # one PAGE XML per scan
deeplabel recognize lines ./line-images -o lines.json
```

```python
answer = dl.recognize_pages([Path('scans')], format='alto')
for page in answer['pages']:
    print(page['id'], len(page['lines']))
```
