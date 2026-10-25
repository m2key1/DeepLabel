import { test, expect } from '../helpers/test'
import { type PageLine, jobPageIds, pageLines, seedCompletedJob, uniqueName } from '../helpers/api'
import {
  LANDSCAPE, type NormPoint, center, clickAt, dragAt, enterEditMode, openViewer,
} from '../helpers/viewer'

const near = (poly: NormPoint[], digits = 2) =>
  poly.map(([x, y]) => [expect.closeTo(x, digits), expect.closeTo(y, digits)])

async function seedPage(page: import('@playwright/test').Page) {
  const jobId = await seedCompletedJob(uniqueName('Undo'), 1, LANDSCAPE)
  const [pageId] = await jobPageIds(jobId)
  await openViewer(page, jobId, pageId)
  return { jobId, pageId }
}

const lineNamed = async (jobId: string, pageId: number, text: string) =>
  (await pageLines(jobId, pageId)).find((l) => l.text === text)!

const lineById = async (jobId: string, pageId: number, id: number) =>
  (await pageLines(jobId, pageId)).find((l) => l.id === id)

const texts = (jobId: string, pageId: number) =>
  pageLines(jobId, pageId).then((lines) => lines.map((l) => l.text))

const STUB_LINES = [
  'Sample Header line 1', 'Sample Header line 2', 'Sample Header line 3',
  'Sample Paragraph line 1', 'Sample Paragraph line 2', 'Sample Paragraph line 3',
]

async function selectLine(page: import('@playwright/test').Page, line: PageLine) {
  await clickAt(page, center(line.polygon as NormPoint[]))
  await expect(page.getByTestId('line-vertex-handle')).toHaveCount(4)
}

test.describe('Scenario: taking an edit back without losing the ones made after it', () => {
  test('undoing a reshape keeps the text the same person corrected afterwards', async ({ page }) => {
    const { jobId, pageId } = await seedPage(page)
    await enterEditMode(page)
    const line = await lineNamed(jobId, pageId, 'Sample Paragraph line 1')
    const original = line.polygon as NormPoint[]
    await selectLine(page, line)

    const [tl, tr, br, bl] = original
    const mid: NormPoint = [(br[0] + bl[0]) / 2, (br[1] + bl[1]) / 2]
    await dragAt(page, mid, [mid[0], mid[1] + 0.04])
    await expect.poll(async () => (await lineById(jobId, pageId, line.id))!.polygon)
      .toEqual(near([tl, tr, [br[0], br[1] + 0.04], [bl[0], bl[1] + 0.04]]))

    // A correction typed after the reshape is a separate edit, made later.
    await page.getByTestId('line-row').filter({ hasText: 'Sample Paragraph line 1' })
      .getByText('Sample Paragraph line 1', { exact: true }).click()
    await page.getByTestId('line-editor').fill('Corrected after the reshape')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await lineById(jobId, pageId, line.id))!.corrected_text)
      .toBe('Corrected after the reshape')

    await page.keyboard.press('Escape')
    await page.keyboard.press('ControlOrMeta+z')

    // The shape goes back; the correction, which the undo was not asked about, stays.
    await expect.poll(async () => (await lineById(jobId, pageId, line.id))!.polygon)
      .toEqual(near(original))
    const after = (await lineById(jobId, pageId, line.id))!
    expect(after.corrected_text).toBe('Corrected after the reshape')
    expect(after.checked).toBe(false)
  })

  test('a line thrown away from the reading list comes back with Ctrl+Z', async ({ page }) => {
    const { jobId, pageId } = await seedPage(page)
    const doomed = await lineNamed(jobId, pageId, 'Sample Paragraph line 2')
    const row = page.getByTestId('line-row').filter({ hasText: 'Sample Paragraph line 2' })
    await row.hover()
    await row.getByTestId('delete-line').click()
    await expect.poll(() => texts(jobId, pageId))
      .toEqual(STUB_LINES.filter((t) => t !== 'Sample Paragraph line 2'))
    await expect(row).toHaveCount(0)

    // No edit mode was entered to delete it, so none is needed to take it back.
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(() => texts(jobId, pageId)).toEqual(STUB_LINES)
    // The same line, not a new one with the same words.
    expect((await lineNamed(jobId, pageId, 'Sample Paragraph line 2')).id).toBe(doomed.id)
    await expect(row).toHaveCount(1)
  })
})

test.describe('Scenario: cutting a line that is not a box', () => {
  test('s cuts a polygon line in two, like a box', async ({ page }) => {
    const { jobId, pageId } = await seedPage(page)
    await enterEditMode(page)
    const line = await lineNamed(jobId, pageId, 'Sample Paragraph line 1')
    const before = (await pageLines(jobId, pageId)).length
    await selectLine(page, line)

    await page.getByTestId('line-shape-polygon').click()
    await expect.poll(async () => (await lineById(jobId, pageId, line.id))!.polygon.length).toBe(6)

    await page.keyboard.press('s')
    await clickAt(page, center(line.polygon as NormPoint[]))

    await expect.poll(async () => (await pageLines(jobId, pageId)).length).toBe(before + 1)
    // The cut falls at the click: the original id keeps everything left of it, the new
    // line everything right of it, and between them they cover the line it was.
    const cutAt = center(line.polygon as NormPoint[])[0]
    const left = (await lineById(jobId, pageId, line.id))!.polygon as NormPoint[]
    const xs = (poly: NormPoint[]) => poly.map((p) => p[0])
    expect(Math.max(...xs(left))).toBeCloseTo(cutAt, 2)
    expect(Math.min(...xs(left))).toBeCloseTo(Math.min(...xs(line.polygon as NormPoint[])), 2)
  })
})
