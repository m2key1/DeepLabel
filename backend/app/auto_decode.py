import argparse
import sys

from app import config, registry, store

# The fixed modes a dataset that follows the default model is moved off: the defaults a new
# dataset used to get. A fast greedy reading, or a decode chosen for one model, was picked.
MOVED_FROM = ('beam', 'rescored')


def resolve(conn, model_id: int | None, stored: str) -> str:
    """The mode a dataset reads with: the one it stores, or for 'auto' its model's own best -
    the model's own decoder where it has a token decoder, else beam search reranked by the
    decoder head."""
    if stored != 'auto':
        return stored
    return 'decoder' if model_id is not None and registry.has_token_decoder(conn, model_id) else 'rescored'


def move_followers(conn, apply: bool) -> dict[str, int]:
    """The text datasets that follow the default OCR model on one of MOVED_FROM, counted by
    mode - and with `apply`, moved to 'auto'. Datasets pinned to a model keep their mode."""
    where = f"task = 'text' AND model_ocr_id IS NULL AND ocr_decode IN ({','.join('?' * len(MOVED_FROM))})"
    counts = {row['ocr_decode']: row['n'] for row in conn.execute(
        f'SELECT ocr_decode, COUNT(*) n FROM jobs WHERE {where} GROUP BY ocr_decode', MOVED_FROM)}
    if apply and counts:
        conn.execute(f"UPDATE jobs SET ocr_decode = 'auto' WHERE {where}", MOVED_FROM)
        conn.commit()
    return {mode: counts[mode] for mode in MOVED_FROM if mode in counts}


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog='python -m app.auto_decode',
        description='Move the datasets that follow the default OCR model onto the auto decode.')
    parser.add_argument('--apply', action='store_true', help='move them; without it, only count them')
    args = parser.parse_args(argv)
    conn = store.connect(config.DB_PATH)
    try:
        counts = move_followers(conn, args.apply)
    finally:
        conn.close()
    total = sum(counts.values())
    if not total:
        print('No dataset follows the default OCR model on a fixed decode.')
        return
    if args.apply:
        print(f"Moved {total} datasets to auto: {', '.join(f'{n} from {mode}' for mode, n in counts.items())}.")
    else:
        print(f"{total} datasets follow the default OCR model on a fixed decode: "
              f"{', '.join(f'{n} on {mode}' for mode, n in counts.items())}. Run again with --apply to move them to auto.")


if __name__ == '__main__':
    main(sys.argv[1:])
