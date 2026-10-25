import argparse
import json
import os
import sys
from pathlib import Path

from deeplabel.client import DeepLabel, DeepLabelError

EXPORT_SUFFIX = {'json': 'json', 'md': 'md', 'txt': 'txt', 'zip': 'zip'}


def _client(args) -> DeepLabel:
    return DeepLabel(args.url or os.environ.get('DEEPLABEL_URL', ''),
                     args.token or os.environ.get('DEEPLABEL_TOKEN', ''))


def _print_jobs(jobs: list[dict]):
    if not jobs:
        print('no datasets')
        return
    width = max(len(j['name']) for j in jobs)
    for job in jobs:
        counters = job.get('counters', {})
        print(f"{job['id']}  {job['name']:<{width}}  {job['status']:<9} "
              f"{counters.get('pages_total', 0):>5} pages  {counters.get('lines_total', 0):>7} lines")


def cmd_jobs(args, client):
    _print_jobs(client.jobs())


def cmd_show(args, client):
    print(json.dumps(client.job(args.job_id), indent=2, ensure_ascii=False))


def cmd_upload(args, client):
    options = {'run_layout': not args.no_layout, 'run_lines': not args.no_lines,
               'run_ocr': not args.no_ocr, 'gt_autocheck': args.autocheck}
    def progress(sent, total):
        print(f'uploaded {sent}/{total} files', file=sys.stderr)

    job_id = client.upload(args.name, [Path(p) for p in args.paths], resume=args.resume,
                           on_progress=progress, **options)['job_id']
    print(job_id)
    if args.wait:
        _wait(client, job_id)


def cmd_import(args, client):
    result = client.import_export_zip(args.name, Path(args.archive), reviewed=args.reviewed)
    print(f"{result['job_id']}  {result['pages']} pages  {result['lines']} lines")
    if args.wait:
        _wait(client, result['job_id'])


def cmd_export(args, client):
    body = client.export(args.job_id, format=args.format, reviewed_only=args.reviewed)
    if args.output == '-':
        sys.stdout.buffer.write(body)
        return
    destination = Path(args.output or f'{args.job_id}.{EXPORT_SUFFIX[args.format]}')
    destination.write_bytes(body)
    print(f'{destination} ({len(body)} bytes)')


def cmd_wait(args, client):
    _wait(client, args.job_id)


def cmd_models(args, client):
    for model in client.models().get('models', []):
        default = ' (default)' if model.get('is_default') else ''
        print(f"{model['id']:>3}  {model['task']:<8} {model['name']}{default}")


def cmd_corpus(args, client):
    documents = client.documents(args.job_id)['documents']
    if not documents:
        print('no corpus documents')
        return
    for document in documents:
        print(f"{document['idx']:>4}  {document['name']:<40} "
              f"{document['lines']:>5} lines  {document['pages']:>3} pages")


def cmd_corpus_add(args, client):
    result = client.upload_documents(args.job_id, [Path(p) for p in args.paths])
    print(f"stored {result['stored']}, {result['documents']} in the corpus")
    for name in result['skipped']:
        print(f'skipped {name}', file=sys.stderr)


def cmd_cut(args, client):
    result = client.cut_reference(args.job_id)
    print(f"{result['placed']}/{result['pages']} pages placed from "
          f"{result['documents']} document(s), {result['unanchored']} without an anchor")


def cmd_reference(args, client):
    body = client.reference(args.job_id, limit=args.limit)
    for page in body['pages']:
        first = (page['text'].splitlines() or [''])[0]
        print(f"{page['idx']:>4}  {page['filename']:<28} {page['document'] or '-':<24} "
              f"{page['anchors']:>3} anchors  {page['score']:.2f}  {first[:50]}")
    print(f"{len(body['pages'])} of {body['total']} pages")


def cmd_groundtruth(args, client):
    result = client.read_groundtruth(args.job_id, refresh=args.refresh)
    print(f"queued {result['queued']}, reused {result['reused']}, of {result['pages']} pages")
    if args.wait:
        _wait_groundtruth(client, args.job_id)


def _wait_groundtruth(client: DeepLabel, job_id: str):
    seen = {}

    def progress(state):
        left = state['pending'] + state['running']
        if left != seen.get('left'):
            seen['left'] = left
            print(f"{state['done']} read, {left} left, {state['error']} failed", flush=True)

    state = client.wait_groundtruth(job_id, on_progress=progress)
    for failure in state['errors']:
        print(f"page {failure['page_id']}: {failure['error']}", file=sys.stderr)


def _wait(client: DeepLabel, job_id: str):
    seen = {}

    def progress(job):
        state = (job['status'], job.get('phase'))
        if state != seen.get('state'):
            seen['state'] = state
            print(f"{job['status']}{' ' + job['phase'] if job.get('phase') else ''}", flush=True)

    job = client.wait(job_id, on_progress=progress)
    if job['status'] != 'done':
        raise DeepLabelError(0, job.get('error') or f"finished as {job['status']}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog='deeplabel', description='Talk to a DeepLabel deployment.')
    parser.add_argument('--url', default='', help='deployment URL (or DEEPLABEL_URL)')
    parser.add_argument('--token', default='', help='API token (or DEEPLABEL_TOKEN)')
    sub = parser.add_subparsers(dest='command', required=True)

    sub.add_parser('jobs', help='list datasets').set_defaults(run=cmd_jobs)

    show = sub.add_parser('show', help='one dataset as JSON')
    show.add_argument('job_id')
    show.set_defaults(run=cmd_show)

    upload = sub.add_parser('upload', help='create a dataset from images (and .txt siblings)')
    upload.add_argument('name')
    upload.add_argument('paths', nargs='+', help='image files, or a directory of them')
    upload.add_argument('--no-layout', action='store_true', help='skip layout detection')
    upload.add_argument('--no-lines', action='store_true', help='skip line detection')
    upload.add_argument('--no-ocr', action='store_true', help='skip recognition')
    upload.add_argument('--autocheck', action='store_true',
                        help='mark lines reviewed where a transcription matches exactly')
    upload.add_argument('--resume', action='store_true',
                        help='finish an interrupted upload of this dataset, sending only what it lacks')
    upload.add_argument('--wait', action='store_true', help='block until the pipeline finishes')
    upload.set_defaults(run=cmd_upload)

    imp = sub.add_parser('import', help='import a PAGE/ALTO export zip')
    imp.add_argument('name')
    imp.add_argument('archive')
    imp.add_argument('--reviewed', action='store_true', help='mark imported lines reviewed')
    imp.add_argument('--wait', action='store_true')
    imp.set_defaults(run=cmd_import)

    export = sub.add_parser('export', help='download a dataset')
    export.add_argument('job_id')
    export.add_argument('--format', choices=sorted(EXPORT_SUFFIX), default='json')
    export.add_argument('--reviewed', action='store_true', help='reviewed lines only')
    export.add_argument('-o', '--output', help='file to write, or - for stdout')
    export.set_defaults(run=cmd_export)

    wait = sub.add_parser('wait', help='block until a dataset stops running')
    wait.add_argument('job_id')
    wait.set_defaults(run=cmd_wait)

    corpus = sub.add_parser('corpus', help='list the corpus a dataset was uploaded with')
    corpus.add_argument('job_id')
    corpus.set_defaults(run=cmd_corpus)

    corpus_add = sub.add_parser('corpus-add', help='add corpus text files to a dataset')
    corpus_add.add_argument('job_id')
    corpus_add.add_argument('paths', nargs='+', help='.txt files, or a directory of them')
    corpus_add.set_defaults(run=cmd_corpus_add)

    cut = sub.add_parser('cut', help='cut the corpus across the pages, using what OCR read')
    cut.add_argument('job_id')
    cut.set_defaults(run=cmd_cut)

    ref = sub.add_parser('reference', help='what each page is answerable for')
    ref.add_argument('job_id')
    ref.add_argument('--limit', type=int, default=200)
    ref.set_defaults(run=cmd_reference)

    gt = sub.add_parser('groundtruth', help='read each page against its reference span')
    gt.add_argument('job_id')
    gt.add_argument('--refresh', action='store_true',
                    help='read every page again, not only those whose wording or cut has moved')
    gt.add_argument('--wait', action='store_true', help='block until every page is read')
    gt.set_defaults(run=cmd_groundtruth)

    sub.add_parser('models', help='list registered models').set_defaults(run=cmd_models)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        args.run(args, _client(args))
    except (DeepLabelError, ValueError, TimeoutError) as error:
        print(f'error: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
