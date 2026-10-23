import { expect, type Page } from '@playwright/test'
import {
  backendFetch, createTraining, listRegistryModels, listTrainings, markLinesChecked, seedDistinctPagesJob, uniqueName,
} from './api'

/** Submit the training form: Next opens the pre-flight review, and the run
 *  starts from its Train button. */
export async function startTraining(page: Page) {
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await page.getByTestId('training-review').getByRole('button', { name: 'Train', exact: true }).click()
}

/** A dataset's row in the picker, found the way a person finds one in a long list: by
 *  searching for it, which also opens the folded group it sits in. */
export async function datasetOption(page: Page, name: string) {
  await page.getByRole('searchbox', { name: 'Search datasets' }).fill(name)
  return page.getByTestId('dataset-option').filter({ hasText: name }).first()
}

export async function pickDataset(page: Page, name: string) {
  await (await datasetOption(page, name)).getByRole('checkbox').check()
}

/** One task's block on the models page: its models, its archive and its Train button. */
export function taskSection(page: Page, task: 'layout' | 'lines' | 'ocr') {
  return page.locator(`[data-testid="task-section"][data-task="${task}"]`)
}

/** A model's row on its family's graph, on the stage tab the page is showing: its family
 *  is everything descended from the same root, opened if it starts folded. */
export async function versionRow(page: Page, task: 'layout' | 'lines' | 'ocr', modelId: number) {
  const models = await listRegistryModels(true)
  let root = models.find((m) => m.id === modelId)!
  while (root.trained_from !== null && models.some((m) => m.id === root.trained_from)) {
    root = models.find((m) => m.id === root.trained_from)!
  }
  const section = taskSection(page, task)
  const family = section.locator(`[data-testid="model-family"][data-root="${root.id}"]`)
  const toggle = family.getByTestId('family-toggle')
  await expect(section.getByTestId('family-toggle').first()).toBeVisible()
  // A family with nothing live left is folded into the archived group at the bottom.
  const archived = section.getByTestId('archived-families-toggle')
  if (await family.count() === 0 && await archived.getAttribute('aria-expanded') === 'false') await archived.click()
  await expect(toggle).toBeVisible()
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  return family.locator(`[data-testid="version-row"][data-version="m${modelId}"]`)
}

/** A run cancelled before it trained, with the pre-flight its submit computed: a finished
 *  run in seconds rather than after a training. */
export async function cancelledRun(name: string): Promise<number> {
  const jobId = await seedDistinctPagesJob(uniqueName(`${name} data`), 2, 40)
  await markLinesChecked(jobId, 12)
  const created = await createTraining({
    task: 'ocr', name: uniqueName(name), target: 'local', epochs: 1, batch_size: 4,
    val_fraction: 0.5, dataset_job_ids: [jobId],
  })
  await expect.poll(async () => (await backendFetch(`/api/trainings/${created.id}/preflight`)).status,
                    { timeout: 30_000 }).toBe('done')
  await backendFetch(`/api/trainings/${created.id}/cancel`, { method: 'POST' })
  await expect.poll(async () => (await listTrainings()).find((t) => t.id === created.id)?.status)
    .toBe('cancelled')
  return created.id
}
