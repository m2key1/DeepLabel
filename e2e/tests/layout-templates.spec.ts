import { test, expect } from '../helpers/test'
import {
  backendFetch, getJob, getPageDetail, importStubModel, jobPageIds, listRegistryModels, markLayoutChecked,
  seedCompletedJob, uniqueName, waitForJobStatus,
} from '../helpers/api'
import { scanPng } from '../helpers/image'
import { enterEditMode, openViewer } from '../helpers/viewer'
import { pickDataset } from '../helpers/training'

interface LayoutClass { id: number; name: string; role: string; reads: string | null; color: string | null }

const templates = async (): Promise<{ id: number; name: string; is_default: boolean; outside_order: string
  classes: LayoutClass[] }[]> =>
  (await backendFetch('/api/layout-templates')).templates

const datasetClasses = async (jobId: string): Promise<(LayoutClass & { elements: number })[]> =>
  (await backendFetch(`/api/jobs/${jobId}/layout-classes`)).classes

const shape = (classes: LayoutClass[]) => classes.map((c) => [c.name, c.role, c.reads])

async function letterTemplate(name: string): Promise<number> {
  const made = await backendFetch('/api/layout-templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      classes: [{ name: 'Salutation' }, { name: 'Body' }, { name: 'Panel', role: 'container', reads: 'across' }],
    }),
  })
  return made.id
}

/** A dataset made from a template - with nothing run on it unless `run`: then its boxes
 *  are the scenario's own. */
async function letterDataset(templateId: number, run = false, name = uniqueName('Letters')): Promise<{ jobId: string; pageId: number }> {
  const form = new FormData()
  form.append('name', name)
  form.append('run_layout', String(run))
  form.append('run_lines', String(run))
  form.append('run_ocr', String(run))
  form.append('layout_template_id', String(templateId))
  form.append('files', new Blob([new Uint8Array(scanPng())], { type: 'image/png' }), 'letter.png')
  const { job_id: jobId } = await backendFetch('/api/jobs', { method: 'POST', body: form })
  await waitForJobStatus(jobId, 'done')
  const [pageId] = await jobPageIds(jobId)
  return { jobId, pageId }
}

async function drawBox(pageId: number, className: string, bbox: number[]) {
  await backendFetch(`/api/pages/${pageId}/elements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ class_name: className, bbox }),
  })
}

test.describe('Scenario: layout classes from templates', () => {
  test('a template made on the templates page is what a new dataset copies its classes from', async ({ page }) => {
    const name = uniqueName('Letter template')
    await page.goto('/templates')
    await page.getByTestId('new-template').click()
    await page.getByLabel('Name', { exact: true }).fill(name)
    const rows = page.getByTestId('class-row')
    await rows.nth(0).getByLabel('Class name').fill('Salutation')
    await page.getByTestId('add-class').click()
    await rows.nth(1).getByLabel('Class name').fill('Body')
    await page.getByTestId('add-class').click()
    await rows.nth(2).getByLabel('Class name').fill('Panel')
    await rows.nth(2).getByLabel(/^Role of/).selectOption('container-across')
    await page.getByTestId('save-template').click()
    await expect(page.getByRole('status')).toContainText(`Saved "${name}"`)
    await expect.poll(async () => (await templates()).find((t) => t.name === name)?.classes.map((c) => [c.id, ...shape([c])[0]]))
      .toEqual([[1, 'Salutation', 'content', null], [2, 'Body', 'content', null], [3, 'Panel', 'container', 'across']])

    const dataset = uniqueName('Letters')
    await page.goto('/new')
    await page.getByLabel('Job name').fill(dataset)
    await page.locator('input[type="file"]').setInputFiles([{ name: 'letter.png', mimeType: 'image/png', buffer: scanPng() }])
    // Schematismus is what a dataset gets unless something else is chosen.
    const picker = page.getByTestId('layout-template-choice')
    const schematismus = (await templates()).find((t) => t.name === 'Schematismus')!
    await expect(picker).toHaveValue(String(schematismus.id))
    const chosen = (await templates()).find((t) => t.name === name)!
    await picker.selectOption(String(chosen.id))
    await expect(page.getByTestId('layout-template-summary')).toHaveText('Salutation, Body · containers: Panel')
    await page.getByRole('button', { name: 'Create job' }).click()
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)
    const jobId = page.url().split('/').pop()!
    expect(shape(await datasetClasses(jobId))).toEqual(
      [['Salutation', 'content', null], ['Body', 'content', null], ['Panel', 'container', 'across']])
  })

  test('a dataset\'s classes are edited in place, its boxes follow, and the editor offers them', async ({ page }) => {
    const { jobId, pageId } = await letterDataset(await letterTemplate(uniqueName('Letters template')))
    await drawBox(pageId, 'Body', [0.1, 0.2, 0.6, 0.4])
    await page.goto(`/jobs/${jobId}`)
    await page.getByTestId('layout-classes').click()
    const body = page.locator('[data-testid="dataset-class"][data-class-name="Body"]')
    await expect(body.getByTestId('class-elements')).toHaveText('1 box')
    await body.getByLabel('Name of Body').fill('Text')
    await body.getByLabel('Name of Body').press('Enter')
    await expect(page.getByRole('status')).toHaveText('1 box of Body changed with it.')
    await expect.poll(async () => (await getPageDetail(jobId, pageId)).elements.map((e: { class_name: string }) => e.class_name))
      .toEqual(['Text'])

    await page.getByLabel('New class name').fill('Seal')
    await page.getByRole('button', { name: 'Add class' }).click()
    await expect.poll(async () => (await datasetClasses(jobId)).map((c) => [c.id, c.name]))
      .toEqual([[1, 'Salutation'], [2, 'Text'], [3, 'Panel'], [4, 'Seal']])

    await openViewer(page, jobId, pageId)
    await enterEditMode(page)
    const pill = (name: string) => page.locator(`[data-testid="pen-pill"][data-class="${name}"]`)
    await expect(pill('Text')).toBeVisible()
    await expect(pill('Seal')).toBeVisible()
    await expect(pill('Paragraph')).toHaveCount(0)
    // The dataset's container stands among the containers, not the content.
    const containers = page.getByTestId('class-list').filter({ has: pill('Panel') })
    await expect(containers).toHaveCount(1)
    await expect(containers.locator('[data-testid="pen-pill"]')).toHaveCount(1)
  })

  test('a class removed into another hands its boxes over, and its id is never given out again', async ({ page }) => {
    const { jobId, pageId } = await letterDataset(await letterTemplate(uniqueName('Letters template')))
    await drawBox(pageId, 'Salutation', [0.1, 0.1, 0.5, 0.15])
    await page.goto(`/jobs/${jobId}`)
    await page.getByTestId('layout-classes').click()
    await page.getByLabel('Remove Salutation').click()
    await page.getByTestId('remove-class').getByLabel('Merge into').selectOption({ label: 'Make them Body' })
    await page.getByTestId('confirm-remove-class').click()
    await expect(page.getByRole('status')).toHaveText('Removed Salutation; its box is now Body.')
    await expect.poll(async () => (await getPageDetail(jobId, pageId)).elements.map((e: { class_name: string }) => e.class_name))
      .toEqual(['Body'])
    await page.getByLabel('New class name').fill('Greeting')
    await page.getByRole('button', { name: 'Add class' }).click()
    await expect.poll(async () => (await datasetClasses(jobId)).map((c) => [c.id, c.name]))
      .toEqual([[2, 'Body'], [3, 'Panel'], [4, 'Greeting']])
  })

  test('a Schematismus dataset keeps its classes\' names but takes a colour', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Volume'), 1)
    const [pageId] = await jobPageIds(jobId)
    await page.goto(`/jobs/${jobId}`)
    await page.getByTestId('layout-classes').click()
    const paragraph = page.locator('[data-testid="dataset-class"][data-class-name="Paragraph"]')
    await expect(paragraph.getByLabel('Name of Paragraph')).toBeDisabled()
    await expect(paragraph.getByLabel('Role of Paragraph')).toBeDisabled()
    await expect(paragraph.getByLabel('Remove Paragraph')).toHaveCount(0)
    await paragraph.getByLabel('Colour of Paragraph').fill('#336699')
    await expect.poll(async () => (await datasetClasses(jobId)).find((c) => c.name === 'Paragraph')?.color).toBe('#336699')
    expect((await datasetClasses(jobId)).find((c) => c.name === 'Paragraph')?.name).toBe('Paragraph')

    await openViewer(page, jobId, pageId)
    await enterEditMode(page)
    await expect(page.locator('[data-testid="pen-row"]').filter({ has: page.locator('[data-class="Paragraph"]') })
      .getByTestId('pen-swatch')).toHaveCSS('background-color', 'rgb(51, 102, 153)')
  })
})

test.describe('Scenario: a layout model on a dataset of other classes', () => {
  test('its labels are left out until mapped, then land under the classes chosen', async ({ page }) => {
    test.setTimeout(150_000)
    const patch = (path: string, body: Record<string, unknown>) => backendFetch(path, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const defaults = (await listRegistryModels()).filter((m) => m.is_default && ['layout', 'lines', 'ocr'].includes(m.task))
    const layoutModel = defaults.find((m) => m.task === 'layout')!
    const classesOf = async (jobId: string, pageId: number) =>
      (await getPageDetail(jobId, pageId)).elements.map((e: { class_name: string; lines: unknown[] }) => [e.class_name, e.lines.length])
    try {
      // On the stub backend, the dataset is read by DeepLabel's own layout phase, which maps labels.
      for (const model of defaults) await patch(`/api/models/${model.id}`, { backend: 'stub' })
      const name = uniqueName('Letters run')
      const { jobId, pageId } = await letterDataset(await letterTemplate(uniqueName('Letters template')), true, name)
      // The stub detects a Header and a Paragraph, neither a class of this dataset: undecided, both
      // left out. The page's lines are still found and read, unassigned to any box.
      expect(await classesOf(jobId, pageId)).toEqual([['Unassigned', 6]])
      const plan = async () => Object.fromEntries((await backendFetch(`/api/jobs/${jobId}/layout-labels`)).labels
        .map((p: { label: string; how: string; class_id: number | null }) => [p.label, [p.how, p.class_id]]))
      expect(await plan()).toEqual({ Header: ['undecided', null], Paragraph: ['undecided', null] })

      await page.goto('/')
      const card = page.getByTestId('job-card').filter({ hasText: name })
      await card.getByTestId('job-menu').click()
      await card.getByTestId('processing-open').click()
      const mapping = page.getByTestId('label-mapping')
      await expect(mapping.getByTestId('label-choice')).toHaveCount(2)
      await mapping.getByLabel('Class for Paragraph').selectOption({ label: 'Body' })
      await expect.poll(plan).toEqual({ Header: ['undecided', null], Paragraph: ['mapped', 2] })
      await mapping.getByLabel('Class for Header').selectOption({ label: 'Leave out' })
      await expect.poll(plan).toEqual({ Header: ['skipped', null], Paragraph: ['mapped', 2] })

      await backendFetch(`/api/jobs/${jobId}/rerun`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from_phase: 'layout' }) })
      await expect.poll(() => classesOf(jobId, pageId), { timeout: 60_000 }).toEqual([['Body', 3]])
      const [body] = (await getPageDetail(jobId, pageId)).elements as { id: number }[]
      const history = await backendFetch(`/api/elements/${body.id}/revisions`)
      expect(history.map((r: { author: string; action: string }) => [r.author, r.action]))
        .toContainEqual([`model:layout@${layoutModel.name}`, 'create'])
    } finally {
      for (const model of defaults) await patch(`/api/models/${model.id}`, { backend: null })
    }
  })
})

test.describe('Scenario: fine-tuning a layout model on other classes', () => {
  test('is allowed, and the review warns that its classification head starts afresh', async ({ page }) => {
    const name = uniqueName('Letters to train')
    const { pageId } = await letterDataset(await letterTemplate(uniqueName('Letters template')), false, name)
    await drawBox(pageId, 'Body', [0.1, 0.2, 0.6, 0.4])
    await markLayoutChecked(pageId)

    await page.goto('/models/train?task=layout')
    await page.getByLabel('Model name').fill(uniqueName('Letters layout'))
    await pickDataset(page, name)
    await expect(page.locator('#training-base')).toHaveValue(/\d+/)
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    const review = page.getByTestId('training-review')
    await expect(review.getByTestId('preflight')).toHaveAttribute('data-status', 'done')
    const warning = review.locator('[data-testid="preflight-finding"][data-code="fresh_head"]')
    await expect(warning).toHaveAttribute('data-level', 'warn')
    await expect(warning).toContainText('new to it: Salutation, Body, Panel')
    await expect(warning).toContainText('classification head starts afresh')
    // A warning, never a block: the run can still be started from the review.
    await expect(review.getByRole('button', { name: 'Train' })).toBeEnabled()
  })
})

test.describe('Scenario: the reading order is set in the template', () => {
  test('a template says how what stands outside its containers reads', async ({ page }) => {
    const name = uniqueName('Ledger template')
    await page.goto('/templates')
    await page.getByTestId('new-template').click()
    await page.getByLabel('Name', { exact: true }).fill(name)
    await page.getByTestId('class-row').nth(0).getByLabel('Class name').fill('Entry')
    await expect(page.getByTestId('template-outside')).toHaveValue('from_page')
    await page.getByTestId('template-outside').selectOption('top_to_bottom')
    await page.getByTestId('save-template').click()
    await expect(page.getByRole('status')).toContainText(`Saved "${name}"`)
    await expect.poll(async () => (await templates()).find((t) => t.name === name)?.outside_order).toBe('top_to_bottom')

    // The built-in Schematismus template reads as the pipeline does, and stays as it is.
    await page.getByTestId('template-row').filter({ hasText: 'Schematismus' }).click()
    await expect(page.getByTestId('template-outside')).toHaveValue('top_to_bottom')
    await expect(page.getByTestId('template-outside')).toBeDisabled()
  })

  test('a layout model is given its template, and its page says how its datasets read', async ({ page }) => {
    const ledgers = await letterTemplate(uniqueName('Ledgers'))
    const modelName = uniqueName('Ledger layout')
    const modelId = importStubModel('layout', modelName, 'stub-slow')
    await page.goto(`/models/${modelId}`)
    await expect(page.getByTestId('model-reading-order')).toHaveText('worked out from each page - it belongs to no layout template')

    await page.getByRole('button', { name: 'Edit' }).click()
    await page.getByTestId('model-template').selectOption(String(ledgers))
    await page.getByRole('button', { name: 'Save' }).click()
    await expect.poll(async () => (await listRegistryModels()).find((m) => m.id === modelId)?.layout_template_id)
      .toBe(ledgers)
    const ledgerName = (await templates()).find((t) => t.id === ledgers)!.name
    await expect(page.getByTestId('model-reading-order'))
      .toHaveText(`the ${ledgerName} template's: by the page's leaves and columns outside containers`)
  })

  test('a dataset its layout model\'s template orders top to bottom offers no page structure of its own',
    async ({ page }) => {
      const schematismus = (await templates()).find((t) => t.name === 'Schematismus')!
      const modelId = importStubModel('layout', uniqueName('Schematismus layout'), 'stub-misread')
      await backendFetch(`/api/models/${modelId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layout_template_id: schematismus.id }),
      })
      const name = uniqueName('Ordered by template')
      const form = new FormData()
      form.append('name', name)
      form.append('model_layout_id', String(modelId))
      form.append('files', new Blob([new Uint8Array(scanPng())], { type: 'image/png' }), 'page.png')
      const { job_id: jobId } = await backendFetch('/api/jobs', { method: 'POST', body: form })
      await waitForJobStatus(jobId, 'done')
      // Its layout model belongs to the Schematismus template, which reads top to bottom.
      expect((await getJob(jobId)).reading_order_template).toBe('Schematismus')

      await page.goto('/')
      const card = page.getByTestId('job-card').filter({ hasText: name })
      await card.getByTestId('job-menu').click()
      await card.getByTestId('processing-open').click()
      await expect(page.getByTestId('reading-order-set-by')).toContainText('Set by the Schematismus template')
      await expect(page.getByTestId('reading-order-choice')).toBeDisabled()

      // Without its layout model the dataset's own structure decides again.
      await page.locator('[data-testid="processing-phase"][data-phase="layout"]').getByRole('checkbox').uncheck()
      await expect(page.getByTestId('reading-order-set-by')).toHaveCount(0)
      await expect(page.getByTestId('reading-order-choice')).toBeEnabled()
    })
})
