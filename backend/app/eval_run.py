import argparse
import itertools
import json
from pathlib import Path

from app import backend_client, config, data_use, eval_material, evaluator, store
from app.eval_metrics import line_record
from app.remote_models import RemoteOcrEngine
from app.scoring import corpus_scores, group_breakdown


def batches_of(conn, evaluation: dict):
    source = json.loads(evaluation['source'])
    if 'snapshot' in source:
        return eval_material.snapshot_batches(config.training_dir(source['snapshot']) / 'snapshot', conn=conn)
    return eval_material.job_batches(conn, source.get('jobs', []),
                                     human_checked_only=source.get('human_checked_only', False),
                                     test_pages_only=source.get('test_pages', False))


def score(conn, evaluation: dict, make_engine, lines_out: Path | None) -> None:
    """Read an evaluation's material with whichever engine make_engine builds, and record
    the scores. The material is peeked rather than counted, so nothing is scored twice and
    no model is loaded for a split that turns out to be empty."""
    batches = batches_of(conn, evaluation)
    first = next(batches, None)
    if first is None:
        evaluator.finish(conn, evaluation['id'], status='error', error='no checked material to evaluate on')
        return

    engine = make_engine()
    references, hypotheses, groups = [], [], []
    records = lines_out.open('w', encoding='utf-8') if lines_out else None
    for batch in itertools.chain([first], batches):
        images = [item.image for item in batch]
        read, confidences, _ = engine.predict_batch(images, contexts=[item.context for item in batch])
        hypotheses.extend(read)
        references.extend(item.text for item in batch)
        groups.extend(item.group for item in batch)
        if records:
            for item, text, confidence in zip(batch, read, confidences):
                if item.line_id is not None:
                    records.write(json.dumps(line_record(
                        item.line_id, item.group or None, item.page_id, evaluation['decode'],
                        item.text, text, confidence), ensure_ascii=False) + '\n')
        # The whole point: the batch goes out of scope holding nothing.
        for image in images:
            image.close()
    if records:
        records.close()
    cer, wer = corpus_scores(references, hypotheses)
    evaluator.finish(conn, evaluation['id'], status='done',
                        cer=cer, wer=wer, line_count=len(references),
                        breakdown=group_breakdown(references, hypotheses, groups))


def main():
    """An evaluation, read on the model's backend by the app's own interpreter."""
    parser = argparse.ArgumentParser()
    parser.add_argument('--evaluation-id', type=int, required=True)
    parser.add_argument('--db-path', required=True)
    parser.add_argument('--lines-out', type=Path)
    args = parser.parse_args()

    conn = store.connect(Path(args.db_path))
    evaluation = evaluator.get_evaluation(conn, args.evaluation_id)
    if evaluation is None:
        raise SystemExit(1)
    refused = data_use.refusal(conn, json.loads(evaluation['source'] or '{}').get('jobs') or [], 'test')
    if refused:
        evaluator.finish(conn, evaluation['id'], status='error', error=refused)
        return
    client = backend_client.client_for(conn, evaluation['model_id'])
    if client is None:
        evaluator.finish(conn, evaluation['id'], status='error',
                            error=f'model {evaluation["model_id"]} is not on a configured model backend')
        return
    score(conn, evaluation,
          lambda: RemoteOcrEngine(conn, client, evaluation['model_id'], evaluation['decode']),
          args.lines_out)


if __name__ == '__main__':
    main()
