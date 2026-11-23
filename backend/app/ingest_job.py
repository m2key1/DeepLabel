import argparse
from pathlib import Path

from app import store
from app.text_job import phase_ingest


def main() -> None:
    """Renders a dataset's pending pages, outside the GPU queue (ingest_queue)."""
    parser = argparse.ArgumentParser()
    parser.add_argument('--job-id', required=True)
    parser.add_argument('--db-path', required=True)
    parser.add_argument('--job-path', required=True)
    args = parser.parse_args()
    conn = store.connect(Path(args.db_path))
    phase_ingest(conn, args.job_id, Path(args.job_path))


if __name__ == '__main__':
    main()
