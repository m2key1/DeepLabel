import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/test'
import {
  OCR_AUTHOR, UNASSIGNED_LINES, backendFetch, correctLine, getPageDetail, getReocrPreview, jobPageIds, pageLines,
  patchJob, seedCompletedJob, seedJobWithoutLayout, uniqueName, waitForJobStatus,
} from '../helpers/api'
import type { PageLine } from '../helpers/api'
import { openViewer } from '../helpers/viewer'
import { datasetAction } from '../helpers/dataset'

const STUB_LINES = [
  'Sample Header line 1', 'Sample Header line 2', 'Sample Header line 3',
  'Sample Paragraph line 1', 'Sample Paragraph line 2', 'Sample Paragraph line 3',
]

type RerunPhase = 'layout' | 'lines' | 'ocr'

/** The dataset page's Re-run dialog, confirmed the way a person does it, and the dataset
 *  waited for until the runner is through. `keep` picks the second choice the detection
 *  phases ask: re-offer the text on what is found (true) or start the pages clean (false). */
async function rerunFromDialog(page: Page, jobId: string, phase: RerunPhase, keep?: boolean) {
  await page.goto(`/jobs/${jobId}`)
  await datasetAction(page, 'rerun-open')
  await page.locator(`[data-testid="rerun-phase"][data-phase="${phase}"]`).check()
  if (keep !== undefined) {
    await page.locator(`[data-testid="rerun-choice"][data-keep="${keep}"]`).check()
  }
  const answer = page.waitForResponse((r) =>
    r.url().endsWith(`/api/jobs/${jobId}/rerun`) && r.request().method() === 'POST')
  await page.getByTestId('rerun-confirm').click()
  expect((await answer).status()).toBe(200)
  await waitForJobStatus(jobId, 'done')
}

/** [text, correction] of every line somebody corrected, in reading order. */
async function corrections(jobId: string, pageId: number) {
  return (await pageLines(jobId, pageId))
    .filter((l) => l.corrected_text !== null)
    .map((l) => [l.text, l.corrected_text])
}

async function reshapeLine(lineId: number, polygon: number[][]) {
  return backendFetch(`/api/lines/${lineId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ polygon }),
  })
}

test.describe('Scenario: reading one page again', () => {
  test('re-reads the lines of that page and leaves the other pages exactly as they were',
    async ({ page }) => {
      const jobId = await seedCompletedJob(uniqueName('One page re-read'), 2)
      const [runPage, otherPage] = await jobPageIds(jobId)
      // Greedy from here on: the stub signs a greedy reading '#greedy', so the lines this run
      // reads are tellable from the first run's although the words come back identical.
      await patchJob(jobId, { ocr_decode: 'greedy' })
      const [first] = await pageLines(jobId, otherPage)
      await correctLine(first.id, 'Kept on the other page')
      const otherBefore = await pageLines(jobId, otherPage)
      expect(otherBefore.map((l) => l.text)).toEqual(STUB_LINES)
      const runBefore = await pageLines(jobId, runPage)

      await openViewer(page, jobId, runPage)
      await page.getByTestId('run-menu').click()
      const ocr = page.locator('[data-testid="run-phase"][data-phase="ocr"]')
      await expect(ocr).toContainText('re-reads 6 lines')
      const answer = page.waitForResponse((r) =>
        r.url().endsWith(`/api/pages/${runPage}/run`) && r.request().method() === 'POST')
      await ocr.click()
      expect((await answer).status()).toBe(200)
      await waitForJobStatus(jobId, 'done')

      // Backend oracle: who last read each live line. Six lines read greedily - the run
      // page's - and the other page's six still signed by the first pass.
      await expect.poll(async () => [...(await getReocrPreview(jobId)).authors]
        .sort((a, b) => a.author.localeCompare(b.author))).toEqual([
        { author: OCR_AUTHOR, lines: 6 },
        { author: `${OCR_AUTHOR}#greedy`, lines: 6 },
      ])
      const runAfter = await pageLines(jobId, runPage) as (PageLine & { text_author: string })[]
      expect(runAfter.map((l) => l.id)).toEqual(runBefore.map((l) => l.id))
      expect(runAfter.map((l) => [l.text, l.text_author]))
        .toEqual(STUB_LINES.map((text) => [text, `${OCR_AUTHOR}#greedy`]))
      // Not a text, correction, check or revision on the other page moved.
      expect(await pageLines(jobId, otherPage)).toEqual(otherBefore)
    })
})

test.describe('Scenario: detecting again and starting the pages clean', () => {
  test('a correction made after the clean run is the only one the next edit leaves standing',
    async ({ page }) => {
      const jobId = await seedCompletedJob(uniqueName('Clean re-run'), 1)
      const [pageId] = await jobPageIds(jobId)
      const [header1] = await pageLines(jobId, pageId)
      expect(header1.text).toBe('Sample Header line 1')
      await correctLine(header1.id, 'Old correction')

      // Re-offered once, as the careful answer promises: the correction rides the pool
      // onto the line detected in the same place.
      await rerunFromDialog(page, jobId, 'lines', true)
      await expect.poll(async () => corrections(jobId, pageId))
        .toEqual([['Sample Header line 1', 'Old correction']])

      // Then asked to start clean - "corrected and checked are not offered again".
      await rerunFromDialog(page, jobId, 'lines', false)
      await expect.poll(async () => (await pageLines(jobId, pageId))
        .map((l) => [l.text, l.corrected_text, l.checked]))
        .toEqual(STUB_LINES.map((text) => [text, null, false]))

      const paragraph1 = (await pageLines(jobId, pageId))[3]
      expect(paragraph1.text).toBe('Sample Paragraph line 1')
      await correctLine(paragraph1.id, 'New correction')
      // Any edit of the page's geometry puts the pool right again - here a nudge to the
      // line just corrected, which is checked and so is not queued for another read.
      await reshapeLine(paragraph1.id, paragraph1.polygon.map(([x, y]) => [x, y + 0.005]))

      await expect.poll(async () => corrections(jobId, pageId))
        .toEqual([['Sample Paragraph line 1', 'New correction']])
    })
})

test.describe('Scenario: detecting lines again on a page that never had layout', () => {
  const kindAndLines = (e: { kind: string; lines: { text: string | null }[] }) =>
    [e.kind, e.lines.map((l) => l.text)]

  test('its lines land in the one unassigned bucket, not in a second one beside it',
    async ({ page }) => {
      const jobId = await seedJobWithoutLayout(uniqueName('Bucket re-run'), 1)
      const [pageId] = await jobPageIds(jobId)
      const before = await getPageDetail(jobId, pageId)
      expect(before.elements.map(kindAndLines)).toEqual([['orphan', UNASSIGNED_LINES]])

      await rerunFromDialog(page, jobId, 'lines')

      await expect.poll(async () => (await pageLines(jobId, pageId)).map((l) => l.text))
        .toEqual(UNASSIGNED_LINES)
      // Backend oracle: the elements the page lists. One bucket holds the three lines;
      // the one they were in before is not left standing empty beside it.
      const after = await getPageDetail(jobId, pageId)
      expect(after.elements.map(kindAndLines)).toEqual([['orphan', UNASSIGNED_LINES]])
    })
})
