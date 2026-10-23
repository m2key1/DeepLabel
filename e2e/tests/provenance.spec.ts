import { test, expect } from '../helpers/test'
import {
  correctLine, drawLine, getPageDetail, jobPageIds, listRegistryModels, seedCompletedJob, uniqueName,
} from '../helpers/api'
import { openViewer } from '../helpers/viewer'

type Model = { id: number; hash: string | null } | null

const tag = (model: Model) => (model ? model.hash ?? `#${model.id}` : '-')

test.describe('Scenario: which models produced a page', () => {
  test('the footer names the models and counts the hand work', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Provenance'), 1)
    const [pageId] = await jobPageIds(jobId)
    const models = await listRegistryModels()
    const defaultOf = (task: string) => models.find((m) => m.task === task && m.is_default)!.id
    const [layoutId, linesId, ocrId] = ['layout', 'lines', 'ocr'].map(defaultOf)

    const detail = await getPageDetail(jobId, pageId)
    const firstLine = detail.elements.flatMap((e: { lines: { id: number }[] }) => e.lines)[0]
    await correctLine(firstLine.id, 'Corrected by a person')
    await drawLine(pageId, [[0.1, 0.9], [0.9, 0.9], [0.9, 0.95], [0.1, 0.95]])

    // The backend credits each stage to the dataset's model and counts the hand work.
    await expect.poll(async () => {
      const p = (await getPageDetail(jobId, pageId)).provenance
      return {
        layout: p.layout?.id, lines: p.lines?.id, total: p.lines_total, byHand: p.lines_by_hand,
        ocr: p.ocr.map((r: { model: Model; lines: number }) => [r.model?.id, r.lines]), corrected: p.ocr_corrected,
      }
    }).toEqual({ layout: layoutId, lines: linesId, total: 7, byHand: 1, ocr: [[ocrId, 6]], corrected: 1 })
    const provenance = (await getPageDetail(jobId, pageId)).provenance

    await openViewer(page, jobId, pageId)
    const chip = page.getByTestId('model-provenance')
    await expect(chip).toHaveText(
      `L ${tag(provenance.layout)} · S ${tag(provenance.lines)} · O ${tag(provenance.ocr[0].model)}`)
    await expect(page.getByTestId('provenance-popover')).toHaveCount(0)

    await chip.click()
    const popover = page.getByTestId('provenance-popover')
    await expect(popover).toBeVisible()
    const rows = popover.getByTestId('provenance-row')
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(0)).toHaveAttribute('data-stage', 'layout')
    await expect(rows.nth(0)).toHaveAttribute('data-model-id', String(layoutId))
    await expect(rows.nth(1)).toHaveAttribute('data-model-id', String(linesId))
    await expect(rows.nth(1)).toContainText('7 lines (1 by hand)')
    await expect(rows.nth(2)).toHaveAttribute('data-model-id', String(ocrId))
    await expect(rows.nth(2)).toContainText('6 lines')
    await expect(popover.getByTestId('provenance-corrected')).toHaveText('1 line corrected by hand.')
    await expect(rows.nth(2).getByRole('link')).toHaveAttribute('href', `/models/${ocrId}`)

    await page.keyboard.press('Escape')
    await expect(popover).toHaveCount(0)
  })
})
