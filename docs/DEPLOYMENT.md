# Deployment

DeepLabel is three services with their own compose files - the frontend (nginx gateway
and app), the auth service with Authentik, and the backend - plus one model backend per
model type. They talk only over HTTP, so each can run on a different machine. Every
variable is explained in [`.env.frontend.example`](../.env.frontend.example) and
[`.env.backend.example`](../.env.backend.example).

## Stub stack (no GPU, no models)

`compose.e2e.yml` is the stack the end-to-end tests run against. Its model backends are
stubs that return deterministic boxes, lines and text, a stub answers language-model
calls, and login is bypassed with an automatic admin session. It is built from the
`deeplabel-backends` clone beside this one (`DEEPLABEL_BACKENDS_ROOT` says where else).

```bash
docker compose -f compose.e2e.yml up -d --build      # http://localhost:8090
docker compose -f compose.e2e.yml down -v            # stop and remove its data
```

## Development

Run the backend natively and the web layers in Docker. PDF ingest needs poppler
(`sudo apt-get install poppler-utils`).

```bash
cd backend && uv sync && uv run uvicorn app.main:app --host 0.0.0.0 --port 8000
docker compose -f compose.dev.yml up -d --build      # http://localhost:8080, login bypassed
```

## Model backends

Build the images in [deeplabel-backends](https://github.com/m2key1/deeplabel-backends):

```bash
./build.sh deepocr ../DeepOCR        # DeepOCR v3, its weights built into the image
./build.sh kraken_lines              # Kraken line segmentation
```

Set `OCR_BACKEND_IMAGE` and `LINES_BACKEND_IMAGE` to the printed tags, a secret per backend,
and the backend URLs in `.env` (the template lists them), then start them beside the
backend:

```bash
docker compose -f compose.backend.yml -f compose.models.yml up -d
```

A backend that ships its own weights becomes its task's default model the first time
DeepLabel reaches it. To wrap another model, see [MODEL-BACKENDS.md](MODEL-BACKENDS.md).

## Production

The backend and model backends go on a GPU host with the NVIDIA container runtime; the
frontend, auth service and Authentik usually on a small public server. Each machine gets
its own `.env` from the matching template, and both share the same `FRONTEND_SECRET`.

```bash
# GPU host
cp .env.backend.example .env
docker compose -f compose.backend.yml -f compose.models.yml up -d --build

# public server
cp .env.frontend.example .env
docker compose -f compose.frontend.yml up -d --build
docker compose -f compose.authentik.yml up -d
```

`BACKEND_URL` on the public server points at the GPU host. `FRONTEND_SECRET` lets its
holder act as any user, so keep the backend port private: when everything runs on one
machine, set `BACKEND_BIND=127.0.0.1` and `BACKEND_URL=http://backend:8000`.

Login is set up in [AUTHENTIK.md](../AUTHENTIK.md). Training on a Slurm cluster is
configured with the `SLURM_*` variables and one cluster image per model backend
(`MODEL_BACKEND_<NAME>_CLUSTER_IMAGE`).

Map tiling and pre-annotation are optional (`MAPSEG_*`); without them, map datasets are
annotation-only.
