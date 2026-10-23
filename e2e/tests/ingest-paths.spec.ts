import { execSync } from 'node:child_process'
import { test, expect } from '../helpers/test'
import {
  backendFetch, getJob, jobPageIds, pageLines, uniqueName, waitForJobStatus,
} from '../helpers/api'
import { scanPng } from '../helpers/image'

/** Writes files into the backend container, which is where a server path is read. A value
 *  of 'png' becomes a distinct grey scan (distinct, or ingest folds it as a duplicate). */
function writeOnServer(dir: string, files: Record<string, string>): void {
  const payload = Buffer.from(JSON.stringify({ dir, files })).toString('base64')
  const script = [
    'import base64, json, pathlib',
    'from PIL import Image',
    `spec = json.loads(base64.b64decode('${payload}'))`,
    'root = pathlib.Path(spec["dir"])',
    'for n, (name, body) in enumerate(sorted(spec["files"].items())):',
    '    p = root / name; p.parent.mkdir(parents=True, exist_ok=True)',
    '    Image.new("L", (600, 800), 40 + n * 7).save(p) if body == "png" else p.write_text(body)',
  ].join('\n')
  execSync('docker compose -f ../compose.e2e.yml exec -T backend python -',
           { input: script })
}

const correctedOn = async (jobId: string) => {
  const result: (string | null)[] = []
  for (const pageId of await jobPageIds(jobId)) {
    const corrected = (await pageLines(jobId, pageId)).filter((l) => l.corrected_text)
    result.push(corrected.map((l) => l.corrected_text).join('|') || null)
  }
  return result
}

test.describe('Scenario: adding more scans to a dataset', () => {
  test("a new scan named like an old one does not take over the old one's transcription", async () => {
    const form = new FormData()
    form.append('name', uniqueName('Second batch'))
    form.append('line_mode', 'per_crop')
    form.append('files', new Blob([new Uint8Array(scanPng(600, 800, 1))], { type: 'image/png' }), 'IMG_0001.png')
    form.append('files', new Blob(['Sample Header line 1'], { type: 'text/plain' }), 'IMG_0001.txt')
    const { job_id: jobId } = await backendFetch('/api/jobs', { method: 'POST', body: form })
    await waitForJobStatus(jobId, 'done')
    expect(await correctedOn(jobId)).toEqual(['Sample Header line 1'])

    const more = new FormData()
    more.append('files', new Blob([new Uint8Array(scanPng(600, 800, 2))], { type: 'image/png' }), 'IMG_0001.png')
    more.append('files', new Blob(['Sample Header line 2'], { type: 'text/plain' }), 'IMG_0001.txt')
    await backendFetch(`/api/jobs/${jobId}/pages/upload`, { method: 'POST', body: more })
    await expect.poll(async () => (await getJob(jobId)).pages.length).toBe(2)
    await waitForJobStatus(jobId, 'done')

    // Each scan keeps the transcription that came with it.
    expect(await correctedOn(jobId)).toEqual(['Sample Header line 1', 'Sample Header line 2'])
  })
})

test.describe('Scenario: ingesting a directory on the server', () => {
  test('pages in sub-folders keep folder order, each with its own transcription', async () => {
    const dir = `/data/e2e-fixtures/${Date.now()}-nested`
    writeOnServer(dir, {
      'vol1/001.png': 'png', 'vol1/001.txt': 'Sample Header line 1',
      'vol1/002.png': 'png', 'vol1/002.txt': 'Sample Header line 2',
      'vol2/001.png': 'png', 'vol2/001.txt': 'Sample Header line 3',
      'vol2/002.png': 'png', 'vol2/002.txt': 'Sample Paragraph line 1',
    })
    const { job_id: jobId } = await backendFetch('/api/jobs/path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: uniqueName('Nested volumes'), server_path: dir }),
    })
    await waitForJobStatus(jobId, 'done')

    expect(await correctedOn(jobId)).toEqual([
      'Sample Header line 1', 'Sample Header line 2', 'Sample Header line 3', 'Sample Paragraph line 1',
    ])
  })

  test('appending a directory keeps the corpus documents it holds, as an upload does', async () => {
    const form = new FormData()
    form.append('name', uniqueName('Append from path'))
    form.append('line_mode', 'per_crop')
    form.append('files', new Blob([new Uint8Array(scanPng(600, 800, 3))], { type: 'image/png' }), 'scan_1.png')
    const { job_id: jobId } = await backendFetch('/api/jobs', { method: 'POST', body: form })
    await waitForJobStatus(jobId, 'done')

    const dir = `/data/e2e-fixtures/${Date.now()}-append`
    writeOnServer(dir, { 'scan_9.png': 'png', 'letter-02.txt': 'Ein Brief\nmit zwei Zeilen\n' })
    await backendFetch(`/api/jobs/${jobId}/pages/path`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server_path: dir }),
    })
    await expect.poll(async () => (await getJob(jobId)).pages.length).toBe(2)
    await waitForJobStatus(jobId, 'done')

    const docs = await backendFetch(`/api/jobs/${jobId}/documents`)
    expect((docs.documents as { name: string }[]).map((d) => d.name)).toEqual(['letter-02'])
  })
})
