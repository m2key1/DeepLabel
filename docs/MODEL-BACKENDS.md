# Model backends

Contract version **1.3**. 1.1 added batches per card, gradient accumulation,
learning-rate scaling, the out-of-memory fallback, resuming, declared metrics and the
final evaluation (6.9); 1.2 added builtin weight facts (5.2), `default_epochs` (6.2) and
the trainer's default augmentation stack (7.1); 1.3 added a builtin base for a training
(6.5, 6.6).

A *model backend* is a small HTTP service that wraps one model type, with its own image,
GPU and dependencies. DeepLabel knows a backend only by its URL and a shared secret. It
sends the backend images and gets geometry and text back, serves it the weights to use,
and for a trainable backend ships it training material and takes the new weights back.
DeepLabel itself holds no model code.

The contract's code - the SDK, a template, the contract test suite, a stub backend, and
DeepOCR and Kraken backends as examples - lives in
[deeplabel-backends](https://github.com/m2key1/deeplabel-backends). DeepLabel's side
(client, weight store, remote training) is in `backend/app/`.

Layout, line detection and OCR run and train only on model backends. Map segmentation and
edge detection run on their backend (`mapseg`, `edges`) when one is configured with a URL,
and otherwise in-process under `MAPSEG_PYTHON` and `EDGE_DETECT_PYTHON`. Cutting a map
into tiles always runs in-process under `MAPSEG_PYTHON`.

In this document *DeepLabel* means DeepLabel's API service (`backend/`), and *backend*
always means a model backend.

Contents

2. [The split of responsibilities](#2-the-split-of-responsibilities)
3. [Transport and lifecycle](#3-transport-and-lifecycle)
4. [Predict, per task](#4-predict-per-task)
5. [Weights](#5-weights)
6. [Training](#6-training)
7. [Template, SDK, contract tests, stub](#7-template-sdk-contract-tests-stub)

---

## 2. The split of responsibilities

The rule: **a backend turns pixels into predictions; DeepLabel turns predictions into
annotations.** Everything that touches the database, the dataset vocabulary, reading
order, crop recipes or revisions stays in DeepLabel. A backend never sees the database and
is stateless apart from its weight cache and its running trainings.

| Concern | Owner | Why |
|---|---|---|
| Phase loop, progress counters, cancel, authors, revisions, candidates | DeepLabel | DeepLabel's data model |
| Ingest, PDF materialise, renditions, map tiling | DeepLabel | IO, no model; annotation-only jobs need it without any backend |
| Line crop recipe (`linecrop.crop_line`, mask, orientation) | DeepLabel | the same recipe cuts training snapshots and evaluation material, so predict and train agree |
| Raw label to class and kind, reading order, containers, orphan bucket, row-fragment merge, full-box classes | DeepLabel | dataset semantics |
| Map class selection, polyline reduction (`as_regions`) | DeepLabel | `map_lines` is a DeepLabel concept over a segmentation model |
| Windowed prediction over a map tile, polygonising the mask | backend | needs numpy/cv2 and the model's own window; see 4.6 |
| Decoding (beam, rescored, greedy), KenLM fusion, n-best, per-character confidences | backend | inseparable from the model |
| Batching inside a request, out-of-memory halving | backend | it knows its memory |
| Training snapshot (split, selection, format) | DeepLabel | split rules and checked-only selection are DeepLabel's |
| Training loop, augmentation, LM fitting | backend (its training entrypoint) | model code |
| Slurm submission, ssh session, rsync | DeepLabel | one cluster login, generic for every backend; see 6.7 |
| Weight files | DeepLabel stores and serves them; backends cache them | one source of truth, content-addressed |

---

## 3. Transport and lifecycle

### 3.1 Addressing

A backend is one base URL, for example `http://ocr-backend:9100`. All contract routes sit
under `/v1/`. DeepLabel names each backend; the name is what a model row points at.

```
MODEL_BACKENDS=layout,lines,ocr,mapseg,edges
MODEL_BACKEND_LAYOUT_URL=http://layout-backend:9100
MODEL_BACKEND_LAYOUT_SECRET=...
MODEL_BACKEND_LAYOUT_GPU_GROUP=gpu0
MODEL_BACKEND_LAYOUT_CLUSTER_IMAGE=/path/on/cluster/layout-backend.sqsh
```

`_SECRET` is required for every listed name. `_GPU_GROUP` defaults to `default` (3.9).
`_CLUSTER_IMAGE` is only needed for training on Slurm (6.7). A name listed without a URL
is not used.

One backend may serve several tasks (the stub serves all of them), and several backends
may serve one task (two layout models side by side).

DeepLabel also needs the address at which backends reach *it*, for weights and snapshots:
`MODEL_BACKEND_FETCH_URL` (for example `http://deeplabel-backend:8000`). It is put into
every URL DeepLabel hands a backend, so a backend has no DeepLabel address configured of
its own.

### 3.2 Routes

| Route | Required | Purpose |
|---|---|---|
| `GET /health` | yes | liveness, no auth (container healthchecks) |
| `GET /v1/info` | yes | contract version, tasks, capabilities |
| `POST /v1/weights/load` | yes | make a weights version ready (download, verify, load) |
| `GET /v1/weights/{sha256}` | yes | state of one version; `builtin` for a backend's own weights (5.2) |
| `POST /v1/weights/unload` | yes | free GPU memory (3.9) |
| `POST /v1/predict/{task}` | yes, per declared task | predict a batch |
| `POST /v1/train` and `/v1/train/...` | if `train` | see 6.5 |
| `GET /v1/train/tunables`, `GET /v1/train/augmentations`, `POST /v1/train/augmentations/preview` | if `train` | the training form's tunables, augmentation catalogue and preview (7.1) |
| `POST /v1/export` | if `export` | reserved: convert a weights version to another format; nothing implements it yet |

### 3.3 `GET /health`

```json
{"status": "ok", "contract": "1.3", "busy": 0, "loaded": ["9f2c...e1"]}
```

`status` is `ok`, `starting` (process up, not ready) or `error` (with `message`). `busy`
counts the requests and trainings running now; `loaded` lists the versions in memory.

### 3.4 `GET /v1/info`

```json
{
  "contract": "1.3",
  "name": "deepocr",
  "version": "2026.10.1",
  "model_type": "deepocr",
  "tasks": ["ocr"],
  "capabilities": ["predict", "train", "lm", "nbest"],
  "concurrency": 1,
  "max_request_mb": 64,
  "tasks_detail": {
    "ocr": {
      "batch": {"max_items": 512},
      "decodes": ["beam", "rescored", "greedy"],
      "default_decode": "beam",
      "params": {
        "lm_weight": {"type": "number", "default": 1.5},
        "beam_width": {"type": "integer", "default": 10}
      }
    }
  },
  "weights": {
    "roles": {"weights": "required", "lm": "optional", "lm_dict": "optional"},
    "builtin": false
  },
  "gpu": {"name": "NVIDIA H200", "card": "h200", "count": 1, "memory_gb": 141},
  "train": { "...": "see 6.2" }
}
```

| Field | Meaning |
|---|---|
| `contract` | contract version the backend speaks (`major.minor`) |
| `model_type` | weights family; the load request names the family of the weights, and a backend refuses another with `weights_incompatible` |
| `tasks` | any of `layout`, `lines`, `ocr`, `map_segmentation`, `edges` |
| `capabilities` | `predict` always; optional `train`, `export`, `nbest`, `lm` |
| `concurrency` | requests and trainings the backend runs at once (default 1) |
| `max_request_mb` | request body ceiling; DeepLabel splits batches by count and by bytes |
| `tasks_detail.<task>` | per task: `batch.max_items` (DeepLabel assumes 64 when absent), task params with defaults, and task facts: layout `labels` (raw labels in checkpoint order) and `max_side`; OCR `conventions`; map `input_size`, `classes`; edges `methods` |
| `weights.roles` | files a weights version consists of |
| `weights.builtin` | the backend carries its own weights; requests may omit `weights` (a classical edge detector, a model shipped in its image) |
| `gpu` | optional: the card the backend runs on (6.9) |

Facts that depend on the weights rather than the backend (OCR `target_height`,
`max_width`, whether a decoder head exists, the LM loaded, the `conventions` flags it is
conditioned on; a map checkpoint's class count) come back from `POST /v1/weights/load`,
not from `/info`.

### 3.5 Authentication

Both directions use one header and a per-backend secret:

```
X-Model-Backend-Secret: <MODEL_BACKEND_<NAME>_SECRET>
```

* DeepLabel to backend: every `/v1/` route. A backend rejects a missing or wrong secret
  with `401`. The SDK reads the secret from `MODEL_BACKEND_SECRET`.
* Backend to DeepLabel: the weights and snapshot routes (5.2, 6.4). DeepLabel looks the
  secret up, which identifies the backend (or every name one server is configured under),
  and serves only files of models registered to that backend and snapshots of trainings
  that backend is running. A third-party backend can never pull another backend's weights.

DeepLabel's backend routes live under `/backend-api/v1/` and bypass the frontend's
`X-Frontend-Secret` / `X-Auth-*` identity gate. Secrets are compared in constant time.
Traffic between DeepLabel and a backend on another machine goes over a private network or
TLS (a VPN address or an HTTPS reverse proxy); the contract carries no encryption of its
own.

### 3.6 Timeouts, retries, cancel

| Call | Timeout (DeepLabel side) | Retry |
|---|---|---|
| any call not listed below (`/v1/info`, weight state, training state, progress, cancel, artifact list) | 10 s | |
| `POST /v1/weights/load` | 30 s for the call; then `GET /v1/weights/{sha}` every 2 s for up to `MODEL_BACKEND_LOAD_TIMEOUT` (default 1800 s) | |
| `POST /v1/predict/{task}` | `MODEL_BACKEND_PREDICT_TIMEOUT` (default 600 s per request) | once on a connection error or a retryable error (`503`); once after 2 s on `429` |
| `POST /v1/train` | 30 s | |
| artifact download | `MODEL_BACKEND_PREDICT_TIMEOUT` | |

`/v1/info` is read once per job or request and kept for its duration. DeepLabel does not
call `/health`.

**Cancel.** Predict requests are bounded batches, and DeepLabel checks the job's status
between them, so a cancel costs at most one batch. Cancelling also stops the job's
process, which drops an in-flight request; a backend may stop early when it notices, but
does not have to. Training has an explicit `POST /v1/train/{id}/cancel` (6.5).

**Busy.** A backend at its `concurrency` answers `429` with `Retry-After`. DeepLabel runs
one piece of model work at a time (3.9), so a `429` means another client is using the
backend.

### 3.7 Errors

Any non-2xx response carries:

```json
{"error": {"code": "weights_unavailable", "message": "could not download 9f2c...: 404", "retryable": false}}
```

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `bad_request` | malformed request, unknown param, unknown task |
| 401 | `unauthorized` | secret missing or wrong |
| 404 | `not_found` | unknown training or artifact; a training route on a backend that does not train |
| 409 | `weights_not_loaded` | predict named a version that is not ready (call load first) |
| 409 | `weights_incompatible` | the file is not this backend's `model_type` |
| 413 | `too_large` | over `max_request_mb` or `batch.max_items` |
| 422 | `weights_checksum_mismatch` | the download does not hash to the named sha256 (after one retry) |
| 424 | `weights_unavailable` | DeepLabel could not serve the file |
| 429 | `busy` | at concurrency limit |
| 500 | `internal` | anything else; `message` is shown on the job |
| 503 | `starting`, `out_of_memory` | transient; `retryable: true` |

A failure that concerns one item of a batch (an unreadable image, a crop too small to
read) is not a request error: that item's result carries `"error": {"code", "message"}`
and the others succeed. DeepLabel reads such an OCR item as empty text, a lines item as
no lines, and fails the job on a layout or map item.

### 3.8 Versioning

* The contract version is `major.minor`. Routes carry the major (`/v1/`).
* A minor version only adds: new optional request fields, new response fields, new
  optional routes, new error codes. Receivers ignore fields they do not know, and
  DeepLabel sends a newer optional field only when it is set.
* A breaking change is a new major, served at `/v2/` beside `/v1/` for one release.
* Snapshot formats (6.3) and the progress format (6.6) carry their own version strings.

### 3.9 Several backends on one GPU

On a machine with one card, backends each holding a loaded model would compete for its
memory. So:

* every backend has a **GPU group** (`MODEL_BACKEND_<NAME>_GPU_GROUP`, default `default`);
* DeepLabel runs one piece of model work at a time - jobs, local trainings and
  evaluations share one queue, oldest first;
* before a backend loads a model or starts a training, DeepLabel calls
  `POST /v1/weights/unload` on every other backend of its group (one at the same address is
  the same server, which manages its own memory).

Edge detection predicts without a load, so it never unloads a neighbour.

---

## 4. Predict, per task

### 4.1 Common shape

`POST /v1/predict/{task}` as `multipart/form-data`:

* part `request`, `application/json`, the request below;
* one part per image, `image/png` or `image/jpeg`, named by the item that uses it. Several
  items may name the same part.

```json
{
  "weights": {"sha256": "9f2c...e1", "files": {"lm": "77ab...", "lm_dict": "c01d..."}},
  "params": {},
  "items": [{"id": "1042", "image": "img0"}, {"id": "1043", "image": "img1", "context": {}}]
}
```

`weights` names the version by the sha256 of its `weights` file and its other files by
role; it is `null` for a backend's builtin weights. An item's optional `context` is what
DeepLabel knows about the image beyond its pixels; a backend may use it or ignore it. For
an OCR line crop it is `{"element_class": "Paragraph", "line_index": 0}`, the class of the
element the line sits in and the line's place within it (the same `element_class` the
`page-lines` snapshot carries).

The response is JSON, one result per item, in the request's order, echoing `id`:

```json
{"weights": {"sha256": "9f2c...e1"}, "results": [{"id": "1042", "...": "..."}]}
```

**Coordinates.** All geometry in the contract is normalised to the image *as sent*: `x`
right, `y` down, origin at the top-left corner, values in `[0, 1]`. A box is
`[x0, y0, x1, y1]`, a polygon `[[x, y], ...]` (not closed, the first point is not
repeated). This is what the database stores (`elements.bbox`, `lines.polygon`,
`regions.points`), so DeepLabel can downscale an image before sending it without the
backend knowing, and a backend never needs the original size.

**Confidences** are floats in `[0, 1]`, except the per-character profile, which keeps `c`
as an integer 0 to 100.

### 4.2 How images travel

Images are **sent inline in the predict request**. They are not fetched by the backend
and not shared through a folder.

* A predict image is used once. Inline costs one transfer; a pull would cost a second
  round trip per batch and a DeepLabel route exposing scans to backends.
* The request is self-contained, so the backend stays stateless and testable with `curl`.
* Sizes are bounded: a line crop is tens of kilobytes, a page scan a few megabytes, a map
  tile under one. DeepLabel splits requests to stay under `max_request_mb` and
  `batch.max_items`.
* Pull-by-URL is kept for what is large, reused and worth resuming: weights (5) and
  training snapshots (6.4).

What DeepLabel sends:

| Task | Image | Encoding |
|---|---|---|
| layout | the page, scaled to at most 3000 px high | the source file's own bytes when it is an unscaled RGB JPEG or PNG; else PNG |
| lines | the page (`scope: page`) or element crops (`scope: crop`, outside the element's outline painted over) at full resolution | PNG |
| ocr | line crops cut by `linecrop.crop_line` with the deployment's `LINE_CROP_MASK`, at the line's orientation (an unturned vertical line at both directions, the more confident read kept) | PNG (lossless, the format training crops are cut in) |
| map_segmentation | one whole tile | source bytes as for layout |
| edges | the tile | source bytes as for layout |

### 4.3 `layout`

Request `params`: none from DeepLabel; a backend may accept its own, such as
`{"threshold": 0.3}`.

Result per item:

| Field | Type | Notes |
|---|---|---|
| `detections` | list | |
| `detections[].label` | string | the checkpoint's own label (`raw_class_name`), for example `PageNumber` |
| `detections[].bbox` | `[x0,y0,x1,y1]` | normalised |
| `detections[].confidence` | float | stored as `elements.conf` |

DeepLabel maps `label` through the dataset's layout vocabulary to `class_name` and `kind`
(`content` or `container`); a label the dataset has no class for is stored as content
under its own name. Containers are a property of DeepLabel's layout vocabulary, not of
the backend. The backend declares its labels in `/info` (`tasks_detail.layout.labels`),
which the dataset's label map is built from. DeepLabel's reading-order rules order the
boxes and snap the containers.

### 4.4 `lines`

Request `params`: `{"scope": "page"}` or `{"scope": "crop"}`, saying whether the image is a
whole page or an element crop (default `page`), plus optional backend params such as
`box_type`.

Result per item:

| Field | Type | Notes |
|---|---|---|
| `lines` | list | |
| `lines[].polygon` | `[[x,y],...]` | normalised to the image sent; any polygon |
| `lines[].confidence` | float or null | not stored; reserved |

There is one schema for both line modes. In `per_crop` mode DeepLabel sends element crops,
maps each crop's polygons back to page coordinates and merges row fragments; in `per_page`
mode it sends the page and routes each line to the tightest element, with an orphan bucket
for the rest. Re-detecting the lines of changed elements always uses crops. Full-box
classes (a page number) are not sent at all.

### 4.5 `ocr`

Request:

```json
{
  "weights": {"sha256": "9f2c...e1", "files": {"lm": "77ab...", "lm_dict": "c01d..."}},
  "params": {"decode": "beam", "convention": {"long_s": true}, "lm_weight": 1.5, "beam_width": 10, "nbest": 0},
  "items": [{"id": "88120", "image": "img0", "context": {"element_class": "Paragraph", "line_index": 0}}]
}
```

| Param | Meaning |
|---|---|
| `decode` | `beam` (CTC beam with the version's KenLM), `rescored` (CTC n-best reranked by the AR decoder), `greedy`; the dataset's decode choice |
| `convention` | `{flag: true}`: the transcription-convention flags the dataset asks for. A flag the version does not list in its `conventions` fact is ignored, not an error; `{}` reads normalized |
| `lm_weight`, `beam_width` | optional; DeepLabel leaves them to the backend's defaults |
| `nbest` | `0` (default): no alternatives. `k > 0`: return up to `k` alternatives (capability `nbest`) |

The LM files belong to the weights version (5.1): a request never combines a model with
another model's LM.

Response:

```json
{
  "weights": {"sha256": "9f2c...e1"},
  "decode": "rescored",
  "conventions": ["long_s"],
  "results": [{
    "id": "88120",
    "text": "Anno 1754 den 3. May",
    "confidence": 0.93,
    "conf_profile": [{"x0": 0.0, "x1": 0.041, "c": 98}],
    "alternatives": [{"text": "Anno 1754 den 3. Mai", "score": -4.21}]
  }]
}
```

| Field | Notes |
|---|---|
| `decode` | the mode that actually ran: asking for `beam` on a version without an LM yields `rescored` or `greedy`. DeepLabel writes `#greedy` into the author when it asked for greedy |
| `conventions` | the flags the read honoured, in the version's order; DeepLabel stores them on the dataset (`jobs.ocr_convention_read`) and shows them in its model dialog |
| `text` | composed to NFC and stripped by DeepLabel before storing |
| `confidence` | `lines.confidence` |
| `conf_profile` | `lines.conf_profile`: one band per character, `x0`/`x1` as a fraction of the crop width, `c` 0 to 100 |
| `alternatives` | only with `nbest > 0`; not stored |

The OCR backend returns the batch in request order even when it sorts by width
internally.

### 4.6 `map_segmentation`

**Windowing happens in the backend.** DeepLabel sends whole tiles; the backend slides its
own window over them and polygonises the mask. The window is the model's input size, which
the backend knows; returning per-window masks would put numpy and cv2 into DeepLabel's
torch-free app; and it is one request per tile instead of up to nine. The SDK's `windows`
helper gives every map backend the same quarter-overlap, nearest-middle stitching.

Request `params`:

| Param | Meaning |
|---|---|
| `class_ids` | the drawable classes to extract: the job's classes intersected with the model's |
| `epsilon` | polygon simplification in pixels (`MAPSEG_EPSILON`) |
| `min_area` | smallest region kept, in pixels (`MAPSEG_MIN_AREA`) |

Result per item:

| Field | Type | Notes |
|---|---|---|
| `regions` | list | |
| `regions[].class_id` | int | the weights' class id |
| `regions[].points` | `[[x,y],...]` | outer ring, normalised to the tile |
| `regions[].holes` | `[[[x,y],...]]` | inner rings |

`map_lines` is not a separate model task: DeepLabel calls the same segmentation backend,
puts every surface on the job's one line class and reduces it to its outline
(`line_geometry.as_regions`). Results are stored as unreviewed regions authored
`model:mapseg@<model name>`.

Map models come from `models/mapseg/registry.json`. `python -m app.weights import-existing`
turns each entry into a model row (`source` `registry`, its registry id as `models.ref`, its
`classes` and `input_size`) and stores its checkpoint. A map job names its model by
registry id and is predicted on the `mapseg` backend when that row's backend is configured
with a URL; otherwise it runs in-process.

### 4.7 `edges`

Interactive, synchronous, one tile per request, with the backend's builtin weights.

```json
{"weights": null, "params": {"method": "centreline", "method_params": {"block_size": 21}, "area": [[0.1,0.1],[0.6,0.1],[0.6,0.5],[0.1,0.5]]},
 "items": [{"id": "tile", "image": "img0"}]}
```

`area` is the selected ring, normalised to the tile. `method_params` carries each of the
method's params at its declared default.

Result: `{"id": "tile", "polylines": [[[x, y], ...], ...]}` normalised. DeepLabel drops a
malformed polyline rather than the whole answer, and stores the rest as unreviewed
`polyline` regions authored `model:edge@<method>`. `/info` lists the methods under
`tasks_detail.edges.methods` as `{id, label, params, needs_weights}`, each param with its
`default`.

When no `edges` backend is configured with a URL, DeepLabel runs the detector in-process
under `EDGE_DETECT_PYTHON`, with its methods from `models/edge/registry.json`.

---

## 5. Weights

### 5.1 A weights version

Every model row in DeepLabel's registry is one *weights version*: a set of files
identified by content.

| File role | Example | Who uses it |
|---|---|---|
| `weights` | `best_model.pt`, `checkpoint_best_ema.pth` | every backend |
| `lm`, `lm_dict` | `domain.bin`, `domain.dict` | OCR with KenLM |
| `config` | an optional JSON or YAML the backend needs beside the weights | any |

The version's identity is the sha256 of its `weights` file; the other files are named by
their own sha256 in the request. Content addressing means a cache can never confuse two
versions, one LM shared by several models is downloaded once, and storing the same file
twice is a no-op.

DeepLabel stores files content-addressed under `WEIGHTS_DIR/<sha[0:2]>/<sha>` (default
`DATA_DIR/weights`) and records them:

```sql
CREATE TABLE IF NOT EXISTS model_files (
    model_id INTEGER NOT NULL REFERENCES models(id),
    role TEXT NOT NULL,              -- weights | lm | lm_dict | config
    filename TEXT NOT NULL,          -- original name, for authors and downloads
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    PRIMARY KEY (model_id, role)
);
-- models: backend TEXT       (backend name; NULL = the task's backend)
--         model_type TEXT    (weights family, sent with every load)
--         classes TEXT       (map classes JSON with priority; a layout model's learned classes)
--         input_size INTEGER (map window)
--         ref TEXT           (map registry id)
```

`models.checkpoint`, `lm_path` and `lm_dict_path` keep the path a file was registered
from; prediction reads only the store. Model ids are never renumbered:
`jobs.model_*_id`, `trainings.base_model_id`, `evaluations.model_id` and revision authors
keep pointing where they did.

A model row with no `backend` belongs to the backend named after its task: `layout`,
`lines`, `ocr`, `mapseg` for map segmentation, `edges`. A fine-tune inherits its base's
`backend`. A file shared by several models is stored once; deleting a training's model
drops its file records and every stored file no other model still uses. Map rows are not
listed by `/api/models`, whose pickers are the text pipeline's.

A model row resolves to a call as:

```
models row -> backend name (models.backend, else the task's backend)
           -> MODEL_BACKEND_<NAME>_URL / _SECRET
           -> weights: {sha256 of role weights, files: {role: sha256}, urls}
```

### 5.2 DeepLabel's file routes

| Route | Purpose |
|---|---|
| `GET /backend-api/v1/files/{sha256}` | the bytes of one file |
| `HEAD /backend-api/v1/files/{sha256}` | size and digest without the body |
| `GET /backend-api/v1/models/{model_id}/manifest` | `{model_id, name, task, model_type, backend, files: [{role, filename, sha256, size, url}]}` |

The file route:

* sends `Content-Length`, `ETag: "<sha256>"`, `Repr-Digest: sha-256=:<base64>:`,
  `Accept-Ranges: bytes`;
* answers `Range: bytes=<from>-` with `206 Partial Content`, so a multi-gigabyte download
  that broke resumes where it stopped;
* streams from disk without reading the file into memory;
* checks the caller's secret against the file's models (3.5), else `404` (not `403`, so a
  backend cannot probe which files exist).

The load request carries the URLs, so a backend needs nothing but the secret:

```json
POST /v1/weights/load
{
  "sha256": "9f2c...e1",
  "model_type": "deepocr",
  "files": {
    "weights": {"sha256": "9f2c...e1", "size": 2147483648, "url": "http://deeplabel-backend:8000/backend-api/v1/files/9f2c...e1"},
    "lm":      {"sha256": "77ab...",   "size": 512000000,  "url": ".../files/77ab..."},
    "lm_dict": {"sha256": "c01d...",   "size": 2048,       "url": ".../files/c01d..."}
  }
}
```

`model_type` is the model row's, else the backend's own. Answer
`200 {"state": "loaded", "facts": {...}}` when it is ready, else
`202 {"state": "downloading"}`. `GET /v1/weights/{sha256}` reports:

```json
{"state": "downloading", "bytes": 1200000000, "total": 2659000000}
{"state": "loaded", "facts": {"target_height": 256, "max_width": 6144, "has_decoder": true, "lm_loaded": true, "conventions": ["long_s", "oblique_hyphen"]}}
{"state": "error", "error": {"code": "weights_checksum_mismatch", "message": "...", "retryable": false}}
```

States: `absent`, `downloading`, `cached` (on disk, not in memory), `loading`, `loaded`,
`error`. DeepLabel calls load at the start of every phase that needs a model, polls until
`loaded`, stores the OCR `facts` on the model row (`target_height`, `max_width`,
`conventions`), and only then sends predict requests. A predict for a version that is not
loaded is refused with `409 weights_not_loaded` rather than blocking a request for minutes.

A backend with `weights.builtin` answers `GET /v1/weights/builtin` by loading its own
weights if it has not yet and reporting them the same way, so a model with no files of its
own still has its facts stored.

### 5.3 The backend's cache

The SDK implements these rules, so a backend author writes none of them:

* Disk cache in `MODEL_CACHE_DIR` (default `/cache`; the backend's own volume, never
  shared), files named by sha256.
* A download writes `<sha>.part`, resumes it with `Range` after a failure, hashes while
  writing, and renames to `<sha>` only when the hash matches. A mismatch deletes the part,
  retries once from zero, then reports `weights_checksum_mismatch`.
* Concurrent loads of one version share one download.
* Disk budget `MODEL_CACHE_MAX_GB` (default 50): least recently used files that are not
  loaded are deleted first. A loaded version is never deleted.
* Memory: at most `MODEL_MAX_LOADED` versions loaded (default 2), least recently used
  unloaded first, never one that is serving a request.
* `POST /v1/weights/unload {"sha256": ...}` (or `{}` for all) frees GPU memory now, and
  `MODEL_IDLE_UNLOAD_SECONDS` (default 0 = never) unloads after idling.
* `MODEL_DEVICE` (default `auto`) picks the device `load` is given.
* The cache survives restarts.

### 5.4 Missing or broken weights

| Where | What happens |
|---|---|
| Model has no stored `weights` file (and the backend has no builtin) | DeepLabel fails the job before calling the backend: "model *N* has no files in the weight store - run python -m app.weights import-existing" |
| File recorded but gone from DeepLabel's disk | the file route answers `404`; the backend reports `weights_unavailable` and the job fails |
| Backend cannot download (network) | `weights_unavailable`, the job fails naming the model and the backend |
| Checksum mismatch | `weights_checksum_mismatch` after one retry |
| Wrong family | `weights_incompatible` from the backend |
| Model's backend not configured with a URL | the job fails: "the *ocr* model (*N*) is not on a configured model backend" |
| Backend down | the job fails with `unreachable: model backend "ocr" at <URL>: <reason>` |

### 5.5 Getting weights into DeepLabel

* Training results come in through 6.8.
* An admin adds a model trained elsewhere with `python -m app.weights import <file> --task
  ocr --name "..." [--backend ocr] [--model-type deepocr] [--lm <bin> --lm-dict <dict>]`
  (source `imported`).
* `python -m app.weights import-existing` stores the files existing model rows point at
  and adds the map registry's models. It prints what it stored, skipped and found missing
  as JSON, and exits 1 when anything was missing.
* A training result goes into the store when it registers. When that copy fails the model
  is registered anyway and the next `import-existing` catches it up.
* `/api/models` lists each model's stored files and the backend it runs on.
* A backend with `weights.builtin` gets one model row per text task it is the task's
  backend for (source `backend`, named `<model_type> (builtin)`) with no files; it becomes
  the task's default when the task has none. DeepLabel asks every configured backend at
  startup, and asks again every 30 s until it answers. Requests for that model omit
  `weights`.

---

## 6. Training

Training is an optional capability and works the same for every task and every trainable
backend, locally and on the cluster. The pieces:

1. DeepLabel cuts a **task-neutral snapshot** (6.3);
2. the backend's image carries a **training entrypoint** with one contract (6.6);
3. that entrypoint runs either inside the backend's container (local, started over HTTP)
   or from the same image on the cluster (Slurm, started by DeepLabel's generic job
   script);
4. it writes **one progress format** (6.6) that the run page charts without knowing the
   task;
5. DeepLabel takes the resulting **weights back over the network** and registers them
   (6.8).

DeepLabel cuts snapshots for `ocr`, `lines` and `layout`. A run trains on its base
model's backend, or for a run from scratch on the task's backend; that backend must list
the task in `train.tasks` and declare the snapshot kind DeepLabel cuts for it.

### 6.1 Flow

```
                 local                                       cluster
DeepLabel  cut snapshot ------------------------------ cut snapshot
           POST /v1/train (snapshot manifest URL)      rsync run directory up
backend    pulls snapshot over HTTP                    sbatch: srun --container-image=<cluster image>
           runs entrypoint in its container                   runs the same entrypoint
           progress.jsonl                              progress.jsonl
DeepLabel  GET /v1/train/{id}/progress                 rsync progress.jsonl + log tail per poll
           GET /v1/train/{id}/artifacts/{name}         rsync output/ back
           register_result (weights into the store, model row, evaluations)
```

### 6.2 What a trainable backend declares

```json
"train": {
  "tasks": ["ocr"],
  "snapshot": "ocr-lines/1",
  "entrypoint": ["deeplabel-train"],
  "image": "deepocr-backend:2026.10.1",
  "resources": {
    "gpus": {"min": 1, "max": 8, "multi_gpu": true},
    "cpus_per_gpu": 12,
    "memory_per_gpu_gb": 128,
    "shm_gb": 8,
    "batch_by_gpu": {"h200": 76, "rtx6000bb": 50, "l40s": 22},
    "default_batch": {"local": 8, "cluster": 22},
    "effective_batch": 64,
    "preferred_gpu": "h200"
  },
  "tunables": [
    {"key": "learning_rate", "role": "learning_rate", "label": "Learning rate", "group": "Schedule",
     "kind": "float", "help": "...", "above": 0, "default": 0.0003, "env": "TRAIN_LR"}
  ],
  "augmentation": {"library": "albumentations", "version": "1.4.24", "targets": ["image"]},
  "metrics": [{"key": "cer", "label": "CER", "unit": "fraction", "better": "lower", "headline": true}],
  "default_epochs": 20,
  "outputs": ["weights", "lm", "lm_dict"],
  "resume": true
}
```

`entrypoint` is reported by the SDK already wrapped in the out-of-memory fallback (6.9).
`image` names the backend's image; on the cluster DeepLabel runs the `.sqsh` file
configured as `MODEL_BACKEND_<NAME>_CLUSTER_IMAGE` (6.7).

`default_epochs` is what a run that names no epochs trains for; the training form shows it
as the Epochs placeholder.

A `lines` backend may also declare `line_shape`, the shape its lines are cut as when a run
names none: `polygon` (as drawn), `rotated` (the smallest rectangle round the line, at any
angle) or `box` (the upright one). A run chooses its own in the training form. A backend
that declares none trains on polygons. A detector that learns a shrunk core of every line
(DB-style) does better with `rotated`: the shrink falls apart on an outline that steps
around ascenders and word gaps.

The training form renders whatever the backend declares - tunables, their groups and
defaults, the augmentation catalogue - the same way the run page renders whatever metrics
arrive.

### 6.3 Snapshot formats

DeepLabel cuts the snapshot from checked material only, split per page by content hash
(uniform, stratified or holdout; optionally human-checked only), and writes it in the
canonical format of the task's *kind*. A backend that wants its trainer's native layout
converts in its entrypoint.

Every snapshot has `manifest.json` at its root:

```json
{
  "format": "deeplabel-snapshot/1",
  "kind": "ocr-lines",
  "kind_version": 1,
  "task": "ocr",
  "training_id": 412,
  "splits": {"train": 28311, "valid": 3115},
  "groups": {"line_88120": "4b1f0c"},
  "classes": [],
  "files": [{"path": "train/line_88120.png", "sha256": "...", "size": 41233}]
}
```

`groups` maps each item's file stem to the dataset it came from, for per-dataset
validation curves and evaluations. `classes` lists a layout snapshot's category names by
id, empty for other kinds. `splits.test` appears only when the run has a test split.
`files` lists every file with its hash so the snapshot can be transferred and verified
file by file (6.4). `counts.json` sits beside it.

| Kind | Tasks | Layout |
|---|---|---|
| `ocr-lines/1` | `ocr` | `train/`, `valid/`: `line_<id>.png` (crop, recipe v2 with the deployment's mask setting) and `line_<id>.txt` (training target, `characters.training_target`) |
| `page-lines/1` | `lines` | `<split>/images/<stem>.png` and `<split>/lines/<stem>.json`: `{"width", "height", "lines": [{"id", "polygon": [[x,y],...] in pixels, "element_class"}]}`, each polygon already in the run's `line_shape` (6.2) |
| `page-boxes/1` | `layout` | `<split>/images/<file>` and `<split>/_annotations.coco.json` (COCO: `images`, `annotations` with `bbox` `[x,y,w,h]` in pixels, `categories` from the run's layout classes) |
| `map-masks/1` | `map_segmentation`, `map_lines` | `<split>/images/<stem>.png` (tile), `<split>/annotations/<stem>.png` (8-bit class-index mask, priority-painted, polylines stroked at `line_width`) and `<stem>.json` (the `map_export` sidecar, schema 2 for polygons, 3 with `polylines` and `line_width`), plus `class_map.json`; reviewed tiles only |

`page-lines` and `page-boxes` carry a `test/` split holding the run's test datasets when it
has any (6.9). `map-masks/1` is part of the contract and its fixture is in the contract
tests, but DeepLabel does not train map models yet and cuts no map snapshot.

### 6.4 How the snapshot reaches the trainer

* **Local (HTTP).** DeepLabel serves the snapshot read-only:
  `GET /backend-api/v1/trainings/{id}/snapshot/manifest.json` and
  `GET /backend-api/v1/trainings/{id}/snapshot/{path}`, with the same `Range` and secret
  rules as weights, open only to the backend running that training and only while it
  runs. The SDK's `fetch_tree` downloads in parallel (default 8 connections), skips files
  already present with the right size and hash, verifies each against the manifest, and
  writes the manifest to the snapshot's root.
* **Cluster (rsync over ssh).** The whole run directory goes up with `rsync --partial`,
  bandwidth-limited (`SLURM_RSYNC_BWLIMIT`) and resumable, through the cluster ssh
  session. Cluster nodes usually cannot reach DeepLabel, and ssh is network transport, not
  a shared volume. The job script copies the contract manifest into the snapshot's root.

The base weights travel the same way: over HTTP into the backend's cache locally, and
copied into the run directory as `base/<role>` for the cluster.

### 6.5 The training API (local)

| Route | Body / answer |
|---|---|
| `POST /v1/train` | request below; `202 {"train_id": "..."}`. Idempotent on `run.id` + `run.attempt` |
| `GET /v1/train/{train_id}` | `{"train_id", "state": "queued|fetching|running|done|error|cancelled", "phase": "fetching snapshot 812/31426", "error": null, "progress_lines": 418, "log_tail": "..."}` |
| `GET /v1/train/{train_id}/progress?from=<line>` | `application/x-ndjson`: progress lines from that index on |
| `POST /v1/train/{train_id}/cancel` | stops the entrypoint (`SIGTERM`, then `SIGKILL` after 30 s); state `cancelled` |
| `GET /v1/train/{train_id}/artifacts` | the entrypoint's `artifacts.json` with sizes and hashes |
| `GET /v1/train/{train_id}/artifacts/{name}` | the file |
| `DELETE /v1/train/{train_id}` | DeepLabel has stored everything; the backend deletes the run |

```json
POST /v1/train
{
  "run": {"id": 412, "attempt": 1, "name": "Letters finetune", "owner": "alice"},
  "task": "ocr",
  "snapshot": {"manifest_url": "http://deeplabel-backend:8000/backend-api/v1/trainings/412/snapshot/manifest.json"},
  "base_weights": {"sha256": "9f2c...", "files": {"weights": {"...": "as in load"}}},
  "params": {
    "epochs": 30, "batch_size": 8, "gpus": 1,
    "hyperparams": {"learning_rate": 0.0002},
    "augmentation": {"__version__": "1.4.24", "transform": {"...": "albumentations dict"}},
    "build_lm": true
  }
}
```

A run whose base is the backend's builtin sends `"base_weights": {"builtin": true}` with no
files; a run from scratch sends `null`. A local run always has one GPU.

DeepLabel polls state and progress every 2 s and mirrors progress and the log tail into
the run's directory. A backend that stays unreachable for 5 minutes fails the run.

A backend runs one training at a time unless `concurrency` says otherwise, and a training
counts against its `concurrency` (and its GPU group, 3.9) while it runs. A backend restart
loses a running local training: its state comes back as `error` ("backend restarted") and
the run can be retried. Training state, progress and artifacts live in the backend's own
volume until DeepLabel deletes them.

### 6.6 The entrypoint contract (local and cluster alike)

The image's `entrypoint` is run with:

| Env | Meaning |
|---|---|
| `TRAIN_SNAPSHOT` | snapshot directory (read only) |
| `TRAIN_OUTPUT` | output directory (empty, writable) |
| `TRAIN_BASE` | directory with the base version's files by role (`TRAIN_BASE/weights`, `TRAIN_BASE/lm`); for a run on the backend's builtin, only an empty `TRAIN_BASE/builtin`; empty for from scratch |
| `TRAIN_PARAMS` | path of `params.json`: the `params` object of 6.5 plus `task` and `run` |
| `TRAIN_GPUS` | GPUs given; the entrypoint launches one process per GPU itself (`torchrun`) when `multi_gpu` |
| `TRAIN_RESUME` | only when a cluster run is resubmitted after its time limit (6.9): the output directory of the run so far, where the entrypoint finds its last checkpoint and continues from it |

`params.json` is the only source of tunables. The SDK's `train.legacy_env` translates it
into `TRAIN_*` environment variables for train scripts that read those (`TRAIN_EPOCHS`,
`TRAIN_BATCH`, `TRAIN_AUGMENT`, `TRAIN_BASE_CHECKPOINT`, one per tunable: the tunable's
`env` field names its variables, else `TRAIN_<KEY>`), so an existing train module needs no
change. `train.ProgressLog` and `train.write_outputs` write the files below.

It writes into `TRAIN_OUTPUT`:

| File | Content |
|---|---|
| `progress.jsonl` | progress events, appended and flushed as they happen (below) |
| `metrics.json` | final metrics, a free-form JSON object; recommended keys `val_metric`, `val_metric_name`, `higher_is_better` |
| `artifacts.json` | `{"files": [{"role": "weights", "path": "model.ckpt"}, {"role": "lm", "path": "lm/domain.bin"}, {"role": "lm_dict", "path": "lm/domain.dict"}], "lm_build": "built"}`. Without it, `model.ckpt` is read as role `weights` |

Exit code 0 means success. On failure the last log line that names an exception is what
DeepLabel shows.

**Progress events** (`progress.jsonl`, format `deeplabel-progress/1`): one JSON object per
line.

| Key | Meaning |
|---|---|
| `epoch` | number, the x axis; lines with the same `epoch` are merged into one point |
| `ts` | optional, Unix seconds; enables relative time and the ETA |
| `step` | optional, global step, for the step axis |
| any other key with a number | a metric. Discovered, never listed: the run page draws a chart for every numeric key it finds. A `/` splits group and leaf (`train/grad_norm`) |
| `cer_by_dataset` | optional object `{dataset: number}`, drawn as one series per dataset. Other `*_by_dataset` keys are kept but not expanded |
| non-numeric keys | ignored by the charts, kept in the file |

There is no per-task schema. A layout trainer reporting `map50` and `train/box_loss` gets
those charts with no change in DeepLabel.

An entrypoint that builds a language model does so when `build_lm` is true: the OCR one
fits a KenLM on `TRAIN_SNAPSHOT/train`, best effort, lists the files as roles `lm` and
`lm_dict`, and reports `lm_build` (`built` or `failed`) in `artifacts.json`. A backend
that builds one declares `lm` in `outputs`, and the training form offers it only then. A
fine-tune without its own LM inherits the base's.

### 6.7 Cluster: DeepLabel submits

DeepLabel runs Slurm and starts the backend's declared entrypoint inside the backend's
image. The backend does not submit jobs.

* There is one cluster login, opened once by a person answering the second factor.
  Handing that to every backend would spread a credential that is held in one place.
* The scheduler logic (accounts, partitions, resources, pending reasons, retries,
  resuming) is generic; no backend reimplements it.
* A third-party backend becomes cluster-trainable by providing an image and an
  entrypoint, with no Slurm code at all.

The job script:

```bash
#!/bin/bash
#SBATCH --job-name=deeplabel-<task>-<id>
#SBATCH --partition=<SLURM_PARTITION>                     # when set
#SBATCH --account=<the run's account, else SLURM_ACCOUNT> # when set
#SBATCH --comment=deeplabel:<owner>
#SBATCH --gres=gpu:<card>:<n>                             # the run's card, else SLURM_GRES
#SBATCH --cpus-per-task=<cpus_per_gpu x n, capped by SLURM_CPUS>
#SBATCH --mem=<memory_per_gpu_gb x n, capped by SLURM_MEM>
#SBATCH --time=<SLURM_TIME>                               # when set
#SBATCH --output=slurm.out
#SBATCH --error=slurm.out
set -euo pipefail
ulimit -n "$(ulimit -Hn)"
cd "${SLURM_SUBMIT_DIR}"
export PYTHONNOUSERSITE=1
export TRAIN_SNAPSHOT="${SLURM_SUBMIT_DIR}/snapshot"
export TRAIN_OUTPUT="${SLURM_SUBMIT_DIR}/output"
export TRAIN_BASE="${SLURM_SUBMIT_DIR}/base"
export TRAIN_PARAMS="${SLURM_SUBMIT_DIR}/params.json"
export TRAIN_GPUS="<n>"
cp "${SLURM_SUBMIT_DIR}/snapshot-manifest.json" "${TRAIN_SNAPSHOT}/manifest.json"
rm -rf "${TRAIN_OUTPUT}"            # a resumed run instead: export TRAIN_RESUME="${TRAIN_OUTPUT}"
mkdir -p "${TRAIN_OUTPUT}"
srun --container-image=<MODEL_BACKEND_<NAME>_CLUSTER_IMAGE> --container-mounts="${SLURM_SUBMIT_DIR}:${SLURM_SUBMIT_DIR}" \
     --container-workdir="${SLURM_SUBMIT_DIR}" <entrypoint>
```

A backend that declares no `cpus_per_gpu` or `memory_per_gpu_gb` gets `SLURM_CPUS_PER_GPU`
and `SLURM_MEM_PER_GPU`. The run directory goes to `SLURM_REMOTE_DIR/<id>` on the cluster.

The image is a squashfs file the admin places on the cluster and names in
`MODEL_BACKEND_<NAME>_CLUSTER_IMAGE`; a backend without one cannot train there.
`cluster-image.sh` in deeplabel-backends turns a built image into that file.

DeepLabel polls every 60 s: `sacct` for the state, `squeue` for a pending reason, and while
the job runs it fetches `progress.jsonl` and the log tail. On `COMPLETED` it rsyncs
`output/` back and registers the result; on `TIMEOUT` it resumes (6.9); any other end
fails the run with the last exception line of the log.

**What a third-party backend must provide to train on the cluster:**

1. `train` in `capabilities` and a complete `train` block in `/info` (6.2);
2. an OCI image runnable by enroot/pyxis as an unprivileged user, with the entrypoint on
   `PATH`;
3. no network at run time (nodes may have none): everything comes from `TRAIN_SNAPSHOT`,
   `TRAIN_BASE` and `TRAIN_PARAMS`;
4. read only the snapshot kind it declares, write only into `TRAIN_OUTPUT`;
5. honour `TRAIN_GPUS`;
6. write the outputs of 6.6, flushing `progress.jsonl` as it goes;
7. optionally (`resume: true`) continue from a checkpoint it left in `TRAIN_OUTPUT` when
   started again with `TRAIN_RESUME`, which turns a timed-out Slurm run into a resubmit.

The contract tests (7.3) run the entrypoint in the image, offline, against a fixture
snapshot, so a backend that passes them trains on the cluster.

### 6.8 Results back into DeepLabel

**DeepLabel fetches; backends never upload.**

* Locally DeepLabel downloads every file `GET /v1/train/{id}/artifacts` lists, verifies
  each file's sha256 against the listing, and also fetches `metrics.json` and
  `fallback.json` when present.
* On the cluster DeepLabel rsyncs `output/` back.

Either way `register_result` then reads `artifacts.json`, inserts the `models` row (with
the base's `backend`, and a layout model's learned classes from the snapshot), takes the
run's own LM or inherits the base's, copies the files into the weight store, and for OCR
schedules the evaluations. Only then does DeepLabel `DELETE /v1/train/{id}`.

Why fetch rather than upload: DeepLabel needs no write route open to backends; a backend
needs no credential that can create models; registration happens on DeepLabel's schedule
and is the same code path for local and cluster runs. The cost is that a backend keeps a
finished run's artifacts until DeepLabel deletes them.

Evaluations are OCR-only (CER/WER): the base model and the new one on the run's
validation split, and both on the run's test datasets. DeepLabel cuts the material with
`eval_material`, 512 lines at a time, reads it on the model's OCR backend, and scores it
with `scoring.py`. Each evaluation runs in its own process under DeepLabel's interpreter,
stopped above `EVAL_MEMORY_LIMIT_GB` (default half the host's memory).

### 6.9 Batch, accumulation and learning rate per card (contract 1.1)

A backend declares, beside `default_batch` in `resources`:

| Field | Meaning |
|---|---|
| `batch_by_gpu` | `{card: batch}`, the batch **per GPU** measured to fit that card on the densest material of a fixed benchmark. Card ids: `rtx5090`, `rtx6000bb`, `h200`, `l40s` |
| `effective_batch` | the batch x accumulation x GPUs the trainer's learning rates were tuned at |
| `preferred_gpu` | optional: the cheapest card that holds a run, which the training dialog starts a cluster run on until one is picked (a small model peaking at 2 GB: `l40s`). A card the cluster does not offer is ignored |
| a tunable's `role` | `accumulation` on the one tunable that sets gradient accumulation, `learning_rate` on each absolute learning rate |

and `/v1/info` reports the card the backend runs on as `gpu: {name, card, count, memory_gb}`
(the SDK reads it from `nvidia-smi`).

DeepLabel computes a run's scaling (`trainer.run_scaling`): the batch per GPU is the one
asked for, else `batch_by_gpu` of the card the run lands on (a local run: the backend's
own card; a cluster run: the chosen card), else `default_batch`, else 8. Where the backend
declares `effective_batch` and an accumulation tunable, and the run does not set that
tunable itself, the accumulation is `round(effective_batch / (batch x GPUs))`, at least 1,
so more GPUs means fewer accumulation steps. When the resulting effective batch differs
from the declared one and the backend has `learning_rate` tunables, the learning rates are
scaled by `sqrt(effective / declared)`. The train request (6.5) carries the result as
`params.grad_accum_steps` and `params.lr_scale`, only when set, and the run records both.
`train.run_hyperparams` turns them into the tunables with those roles; a tunable the run
set itself stands as given.

**Out-of-memory fallback.** The SDK runs every entrypoint under
`python -m deeplabel_backend.fallback`, on the backend and in its cluster image (the
declared `entrypoint` already includes it). When the entrypoint dies naming a CUDA
out-of-memory error, it is run again from an emptied `TRAIN_OUTPUT` with half the batch and
twice the accumulation, down to a batch of 1. A run that had to shrink writes
`TRAIN_OUTPUT/fallback.json` (`{asked, trained}`); DeepLabel fetches it with the artifacts
and records the batch the run really had.

**Resuming.** A backend whose `train.resume` is true can continue from `TRAIN_RESUME`
(6.6). When a cluster run on it ends in Slurm's `TIMEOUT`, DeepLabel writes the job script
again with `TRAIN_RESUME` set and resubmits it in the same remote directory, up to
`SLURM_MAX_RESUMES` times (default 3); the run stays one training and counts its resumes.

**Metrics.** A train block declares what its trainer reports as `metrics`:
`[{key, label, unit, better, headline, detail}]`, where `unit` is `fraction`, `number`,
`gb`, `seconds` or `per_second`, `better` is `higher` or `lower`, exactly one metric is the
`headline`, and `detail` folds a metric away on the run page (per-decoder-layer losses, an
EMA copy's scores). A `*` in a key matches many, one per class, and `{}` in the label is
what it matched (`val/AP/*` labelled `AP {}`). The SDK adds the two every trainer can
report, `lr` and `gpu/peak_memory_gb` (`train.system_metrics`), and stamps every point
`ProgressLog` writes with `ts`. DeepLabel keeps the declaration with the run when it
starts, and the run page charts by it - its headline first - and works out the time per
epoch and the items per second from the stamps and the split.

**Final evaluation.** A layout or lines entrypoint ends with `evaluate.after_training`: the
trained weights read the snapshot's validation pages through the backend's own predict
path, scored at IoU 0.5 - AP50 per class and mAP50 for layout, precision, recall and F1 of
lines matched one to one for lines - overall and per dataset, by the snapshot manifest's
`groups`. It is written into `metrics.json` as `evaluation`, with `final/<metric>` beside
it, and the run page shows it as a table. A failed evaluation is recorded there; the run
stands.

**Test datasets.** A layout or lines run's test datasets travel in its snapshot as a
`test/` split in the kind's own layout, counted under `splits.test` in the manifest; a run
without them has no `test/`. Nothing trains or validates on it. `after_training` scores it
twice in the same way - with the trained weights and with the base the run started from
(`TRAIN_BASE/weights`, or the backend's builtin where `TRAIN_BASE/builtin` says so) - and
writes `test_evaluation: {"trained": ..., "base": ...}` into `metrics.json`; a run from
scratch has no `base`. The run page sets the two side by side. OCR runs score their test
datasets in DeepLabel instead (6.8), and their snapshots carry none.

---

## 7. Template, SDK, contract tests, stub

These live in the [deeplabel-backends](https://github.com/m2key1/deeplabel-backends)
repository, beside the DeepOCR (`deepocr/`) and Kraken (`kraken_lines/`) backends. They
are the contract, not model code, and import nothing from DeepLabel.

```
deeplabel-backends/
  sdk/                      deeplabel_backend package (pip-installable)
    app.py                  create_app(model) -> FastAPI app with every /v1 route; serve(model)
    model.py                class Model: the hooks below; Loaded, Prediction
    results.py              per-task validation of what predict() returns
    errors.py               the error codes of 3.7
    weights.py              cache, resumable download, sha256, LRU
    transfer.py             download with Range resume, fetch_tree for snapshots
    train.py                local trainings, params.json -> TRAIN_* env, ProgressLog, write_outputs
    fallback.py             the out-of-memory fallback around an entrypoint (6.9)
    evaluate.py             after_training, the final evaluation of layout and lines runs (6.9)
    gpu.py                  the card the backend runs on
    windows.py              map windows (4.6)
    schemas.py              pydantic models of every request and response; CONTRACT
  template/                 copy this to wrap a model
    model.py
    server.py               uvicorn entry: serve(MyModel())
    train_entrypoint.py     the training entrypoint for this model (optional)
    requirements.txt
    Dockerfile
    compose.snippet.yml
    README.md               includes every setting the SDK reads
  contract_tests/           pytest suite, run against a URL
  stub/                     the deterministic e2e backend
  cluster-image.sh          a built image -> the .sqsh the cluster runs (6.7)
```

### 7.1 The hooks

```python
class Model:
    name, version, model_type = 'my-layout', '0.1.0', 'yolo'
    tasks = ('layout',)
    capabilities = ()                                 # beyond predict: 'nbest', 'lm', ...
    weight_roles = {'weights': 'required'}
    builtin = False
    concurrency, max_request_mb = 1, 64

    def tasks_detail(self) -> dict: ...               # /info tasks_detail
    def load(self, files: dict[str, Path], device: str) -> Loaded: ...   # handle + facts
    def unload(self, loaded: Loaded) -> None: ...
    def predict(self, loaded, task, images: list[PIL.Image], params: dict,
                contexts: list[dict]) -> list[dict] | Prediction: ...
    # optional
    def batch_size(self, task, params) -> int | None: ...   # images per predict() call
    def train_info(self) -> dict | None: ...          # the train block of 6.2, None if not trainable
    def train_command(self) -> list[str]: ...         # default: train_info()['entrypoint']
    def tunables(self) -> list[dict]: ...             # default: train_info()['tunables']
    def augmentations(self) -> dict: ...              # GET /v1/train/augmentations
    def augmentation_preview(self, spec, images, seed, draws) -> list[PIL.Image]: ...
```

The SDK owns authentication, multipart parsing, image decoding, splitting a batch (and
halving it after an out-of-memory error), the weights cache, local trainings, error
formatting, health and concurrency. `predict` sees PIL images and returns results in the
schema of section 4; the SDK validates them (normalised coordinates, one result per item)
before they leave, so a malformed result is a `500` naming the field, never bad data in
DeepLabel. `Prediction(results, extra)` adds top-level response fields such as OCR's
`decode`. `GET /v1/train/tunables` answers `{"tunables": [...]}`. The preview takes a
multipart body with a `request` part `{spec, seed, draws}` and the images, and answers
`{"images": [<PNG data URLs>]}`. `GET /v1/train/augmentations` answers the catalogue
(`library`, `version`, `transforms`) and, as `default`, the stack the trainer applies when
a run names none, serialised as albumentations does; the training form offers it as "the
model's own".

The server listens on `HOST` (default `0.0.0.0`) and `PORT` (default 9100).

### 7.2 Dockerfile and compose snippet

The template's Dockerfile starts from a CUDA runtime image, installs the SDK and the
model's requirements, and runs `server.py` on port 9100. The snippet:

```yaml
services:
  my-layout-backend:
    build: .
    restart: unless-stopped
    environment:
      MODEL_BACKEND_SECRET: ${MY_LAYOUT_BACKEND_SECRET:?}
      MODEL_CACHE_MAX_GB: ${MY_LAYOUT_CACHE_GB:-20}
      MODEL_MAX_LOADED: 2
    volumes:
      - my-layout-cache:/cache        # the backend's own disk, not shared with DeepLabel
    deploy:
      resources:
        reservations:
          devices: [{driver: nvidia, device_ids: ["0"], capabilities: [gpu]}]
volumes:
  my-layout-cache:
```

### 7.3 Contract test suite

From a checkout of deeplabel-backends:

```
uv run pytest contract_tests \
    --backend-url http://localhost:9100 --backend-secret s3cret \
    --weights-file ./fixture/model.pt [--weights-file-lm ... --weights-file-lm-dict ...] \
    --serve-host 172.17.0.1 [--train] [--train-image my-backend:1.0] \
    [--train-squashfs my-backend.sqsh] [--train-timeout <seconds>]
```

`--backend-cmd "<command>"` instead of `--backend-url` starts the backend itself on a free
port. A backend whose `weights` role is optional (the stub) is tested with random bytes as
weights when no `--weights-file` is given. The suite plays DeepLabel: it serves the fixture
weights (and a fixture snapshot) itself on `--serve-host` with Range and secret checks, and
drives the backend. It asserts:

| Area | Checks |
|---|---|
| health and info | schema valid; contract major is 1; declared tasks have `tasks_detail`; a train block names a known snapshot kind |
| auth | every `/v1` route answers `401` without the secret; `/health` does not need it |
| weights | load reaches `loaded`; the second load of the same version is instant; a corrupted file yields `weights_checksum_mismatch`; an interrupted download resumes with a `Range` request (the fixture server drops the connection once); an unknown URL yields `weights_unavailable`; predict before load yields `weights_not_loaded` |
| predict, per declared task | fixture images in, schema-valid results out; result count and `id` order equal the request's; every coordinate in `[0, 1]`; deterministic output for a fixed image (two calls agree); a batch over `max_items` yields `413` |
| ocr | the returned `decode` is one of the declared decodes; `conf_profile` bands are ordered and within `[0, 1]` |
| concurrency | requests over `concurrency` get `429` with `Retry-After` |
| errors | every error body has `code`, `message`, `retryable` |
| training (`--train`) | a tiny fixture snapshot of the declared kind trains to `done`; at least one progress line with `epoch`; `artifacts.json` hashes match the downloaded artifacts; cancel reaches `cancelled`; with `--train-image` the entrypoint also runs offline in the image (`docker run --network none`, unprivileged), and with `--train-squashfs` from the cluster `.sqsh` |

A model repo runs the suite in its own CI, against its own image. Where a host firewall
stops containers from reaching the host, run the backend with `--network host` and leave
`--serve-host` at `127.0.0.1`.

### 7.4 The stub backend for e2e

`stub/` is a pure-Python backend built on the SDK that serves every task, with no GPU and
no weights files of its own (`builtin`), plus a trainer. DeepLabel's e2e suite runs on it.

* Predictions are deterministic: a `Header` and a `Paragraph` box per page, three lines
  per element (`scope: page`) or per crop (`scope: crop`), per-class confidences, the OCR
  text `Sample <element_class> line <line_index + 1>` read from the item's `context`,
  `target_height` 256 and `max_width` 6144 as load facts, profiles of 20 bands, the
  `centreline` edge method, and for map segmentation one square per class, the first with
  a hole.
* Weights whose content is `stub-slow` wait 15 s before every prediction; `stub-misread`
  reads OCR with a fixed cycle of four errors. `STUB_PREDICT_DELAY` (seconds) slows every
  prediction a little, so a job's phases can be watched.
* Like any backend it trains one snapshot kind, picked by `STUB_TRAIN_SNAPSHOT`
  (`ocr-lines/1`, the default, `page-lines/1` or `page-boxes/1`).
* The trainer honours markers in `run.name`: `[slow]` waits first, `[no-ts]` leaves the
  timestamps out, `[oom]` runs out of memory above a batch of 2, `[lm-fails]` fails the
  language model. It writes three epochs with `loss`, `train/grad_norm`, `cer` and
  `cer_by_dataset`, and returns a weights artifact, so `register_result` runs for real.
* DeepLabel's `compose.e2e.yml` runs one stub container per trainable task and points every
  `MODEL_BACKEND_*_URL` at them. The stubs fetch weights and snapshots from the e2e API,
  which tests the transfer path in every run.
