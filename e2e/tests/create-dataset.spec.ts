import { test, expect } from '../helpers/test'
import { getJob, listRegistryModels, seedCompletedJob, uniqueName, waitForJobStatus } from '../helpers/api'
import { scanPng } from '../helpers/image'
import { withLayoutPerCrop } from '../helpers/new-dataset'
import { seedSession, useSession } from '../helpers/session'

const uploadFiles = (names: string[]) =>
  names.map((name) => ({ name, mimeType: 'image/png', buffer: scanPng() }))

test.describe('Scenario: creating a dataset', () => {
  test('uploading scans creates a job and the pipeline runs to done', async ({ page }) => {
    const name = uniqueName('Upload flow')
    const builtinOcr = (await listRegistryModels()).find((m) => m.task === 'ocr' && m.source === 'backend')!
    await page.goto('/new')
    await withLayoutPerCrop(page)
    await page.getByLabel('Job name').fill(name)
    await page.locator('input[type="file"]').setInputFiles(uploadFiles(['page_a.png', 'page_b.png']))
    await expect(page.getByText('page_a.png')).toBeVisible()
    await expect(page.getByText('page_b.png')).toBeVisible()
    await page.getByTestId('new-model-ocr').selectOption(String(builtinOcr.id))
    await page.getByTestId('ocr-decode-greedy').click()

    await page.getByRole('button', { name: 'Create job' }).click()
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)
    await expect(page.getByRole('heading', { name })).toBeVisible()
    const jobId = page.url().split('/').pop()!
    // The model and decode choices were persisted on the created job.
    const created = await getJob(jobId)
    expect(created.model_ocr_id).toBe(builtinOcr.id)
    expect(created.ocr_decode).toBe('greedy')

    await expect(page.getByTestId('status-badge')).toHaveText('done')
    await expect(page.getByText('Ingest')).toBeVisible()
    await expect(page.getByText('2/2').first()).toBeVisible()
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
    await page.getByRole('button', { name: 'Create job' }).click()
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

  test('a duplicate dataset name is rejected with a clear error', async ({ page }) => {
    const name = uniqueName('Duplicate')
    await seedCompletedJob(name, 1)

    await page.goto('/new')
    await page.getByLabel('Job name').fill(name)
    await page.locator('input[type="file"]').setInputFiles(uploadFiles(['again.png']))
    await page.getByRole('button', { name: 'Create job' }).click()

    await expect(page.getByText(/already exists/)).toBeVisible()
    await expect(page).toHaveURL(/\/new$/)
  })

  test('the form explains what is missing before it can submit', async ({ page }) => {
    await page.goto('/new')
    const submit = page.getByRole('button', { name: 'Create job' })
    await expect(submit).toBeDisabled()
    await expect(page.getByText('Add a job name')).toBeVisible()

    await page.getByLabel('Job name').fill(uniqueName('Incomplete'))
    await expect(page.getByText('Select at least one image or PDF')).toBeVisible()
    await expect(submit).toBeDisabled()

    await page.locator('input[type="file"]').setInputFiles(uploadFiles(['ready.png']))
    await expect(submit).toBeEnabled()
  })
})

test.describe('Scenario: the choices made at creation are the ones the dataset keeps', () => {
  test('a new dataset starts without layout detection, finding lines across the whole page', async ({ page }) => {
    const name = uniqueName('Default phases')
    await page.goto('/new')
    await page.getByLabel('Job name').fill(name)
    await page.locator('input[type="file"]').setInputFiles(uploadFiles(['letter.png']))
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
    await page.getByRole('button', { name: 'Create job' }).click()
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
    await page.getByRole('button', { name: /^Per page/ }).click()
    await page.getByTestId('reading-order-choice').selectOption('1x2')
    await page.getByRole('button', { name: 'Create job' }).click()
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)

    const jobId = page.url().split('/').pop()!
    const created = await getJob(jobId)
    expect({ line_mode: created.line_mode, reading_order: created.reading_order })
      .toEqual({ line_mode: 'per_page', reading_order: '1x2' })
    await waitForJobStatus(jobId, 'done')
  })
})
