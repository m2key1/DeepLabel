import { test, expect } from '../helpers/test'
import { correctLine, getPageDetail, jobPageIds, seedCompletedJob, uniqueName } from '../helpers/api'
import { LANDSCAPE, openViewer } from '../helpers/viewer'

// Stored the way the model writes it: c followed by a combining acute.
const STORED = 'Pucic\u{301} Medo, Gf. 825'
const SHOWN = 'Puci\u{107} Medo, Gf. 825'

async function seedStoredLine() {
  const jobId = await seedCompletedJob(uniqueName('Composed'), 1, LANDSCAPE)
  const [pageId] = await jobPageIds(jobId)
  const lineOf = async () => (await getPageDetail(jobId, pageId)).elements
    .find((e: { class_name: string }) => e.class_name === 'Paragraph')
    .lines.find((l: { order_idx: number }) => l.order_idx === 0)
  await correctLine((await lineOf()).id, STORED)
  await expect.poll(async () => (await lineOf()).corrected_text).toBe(STORED)
  return { jobId, pageId, lineOf }
}

test.describe('Scenario: decomposed text is shown composed and saved decomposed', () => {
  test('a stored c + combining acute reads as one letter in the list and the editor', async ({ page }) => {
    const { jobId, pageId } = await seedStoredLine()
    await openViewer(page, jobId, pageId)

    const text = page.getByTestId('line-text').filter({ hasText: 'Medo, Gf. 825' })
    await expect(text).toHaveCount(1)
    expect(await text.textContent()).toBe(SHOWN)

    await text.click()
    await expect(page.getByTestId('line-editor')).toHaveValue(SHOWN)
  })

  test('a typed composed letter and a palette letter land decomposed, the caret after the inserted one',
    async ({ page }) => {
      const { jobId, pageId, lineOf } = await seedStoredLine()
      await openViewer(page, jobId, pageId)

      await page.getByTestId('line-text').filter({ hasText: 'Medo, Gf. 825' }).click()
      const editor = page.getByTestId('line-editor')
      await expect(editor).toHaveValue(SHOWN)
      // Straight after the composed letter: the caret counts what is on screen.
      await editor.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(5, 5))
      await page.getByTitle('Insert \u{e4}', { exact: true }).click()
      await page.keyboard.type('x\u{107}')
      await expect(editor).toHaveValue('Puci\u{107}\u{e4}x\u{107} Medo, Gf. 825')
      await page.keyboard.press('Enter')

      await expect.poll(async () => (await lineOf()).corrected_text)
        .toBe('Pucic\u{301}a\u{308}xc\u{301} Medo, Gf. 825')
      const row = page.getByTestId('line-text').filter({ hasText: 'Medo, Gf. 825' })
      await expect(row).toHaveCount(1)
      expect(await row.textContent()).toBe('Puci\u{107}\u{e4}x\u{107} Medo, Gf. 825')
    })

  test('leaving the editor untouched saves nothing, though the screen shows it composed', async ({ page }) => {
    const { jobId, pageId, lineOf } = await seedStoredLine()
    const before = (await lineOf()).revision
    await openViewer(page, jobId, pageId)
    const writes: string[] = []
    page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('/api/lines/')) writes.push(r.url()) })

    await page.getByTestId('line-text').filter({ hasText: 'Medo, Gf. 825' }).click()
    await expect(page.getByTestId('line-editor')).toHaveValue(SHOWN)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('line-editor')).toHaveCount(0)
    await expect(page.getByTestId('line-text').filter({ hasText: 'Medo, Gf. 825' })).toHaveCount(1)

    expect(writes).toEqual([])
    expect(await lineOf()).toMatchObject({ corrected_text: STORED, revision: before })
  })
})
