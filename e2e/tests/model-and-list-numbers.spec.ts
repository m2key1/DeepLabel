import { test, expect } from '../helpers/test'
import {
  backendFetch, createTraining, getJob, getPageDetail, jobPageIds, listJobs, listRegistryModels,
  listTrainings, markLinesChecked, patchJob, seedCompletedJob, uniqueName, waitForJobStatus,
} from '../helpers/api'
import { scanPng } from '../helpers/image'
import { TILE } from '../helpers/map'

const json = { 'Content-Type': 'application/json' }

async function trainedOcrModel(name: string) {
  const jobId = await seedCompletedJob(uniqueName('Model source'), 1)
  await markLinesChecked(jobId, 6)
  await createTraining({ task: 'ocr', name, dataset_job_ids: [jobId], target: 'local',
                         epochs: 1, batch_size: 4, val_fraction: 0.3 })
  await expect.poll(async () => (await listTrainings()).find((t) => t.name === name)?.status,
                    { timeout: 60_000 }).toBe('done')
  return (await listRegistryModels()).find((m) => m.name === name)!
}

test.describe('Scenario: a dataset pinned to a model that was archived since', () => {
  test('the picker shows the model it still runs, and saving another setting keeps it', async ({ page }) => {
    const modelName = uniqueName('Retired but pinned')
    const model = await trainedOcrModel(modelName)
    const datasetName = uniqueName('Pinned dataset')
    const jobId = await seedCompletedJob(datasetName, 1)
    await patchJob(jobId, { model_ocr_id: model.id })
    await backendFetch(`/api/models/${model.id}`, {
      method: 'PATCH', headers: json, body: JSON.stringify({ archived: true }),
    })
    expect((await getJob(jobId)).model_ocr_id).toBe(model.id)

    await page.goto('/')
    const card = page.getByTestId('job-card').filter({ hasText: datasetName })
    await card.getByTestId('job-menu').click()
    await card.getByRole('button', { name: 'Models…' }).click()
    await expect(page.getByTestId('model-pick-ocr')).toHaveValue(String(model.id))

    await page.getByTestId('pick-decode').selectOption('greedy')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect.poll(async () => {
      const job = await getJob(jobId)
      return { model: job.model_ocr_id, decode: job.ocr_decode }
    }).toEqual({ model: model.id, decode: 'greedy' })
  })
})

test.describe('Scenario: the registry always has a default to fall back on', () => {
  test('one request cannot make a model the default and archive it at once', async () => {
    const model = await trainedOcrModel(uniqueName('Default and gone'))
    const defaultBefore = (await listRegistryModels()).find((m) => m.task === 'ocr' && m.is_default)!

    await expect(backendFetch(`/api/models/${model.id}`, {
      method: 'PATCH', headers: json, body: JSON.stringify({ is_default: true, archived: true }),
    })).rejects.toThrow(/409/)
    const ocrDefaults = (await listRegistryModels()).filter((m) => m.task === 'ocr' && m.is_default)
    expect(ocrDefaults.map((m) => m.id)).toEqual([defaultBefore.id])
  })
})

test.describe("Scenario: the dataset list's numbers match the dataset's own", () => {
  test('tiles that are duplicates are not counted among those to review', async ({ page }) => {
    const name = uniqueName('Duplicate in the list')
    const form = new FormData()
    form.append('name', name)
    form.append('task', 'map_segmentation')
    form.append('run_predict', 'false')
    form.append('run_tile', 'false')
    for (const [variant, file] of [[0, 'a.png'], [0, 'a_again.png'], [1, 'b.png']] as const) {
      form.append('files', new Blob([new Uint8Array(scanPng(TILE.width, TILE.height, variant))],
                                    { type: 'image/png' }), file)
    }
    const { job_id: jobId } = await backendFetch('/api/jobs', { method: 'POST', body: form })
    await waitForJobStatus(jobId, 'done')
    const tiles = [...(await getJob(jobId)).pages].sort((a, b) => a.idx - b.idx)
    expect(tiles.map((t: { status: string }) => t.status)).toEqual(['done', 'duplicate', 'done'])
    for (const tile of [tiles[0], tiles[2]]) {
      await backendFetch(`/api/pages/${tile.id}`, {
        method: 'PATCH', headers: json, body: JSON.stringify({ layout_checked: true }),
      })
    }

    const listed = (await listJobs()).find((j) => j.id === jobId) as unknown as { pages_total: number }
    expect(listed.pages_total).toBe((await getJob(jobId)).tiles_total)

    await page.goto('/')
    const link = page.getByTestId('job-card').filter({ hasText: name }).getByTestId('layout-progress-link')
    await expect(link).toHaveAttribute('title', '2 of 2 tiles reviewed')
  })

  test('lines inside a container box are not counted as lines to review', async () => {
    const jobId = await seedCompletedJob(uniqueName('Container in the list'), 1)
    const [pageId] = await jobPageIds(jobId)
    const elements = (await getPageDetail(jobId, pageId)).elements as
      { id: number; class_name: string; lines: { id: number }[] }[]
    const header = elements.find((e) => e.class_name === 'Header')!
    const paragraph = elements.find((e) => e.class_name === 'Paragraph')!
    for (const line of header.lines) {
      await backendFetch(`/api/lines/${line.id}`, {
        method: 'PATCH', headers: json, body: JSON.stringify({ checked: true }),
      })
    }
    await backendFetch(`/api/elements/${paragraph.id}`, {
      method: 'PATCH', headers: json, body: JSON.stringify({ class_name: 'Table' }),
    })

    // The table's three lines are out of the reading, as the page table counts them.
    await expect.poll(async () => {
      const row = (await listJobs()).find((j) => j.id === jobId) as unknown as
        { lines_total: number; lines_done: number }
      return { total: row.lines_total, done: row.lines_done }
    }).toEqual({ total: 3, done: 3 })
  })

  test('a dataset can be picked from its card as it can from its row', async ({ page }) => {
    const name = uniqueName('Pick a card')
    await seedCompletedJob(name, 1)
    await page.goto('/')
    await expect(page.getByLabel(`Select ${name}`)).toHaveCount(1)
    await page.goto('/?view=cards')
    await expect(page.getByLabel(`Select ${name}`)).toHaveCount(1)
    await page.getByLabel(`Select ${name}`).check()
    await expect(page.getByTestId('bulk-bar')).toContainText('1 selected')
  })
})
