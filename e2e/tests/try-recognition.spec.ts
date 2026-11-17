import { test, expect } from '../helpers/test'
import { backendFetch, importStubModel, listRegistryModels, slowOcrModelId, uniqueName } from '../helpers/api'
import { scanPng, scanTiff } from '../helpers/image'
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

  test('a TIFF scan, which the browser cannot show by itself, is drawn with its lines all the same',
    async ({ page }) => {
      await page.goto('/try')
      await page.getByTestId('try-files').setInputFiles({ name: 'leaf.tif', mimeType: 'image/tiff', buffer: scanTiff(600, 800, 40) })
      await expect(page.getByTestId('try-text')).toHaveText(READ(6))
      await expect(page.getByTestId('try-line')).toHaveCount(6)

      // Decoded at the scan's own size, in the view and in its thumbnail - not a broken image.
      const size = (img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]
      const shown = page.getByRole('region', { name: 'Scan' }).getByRole('img', { name: 'leaf.tif' })
      await expect.poll(() => shown.evaluate(size)).toEqual([600, 800])
      const thumbnail = page.getByRole('button', { name: 'leaf.tif' }).locator('img')
      await expect.poll(() => thumbnail.evaluate(size)).toEqual([600, 800])
    })

  test('scans added later are shown at once, from the first of them', async ({ page }) => {
    const scanFile = (name: string, variant: number) => ({ name, mimeType: 'image/png', buffer: scanPng(600, 800, variant) })
    const thumbnail = (name: string) => page.getByRole('button', { name, exact: true })
    await page.goto('/try')
    await page.getByTestId('try-files').setInputFiles(scanFile('first.png', 40))
    await expect(thumbnail('first.png')).toHaveAttribute('aria-current', 'true')

    await page.getByTestId('try-files').setInputFiles([scanFile('second.png', 41), scanFile('third.png', 42)])
    await expect(thumbnail('second.png')).toHaveAttribute('aria-current', 'true')
    await expect(thumbnail('first.png')).not.toHaveAttribute('aria-current')
    await expect(thumbnail('third.png')).not.toHaveAttribute('aria-current')
    await expect(page.getByRole('region', { name: 'Scan' }).getByRole('img', { name: 'second.png' })).toBeVisible()
    // The last is read after the others; the account reads one request at a time, so the
    // next test waits for nothing left running here.
    await thumbnail('third.png').click()
    await expect(page.getByTestId('try-text')).toHaveText(READ(6))
  })

  test('the reading order is chosen as for a dataset, and the scan read again with it', async ({ page }) => {
    // A request carrying a file has no body Playwright can read, so the page notes what it sends.
    await page.addInitScript(() => {
      const sent: (FormDataEntryValue | null)[] = []
      Object.assign(window, { readingOrdersSent: sent })
      const original = window.fetch.bind(window)
      window.fetch = (input, init) => {
        if (String(input).endsWith('/api/recognize/pages') && init?.body instanceof FormData) {
          sent.push(init.body.get('reading_order'))
        }
        return original(input, init)
      }
    })
    const sent = () => page.evaluate(() => (window as unknown as { readingOrdersSent: unknown[] }).readingOrdersSent)
    await page.goto('/try')
    await page.getByTestId('try-files').setInputFiles({ name: 'leaf.png', mimeType: 'image/png', buffer: scanPng(600, 800, 40) })
    await expect(page.getByTestId('try-text')).toHaveText(READ(6))
    const order = page.getByLabel('Reading order')
    await expect(order.locator('option')).toHaveText([
      'Work it out per page', 'Single page, one column', 'Single page, two columns', 'Single page, three columns',
      'Double page, one column each', 'Double page, two columns each', 'Double page, three columns each'])
    await expect(page.getByTestId('try-api')).not.toContainText('reading_order')
    await expect(page.getByLabel('OCR decoding')).toHaveValue('auto')

    await order.selectOption({ label: 'Single page, two columns' })
    await expect.poll(sent).toEqual([null, '1x2'])
    await expect(page.getByTestId('try-text')).toHaveText(READ(6))
    await expect(page.getByTestId('try-api')).toContainText('-F reading_order=1x2')
  })

  test('beside the scan the text is as tall as it and scrolls itself to the outline under the pointer',
    async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 })
      const reader = (await listRegistryModels()).find((m) => m.task === 'ocr' && m.is_default)!
      // Wide and low, so its lines, the buttons and the API call outgrow it.
      const png = scanPng(1600, 400, 40)
      const count = (await answered(png, reader.id)).length
      await page.goto('/try')
      await page.getByTestId('try-files').setInputFiles({ name: 'wide.png', mimeType: 'image/png', buffer: png })
      await expect(page.getByTestId('try-text-line')).toHaveCount(count)

      const scan = page.getByRole('region', { name: 'Scan' })
      const text = page.getByRole('region', { name: 'Text' })
      const height = async (region: typeof scan) => Math.round((await region.boundingBox())!.height)
      await expect.poll(() => height(text)).toBe(await height(scan))
      const list = page.getByTestId('try-text-scroll')
      expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)

      const inList = (n: number) => list.evaluate((el, line) => {
        const row = el.querySelector(`[data-line="${line}"]`)!.getBoundingClientRect()
        const box = el.getBoundingClientRect()
        return row.top >= box.top && row.bottom <= box.bottom
      }, n)
      const main = page.getByTestId('app-main')
      const pageScroll = await main.evaluate((el) => el.scrollTop)
      await list.evaluate((el) => { el.scrollTop = el.scrollHeight })
      expect(await inList(1)).toBe(false)
      await page.locator('[data-testid="try-line"][data-line="1"]').hover({ force: true })
      await expect.poll(() => inList(1)).toBe(true)
      await expect(page.locator('[data-testid="try-text-line"][data-active]')).toHaveAttribute('data-line', '1')
      // Only the text column moved: the page stayed where it was under the pointer.
      expect(await main.evaluate((el) => el.scrollTop)).toBe(pageScroll)
    })

  test('a click on a line brings its outline into view, and the line numbers on the scan can be hidden',
    async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 700 })
      const png = scanPng(600, 2400, 40)
      await page.goto('/try')
      await page.getByTestId('try-files').setInputFiles({ name: 'tall.png', mimeType: 'image/png', buffer: png })
      const lines = page.getByTestId('try-text-line')
      await expect(lines.first()).toBeVisible()
      const count = await lines.count()
      const last = page.locator(`[data-testid="try-line"][data-line="${count}"]`)
      await expect(last).not.toBeInViewport()
      await page.locator(`[data-testid="try-text-line"][data-line="${count}"]`).click()
      await expect(last).toBeInViewport()

      const badges = page.getByRole('region', { name: 'Scan' }).locator('svg circle')
      await expect(badges).toHaveCount(count)
      const numbers = page.getByRole('button', { name: 'Line numbers' })
      await expect(numbers).toHaveAttribute('aria-pressed', 'true')
      await numbers.click()
      await expect(badges).toHaveCount(0)
      // The outlines stay, and the text keeps its numbers.
      await expect(page.getByTestId('try-line')).toHaveCount(count)
      await expect(lines.first()).toContainText('1')
      // Remembered by the browser for the next scan.
      await page.reload()
      await page.getByTestId('try-files').setInputFiles({ name: 'tall.png', mimeType: 'image/png', buffer: png })
      await expect(page.getByTestId('try-line')).toHaveCount(count)
      await expect(badges).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Line numbers' })).toHaveAttribute('aria-pressed', 'false')
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

  test('a layout model draws the regions behind the lines and groups the text under each region',
    async ({ page }) => {
      const layout = (await listRegistryModels()).find((m) => m.task === 'layout' && m.is_default)!
      await page.goto('/try')
      await expect(page.getByTestId('try-layout-model')).toHaveValue('')
      await page.getByTestId('try-files').setInputFiles({ name: 'leaf.png', mimeType: 'image/png', buffer: scanPng(600, 800, 43) })
      await expect(page.getByTestId('try-text')).toHaveText(READ(6))
      await expect(page.getByTestId('try-region')).toHaveCount(0)
      await expect(page.getByTestId('try-region-label')).toHaveCount(0)

      await page.getByTestId('try-layout-model').selectOption(String(layout.id))
      await expect(page.getByTestId('try-text')).toHaveText([
        ...[1, 2, 3].map((n) => `Sample Header line ${n}`), ...[1, 2, 3].map((n) => `Sample Paragraph line ${n}`)])
      await expect(page.getByTestId('try-region')).toHaveCount(2)
      expect(await page.getByTestId('try-region').evaluateAll((regions) => regions.map((r) => r.getAttribute('data-class'))))
        .toEqual(['Header', 'Paragraph'])
      await expect(page.getByTestId('try-region-label')).toHaveText(['Header', 'Paragraph'])
      // Lines are still numbered through the page, not per region.
      await expect(page.getByTestId('try-line')).toHaveCount(6)
      await expect(page.locator('[data-testid="try-text-line"]').last()).toHaveAttribute('data-line', '6')
      await expect(page.getByTestId('try-api')).toContainText(`-F layout_model=${layout.id}`)

      await page.getByTestId('try-layout-model').selectOption('')
      await expect(page.getByTestId('try-text')).toHaveText(READ(6))
      await expect(page.getByTestId('try-region')).toHaveCount(0)
      await expect(page.getByTestId('try-api')).not.toContainText('layout_model')
    })

  test('while a scan is read it is swept over with what the read is doing, its old results hidden',
    async ({ page }) => {
      test.setTimeout(120_000)
      const slow = slowOcrModelId()
      const pill = page.getByTestId('try-reading')
      await page.goto('/try')
      await page.getByTestId('try-files').setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: scanPng(500, 400, 42) })
      await expect(page.getByTestId('try-text')).toHaveText(READ(6))
      await expect(page.getByTestId('try-line')).toHaveCount(6)
      await expect(pill).toHaveCount(0)

      // The slow reader takes 15 s over a batch, so the scan read again stays on its lines that long.
      await page.getByTestId('try-ocr-model').selectOption(String(slow))
      await expect(pill).toHaveText(/^Reading 0 of 6 lines · \d+ s$/, { timeout: 10_000 })
      await expect.poll(async () => (await page.request.get('/api/recognize/reading')).json())
        .toEqual({ id: expect.any(String), pages: 1, lines_total: 6, lines_read: 0, state: 'reading',
                   started_at: expect.any(String) })
      await expect(page.getByTestId('try-sweep')).toBeVisible()
      await expect(page.getByTestId('try-text-waiting')).toBeVisible()
      await expect(page.getByTestId('try-line')).toHaveCount(0)
      await expect(page.getByTestId('try-text')).toHaveCount(0)

      await page.getByTestId('try-files').setInputFiles({ name: 'b.png', mimeType: 'image/png', buffer: scanPng(500, 400, 43) })
      await page.getByRole('button', { name: 'b.png' }).click()
      await expect(pill).toHaveText('Next in line')

      await page.getByRole('button', { name: 'a.png' }).click()
      await expect(page.getByTestId('try-text')).toHaveText(READ(6), { timeout: 30_000 })
      await expect(page.getByTestId('try-line')).toHaveCount(6)
      await expect(page.getByTestId('try-sweep')).toHaveCount(0)
      await expect(page.getByTestId('try-text-waiting')).toHaveCount(0)

      await page.getByRole('button', { name: 'b.png' }).click()
      await expect(pill).toHaveText(/^Reading 0 of 6 lines · \d+ s$/, { timeout: 10_000 })
      await expect(page.getByTestId('try-text')).toHaveText(READ(6), { timeout: 30_000 })
      await expect(pill).toHaveCount(0)
      expect(await (await page.request.get('/api/recognize/reading')).json()).toBeNull()
    })
})
