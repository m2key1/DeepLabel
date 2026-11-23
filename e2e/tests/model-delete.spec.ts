import { expect, test } from '../helpers/test'
import {
  backendFetch, createJob, createTraining, getJob, identity, importStubModel, listRegistryModels, listTrainings,
  markLinesChecked, uniqueName, waitForJobStatus,
} from '../helpers/api'
import { seedSession, useSession } from '../helpers/session'

const archive = (modelId: number, headers: Record<string, string> = {}) =>
  backendFetch(`/api/models/${modelId}`, {
    method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: true }),
  })

test.describe('Scenario: deleting a model for good', () => {
  test('the member who trained it archives it, then deletes it with its run', async ({ browser }) => {
    const trainer = `model-deleter-${Date.now()}`
    const mine = identity(trainer, 'manager')
    const context = await browser.newContext()
    await useSession(context, seedSession('manager', trainer))
    const page = await context.newPage()

    const jobId = await createJob(uniqueName('Deleted model data'), 1, undefined, mine)
    await waitForJobStatus(jobId, 'done')
    await markLinesChecked(jobId, 3)
    const modelName = uniqueName('Deleted model')
    const created = await createTraining({ task: 'ocr', name: modelName, dataset_job_ids: [jobId], target: 'local',
                                           epochs: 1 }, mine)
    await expect.poll(async () => (await listRegistryModels()).find((m) => m.name === modelName)?.id ?? null,
                      { timeout: 60_000 }).not.toBeNull()
    const model = (await listRegistryModels()).find((m) => m.name === modelName)!
    await backendFetch(`/api/jobs/${jobId}`, {
      method: 'PATCH', headers: { ...mine, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_ocr_id: model.id }),
    })

    // In use, it is archived first; Delete is the second step.
    await page.goto(`/models/${model.id}`)
    await expect(page.getByTestId('archive-model')).toHaveText('Archive')
    await expect(page.getByTestId('delete-model')).toHaveCount(0)
    await page.getByTestId('archive-model').click()
    await expect(page.getByTestId('archive-model')).toHaveText('Unarchive')
    await expect.poll(async () => (await listRegistryModels(true)).find((m) => m.id === model.id)?.archived).toBe(true)

    let asked = ''
    page.once('dialog', (dialog) => { asked = dialog.message(); void dialog.accept() })
    await page.getByTestId('delete-model').click()
    await expect(page).toHaveURL(/\/models$/)
    expect(asked).toBe(`Delete "${modelName}", its training run and its checkpoint for good?\n\n`
      + '1 dataset set to it will fall back to the default model.')

    await expect.poll(async () => (await listRegistryModels(true)).some((m) => m.id === model.id)).toBe(false)
    expect((await listTrainings()).some((t) => t.id === created.id)).toBe(false)
    expect((await getJob(jobId)).model_ocr_id).toBeNull()
    await context.close()
  })

  test('a model nobody trained is deleted by an admin only', async ({ page, browser }) => {
    const name = uniqueName('Imported, retired')
    const modelId = importStubModel('ocr', name, 'stub-misread')
    await archive(modelId)

    const member = `model-onlooker-${Date.now()}`
    const context = await browser.newContext()
    await useSession(context, seedSession('manager', member))
    const memberPage = await context.newPage()
    await memberPage.goto(`/models/${modelId}`)
    await expect(memberPage.getByRole('heading', { level: 1 })).toContainText(name)
    await expect(memberPage.getByTestId('delete-model')).toHaveCount(0)
    await context.close()

    await page.goto(`/models/${modelId}`)
    let asked = ''
    page.once('dialog', (dialog) => { asked = dialog.message(); void dialog.accept() })
    await page.getByTestId('delete-model').click()
    await expect(page).toHaveURL(/\/models$/)
    expect(asked).toBe(`Delete "${name}" and its stored weights for good?`)
    await expect.poll(async () => (await listRegistryModels(true)).some((m) => m.id === modelId)).toBe(false)
  })
})
