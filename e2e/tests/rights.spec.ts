import { expect, test } from '../helpers/test'
import type { Page } from '@playwright/test'
import {
  backendFetch, correctLine, createTraining, getJob, jobPageIds, listTrainings, markLinesChecked, pageLines,
  seedCompletedJob, seedDistinctPagesJob, uniqueName,
} from '../helpers/api'
import { scanPng } from '../helpers/image'
import { createDataset } from '../helpers/new-dataset'

const CC_BY_SA = 'http://creativecommons.org/licenses/by-sa/4.0/'
const IN_COPYRIGHT_EDU = 'http://rightsstatements.org/vocab/InC-EDU/1.0/'

type Rights = { status: string | null; credit: string; transcription_licence: string | null
                history: { field: string; new: string | null; author: string }[] }
const rightsOf = async (jobId: string): Promise<Rights> => backendFetch(`/api/jobs/${jobId}/rights`)

test.describe('Scenario: rights and licences', () => {
  test('a new dataset is asked the licence of its transcriptions, with none chosen for it', async ({ page }) => {
    const name = uniqueName('Licensed')
    await page.goto('/new')
    await page.getByLabel('Job name').fill(name)
    await page.locator('input[type="file"]').setInputFiles({ name: 'folio.png', mimeType: 'image/png', buffer: scanPng() })
    const form = page.getByTestId('new-job-step')
    for (let left = 5; left > 0 && (await form.getAttribute('data-step')) !== 'review'; left--) {
      await page.getByTestId('wizard-next').click()
    }
    await expect(form).toHaveAttribute('data-step', 'review')

    const licence = page.getByTestId('new-job-licence-select')
    await expect(licence).toHaveValue('')
    await expect(page.getByTestId('wizard-missing')).toHaveText('Choose a licence for the transcriptions')
    await expect(page.getByRole('button', { name: 'Create job' })).toBeDisabled()

    await licence.selectOption({ label: 'CC BY-SA 4.0' })
    await expect(page.getByTestId('wizard-missing')).toHaveCount(0)
    await page.getByRole('button', { name: 'Create job' }).click()
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)
    const jobId = page.url().split('/').pop()!

    const made = await rightsOf(jobId)
    expect([made.status, made.transcription_licence]).toEqual([null, CC_BY_SA])
    expect(made.history.map((h) => [h.field, h.new])).toEqual([['transcription_licence', CC_BY_SA]])
  })

  test("a dataset's rights are set from its title, and every change is kept", async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Rights'), 1)
    await page.goto(`/jobs/${jobId}`)
    const chip = page.getByTestId('job-rights')
    await expect(chip).toHaveText('Rights not evaluated')

    await chip.click()
    const dialog = page.getByTestId('rights-dialog')
    await dialog.getByTestId('rights-status').selectOption({ label: 'In Copyright - Educational Use Permitted' })
    await dialog.getByTestId('rights-credit').fill('Stadtarchiv Eferding')
    await page.getByTestId('rights-save').click()

    await expect.poll(async () => {
      const held = await rightsOf(jobId)
      return [held.status, held.credit, held.history.map((h) => h.field).sort()]
    }).toEqual([IN_COPYRIGHT_EDU, 'Stadtarchiv Eferding', ['credit', 'status']])
    await expect(dialog.getByTestId('rights-change')).toHaveCount(2)
    await expect(dialog.locator('[data-testid="rights-change"][data-field="status"]'))
      .toContainText('Rights: - to In Copyright - Educational Use Permitted')
    await page.getByRole('button', { name: 'Close' }).click()
    await expect(chip).toHaveText('In Copyright - Educational Use Permitted')
    // From the dataset itself, not only from what the dialog said.
    await page.reload()
    await expect(chip).toHaveText('In Copyright - Educational Use Permitted')
  })
})

const CC_BY = 'http://creativecommons.org/licenses/by/4.0/'
const CC0 = 'http://creativecommons.org/publicdomain/zero/1.0/'
const IN_COPYRIGHT = 'http://rightsstatements.org/vocab/InC/1.0/'
const CONTRACTUAL = 'http://rightsstatements.org/vocab/NoC-CR/1.0/'

type PageRights = { own: { status: string; holder: string } | null }
const pageRightsOf = async (jobId: string, pageId: number): Promise<PageRights> =>
  backendFetch(`/api/jobs/${jobId}/pages/${pageId}/rights`)
const json = (method: string, body: unknown) =>
  ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const setRights = (jobId: string, body: Record<string, string>) =>
  backendFetch(`/api/jobs/${jobId}/rights`, json('PUT', body))
const setPageRights = (jobId: string, pageIds: number[], held: Record<string, string> | null) =>
  backendFetch(`/api/jobs/${jobId}/page-rights`, json('PUT', { page_ids: pageIds, rights: held }))

async function selectPages(page: Page, pageIds: number[]) {
  for (const id of pageIds) {
    await page.locator(`[data-page-row="${id}"]`).getByRole('checkbox').check()
  }
}

test.describe('Scenario: mixed material', () => {
  test('a page takes rights of its own in the viewer, and its dataset keeps its own', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Mixed'), 2)
    const [first, second] = await jobPageIds(jobId)
    await setRights(jobId, { status: CC_BY })

    await page.goto(`/jobs/${jobId}/pages/${second}`)
    const chip = page.getByTestId('page-rights')
    await expect(chip).toHaveAccessibleName('Rights: CC BY 4.0')
    await expect(chip).toHaveAttribute('data-own', 'false')
    await chip.click()
    const dialog = page.getByTestId('page-rights-dialog')
    await expect(dialog.getByTestId('page-rights-follow')).toBeChecked()
    await dialog.getByTestId('page-rights-own').check()
    await dialog.getByTestId('rights-status').selectOption({ label: 'In Copyright' })
    await dialog.getByTestId('rights-holder').fill('Familie Huber')
    await page.getByTestId('page-rights-save').click()

    await expect.poll(async () => (await pageRightsOf(jobId, second)).own)
      .toEqual({ status: IN_COPYRIGHT, credit: '', holder: 'Familie Huber', source: '', note: '' })
    expect((await pageRightsOf(jobId, first)).own).toBeNull()
    expect((await backendFetch(`/api/jobs/${jobId}/rights`)).status).toBe(CC_BY)
    await expect(chip).toHaveAccessibleName('Rights: In Copyright')
    await expect(chip).toHaveAttribute('data-own', 'true')
    await page.reload()
    await expect(chip).toHaveAccessibleName('Rights: In Copyright')
    await page.goto(`/jobs/${jobId}/pages/${first}`)
    await expect(chip).toHaveAccessibleName('Rights: CC BY 4.0')
  })

  test('the selected pages take rights at once, and go back to the dataset\'s', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Bulk rights'), 3)
    const [first, second, third] = await jobPageIds(jobId)
    await setRights(jobId, { status: CC_BY })

    await page.goto(`/jobs/${jobId}`)
    await selectPages(page, [first, second])
    await page.getByTestId('bulk-rights').click()
    const dialog = page.getByTestId('page-rights-dialog')
    await expect(dialog).toContainText('2 pages')
    await dialog.getByTestId('page-rights-own').check()
    await dialog.getByTestId('rights-status').selectOption({ label: 'CC0 1.0' })
    await page.getByTestId('page-rights-save').click()
    await expect(dialog).toHaveCount(0)

    await expect.poll(async () => Promise.all([first, second, third].map(async (id) => (await pageRightsOf(jobId, id)).own?.status ?? null)))
      .toEqual([CC0, CC0, null])

    await selectPages(page, [first])
    await page.locator(`[data-page-row="${second}"]`).getByRole('checkbox').uncheck()
    await page.getByTestId('bulk-rights').click()
    await expect(dialog).toContainText('1 page')
    await dialog.getByTestId('page-rights-follow').check()
    await page.getByTestId('page-rights-save').click()

    await expect.poll(async () => Promise.all([first, second].map(async (id) => (await pageRightsOf(jobId, id)).own?.status ?? null)))
      .toEqual([null, CC0])
  })
})

test.describe('Scenario: finding material by its rights', () => {
  test('the dataset list keeps to the datasets holding material under a statement', async ({ page }) => {
    const [open, mixed] = [uniqueName('Open rights'), uniqueName('Mixed rights')]
    const openId = await seedCompletedJob(open, 1)
    const mixedId = await seedCompletedJob(mixed, 2)
    await setRights(openId, { status: CC_BY })
    await setRights(mixedId, { status: CC_BY })
    await setPageRights(mixedId, [(await jobPageIds(mixedId))[1]], { status: IN_COPYRIGHT })

    await page.goto('/')
    await page.getByRole('textbox', { name: 'Search datasets' }).fill('rights')
    const rows = page.getByTestId('job-card')
    await expect(rows.filter({ hasText: open })).toHaveCount(1)
    await page.getByTestId('filter-menu').click()
    await page.getByTestId('filter-rights').selectOption({ label: 'In Copyright' })
    await expect(page).toHaveURL(new RegExp(`rights=${encodeURIComponent(IN_COPYRIGHT)}`))
    await expect(rows.filter({ hasText: mixed })).toHaveCount(1)
    await expect(rows.filter({ hasText: open })).toHaveCount(0)
    await expect(page.locator('[data-testid="filter-chip"][data-filter="rights"]')).toContainText('Rights: In Copyright')
  })

  test('Search keeps to the pages under a statement, their own or their dataset\'s', async ({ page }) => {
    const surname = `Qrz${Date.now().toString(36)}`
    const jobId = await seedCompletedJob(uniqueName('Rights search'), 2)
    const pageIds = await jobPageIds(jobId)
    const lineIds: number[] = []
    for (const pageId of pageIds) {
      const [line] = await pageLines(jobId, pageId)
      await correctLine(line.id, `Johann ${surname} Pfarrer`, false)
      lineIds.push(line.id)
    }
    await setRights(jobId, { status: CC_BY })
    await setPageRights(jobId, [pageIds[1]], { status: IN_COPYRIGHT })

    await page.goto(`/search?q=${surname}`)
    await expect(page.getByTestId('search-summary')).toHaveText('2 lines in 1 dataset')
    await page.getByTestId('search-rights').selectOption({ label: 'In Copyright' })
    await expect(page.getByTestId('search-summary')).toHaveText('1 line in 1 dataset')
    await expect(page.locator(`[data-testid="search-hit"][data-line="${lineIds[1]}"]`)).toHaveCount(1)
    await expect(page.locator(`[data-testid="search-hit"][data-line="${lineIds[0]}"]`)).toHaveCount(0)
    await page.getByTestId('search-rights').selectOption({ label: 'CC BY 4.0' })
    await expect(page.locator(`[data-testid="search-hit"][data-line="${lineIds[0]}"]`)).toHaveCount(1)
    await expect(page.locator(`[data-testid="search-hit"][data-line="${lineIds[1]}"]`)).toHaveCount(0)
  })
})

test.describe('Scenario: training on material in copyright', () => {
  test('its owner confirms once that training is permitted', async ({ page }) => {
    await page.goto('/new')
    await page.getByLabel('Job name').fill(uniqueName('In copyright'))
    await page.locator('input[type="file"]').setInputFiles({ name: 'folio.png', mimeType: 'image/png', buffer: scanPng() })
    await createDataset(page)
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)
    const jobId = page.url().split('/').pop()!

    await page.getByTestId('job-rights').click()
    const dialog = page.getByTestId('rights-dialog')
    await expect(dialog.getByTestId('rights-training')).toHaveCount(0)
    await dialog.getByTestId('rights-status').selectOption({ label: 'In Copyright' })
    await page.getByTestId('rights-save').click()
    const training = dialog.getByTestId('rights-training')
    await expect(training).toContainText('Training waits for your confirmation')
    await training.getByTestId('rights-permit-training').click()

    const owner = (await getJob(jobId)).owner
    await expect.poll(async () => (await backendFetch(`/api/jobs/${jobId}/rights`)).training.permitted?.by ?? null)
      .toBe(owner)
    await expect(training).toContainText(`Training permitted, confirmed by ${owner}`)
    await expect(training.getByTestId('rights-permit-training')).toHaveCount(0)
  })

  test("a run's material is listed with its rights", async ({ page }) => {
    test.setTimeout(120_000)
    const name = uniqueName('Run rights')
    const jobId = await seedDistinctPagesJob(name, 2, 60)
    await markLinesChecked(jobId, 12)
    await setRights(jobId, { status: CC_BY })
    await setPageRights(jobId, [(await jobPageIds(jobId))[0]], { status: CONTRACTUAL })
    await backendFetch(`/api/jobs/${jobId}/rights/training-permitted`, { method: 'POST' })
    const run = await createTraining({ task: 'ocr', name: uniqueName('Rights run'), target: 'local', epochs: 1,
                                       batch_size: 4, val_fraction: 0.5, dataset_job_ids: [jobId] })
    await expect.poll(async () => (await backendFetch(`/api/trainings/${run.id}/preflight`)).status,
                      { timeout: 30_000 }).toBe('done')
    await backendFetch(`/api/trainings/${run.id}/cancel`, { method: 'POST' })
    await expect.poll(async () => (await listTrainings()).find((t) => t.id === run.id)?.status).toBe('cancelled')

    await page.goto(`/models/runs/${run.id}?tab=data`)
    const row = page.locator(`[data-testid="run-rights-dataset"][data-job="${jobId}"]`)
    await expect(row).toContainText(name)
    await expect(row.getByTestId('run-rights-status')).toHaveText('CC BY 4.0')
    await expect(row.getByTestId('run-rights-pages')).toHaveText('1 page under No Copyright - Contractual Restrictions')
    await expect(row.getByTestId('run-rights-permitted')).toHaveText('Training permitted, confirmed by e2e-seeder')
  })
})
