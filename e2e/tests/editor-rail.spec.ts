import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/test'
import {
  backendFetch, correctLine, getPageDetail, identity, jobPageIds, pageLines, patchJob, seedCompletedJob,
  seedDistinctPagesJob, seedLlmConnection, uniqueName,
} from '../helpers/api'
import { startLlmRead } from '../helpers/llm'
import { LANDSCAPE, center, clickAt, dragAt, enterEditMode, openViewer } from '../helpers/viewer'
import type { NormPoint } from '../helpers/viewer'

const DEV = identity('dev', 'admin')

interface Line {
  id: number
  polygon: NormPoint[]
  text: string | null
  corrected_text: string | null
  checked: boolean
}

interface Element {
  id: number
  class_name: string
  lines: Line[]
}

const elements = async (jobId: string, pageId: number): Promise<Element[]> =>
  (await getPageDetail(jobId, pageId)).elements

const paragraphLines = async (jobId: string, pageId: number) =>
  (await elements(jobId, pageId)).find((e) => e.class_name === 'Paragraph')!.lines

const lineById = async (jobId: string, pageId: number, id: number) =>
  (await elements(jobId, pageId)).flatMap((e) => e.lines).find((l) => l.id === id)!

async function seedEditor(page: Page) {
  const jobId = await seedCompletedJob(uniqueName('Rail editing'), 1, LANDSCAPE)
  const [pageId] = await jobPageIds(jobId)
  await openViewer(page, jobId, pageId)
  await enterEditMode(page)
  return { jobId, pageId }
}

/** Put the brush on an exact size, so a sweep takes the corners it is aimed at. */
async function eraserAt(page: Page, radiusPx: number) {
  await page.getByTestId('tool-erase').click()
  const radius = page.getByTestId('brush-radius')
  await radius.fill(String(radiusPx))
  await radius.blur()
}

/** A short sweep ending on the line's first corner, with the next one far enough off. */
const sweepFirstCorner = (page: Page, line: Line) => {
  const [cx, cy] = line.polygon[0]
  return dragAt(page, [cx - 0.02, cy - 0.01], [cx, cy])
}

const penRow = (page: Page, name: string) => page.locator(`[data-testid="pen-row"][data-class="${name}"]`)
const pill = (page: Page, name: string) => page.locator(`[data-testid="pen-pill"][data-class="${name}"]`)

// A point inside the Paragraph box but in the gap between its line polygons, so a click
// selects the element itself rather than a line.
const PARAGRAPH_GAP: NormPoint = [0.5, 0.42]

test.describe('Scenario: the eraser and what somebody has read', () => {
  // README: the eraser "rubs out the corners under it", and a line somebody has read is
  // stepped over. A line the language models filled in, which nobody checked, has been
  // read by nobody - a model's agreement is not a person's work, and the eraser has to
  // take it like any other detection.
  test('a line the models filled in is erased like any other; a line a person typed into is spared',
    async ({ page }) => {
      const jobId = await seedDistinctPagesJob(uniqueName('Model-filled'), 1, 140)
      const [pageId] = await jobPageIds(jobId)
      const connection = uniqueName('Erase readers')
      await seedLlmConnection(connection, ['stub-perfect', 'stub-second'], DEV)
      await startLlmRead(page, jobId, connection, ['stub-perfect', 'stub-second'], { minAgree: 2, autocheck: false })
      // Both readers agree with the OCR on every line: all six are filled in, none is checked.
      await expect.poll(async () =>
        (await pageLines(jobId, pageId)).map((l) => [l.corrected_text === l.text, l.checked]),
      ).toEqual(Array(6).fill([true, false]))

      await openViewer(page, jobId, pageId)
      await enterEditMode(page)
      await eraserAt(page, 4)
      const [filled, typed] = await paragraphLines(jobId, pageId)
      expect(filled.polygon).toHaveLength(4)

      await sweepFirstCorner(page, filled)
      await expect.poll(async () => (await lineById(jobId, pageId, filled.id)).polygon.length).toBe(3)
      await expect(page.getByTestId('editor-notice')).toHaveText('1 reshaped')

      // A correction a person typed, checked or not, is their work: the brush steps over it
      // and says so, until Shift says to take it too.
      await correctLine(typed.id, 'Typed by hand', false)
      await sweepFirstCorner(page, typed)
      await expect(page.getByTestId('editor-notice')).toContainText('left alone')
      expect((await lineById(jobId, pageId, typed.id)).polygon).toEqual(typed.polygon)
    })

  // A line somebody reshaped since the page was loaded is theirs now. The brush judges
  // every corner by the shape it loaded: a sweep that would reshape such a line is refused
  // and named in the notice, and a sweep that would take the whole line has to be refused
  // the same way, not throw their line away.
  test('a line changed since it was loaded is left standing when the brush would take all of it',
    async ({ page }) => {
      const jobId = await seedCompletedJob(uniqueName('Erase conflict'), 1, LANDSCAPE)
      const [pageId] = await jobPageIds(jobId)
      // A reshape queues a re-read, whose fresh text is a revision of its own and lands at
      // the batcher's cadence; with OCR off for the dataset, hers is the only change.
      await patchJob(jobId, { run_ocr: false })
      // This tab hears nothing after loading, as on a dropped connection.
      await page.route('**/api/pages/*/events**', (route) => route.abort())
      await openViewer(page, jobId, pageId)
      await enterEditMode(page)
      await eraserAt(page, 48)
      const [line] = await paragraphLines(jobId, pageId)
      expect(line.polygon).toHaveLength(4)

      // alice nudges the line a little to the right: a change of shape, not a reading.
      const theirs: NormPoint[] = line.polygon.map(([x, y]) => [Math.round((x + 0.01) * 1000) / 1000, y])
      await backendFetch(`/api/lines/${line.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...identity('alice', 'admin') },
        body: JSON.stringify({ polygon: theirs }),
      })
      expect((await lineById(jobId, pageId, line.id)).polygon).toEqual(theirs)

      // Straight across the whole line as it was loaded: every corner is under the brush.
      const sweep = () => dragAt(page, [line.polygon[0][0] - 0.02, center(line.polygon)[1]],
                                 [line.polygon[1][0] + 0.02, center(line.polygon)[1]])
      await sweep()
      await expect(page.getByTestId('editor-notice')).toBeVisible()
      const standing = (await pageLines(jobId, pageId)).find((l) => l.id === line.id)
      expect(standing?.polygon ?? null).toEqual(theirs)
      await expect(page.getByTestId('editor-notice')).toContainText('changed since it was loaded - left alone')
      expect(await pageLines(jobId, pageId)).toHaveLength(6)

      // Loaded again, with her shape in hand, the same sweep takes it.
      await openViewer(page, jobId, pageId)
      await enterEditMode(page)
      await eraserAt(page, 48)
      await sweep()
      await expect.poll(async () => (await pageLines(jobId, pageId)).map((l) => l.id)).not.toContain(line.id)
      await expect(page.getByTestId('editor-notice')).toHaveText('1 line erased')
      expect(await pageLines(jobId, pageId)).toHaveLength(5)
    })
})

test.describe('Scenario: the rail describes what is on the page and what is selected', () => {
  // README: the editor rail lists the regions; a line is as much a shape on the page as a
  // box, and the person correcting the page needs to find it there and know what it is.
  test('every line is listed under its region in the rail, and a row selects it', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)
    const rail = page.getByTestId('region-list')
    const elementRows = rail.locator('[data-testid="region-row"][data-region-id]')
    const lineRows = rail.locator('[data-testid="region-line-row"][data-line-id]')
    await expect(elementRows).toHaveCount(2)
    await expect(lineRows).toHaveCount(6)
    await expect(page.getByTestId('region-count')).toHaveText('2 · 6 lines')

    const [first, second] = await paragraphLines(jobId, pageId)
    const firstRow = rail.locator(`[data-testid="region-line-row"][data-line-id="${first.id}"]`)
    await expect(firstRow).toContainText('Line')
    await firstRow.click()
    await expect(page.getByTestId('line-vertex-handle')).toHaveCount(4)
    await expect(firstRow).toHaveAttribute('data-selected', 'true')
    // The line is what is selected, not the region it sits in.
    await expect(rail.locator('[data-testid="region-row"][data-region-id][data-selected="true"]')).toHaveCount(0)

    // Selecting on the scan marks the row the other way round.
    await clickAt(page, center(second.polygon))
    await expect(rail.locator(`[data-testid="region-line-row"][data-line-id="${second.id}"]`))
      .toHaveAttribute('data-selected', 'true')
    await expect(firstRow).not.toHaveAttribute('data-selected', 'true')
  })

  // README: "the rail says what the next stroke is" - the loaded pen. Which class the
  // selected shape has is a second question, and the rail answers it beside the first:
  // a selected line marks Line, a selected box marks its class, whatever pen is loaded.
  test('the class rail marks the class of what is selected, apart from the pen that is loaded',
    async ({ page }) => {
      const { jobId, pageId } = await seedEditor(page)
      const selectedRows = page.locator('[data-testid="pen-row"][data-selected="true"]')
      await expect(penRow(page, 'Line')).toBeVisible()
      await expect(selectedRows).toHaveCount(0)

      const [first] = await paragraphLines(jobId, pageId)
      await clickAt(page, center(first.polygon))
      await expect(page.getByTestId('line-vertex-handle')).toHaveCount(4)
      await expect(penRow(page, 'Line')).toHaveAttribute('data-selected', 'true')
      await expect(selectedRows).toHaveCount(1)

      // Loading a pen does not change what is selected, and the rail keeps saying both.
      await pill(page, 'Paragraph').click()
      await expect(penRow(page, 'Paragraph')).toHaveAttribute('data-active', 'true')
      await expect(penRow(page, 'Line')).toHaveAttribute('data-selected', 'true')
      await expect(penRow(page, 'Paragraph')).not.toHaveAttribute('data-selected', 'true')

      // Letting go of the selection clears the mark; selecting a box marks its class.
      await page.keyboard.press('Escape')
      await expect(selectedRows).toHaveCount(0)
      await page.getByTestId('tool-select').click()
      await clickAt(page, PARAGRAPH_GAP)
      await expect(page.getByTestId('element-handle')).toHaveCount(8)
      await expect(penRow(page, 'Paragraph')).toHaveAttribute('data-selected', 'true')
      await expect(penRow(page, 'Line')).not.toHaveAttribute('data-selected', 'true')
    })
})
