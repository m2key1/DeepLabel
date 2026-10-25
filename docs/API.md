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
pipeline, maps, models, training, augmentations), `GET /openapi.json` is the machine-readable form -
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

