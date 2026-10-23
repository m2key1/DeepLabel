import { test, expect } from '../helpers/test'
import {
  backendFetch, correctLine, datasetInfo, jobPageIds, pageLines, uniqueName, waitForJobStatus,
} from '../helpers/api'
import { scanPng } from '../helpers/image'

test.describe("Scenario: a dataset's Info names the people who worked on it", () => {
  test('alignment is not listed as an editor; the person who corrected a line is', async () => {
    const name = uniqueName('Editors')
    const form = new FormData()
    form.append('name', name)
    form.append('line_mode', 'per_crop')
    form.append('gt_autocheck', 'true')
    form.append('files', new Blob([new Uint8Array(scanPng())], { type: 'image/png' }), 'folio_1.png')
    form.append('files', new Blob(['Sample Header line 1'], { type: 'text/plain' }), 'folio_1.txt')
    const { job_id: jobId } = await backendFetch('/api/jobs', { method: 'POST', body: form })
    await waitForJobStatus(jobId, 'done')

    // Alignment wrote a correction and checked the line, with nobody touching it.
    const lines = await pageLines(jobId, (await jobPageIds(jobId))[0])
    expect(lines.find((l) => l.text === 'Sample Header line 1')).toMatchObject({
      corrected_text: 'Sample Header line 1', checked: true, check_source: 'align',
    })
    expect((await datasetInfo(jobId)).editors).toEqual([])

    // A person's correction is what makes somebody an editor.
    const other = lines.find((l) => l.text === 'Sample Paragraph line 1')!
    await correctLine(other.id, 'Set right by hand')
    expect((await datasetInfo(jobId)).editors.map((e) => [e.author, e.edits]))
      .toEqual([['e2e-seeder', 1]])
  })
})
