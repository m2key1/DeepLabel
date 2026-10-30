import { test, expect } from '../helpers/test'
import { backendFetch, getJob, listRegistryModels, seedCompletedJob, uniqueName, waitForJobStatus } from '../helpers/api'
import { scanPng } from '../helpers/image'
import { createDataset, withLayoutPerCrop, wizardStep } from '../helpers/new-dataset'
import { seedSession, useSession } from '../helpers/session'

const uploadFiles = (names: string[]) =>
  names.map((name) => ({ name, mimeType: 'image/png', buffer: scanPng() }))

test.describe('Scenario: creating a dataset', () => {
  test('a name another dataset already has stops the first step, and a new one lets it through',
    async ({ page }) => {
      const name = uniqueName('Taken name')
      const jobId = await seedCompletedJob(name, 1)
      await page.goto('/new')
      // Case and surrounding spaces do not make a different name.
      await page.getByLabel('Job name').fill(`  ${name.toUpperCase()} `)
      await page.locator('input[type="file"]').setInputFiles(uploadFiles(['page_a.png']))
      const taken = page.getByTestId('job-name-taken')
      await expect(taken).toContainText(`${name} already exists`)
      await expect(taken.getByRole('link', { name })).toHaveAttribute('href', `/jobs/${jobId}`)
      await expect(page.getByLabel('Job name')).toHaveAttribute('aria-invalid', 'true')
      await expect(page.getByTestId('wizard-next')).toBeDisabled()
      await expect(page.getByTestId('wizard-missing')).toHaveText('Choose a name no other dataset has')

      await page.getByLabel('Job name').fill(`${name} second volume`)
      await expect(page.getByTestId('job-name-taken')).toHaveCount(0)
      await expect(page.getByLabel('Job name')).toHaveAttribute('aria-invalid', 'false')
      await page.getByTestId('wizard-next').click()
      await expect(page.getByTestId('new-job-step')).not.toHaveAttribute('data-step', 'source')
    })

  test('uploading scans creates a job and the pipeline runs to done', async ({ page }) => {
    const name = uniqueName('Upload flow')
    const builtinOcr = (await listRegistryModels()).find((m) => m.task === 'ocr' && m.source === 'backend')!
    await page.goto('/new')
    await withLayoutPerCrop(page)
    await page.getByLabel('Job name').fill(name)
    await page.locator('input[type="file"]').setInputFiles(uploadFiles(['page_a.png', 'page_b.png']))
    await expect(page.getByText('page_a.png')).toBeVisible()
    await expect(page.getByText('page_b.png')).toBeVisible()
    await wizardStep(page, 'models')
    await page.getByTestId('new-model-ocr').selectOption(String(builtinOcr.id))
    await page.getByTestId('ocr-decode-greedy').click()

    await createDataset(page)
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)
    await expect(page.getByRole('heading', { name })).toBeVisible()
    const jobId = page.url().split('/').pop()!
    // The model and decode choices were persisted on the created job.
    const created = await getJob(jobId)
    expect(created.model_ocr_id).toBe(builtinOcr.id)
    expect(created.ocr_decode).toBe('greedy')

    await expect(page.getByTestId('phase-strip')).toHaveAttribute('data-status', 'done')
    const step = (phase: string) => page.getByTestId('phase-strip').locator(`[data-phase="${phase}"]`)
    // The two uploads are the same scan, and a duplicate is left out of every count.
    await expect(step('ingest')).toHaveText('Ingest1/1')
    for (const phase of ['ingest', 'layout', 'lines', 'ocr']) {
      await expect(step(phase)).toHaveAttribute('data-state', 'done')
    }
    await expect(page.locator('tbody tr')).toHaveCount(2)
    await expect(page.locator('tbody img').first()).toBeVisible()
  })

  test('a member creates a dataset, owns it, and shares it with a colleague', async ({ page, context }) => {
    const member = `maria-${Date.now()}`
    const colleague = `karl-${Date.now()}`
    const token = seedSession('member', member)
    seedSession('member', colleague)
    await useSession(context, token)

    const name = uniqueName('Member upload')
    await page.goto('/new')
    // The server-path ingest reads the backend filesystem and stays admin-only.
    await expect(page.getByRole('button', { name: 'Upload files' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Server path' })).toHaveCount(0)
    await page.getByLabel('Job name').fill(name)
    await page.locator('input[type="file"]').setInputFiles(uploadFiles(['mine.png']))
    await createDataset(page)
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)
    const jobId = page.url().split('/').pop()!
    expect((await getJob(jobId)).owner).toBe(member)
    await waitForJobStatus(jobId, 'done')

    // As the owner, the member shares it with a colleague from the card menu.
    await page.goto('/')
    const card = page.getByTestId('job-card').filter({ hasText: name })
    await card.getByTestId('job-menu').click()
    await card.getByRole('button', { name: 'Share…' }).click()
    await page.getByRole('checkbox', { name: colleague }).check()
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(card.getByText('shared with 1')).toBeVisible()
    await expect.poll(async () => (await getJob(jobId)).shared_with).toEqual([colleague])
  })

  test('each step explains what is missing before it lets you on', async ({ page }) => {
    await page.goto('/new')
    const next = page.getByTestId('wizard-next')
    await expect(next).toBeDisabled()
    await expect(page.getByTestId('wizard-missing')).toHaveText('Add a job name')

    await page.getByLabel('Job name').fill(uniqueName('Incomplete'))
    await expect(page.getByTestId('wizard-missing')).toHaveText('Select at least one image or PDF')
    await expect(next).toBeDisabled()
    // Looking ahead is allowed; creating is not, and Review says why.
    await wizardStep(page, 'review')
    await expect(page.getByRole('button', { name: 'Create job' })).toBeDisabled()
    await expect(page.getByTestId('wizard-missing')).toHaveText('Select at least one image or PDF')

    await wizardStep(page, 'source')
    await page.locator('input[type="file"]').setInputFiles(uploadFiles(['ready.png']))
    await expect(next).toBeEnabled()
    await next.click()
    await expect(page.getByTestId('new-job-step')).toHaveAttribute('data-step', 'pages')
  })
})

test.describe('Scenario: the choices made at creation are the ones the dataset keeps', () => {
  test('a new dataset starts without layout detection, finding lines across the whole page', async ({ page }) => {
    const name = uniqueName('Default phases')
    await page.goto('/new')
    await page.getByLabel('Job name').fill(name)
    await page.locator('input[type="file"]').setInputFiles(uploadFiles(['letter.png']))
    await wizardStep(page, 'run')
    const layout = page.getByRole('checkbox', { name: /^Layout detection/ })
    await expect(layout).not.toBeChecked()
    await expect(page.getByRole('checkbox', { name: /^Line segmentation/ })).toBeChecked()
    await expect(page.getByRole('button', { name: /^Per page/ })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('button', { name: /^Per crop/ })).toBeDisabled()
    // Layout switched on, lines are still found across the page until per crop is chosen.
    await layout.check()
    await expect(page.getByRole('button', { name: /^Per crop/ })).toBeEnabled()
    await expect(page.getByRole('button', { name: /^Per page/ })).toHaveAttribute('aria-pressed', 'true')
    await layout.uncheck()
    await createDataset(page)
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)

    const created = await getJob(page.url().split('/').pop()!)
    expect({ run_layout: created.run_layout, run_lines: created.run_lines, line_mode: created.line_mode })
      .toEqual({ run_layout: false, run_lines: true, line_mode: 'per_page' })
  })

  test('line detection over the whole page and a two-column page structure', async ({ page }) => {
    const name = uniqueName('Creation choices')
    await page.goto('/new')
    await page.getByLabel('Job name').fill(name)
    await page.locator('input[type="file"]').setInputFiles(uploadFiles(['two_columns.png']))
    await wizardStep(page, 'run')
    await page.getByRole('button', { name: /^Per page/ }).click()
    await page.getByTestId('reading-order-choice').selectOption('1x2')
    await createDataset(page)
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)

    const jobId = page.url().split('/').pop()!
    const created = await getJob(jobId)
    expect({ line_mode: created.line_mode, reading_order: created.reading_order })
      .toEqual({ line_mode: 'per_page', reading_order: '1x2' })
    await waitForJobStatus(jobId, 'done')
  })
})

test.describe('Scenario: a new dataset step by step', () => {
  test('a page left out on the Pages step is never uploaded', async ({ page }) => {
    const name = uniqueName('Picked pages')
    await page.goto('/new')
    await page.getByLabel('Job name').fill(name)
    await page.locator('input[type="file"]').setInputFiles(['scan_1.png', 'scan_2_blank.png', 'scan_3.png']
      .map((file, i) => ({ name: file, mimeType: 'image/png', buffer: scanPng(undefined, undefined, i) })))
    await page.getByTestId('wizard-next').click()

    const picks = page.getByTestId('page-pick')
    await expect(picks).toHaveCount(3)
    await page.getByRole('checkbox', { name: 'scan_2_blank.png' }).uncheck()
    await expect(page.getByTestId('page-picker-count')).toHaveText('2 of 3 files included')
    await expect(page.getByTestId('new-job-summary').locator('[data-label="Pages"]')).toContainText('2 of 3 included')
    // Leaving every page out is not a dataset.
    await page.getByRole('button', { name: 'select none' }).click()
    await expect(page.getByTestId('wizard-next')).toBeDisabled()
    await expect(page.getByTestId('wizard-missing')).toHaveText('Leave at least one page in')
    await page.getByRole('button', { name: 'select all' }).click()
    await page.getByRole('checkbox', { name: 'scan_2_blank.png' }).uncheck()

    await createDataset(page)
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)
    const jobId = page.url().split('/').pop()!
    await expect.poll(async () => ((await getJob(jobId)).pages as { filename: string }[]).map((p) => p.filename).sort())
      .toEqual(['scan_1.png', 'scan_3.png'])
  })

  test('going back keeps every choice, and the convention picked reaches the dataset', async ({ page }) => {
    const name = uniqueName('Back and forth')
    const flag = `rule_${Date.now()}`
    await backendFetch('/api/convention-flags', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: flag, label: 'Keep the double hyphen', description: 'A broken word keeps its "=".' }),
    })
    const builtinOcr = (await listRegistryModels()).find((m) => m.task === 'ocr' && m.source === 'backend')!

    await page.goto('/new')
    await page.getByLabel('Job name').fill(name)
    await page.locator('input[type="file"]').setInputFiles(uploadFiles(['folio.png']))
    await wizardStep(page, 'models')
    await page.getByTestId('new-model-ocr').selectOption(String(builtinOcr.id))
    await page.getByTestId('ocr-decode-greedy').click()
    const offered = page.locator(`[data-testid="convention-flag"][data-flag="${flag}"]`)
    await expect(offered.getByTestId('convention-description')).toHaveText('A broken word keeps its "=".')
    await offered.getByRole('checkbox').check()

    // All the way back and forward again: nothing chosen is lost on the way.
    for (let i = 0; i < 3; i++) await page.getByTestId('wizard-back').click()
    await expect(page.getByTestId('new-job-step')).toHaveAttribute('data-step', 'source')
    await expect(page.getByLabel('Job name')).toHaveValue(name)
    await expect(page.getByText('folio.png')).toBeVisible()
    for (let i = 0; i < 3; i++) await page.getByTestId('wizard-next').click()
    await expect(page.getByTestId('new-job-step')).toHaveAttribute('data-step', 'models')
    await expect(page.getByTestId('new-model-ocr')).toHaveValue(String(builtinOcr.id))
    await expect(offered.getByRole('checkbox')).toBeChecked()

    await page.getByTestId('wizard-next').click()
    const review = page.getByTestId('new-job-review')
    await expect(review.locator('[data-label="Convention"]')).toContainText('keep the double hyphen')
    await page.getByRole('button', { name: 'Create job' }).click()
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)
    const created = await getJob(page.url().split('/').pop()!)
    expect({ model: created.model_ocr_id, decode: created.ocr_decode, convention: created.ocr_convention })
      .toEqual({ model: builtinOcr.id, decode: 'greedy', convention: { [flag]: true } })
  })

  test('a step with nothing to choose is skipped', async ({ page }) => {
    await page.goto('/new')
    // A map dataset picks its model with what it runs, so it has no models step.
    await expect(page.getByTestId('wizard-step-models')).not.toHaveAttribute('data-skipped', 'true')
    await page.getByTestId('task-map_segmentation').click()
    await expect(page.getByTestId('wizard-step-models')).toHaveAttribute('data-skipped', 'true')
    await expect(page.getByTestId('wizard-step-models')).toBeDisabled()
    // And a server path has no files to show, so no pages step either.
    await page.getByRole('button', { name: 'Server path' }).click()
    await expect(page.getByTestId('wizard-step-pages')).toHaveAttribute('data-skipped', 'true')
    await expect(page.getByTestId('wizard-step-run')).not.toHaveAttribute('data-skipped', 'true')
  })
})
