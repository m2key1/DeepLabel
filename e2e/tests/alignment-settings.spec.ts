import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/test'
import {
  backendFetch, correctLine, getJob, jobPageIds, pageCandidates, pageLines, uniqueName,
  waitForJobStatus,
} from '../helpers/api'
import { scanPng } from '../helpers/image'

// The identity helpers/api.ts seeds under, which is who a correction made there is by.
const SEEDER = 'e2e-seeder'

// One exact match and one near match ('Paragraf') against the stub's recognized lines.
const TRANSCRIPTION = ['Sample Header line 1', 'Sample Paragraf line 2'].join('\n')

async function seedTranscribed(name: string): Promise<string> {
  const form = new FormData()
  form.append('name', name)
  form.append('line_mode', 'per_crop')
  form.append('files', new Blob([new Uint8Array(scanPng())], { type: 'image/png' }), 'folio_1.png')
  form.append('files', new Blob([TRANSCRIPTION], { type: 'text/plain' }), 'folio_1.txt')
  const { job_id: jobId } = await backendFetch('/api/jobs', { method: 'POST', body: form })
  await waitForJobStatus(jobId, 'done')
  return jobId
}

const lineReading = async (jobId: string, text: string) => {
  const [pageId] = await jobPageIds(jobId)
  const line = (await pageLines(jobId, pageId)).find((l) => l.text === text)!
  return { corrected: line.corrected_text, checked: line.checked, source: line.check_source }
}

/** Re-run Alignment the way a person does it, from the dataset page's Re-run dialog, and
 *  wait until the runner is through. */
async function rerunAlignment(page: Page, jobId: string) {
  await page.goto(`/jobs/${jobId}`)
  await page.getByRole('button', { name: 'Re-run', exact: true }).click()
  await page.locator('[data-testid="rerun-phase"][data-phase="align"]').check()
  const answer = page.waitForResponse((r) =>
    r.url().endsWith(`/api/jobs/${jobId}/rerun`) && r.request().method() === 'POST')
  await page.getByTestId('rerun-confirm').click()
  expect((await answer).status()).toBe(200)
  await waitForJobStatus(jobId, 'done')
}

test.describe('Scenario: matching a transcription again under changed settings', () => {
  test('switching auto-check on afterwards and re-running Alignment checks the exact match',
    async () => {
      const jobId = await seedTranscribed(uniqueName('Align later'))
      // Created without auto-check: both matches fill in a correction, neither is checked.
      expect(await lineReading(jobId, 'Sample Header line 1'))
        .toEqual({ corrected: 'Sample Header line 1', checked: false, source: null })
      expect(await lineReading(jobId, 'Sample Paragraph line 2'))
        .toEqual({ corrected: 'Sample Paragraf line 2', checked: false, source: null })

      await backendFetch(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gt_autocheck: true }),
      })
      expect(Boolean((await getJob(jobId)).gt_autocheck)).toBe(true)

      await backendFetch(`/api/jobs/${jobId}/rerun`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from_phase: 'align' }),
      })

      // The exact match now checks itself; the near one stays a suggestion, because
      // 'Paragraf' is below the bar and the transcription was not declared in order.
      await expect.poll(() => lineReading(jobId, 'Sample Header line 1'))
        .toEqual({ corrected: 'Sample Header line 1', checked: true, source: 'align' })
      await waitForJobStatus(jobId, 'done')
      expect(await lineReading(jobId, 'Sample Paragraph line 2'))
        .toEqual({ corrected: 'Sample Paragraf line 2', checked: false, source: null })
    })
})

test.describe('Scenario: matching a transcription again after a person has typed', () => {
  // README: re-running Alignment "keeps the OCR, every checked line and every correction a
  // person typed, checked or not, and offers the aligned text as a reading on those instead
  // of writing over them."
  test('a correction a person typed but never checked survives the re-run, with the aligned text offered beside it',
    async ({ page }) => {
      const jobId = await seedTranscribed(uniqueName('Align keeps typed'))
      const [pageId] = await jobPageIds(jobId)
      const lineOf = async (text: string) =>
        (await pageLines(jobId, pageId)).find((l) => l.text === text)!
      const wrote = (line: { corrected_text: string | null; corrected_by: string | null; checked: boolean }) =>
        ({ corrected_text: line.corrected_text, corrected_by: line.corrected_by, checked: line.checked })

      // The first alignment wrote the near match under its own name, and nobody checked it.
      const typed = await lineOf('Sample Paragraph line 2')
      expect(wrote(typed)).toMatchObject({ corrected_text: 'Sample Paragraf line 2', checked: false })
      expect(typed.corrected_by).toMatch(/^align:gt@/)
      await correctLine(typed.id, 'What a person typed', false)
      expect(wrote(await lineOf('Sample Paragraph line 2')))
        .toEqual({ corrected_text: 'What a person typed', corrected_by: SEEDER, checked: false })

      await rerunAlignment(page, jobId)

      // Unchecked or not, the person's text is theirs...
      expect(wrote(await lineOf('Sample Paragraph line 2')))
        .toEqual({ corrected_text: 'What a person typed', corrected_by: SEEDER, checked: false })
      // ...and the transcription's line is offered on it, as a reading signed by the match.
      const offered = (await pageCandidates(pageId))
        .filter((c) => c.line_id === typed.id && c.source === 'align')
      expect(offered.map((c) => c.text)).toEqual(['Sample Paragraf line 2'])
      expect(offered[0].author).toMatch(/^align:gt@/)

      // A line nobody typed on is matched again, exactly as the first run matched it.
      const untouched = await lineOf('Sample Header line 1')
      expect(wrote(untouched)).toMatchObject({ corrected_text: 'Sample Header line 1', checked: false })
      expect(untouched.corrected_by).toMatch(/^align:gt@/)
    })
})
