import { test, expect } from '../helpers/test'
import {
  augmentPipelines, backendFetch, identity, jobPageIds, listTrainings, markLayoutChecked, markLinesChecked,
  markPageLinesChecked, seedCompletedJob, uniqueName,
} from '../helpers/api'
import { seedSession, useSession } from '../helpers/session'
import { pickDataset, startTraining, taskSection } from '../helpers/training'

// Pipelines are private to whoever saved them, and the dev bypass logs the browser in as
// this account - so the backend oracle has to ask as the same person the UI saved as.
const DEV = identity('dev', 'admin')

// A group's children render inside its own card, so filtering by text would match the
// group as well; the attribute names exactly one kind of step.
const step = (page: import('@playwright/test').Page, name: string) =>
  page.locator(`[data-testid="pipeline-step"][data-step="${name}"]`)

// Every field sits beside a "?" button whose name mentions the same subject, so fields are
// addressed by their role rather than by a label match that would find both.

/** Steps open in place, and a step just added is already open - so this opens one only
 *  when it is shut, rather than toggling whatever it finds. */
async function openStep(page: import('@playwright/test').Page, name: string) {
  const header = page.getByRole('button', { name, exact: true }).first()
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click()
  await expect(header).toHaveAttribute('aria-expanded', 'true')
}

// The catalog stands beside the pipeline: search it, click what you want.
async function addStep(page: import('@playwright/test').Page, name: string) {
  await page.getByTestId('transform-picker').getByRole('textbox', { name: 'Search transforms' }).fill(name)
  await page.getByTestId('picker-option').filter({ hasText: name }).first().click()
}

test.describe('Scenario: augmentation pipelines', () => {
  test('a pipeline is built from the model stack, previewed on real lines, and saved', async ({ page }) => {
    const datasetName = uniqueName('Augmentable')
    const jobId = await seedCompletedJob(datasetName, 2)
    await markLinesChecked(jobId, 12)
    const pipelineName = uniqueName('Heavy')

    await page.goto('/models')
    await page.getByRole('link', { name: 'Augmentations' }).click()
    await expect(page).toHaveURL(/\/augmentations$/)

    // Nothing saved yet, so the page opens the stack training uses today as a draft -
    // minus the normalisation and tensor steps the trainer appends itself.
    await expect(page.getByTestId('draft-hint')).toContainText('Unsaved draft')
    await expect(page.getByTestId('step-count')).toHaveText('5 steps')
    await expect(step(page, 'Normalize')).toHaveCount(0)
    await expect(step(page, 'ToTensorV2')).toHaveCount(0)
    await expect(step(page, 'Morphological')).toHaveCount(2)

    await page.getByLabel('Name').fill(pipelineName)
    await page.getByLabel('Preview on').selectOption({ label: `${datasetName} (12)` })

    // One crop renders, three ways: as scanned, one draw, and the harshest of the draws taken.
    await expect(page.getByTestId('preview-sample')).toHaveCount(1, { timeout: 30_000 })
    await expect(page.getByTestId('preview-augmented')).toHaveCount(1)
    await expect(page.getByTestId('preview-harshest')).toHaveCount(1)
    await expect(page.getByTestId('preview-sample').first()).toContainText('Harshest of 12')
    await expect(page.getByTestId('preview-sample').first()).toContainText(datasetName)

    // Reroll draws a different set of lines from the same dataset. The alt text names
    // the line each crop came from, so a changed set is visible from outside.
    const sampledLines = () => page.getByTestId('preview-augmented').evaluateAll(
      (images) => images.map((image) => image.getAttribute('alt')).join())
    const before = await sampledLines()
    // Reapply keeps the same lines and only re-rolls the stack; changing lines draws others.
    await page.getByTestId('preview-reapply').click()
    await expect.poll(sampledLines, { timeout: 30_000 }).toBe(before)
    await page.getByTestId('preview-change-lines').click()
    await expect.poll(sampledLines, { timeout: 30_000 }).not.toBe(before)

    // A step is added, tuned, and reordered; the tree shows what it will do.
    await addStep(page, 'InvertImg')
    await expect(page.getByTestId('step-count')).toHaveText('6 steps')
    await openStep(page, 'GaussNoise')
    await page.getByRole('spinbutton', { name: 'std_range from' }).fill('0.1')
    await page.getByRole('spinbutton', { name: 'std_range to' }).fill('0.3')
    await page.getByRole('spinbutton', { name: 'Probability' }).fill('0.9')
    await expect(step(page, 'GaussNoise')).toContainText('p 0.9 · std_range 0.1, 0.3')

    await page.getByTestId('save-pipeline').click()
    await expect(page.getByTestId('pipeline-notice')).toContainText(`Saved "${pipelineName}"`)

    // Backend oracle: the saved spec is exactly the tree, in albumentations' own form.
    const saved = (await augmentPipelines('ocr', DEV)).pipelines.find((p) => p.name === pipelineName)!
    expect(saved.owner).toBe('dev')
    expect(saved.is_default).toBe(false)
    const steps = saved.spec.transform.transforms as Record<string, unknown>[]
    expect(steps.map((s) => s.__class_fullname__)).toEqual(
      ['Affine', 'GaussNoise', 'OneOf', 'InvertImg'])
    const noise = steps[1]
    expect(noise).toMatchObject({ p: 0.9, std_range: [0.1, 0.3] })
    // Only what deviates is stored: per_channel came in from the model's stack at the
    // library's own default, so it is dropped rather than pinned into the pipeline.
    expect(Object.keys(noise).sort()).toEqual(['__class_fullname__', 'p', 'std_range'])
  })

  test('muting a step changes the preview without changing the pipeline', async ({ page }) => {
    const pipelineName = uniqueName('Muted')

    await page.goto('/augmentations')
    await page.getByTestId('start-empty').click()
    await page.getByLabel('Name').fill(pipelineName)
    await addStep(page, 'GaussNoise')
    await addStep(page, 'InvertImg')
    await expect(page.getByTestId('muted-count')).toHaveCount(0)

    await openStep(page, 'InvertImg')
    await page.getByRole('button', { name: 'Skip InvertImg in preview' }).click()
    await expect(page.getByTestId('muted-count')).toHaveText('· 1 skipped in the preview only')
    await expect(step(page, 'InvertImg')).toHaveAttribute('data-muted', 'true')

    await page.getByTestId('save-pipeline').click()
    await expect(page.getByTestId('pipeline-notice')).toContainText('Saved')
    // Muting is a preview control: the saved pipeline still carries the step.
    const saved = (await augmentPipelines('ocr', DEV)).pipelines.find((p) => p.name === pipelineName)!
    expect((saved.spec.transform.transforms as Record<string, unknown>[]).map((s) => s.__class_fullname__))
      .toEqual(['GaussNoise', 'InvertImg'])
  })

  test('a stack the model venv refuses is reported with the step named, and not saved', async ({ page }) => {
    const pipelineName = uniqueName('Broken')
    await page.goto('/augmentations')
    await page.getByTestId('start-empty').click()
    await page.getByLabel('Name').fill(pipelineName)
    await addStep(page, 'GaussNoise')
    // A range whose low end exceeds its high end is what the library validates against.
    await page.getByRole('spinbutton', { name: 'std_range from' }).fill('0.9')
    await page.getByRole('spinbutton', { name: 'std_range to' }).fill('0.1')

    await page.getByTestId('save-pipeline').click()
    await expect(page.getByTestId('pipeline-error')).toContainText('GaussNoise')
    await expect(page.getByTestId('pipeline-error')).toContainText('std_range')
    expect((await augmentPipelines('ocr', DEV)).pipelines.map((p) => p.name)).not.toContain(pipelineName)
  })

  test('a step that needs targets the task never supplies is refused before saving', async ({ page }) => {
    const pipelineName = uniqueName('Needs boxes')
    await page.goto('/augmentations')
    await page.getByTestId('start-empty').click()
    await page.getByLabel('Name').fill(pipelineName)
    // The catalog is broad on purpose - layout and line segmentation will want this one -
    // but an OCR stack is only ever handed an image, so it cannot survive a run.
    await addStep(page, 'BBoxSafeRandomCrop')

    await page.getByTestId('save-pipeline').click()
    await expect(page.getByTestId('pipeline-error')).toContainText('BBoxSafeRandomCrop')
    await expect(page.getByTestId('pipeline-error')).toContainText('bounding boxes')
    expect((await augmentPipelines('ocr', DEV)).pipelines.map((p) => p.name)).not.toContain(pipelineName)
  })

  test('an admin default is offered to everyone, read-only, and can be duplicated', async ({ page, context }) => {
    const pipelineName = uniqueName('House style')
    await page.goto('/augmentations')
    await page.getByTestId('start-empty').click()
    await page.getByLabel('Name').fill(pipelineName)
    await addStep(page, 'GaussNoise')
    await page.getByTestId('save-pipeline').click()
    await expect(page.getByTestId('pipeline-notice')).toContainText('Saved')
    await page.getByTestId('toggle-default').click()
    await expect(page.getByTestId('pipeline-row').filter({ hasText: pipelineName }).getByText('default')).toBeVisible()
    const defaultId = (await augmentPipelines('ocr', DEV)).pipelines.find((p) => p.name === pipelineName)!.id

    const member = uniqueName('aug').replace(/\s/g, '-').toLowerCase()
    await useSession(context, seedSession('member', member))
    await page.goto('/augmentations')
    // The default is the only pipeline of someone else's a member ever sees.
    await expect(page.getByTestId('pipeline-row')).toHaveCount(1)
    await page.getByTestId('pipeline-row').filter({ hasText: pipelineName }).click()
    await expect(page.getByTestId('save-pipeline')).toHaveCount(0)
    await expect(page.getByTestId('delete-pipeline')).toHaveCount(0)
    await expect(page.getByTestId('transform-picker')).toHaveCount(0)
    // Read-only reaches the parameters too, not just the buttons around them.
    await openStep(page, 'GaussNoise')
    await expect(page.getByRole('spinbutton', { name: 'std_range from' })).toBeDisabled()
    await expect(page.getByRole('spinbutton', { name: 'Probability' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Skip GaussNoise in preview' })).toHaveCount(0)

    await page.getByTestId('duplicate-pipeline').click()
    await expect(page.getByTestId('pipeline-row')).toHaveCount(2)
    await expect(page.getByTestId('save-pipeline')).toBeVisible()
    const mine = (await augmentPipelines('ocr', identity(member, 'member'))).pipelines
      .find((p) => p.name === `${pipelineName} (copy)`)!
    expect(mine.owner).toBe(member)
    expect(mine.is_default).toBe(false)
    expect(mine.editable).toBe(true)

    // Unmarking puts the instance back on the train module's own stack, and takes the
    // pipeline back out of everyone else's list.
    await useSession(context, seedSession('admin', uniqueName('aug-admin').replace(/\s/g, '-').toLowerCase()))
    await page.goto('/augmentations')
    await backendFetch(`/api/augmentations/pipelines/${defaultId}/default`, {
      method: 'POST', headers: { ...DEV, 'Content-Type': 'application/json' },
      body: JSON.stringify({ default: false }),
    })
    expect((await augmentPipelines('ocr', identity(member, 'member'))).pipelines.map((p) => p.name))
      .not.toContain(pipelineName)
  })

  test('a training freezes the stack it was given, by pipeline or built for the run', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Trainable aug'), 2)
    await markLinesChecked(jobId, 12)
    const pipelineName = uniqueName('For training')
    const withPipeline = uniqueName('Run with pipeline')
    const withCustom = uniqueName('Run with custom')

    await page.goto('/augmentations')
    await page.getByTestId('start-empty').click()
    await page.getByLabel('Name').fill(pipelineName)
    await addStep(page, 'GaussNoise')
    await page.getByTestId('save-pipeline').click()
    await expect(page.getByTestId('pipeline-notice')).toContainText('Saved')

    await page.goto('/models')
    const ocr = taskSection(page, 'ocr')
    await ocr.getByTestId('train-model').click()
    await page.getByLabel('Model name').fill(withPipeline)
    await pickDataset(page, 'Trainable aug')
    // Untouched, a run leaves the train module on its own stack.
    await expect(page.getByRole('combobox', { name: 'Augmentation' })).toHaveValue('builtin')
    await expect(page.getByTestId('submit-summary')).toContainText("augmentation: the model's own")
    await page.getByRole('combobox', { name: 'Augmentation' }).selectOption({ label: pipelineName })
    await expect(page.getByTestId('submit-summary')).toContainText(`augmentation: ${pipelineName}`)
    await startTraining(page)

    await expect
      .poll(async () => (await listTrainings()).find((t) => t.name === withPipeline)?.augmentation_name ?? null,
        { timeout: 30_000 })
      .toBe(pipelineName)
    const frozen = (await listTrainings()).find((t) => t.name === withPipeline)!
    expect((frozen.augmentation!.transform.transforms as Record<string, unknown>[])
      .map((s) => s.__class_fullname__)).toEqual(['GaussNoise'])

    // The overlay builds a stack for one run: named nowhere, frozen all the same.
    await page.getByRole('tab', { name: /^OCR/ }).click()
    await ocr.getByTestId('train-model').click()
    await page.getByLabel('Model name').fill(withCustom)
    await pickDataset(page, 'Trainable aug')
    await page.getByTestId('customise-augmentation').click()
    // The overlay opens on whatever the picker names - here the model's own stack, so a
    // tweak starts from what would otherwise have run.
    await expect(page.getByTestId('step-count')).toHaveText('5 steps')
    await addStep(page, 'InvertImg')
    await expect(page.getByTestId('step-count')).toHaveText('6 steps')
    await page.getByTestId('use-augmentation').click()
    await expect(page.getByRole('combobox', { name: 'Augmentation' })).toHaveValue('custom')
    await expect(page.getByTestId('submit-summary')).toContainText('augmentation: custom')
    await startTraining(page)

    // Polled on the step names themselves: a run that has not been created yet reads as
    // null here, so the wait cannot end on a run that is simply missing.
    await expect
      .poll(async () => {
        const run = (await listTrainings()).find((t) => t.name === withCustom)
        const steps = run?.augmentation?.transform.transforms as Record<string, unknown>[] | undefined
        return steps?.map((step) => step.__class_fullname__) ?? null
      }, { timeout: 30_000 })
      .toEqual(['Affine', 'GaussNoise', 'OneOf', 'InvertImg'])
    expect((await listTrainings()).find((t) => t.name === withCustom)!.augmentation_name).toBe('')

    // The finished run says what it trained with, so runs stay comparable.
    const run = page.getByTestId('training-row').filter({ hasText: withPipeline })
    await expect(run.getByText('done')).toBeVisible({ timeout: 30_000 })
    await run.getByTestId('training-open').click()
    await page.getByRole('tab', { name: 'Settings' }).click()
    await expect(page.getByTestId('run-settings')).toContainText(pipelineName)
  })

  test('a layout pipeline is previewed on a page with its boxes and frozen into a layout run', async ({ page }) => {
    const datasetName = uniqueName('Layout aug')
    const jobId = await seedCompletedJob(datasetName, 1)
    const [pageId] = await jobPageIds(jobId)
    await markLayoutChecked(pageId)
    const pipelineName = uniqueName('Page stack')
    const runName = uniqueName('Layout run')

    await page.goto('/augmentations')
    await page.getByRole('tab', { name: 'Layout' }).click()
    await expect(page).toHaveURL(/\/augmentations\?task=layout$/)
    await expect(page.getByTestId('builtin-draft-note')).toContainText('the stack layout training uses today')
    await expect(page.getByTestId('step-count')).toHaveText('5 steps')

    // A page with checked layout is what a layout trainer is handed, boxes and all.
    await page.getByLabel('Name').fill(pipelineName)
    await page.getByLabel('Preview on').selectOption({ label: `${datasetName} (1)` })
    await expect(page.getByTestId('preview-sample')).toHaveCount(1, { timeout: 30_000 })
    await expect(page.getByTestId('pipeline-preview')).toContainText('one page with checked layout, its boxes outlined')
    await expect(page.getByTestId('preview-augmented')).toHaveAttribute('alt', `page ${pageId} after augmentation`)
    await expect(page.getByTestId('preview-harshest')).toHaveAttribute('alt', `page ${pageId} on its harshest draw`)
    await expect(page.getByTestId('preview-change-lines')).toHaveText('Change pages')

    // A crop that keeps every box needs the boxes a layout trainer has.
    await addStep(page, 'BBoxSafeRandomCrop')
    await expect(page.getByTestId('step-count')).toHaveText('6 steps')
    await expect(page.getByTestId('preview-error')).toHaveCount(0)
    await expect(page.getByTestId('preview-augmented')).toHaveCount(1)
    await page.getByTestId('save-pipeline').click()
    await expect(page.getByTestId('pipeline-notice')).toContainText(`Saved "${pipelineName}"`)

    // Backend oracle: filed under layout, and nowhere under OCR.
    const saved = (await augmentPipelines('layout', DEV)).pipelines.find((p) => p.name === pipelineName)!
    expect((saved.spec.transform.transforms as Record<string, unknown>[]).map((s) => s.__class_fullname__))
      .toEqual(['Affine', 'GaussNoise', 'OneOf', 'BBoxSafeRandomCrop'])
    expect((await augmentPipelines('ocr', DEV)).pipelines.map((p) => p.name)).not.toContain(pipelineName)
    expect((await augmentPipelines('ocr', DEV)).pipelines.length).toBeGreaterThan(0)

    await page.goto('/models/train?task=layout')
    await page.getByLabel('Model name').fill(runName)
    await pickDataset(page, datasetName)
    await page.getByRole('combobox', { name: 'Augmentation' }).selectOption({ label: pipelineName })
    await expect(page.getByTestId('submit-summary')).toContainText(`augmentation: ${pipelineName}`)
    await startTraining(page)

    await expect
      .poll(async () => {
        const run = (await listTrainings()).find((t) => t.name === runName)
        return run ? [run.task, run.augmentation_name] : null
      }, { timeout: 30_000 })
      .toEqual(['layout', pipelineName])
    expect((await listTrainings()).find((t) => t.name === runName)!.augmentation).toEqual(saved.spec)
  })

  test('a lines pipeline is previewed on a page with its lines and frozen into a line run', async ({ page }) => {
    const datasetName = uniqueName('Lines aug')
    const jobId = await seedCompletedJob(datasetName, 2)
    const [pageId, layoutOnly] = await jobPageIds(jobId)
    await markPageLinesChecked(pageId)
    await markLayoutChecked(layoutOnly)
    const pipelineName = uniqueName('Line stack')
    const runName = uniqueName('Lines run')

    await page.goto('/augmentations')
    await page.getByRole('tab', { name: 'Lines' }).click()
    await expect(page).toHaveURL(/\/augmentations\?task=lines$/)
    await expect(page.getByTestId('builtin-draft-note'))
      .toContainText('the stack line segmentation training uses today')
    await expect(page.getByTestId('step-count')).toHaveText('5 steps')

    // Only the page whose lines are checked is what a line trainer is handed; the other
    // page has checked layout, which counts for layout alone.
    await page.getByLabel('Name').fill(pipelineName)
    await page.getByLabel('Preview on').selectOption({ label: `${datasetName} (1)` })
    await expect(page.getByTestId('preview-sample')).toHaveCount(1, { timeout: 30_000 })
    await expect(page.getByTestId('pipeline-preview')).toContainText('one page with checked lines, each line outlined')
    await expect(page.getByTestId('preview-augmented')).toHaveAttribute('alt', `page ${pageId} after augmentation`)
    await expect(page.getByTestId('preview-change-lines')).toHaveText('Change pages')
    await page.getByTestId('save-pipeline').click()
    await expect(page.getByTestId('pipeline-notice')).toContainText(`Saved "${pipelineName}"`)

    // Backend oracle: filed under lines, and nowhere under layout.
    const saved = (await augmentPipelines('lines', DEV)).pipelines.find((p) => p.name === pipelineName)!
    expect((saved.spec.transform.transforms as Record<string, unknown>[]).map((s) => s.__class_fullname__))
      .toEqual(['Affine', 'GaussNoise', 'OneOf'])
    const layoutNames = (await augmentPipelines('layout', DEV)).pipelines.map((p) => p.name)
    expect(layoutNames).not.toContain(pipelineName)
    expect(layoutNames.length).toBeGreaterThan(0)

    // A crop that keeps every box needs boxes, which a line trainer is never handed.
    await addStep(page, 'BBoxSafeRandomCrop')
    await expect(page.getByTestId('preview-error'))
      .toContainText('BBoxSafeRandomCrop: applying it to an image failed: this step needs bounding boxes')

    await page.goto('/models/train?task=lines')
    await page.getByLabel('Model name').fill(runName)
    await pickDataset(page, datasetName)
    await page.getByRole('combobox', { name: 'Augmentation' }).selectOption({ label: pipelineName })
    await expect(page.getByTestId('submit-summary')).toContainText(`augmentation: ${pipelineName}`)
    await startTraining(page)

    await expect
      .poll(async () => {
        const run = (await listTrainings()).find((t) => t.name === runName)
        return run ? [run.task, run.augmentation_name] : null
      }, { timeout: 30_000 })
      .toEqual(['lines', pipelineName])
    expect((await listTrainings()).find((t) => t.name === runName)!.augmentation).toEqual(saved.spec)
  })

  test('a run can train on the crops as scanned', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Clean crops'), 2)
    await markLinesChecked(jobId, 12)
    const modelName = uniqueName('Run without aug')

    await page.goto('/models')
    const ocr = taskSection(page, 'ocr')
    await ocr.getByTestId('train-model').click()
    await page.getByLabel('Model name').fill(modelName)
    await pickDataset(page, 'Clean crops')
    await page.getByRole('combobox', { name: 'Augmentation' }).selectOption('none')
    await expect(page.getByTestId('submit-summary')).toContainText('augmentation: none')
    await startTraining(page)

    await expect
      .poll(async () => (await listTrainings()).find((t) => t.name === modelName)?.augmentation ?? null,
        { timeout: 30_000 })
      .toEqual({ transform: { __class_fullname__: 'Compose', p: 1.0, transforms: [] } })
  })
})
