FROM python:3.12-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends curl libxcb1 libgl1 libglib2.0-0 openssh-client rsync \
        poppler-utils && \
    rm -rf /var/lib/apt/lists/*

# The map and edge venvs (MAPSEG_PYTHON, EDGE_DETECT_PYTHON) are created on the host, where
# their bin/python links to /usr/bin/python3.12; this image keeps python in /usr/local/bin.
RUN ln -s /usr/local/bin/python3.12 /usr/bin/python3.12

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

COPY pyproject.toml uv.lock ./
RUN uv sync --no-dev --frozen

ENV PATH="/app/.venv/bin:$PATH"

COPY app ./app
COPY runner ./runner

ARG GIT_COMMIT=
ENV GIT_COMMIT=$GIT_COMMIT

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]