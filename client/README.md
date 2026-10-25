# DeepLabel client

A dependency-free Python client and CLI for a DeepLabel deployment. Stdlib only, so it
drops into any interpreter - including the minimal model venvs - without pulling a
dependency tree behind it.

## Install

```bash
pip install -e .          # provides the `deeplabel` command
```

Or copy `deeplabel/client.py` next to your script and import it directly.

## Authenticate

Mint a token in the app under **Settings → API tokens**. A token acts as you: it can
never do more than your role allows, and a read-only one is refused every write.

```bash
export DEEPLABEL_URL=https://deeplabel.example.org
export DEEPLABEL_TOKEN=dlp_...
```

Both can also be passed as `--url` and `--token`.

## CLI

```bash
deeplabel jobs                                   # list datasets
deeplabel show <job-id>                          # one dataset as JSON
deeplabel upload "Kurrent 1876" ./scans --wait   # images + any .txt siblings
deeplabel upload "Raw scans" ./scans --no-ocr    # skip pipeline phases
deeplabel upload "Kurrent 1876" ./scans --resume # finish an interrupted upload
deeplabel cancel evaluation 31                   # also dataset, training, llm, groundtruth
deeplabel import "HSA letters" export.zip        # PAGE/ALTO zip with images
deeplabel export <job-id> --format txt --reviewed -o transcript.txt
deeplabel wait <job-id>                          # block until the pipeline settles
deeplabel models

deeplabel corpus <job-id>                        # the corpus a dataset was uploaded with
deeplabel corpus-add <job-id> ./transcriptions   # one .txt per document, any naming
deeplabel cut <job-id>                           # cut the corpus onto the pages
deeplabel reference <job-id>                     # per-page span, anchors and score
deeplabel groundtruth <job-id> --wait            # read each page against its own span
```

## A corpus that is not cut up by hand

Where a transcription exists as whole documents rather than per page - a letter, an entry,
a chapter, each spanning however many leaves it was written on - upload the text files and
let the deployment pair them. The names need nothing in common with the scans; only the
sort order of each side has to be reading order.

```python
dl.upload_documents(job_id, [Path('transcriptions')])   # one .txt per document
dl.cut_reference(job_id)                                # anchors them against the OCR
dl.read_groundtruth(job_id)                             # each page read against its span
dl.wait_groundtruth(job_id)
```

`reference()` reports what each page ended up answerable for, with the anchor count and
score behind its cut - a page with no anchors is where a cut goes wrong quietly, so it is
worth looking at before paying for a reading. What the model returns becomes that page's
ground truth, recorded as machine-made: it fills in corrections and is never marked
reviewed, however exact the match.

## Python

```python
from pathlib import Path
from deeplabel import DeepLabel, DeepLabelError

dl = DeepLabel('https://deeplabel.example.org', 'dlp_...')

job_id = dl.upload('Kurrent 1876', [Path('scans')], gt_autocheck=True)['job_id']
dl.wait(job_id, on_progress=lambda job: print(job['status'], job['phase']))
Path('transcript.json').write_bytes(dl.export(job_id, reviewed_only=True))

try:
    dl.delete_job(job_id)
except DeepLabelError as error:
    print(error.status, error.detail)   # 403 read-only API token
```

`upload()` accepts files or directories, and passes pipeline options straight through
(`run_layout`, `run_lines`, `run_ocr`, `gt_autocheck`, ...).

More than 200 scans (or 512 MB) are sent in parts. The dataset waits as *uploading* until the
last part is in, then starts. If the upload breaks off, run the same command with `--resume`
(or `upload(..., resume=True)`) to send only what is missing. `on_progress(sent, total)` reports
each part.

`cancel_job()`, `cancel_training()` and `cancel_evaluation()` stop a queued or running run;
`cancel_llm_reads()` and `cancel_groundtruth()` drop the readings not yet sent and return how
many.
