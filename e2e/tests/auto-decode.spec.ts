import { test, expect } from '../helpers/test'
import { createGroup, getJob, moveJobToGroup, patchJob, seedCompletedJob, uniqueName } from '../helpers/api'
import { scanPng } from '../helpers/image'
import { createDataset, withLayoutPerCrop, wizardStep } from '../helpers/new-dataset'

test.describe("Scenario: a dataset reads with what suits its model", () => {
  test('a new dataset starts on Automatic, the first of the decode cards', async ({ page }) => {
    const name = uniqueName('Automatic reading')
    await page.goto('/new')
    await page.getByLabel('Job name').fill(name)
    await page.locator('input[type="file"]').setInputFiles([{ name: 'leaf.png', mimeType: 'image/png', buffer: scanPng() }])
    await withLayoutPerCrop(page)
    await wizardStep(page, 'models')

    const cards = page.locator('[data-testid^="ocr-decode-"]')
    await expect(cards).toHaveText([
      /^AutomaticThe model's own best: its token decoder if it has one, else Reranked$/,
      /^With language model/,
      /^RerankedBeam search with the language model, the best candidates reranked by the decoder head$/,
      /^Fast/,
    ])
    await expect(page.getByTestId('ocr-decode-auto')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('ocr-decode-rescored')).toHaveAttribute('aria-pressed', 'false')

    await createDataset(page)
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)
    expect((await getJob(page.url().split('/').pop()!)).ocr_decode).toBe('auto')
  })

  test('the group settings put every dataset of a group on Automatic', async ({ page }) => {
    const groupName = uniqueName('Back to automatic')
    const group = await createGroup(groupName)
    const datasets = [await seedCompletedJob(uniqueName('Fixed beam'), 1), await seedCompletedJob(uniqueName('Fixed fast'), 1)]
    await patchJob(datasets[0], { ocr_decode: 'beam' })
    await patchJob(datasets[1], { ocr_decode: 'greedy' })
    for (const jobId of datasets) await moveJobToGroup(jobId, group.id)

    await page.goto('/')
    await page.locator('section').filter({ hasText: groupName }).getByTestId('group-settings').click()
    const pick = page.getByTestId('group-pick-decode')
    await expect(pick.locator('option').nth(1)).toHaveText("Automatic - the model's own best")
    await pick.selectOption('auto')
    await page.getByTestId('group-settings-save').click()
    await expect(page.getByTestId('group-settings-changed')).toHaveText('2 datasets changed.')

    for (const jobId of datasets) await expect.poll(async () => (await getJob(jobId)).ocr_decode).toBe('auto')
  })
})
