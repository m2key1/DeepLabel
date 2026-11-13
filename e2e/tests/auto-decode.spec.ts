import { test, expect } from '../helpers/test'
import {
  createGroup, getJob, importStubModel, moveJobToGroup, patchJob, seedCompletedJob, setModelColumn, uniqueName,
} from '../helpers/api'
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

  test('a fine-tune no run has loaded yet offers its token decoder, as the model it was trained from does',
    async ({ page }) => {
      const reader = importStubModel('ocr', uniqueName('Token reader'), 'stub-misread')
      const tuned = importStubModel('ocr', uniqueName('Unloaded fine-tune'), 'stub-misread')
      const plain = importStubModel('ocr', uniqueName('Plain reader'), 'stub-misread')
      setModelColumn(reader, 'decoder', 'token')
      setModelColumn(tuned, 'trained_from', reader)

      await page.goto('/new')
      await page.getByLabel('Job name').fill(uniqueName('Decoder card'))
      await page.locator('input[type="file"]').setInputFiles([{ name: 'leaf.png', mimeType: 'image/png', buffer: scanPng() }])
      await withLayoutPerCrop(page)
      await wizardStep(page, 'models')

      const card = page.getByTestId('ocr-decode-decoder')
      for (const model of [reader, tuned]) {
        await page.getByTestId('new-model-ocr').selectOption(String(model))
        await expect(card).toBeVisible()
      }
      await page.getByTestId('new-model-ocr').selectOption(String(plain))
      await expect(page.getByTestId('ocr-decode-auto')).toBeVisible()
      await expect(card).toHaveCount(0)
    })
})
