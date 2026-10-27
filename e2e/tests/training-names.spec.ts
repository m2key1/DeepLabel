import { test, expect } from '../helpers/test'
import {
  backendFetch, createTraining, listRegistryModels, listTrainings, markLinesChecked, seedCompletedJob,
  uniqueName,
} from '../helpers/api'

test.describe('Scenario: naming a new model', () => {
  test("a retired model's name is still taken, and the form says so before submitting",
    async ({ page }) => {
      const jobId = await seedCompletedJob(uniqueName('Retired source'), 1)
      await markLinesChecked(jobId, 6)
      const retiredName = uniqueName('Retired reader')
      await createTraining({
        task: 'ocr', name: retiredName, dataset_job_ids: [jobId], target: 'local',
        epochs: 1, batch_size: 4, val_fraction: 0.3,
      })
      await expect.poll(async () => (await listTrainings()).find((t) => t.name === retiredName)?.status,
                        { timeout: 60_000 }).toBe('done')
      const model = (await listRegistryModels()).find((m) => m.name === retiredName)!
      await backendFetch(`/api/models/${model.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: true }),
      })
      // Gone from the live registry, still on record among the retired.
      expect((await listRegistryModels()).some((m) => m.id === model.id)).toBe(false)
      expect((await listRegistryModels(true)).some((m) => m.id === model.id)).toBe(true)

      // The backend refuses the name: that is the truth the form has to tell in advance.
      await expect(createTraining({
        task: 'ocr', name: retiredName, dataset_job_ids: [jobId], target: 'local',
        epochs: 1, batch_size: 4, val_fraction: 0.3,
      })).rejects.toThrow(/409/)

      await page.goto('/models/train?task=ocr')
      await page.getByLabel('Model name').fill(retiredName)
      await expect(page.getByTestId('name-taken')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled()

      // A free name clears it, so the warning above is about the name and nothing else.
      await page.getByLabel('Model name').fill(uniqueName('Fresh reader'))
      await expect(page.getByTestId('name-taken')).toHaveCount(0)
    })

  // README: a name "is refused while another run is still training under it, since each
  // run registers its model under its own name and the pair would be indistinguishable
  // afterwards". A retry is a run about to register a model, and is held to the same rule.
  test('a failed run cannot be retried under a name a model has taken since', async ({ page }) => {
    // The probe is one ssh to a host that is never reached: where the name does not
    // resolve it gives up at once, where it is black-holed it gives up at its 15 s connect
    // timeout.
    test.setTimeout(120_000)
    const jobId = await seedCompletedJob(uniqueName('Retry source'), 1)
    await markLinesChecked(jobId, 6)
    const name = uniqueName('Retaken')
    const submit = (body: Record<string, unknown>) =>
      createTraining({ task: 'ocr', name, dataset_job_ids: [jobId], ...body })
    const runNamed = async (target: string) =>
      (await listTrainings()).find((t) => t.name === name && t.target === target)

    // A cluster submit with no session open fails before anything is cut...
    await submit({ target: 'slurm', gpu_type: 'h200', gpu_count: 1 })
    await expect.poll(async () => (await runNamed('slurm'))?.status, { timeout: 60_000 }).toBe('error')
    // ...which frees the name: a local run takes it and registers a model under it.
    await submit({ target: 'local', epochs: 1, batch_size: 4, val_fraction: 0.3 })
    await expect.poll(async () => (await runNamed('local'))?.status, { timeout: 60_000 }).toBe('done')
    expect((await listRegistryModels()).some((m) => m.name === name)).toBe(true)

    // Retrying the failed run would register a second model under the name, so the rule
    // that refuses a new run under it refuses this too - and the run stays as it was.
    const failed = (await runNamed('slurm'))!
    await expect(backendFetch(`/api/trainings/${failed.id}/retry`, { method: 'POST' }))
      .rejects.toThrow(/409/)
    expect(await runNamed('slurm')).toMatchObject({ status: 'error', attempt: 1 })

    // The page offers the retry on the failed row, and shows the refusal in place.
    await page.goto('/models?tab=runs')
    const rows = page.getByTestId('training-row').filter({ hasText: name })
    await expect(rows).toHaveCount(2)
    const failedRow = rows.filter({ hasText: 'cluster' })
    await failedRow.getByTestId('run-actions').click()
    await failedRow.getByTestId('retry-training').click()
    await expect(page.getByText(/already exists/)).toBeVisible()
    expect(await runNamed('slurm')).toMatchObject({ status: 'error', attempt: 1 })
  })
})
