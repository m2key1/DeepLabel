import { test, expect } from '../helpers/test'
import { backendFetch, getJob, listJobs, uniqueName, waitForJobStatus } from '../helpers/api'
import { scanPng } from '../helpers/image'

// The e2e stack sets no MAPSEG_PYTHON, so it is a deployment without the map runner:
// tiling and pre-annotation cannot run here at all.
const NO_RUNNER = 'MAPSEG_PYTHON is not set, so this deployment cannot cut maps into tiles or pre-annotate them'

const tileForm = (name: string, phases: { run_predict: boolean; run_tile: boolean }) => {
  const form = new FormData()
  form.append('name', name)
  form.append('task', 'map_segmentation')
  form.append('run_predict', String(phases.run_predict))
  form.append('run_tile', String(phases.run_tile))
  form.append('files', new Blob([new Uint8Array(scanPng(64, 64))], { type: 'image/png' }), 'tile.png')
  return form
}

test.describe('Scenario: a map dataset on a deployment without the map runner', () => {
  test('the form switches tiling and pre-annotation off and says why', async ({ page }) => {
    const name = uniqueName('No runner')
    await page.goto('/new')
    await page.getByTestId('task-map_segmentation').click()

    const predict = page.getByRole('checkbox', { name: /Model pre-annotation/ })
    const tile = page.getByRole('checkbox', { name: /Process map images into tiles/ })
    await expect(predict).toBeDisabled()
    await expect(predict).not.toBeChecked()
    await expect(tile).toBeDisabled()
    await expect(tile).not.toBeChecked()
    await expect(page.getByTestId('map-phase-predict-hint')).toHaveText(NO_RUNNER)
    await expect(page.getByTestId('map-phase-tile-hint')).toHaveText(NO_RUNNER)

    await page.getByLabel('Job name').fill(name)
    await page.locator('input[type="file"]').setInputFiles([
      { name: 'tile.png', mimeType: 'image/png', buffer: scanPng(64, 64) },
    ])
    await page.getByRole('button', { name: 'Create job' }).click()
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)
    const jobId = page.url().split('/').pop()!

    // Created annotation-only, so it runs to done instead of failing on the missing runner.
    const created = await getJob(jobId)
    expect(created.run_predict).toBe(false)
    expect(created.run_tile).toBe(false)
    await waitForJobStatus(jobId, 'done')
    await expect.poll(async () => (await getJob(jobId)).error).toBeNull()
  })

  test('the API refuses a map dataset that would need it, and creates none', async () => {
    const refused = uniqueName('Refused predict')
    const tiled = uniqueName('Refused tiling')
    for (const [name, phases] of [
      [refused, { run_predict: true, run_tile: false }],
      [tiled, { run_predict: false, run_tile: true }],
    ] as const) {
      await expect(backendFetch('/api/jobs', { method: 'POST', body: tileForm(name, phases) }))
        .rejects.toThrow(`400 {"detail":"${NO_RUNNER}"}`)
    }
    const accepted = uniqueName('Annotation only')
    await backendFetch('/api/jobs', {
      method: 'POST', body: tileForm(accepted, { run_predict: false, run_tile: false }),
    })

    const names = (await listJobs()).map((j) => j.name)
    expect(names).toContain(accepted)
    expect(names).not.toContain(refused)
    expect(names).not.toContain(tiled)
  })
})
