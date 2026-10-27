import { test, expect } from '../helpers/test'
import {
  backendFetch, getJob, getPageDetail, importStubModel, jobPageIds, markLinesChecked, uniqueName,
  waitForJobStatus,
} from '../helpers/api'
import { scanPng } from '../helpers/image'

const json = { 'Content-Type': 'application/json' }

/** A one-page dataset read by `modelId` from the start. */
async function datasetReadBy(name: string, modelId: number): Promise<string> {
  const form = new FormData()
  form.append('name', name)
  form.append('line_mode', 'per_crop')
  form.append('model_ocr_id', String(modelId))
  form.append('files', new Blob([new Uint8Array(scanPng())], { type: 'image/png' }), 'scan_1.png')
  const { job_id: jobId } = await backendFetch('/api/jobs', { method: 'POST', body: form })
  await waitForJobStatus(jobId, 'done')
  return jobId
}

const offered = async (jobId: string) =>
  ((await backendFetch(`/api/jobs/${jobId}/newer-models`)).offers as { task: string }[]).map((o) => o.task)

test.describe('Scenario: a model gets a new version', () => {
  test('marked on the model page, it is offered to a dataset read with the old one, which re-reads with it',
    async ({ page }) => {
      const older = uniqueName('Reader v1')
      const newer = uniqueName('Reader v2')
      const olderId = importStubModel('ocr', older, 'stub-misread')
      const newerId = importStubModel('ocr', newer, 'stub-misread')
      const name = uniqueName('Read by v1')
      const jobId = await datasetReadBy(name, olderId)
      const [pageId] = await jobPageIds(jobId)
      await markLinesChecked(jobId, 1)
      expect(await offered(jobId)).toEqual([])

      await page.goto(`/models/${newerId}`)
      await page.getByRole('button', { name: 'Edit', exact: true }).click()
      await page.getByTestId('model-supersedes').selectOption(String(olderId))
      await page.getByRole('button', { name: 'Save' }).click()
      await expect(page.getByTestId('model-versions')).toHaveText(`New version of ${older}`)
      await expect.poll(async () => offered(jobId)).toEqual(['ocr'])

      await page.goto(`/jobs/${jobId}`)
      const dialog = page.getByRole('dialog', { name: `Newer models for ${name}` })
      const ocr = dialog.locator('[data-testid="newer-model"][data-task="ocr"]')
      await expect(ocr.getByTestId('newer-model-from')).toHaveText(older)
      await expect(ocr.getByTestId('newer-model-to')).toHaveText(newer)
      // The stub cuts six lines on a page, one of them checked above.
      await expect(ocr.getByTestId('newer-model-effect'))
        .toHaveText('Re-reads 5 unchecked lines; 1 checked line stay as they are.')
      await expect(ocr.getByRole('checkbox')).toBeChecked()

      await dialog.getByTestId('newer-models-run').click()
      await expect(dialog).toHaveCount(0)
      await expect.poll(async () => (await getJob(jobId)).model_ocr_id).toBe(newerId)
      await waitForJobStatus(jobId, 'done')
      // The five unchecked lines were read by the new version; the checked one keeps its reading.
      const readers = (await getPageDetail(jobId, pageId)).provenance.ocr as { model: { id: number } | null; lines: number }[]
      expect(readers.map((r) => [r.model?.id, r.lines]).sort()).toEqual([[newerId, 5], [olderId, 1]].sort())

      // Nothing is older than what it reads with now, so it is not asked again.
      await page.reload()
      await expect(page.getByRole('heading', { name })).toBeVisible()
      await expect(dialog).toHaveCount(0)
      expect(await offered(jobId)).toEqual([])
    })

  test('Not now is remembered until an even newer version appears', async ({ page }) => {
    const v1 = importStubModel('ocr', uniqueName('Kept v1'), 'stub-misread')
    const v2 = importStubModel('ocr', uniqueName('Kept v2'), 'stub-misread')
    const v3Name = uniqueName('Kept v3')
    const v3 = importStubModel('ocr', v3Name, 'stub-misread')
    const name = uniqueName('Not now')
    const jobId = await datasetReadBy(name, v1)
    await backendFetch(`/api/models/${v2}`, { method: 'PATCH', headers: json, body: JSON.stringify({ supersedes: v1 }) })

    await page.goto(`/jobs/${jobId}`)
    const dialog = page.getByRole('dialog', { name: `Newer models for ${name}` })
    await dialog.getByTestId('newer-models-decline').click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(async () => offered(jobId)).toEqual([])
    await page.reload()
    await expect(page.getByRole('heading', { name })).toBeVisible()
    await expect(dialog).toHaveCount(0)
    expect((await getJob(jobId)).model_ocr_id).toBe(v1)

    await backendFetch(`/api/models/${v3}`, { method: 'PATCH', headers: json, body: JSON.stringify({ supersedes: v2 }) })
    await page.reload()
    await expect(dialog.locator('[data-task="ocr"]').getByTestId('newer-model-to')).toHaveText(v3Name)
  })
})
