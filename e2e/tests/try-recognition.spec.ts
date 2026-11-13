import { test, expect } from '../helpers/test'
import { backendFetch, importStubModel, listRegistryModels, uniqueName } from '../helpers/api'
import { scanPng } from '../helpers/image'
import { seedSession, useSession } from '../helpers/session'

const READ = (n: number) => Array.from({ length: n }, (_, i) => `Sample Text line ${i + 1}`)

/** What the recognition API answers for this scan and OCR model: what the page has to show. */
async function answered(png: Buffer, ocrModel: number) {
  const form = new FormData()
  form.append('files', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'leaf.png')
  form.append('ocr_model', String(ocrModel))
  return (await backendFetch('/api/recognize/pages', { method: 'POST', body: form })).pages[0]
    .lines as { text: string; confidence: number }[]
}

test.describe('Scenario: trying recognition on a scan of your own', () => {
  test('the page is reached from the top bar and from an OCR model, for those who may recognize',
    async ({ page, browser }) => {
      const reader = (await listRegistryModels()).find((m) => m.task === 'ocr' && m.is_default)!
      await page.goto('/')
      await page.getByRole('link', { name: 'Try', exact: true }).click()
      await expect(page).toHaveURL(/\/try$/)
      await expect(page.getByRole('heading', { name: 'Try recognition' })).toBeVisible()

      await page.goto(`/models/${reader.id}`)
      await page.getByRole('link', { name: 'Try this model' }).click()
      await expect(page).toHaveURL(new RegExp(`/try\\?ocr=${reader.id}$`))
      await expect(page.getByTestId('try-ocr-model')).toHaveValue(String(reader.id))

      const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
      await useSession(context, seedSession('member', `try-${Date.now()}`))
      const member = await context.newPage()
      await member.goto('/')
      await expect(member.getByRole('link', { name: 'Models', exact: true })).toBeVisible()
      await expect(member.getByRole('link', { name: 'Try', exact: true })).toHaveCount(0)
      await context.close()
    })

  test('a dropped scan is drawn with its lines and read beside it, each line linked both ways',
    async ({ page }) => {
      const misread = importStubModel('ocr', uniqueName('Unsure reader'), 'stub-misread')
      const png = scanPng(600, 800, 40)
      const expected = await answered(png, misread)

      await page.goto('/try')
      await page.getByTestId('try-files').setInputFiles({ name: 'leaf.png', mimeType: 'image/png', buffer: png })
      await expect(page.getByTestId('try-text')).toHaveText(READ(6))
      await expect(page.getByTestId('try-line')).toHaveCount(6)

      // Another OCR model reads the scan again.
      await page.getByTestId('try-ocr-model').selectOption(String(misread))
      await expect(page.getByTestId('try-text')).toHaveText(expected.map((l) => l.text))
      const unsure = expected.flatMap((l, i) => (l.confidence < 0.85 ? [String(i + 1)] : []))
      expect(unsure.length).toBeGreaterThan(0)
      await expect(page.locator('[data-testid="try-text-line"][data-unsure]')).toHaveCount(unsure.length)
      expect(await page.locator('[data-testid="try-text-line"][data-unsure]')
        .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-line')))).toEqual(unsure)
      await expect(page.getByTestId('try-api')).toContainText(`-F ocr_model=${misread}`)

      await page.locator('[data-testid="try-text-line"][data-line="3"]').hover()
      await expect(page.locator('[data-testid="try-line"][data-active]')).toHaveAttribute('data-line', '3')
      await page.locator('[data-testid="try-line"][data-line="5"]').hover({ force: true })
      await expect(page.locator('[data-testid="try-text-line"][data-active]')).toHaveAttribute('data-line', '5')
    })

  test('the text is copied and the PAGE XML downloaded as the API returns them', async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto('/try')
    await page.getByTestId('try-files').setInputFiles({ name: 'leaf.png', mimeType: 'image/png', buffer: scanPng(500, 400, 41) })
    await expect(page.getByTestId('try-text')).toHaveText(READ(6))

    await page.getByRole('button', { name: 'Copy text' }).click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(READ(6).join('\n'))

    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download PAGE XML' }).click()
    const file = await download
    expect(file.suggestedFilename()).toBe('leaf.xml')
    const xml = await (await import('node:fs/promises')).readFile(await file.path(), 'utf8')
    expect(xml).toContain('<Page imageFilename="leaf.png" imageWidth="500" imageHeight="400">')
    expect(xml.match(/<TextLine /g)).toHaveLength(6)
  })
})
