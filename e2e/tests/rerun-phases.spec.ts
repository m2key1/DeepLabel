import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/test'
import { openSettings, phaseBox, saveSettings } from '../helpers/dataset-settings'
import {
  UNASSIGNED_LINES, backendFetch, getJob, getPageDetail, jobPageIds, pageLines, seedCompletedJob, uniqueName, waitForJobStatus,
} from '../helpers/api'
import { datasetAction } from '../helpers/dataset'

const STUB_LINES = [
  'Sample Header line 1', 'Sample Header line 2', 'Sample Header line 3',
  'Sample Paragraph line 1', 'Sample Paragraph line 2', 'Sample Paragraph line 3',
]

test.describe('Scenario: re-running a phase the dataset has switched off', () => {
  test('asking for OCR again reads the lines, rather than clearing them and stopping',
    async () => {
      const jobId = await seedCompletedJob(uniqueName('OCR off'), 1)
      const [pageId] = await jobPageIds(jobId)
      await backendFetch(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_ocr: false }),
      })
      expect((await getJob(jobId)).run_ocr).toBe(false)
      // Switching a phase off keeps what it already recognised.
      expect((await pageLines(jobId, pageId)).map((l) => l.text)).toEqual(STUB_LINES)

      await backendFetch(`/api/jobs/${jobId}/rerun`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from_phase: 'ocr' }),
      })
      await waitForJobStatus(jobId, 'done')

      // Asked for explicitly, the phase runs - the same as running it on one page does.
      expect((await pageLines(jobId, pageId)).map((l) => l.text)).toEqual(STUB_LINES)
      expect((await getJob(jobId)).run_ocr).toBe(true)
    })
})

test.describe('Scenario: starting over once layout is switched off', () => {
  const phaseOption = (page: Page, phase: string) =>
    page.locator(`[data-testid="rerun-phase"][data-phase="${phase}"]`)

  async function openRerun(page: Page, jobId: string) {
    await page.goto(`/jobs/${jobId}`)
    await datasetAction(page, 'rerun-open')
  }

  test('drops the boxes, reads the whole page and leaves layout off', async ({ page }) => {
    const name = uniqueName('Start over without layout')
    const jobId = await seedCompletedJob(name, 1)
    const [pageId] = await jobPageIds(jobId)
    expect((await getPageDetail(jobId, pageId)).elements.map((e: { kind: string }) => e.kind))
      .toEqual(['content', 'content'])

    await openRerun(page, jobId)
    await expect(phaseOption(page, 'layout')).toBeVisible()
    await expect(phaseOption(page, 'start')).toHaveCount(0)
    await page.getByRole('button', { name: 'Cancel' }).click()

    await openSettings(page, name)
    await phaseBox(page, 'layout').uncheck()
    await saveSettings(page)
    await expect.poll(async () => (await getJob(jobId)).run_layout).toBe(false)

    await openRerun(page, jobId)
    await expect(page.getByRole('radio', { name: /^From the start, without layout/ }))
      .toHaveAttribute('data-phase', 'start')
    await expect(phaseOption(page, 'layout')).toHaveCount(0)
    await phaseOption(page, 'start').check()
    await expect(page.getByTestId('rerun-choices')).toContainText('6 of them')
    const answer = page.waitForResponse((r) =>
      r.url().endsWith(`/api/jobs/${jobId}/rerun`) && r.request().method() === 'POST')
    await page.getByTestId('rerun-confirm').click()
    expect((await answer).request().postDataJSON()).toMatchObject({ from_phase: 'start' })
    expect((await answer).status()).toBe(200)
    await waitForJobStatus(jobId, 'done')

    await expect.poll(async () => (await getPageDetail(jobId, pageId)).elements
      .map((e: { kind: string; lines: { text: string | null }[] }) => [e.kind, e.lines.map((l) => l.text)]))
      .toEqual([['orphan', UNASSIGNED_LINES]])
    expect(await getJob(jobId)).toMatchObject({
      status: 'done', run_layout: false, run_lines: true, run_ocr: true, line_mode: 'per_page',
    })
  })
})
