import { test, expect } from '../helpers/test'
import { getPageDetail, jobPageIds, seedCompletedJob, uniqueName } from '../helpers/api'
import { LANDSCAPE, center, clickAt, dragAt, enterEditMode, openViewer } from '../helpers/viewer'

interface Element {
  id: number
  class_name: string
  kind: string
  bbox: number[]
}

async function seedEditor(page: import('@playwright/test').Page) {
  const jobId = await seedCompletedJob(uniqueName('Element editing'), 1, LANDSCAPE)
  const [pageId] = await jobPageIds(jobId)
  await openViewer(page, jobId, pageId)
  await enterEditMode(page)
  return { jobId, pageId }
}

const elements = async (jobId: string, pageId: number): Promise<Element[]> =>
  (await getPageDetail(jobId, pageId)).elements

const paragraph = (els: Element[]) => els.find((e) => e.class_name === 'Paragraph')!

// A point inside the Paragraph box but in the gap between its line polygons,
// so a click selects the element itself rather than a line.
const PARAGRAPH_GAP: [number, number] = [0.5, 0.42]

test.describe('Scenario: correcting the layout', () => {
  test('drawing a new element with the pen, then undoing it', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)

    await page.locator('[data-testid="pen-pill"][data-class="Paragraph"]').click()
    await dragAt(page, [0.03, 0.3], [0.08, 0.55])
    await expect.poll(async () => (await elements(jobId, pageId)).length).toBe(3)
    const drawn = (await elements(jobId, pageId)).find((e) => e.bbox[2] < 0.1)!
    expect(drawn.class_name).toBe('Paragraph')
    const target = [0.03, 0.3, 0.08, 0.55]
    drawn.bbox.forEach((v, i) => expect(Math.abs(v - target[i])).toBeLessThan(0.02))

    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => (await elements(jobId, pageId)).length).toBe(2)
  })

  test('the pen draws columns inside a table, one after another, without picking the table', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)
    const pen = (name: string) => page.locator(`[data-testid="pen-pill"][data-class="${name}"]`)
    const near = (bbox: number[]) => bbox.map((v) => expect.closeTo(v, 1))
    const ofClass = async (name: string) =>
      (await elements(jobId, pageId)).filter((e) => e.class_name === name).map((e) => e.bbox)
        .sort((a, b) => a[0] - b[0])
    const TABLE = [0.12, 0.87, 0.88, 0.99]
    const COLUMNS = [[0.15, 0.89, 0.45, 0.97], [0.55, 0.89, 0.85, 0.97]]

    await pen('Table').click()
    await dragAt(page, [TABLE[0], TABLE[1]], [TABLE[2], TABLE[3]])
    await expect.poll(() => ofClass('Table')).toEqual([near(TABLE)])
    await expect(page.getByTestId('selected-class')).toHaveValue('Table')

    // Loading the Column pen leaves the selected table a Table. The first stroke lands
    // inside the table while it is selected, the second while the first column is.
    await pen('Column').click()
    for (const [i, c] of COLUMNS.entries()) {
      await dragAt(page, [c[0], c[1]], [c[2], c[3]])
      await expect.poll(() => ofClass('Column')).toEqual(COLUMNS.slice(0, i + 1).map(near))
      await expect(page.getByTestId('selected-class')).toHaveValue('Column')
    }
    await expect(pen('Column')).toHaveAttribute('aria-pressed', 'true')
    // Never picked up, so never moved or reclassed by the strokes aimed inside it.
    expect(await ofClass('Table')).toEqual([near(TABLE)])
    expect((await elements(jobId, pageId)).length).toBe(5)
  })

  test('the editor opens in the select tool, so a click picks what it lands on', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)
    await expect(page.getByTestId('tool-select')).toHaveAttribute('aria-pressed', 'true')

    await clickAt(page, PARAGRAPH_GAP)
    await expect(page.getByTestId('element-handle')).toHaveCount(8)
    await expect(page.getByTestId('selected-class')).toHaveValue('Paragraph')
    await expect(page.getByTestId('box-draft-corner')).toHaveCount(0)
    expect((await elements(jobId, pageId)).length).toBe(2)
  })

  test('a pen click on top of a box starts a box there and leaves the selected one alone', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)
    const pen = (name: string) => page.locator(`[data-testid="pen-pill"][data-class="${name}"]`)
    const near = (bbox: number[]) => bbox.map((v) => expect.closeTo(v, 1))
    await page.getByTestId('tool-select').click()
    await clickAt(page, PARAGRAPH_GAP)
    await expect(page.getByTestId('selected-class')).toHaveValue('Paragraph')

    // The rail loads the pen for the next box; the selected one keeps its class.
    await pen('Header').click()
    await expect(pen('Header')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('selected-class')).toHaveValue('Paragraph')

    // Two clicks, both on top of the paragraph and its lines, lay the box down.
    await clickAt(page, [0.3, 0.4])
    await expect(page.getByTestId('box-draft-corner')).toBeVisible()
    await clickAt(page, [0.6, 0.6])
    await expect
      .poll(async () => (await elements(jobId, pageId))
        .map((e) => ({ class_name: e.class_name, bbox: e.bbox }))
        .sort((a, b) => a.class_name.localeCompare(b.class_name) || a.bbox[1] - b.bbox[1]))
      .toEqual([
        { class_name: 'Header', bbox: near([0.1, 0.05, 0.9, 0.15]) },
        { class_name: 'Header', bbox: near([0.3, 0.4, 0.6, 0.6]) },
        { class_name: 'Paragraph', bbox: near([0.1, 0.2, 0.9, 0.85]) },
      ])
  })

  test('a click selects the innermost item and + steps out to its element', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)

    // The center of the Paragraph lands on one of its lines first.
    await clickAt(page, [0.5, 0.5])
    await expect(page.getByTestId('line-vertex-handle')).toHaveCount(4)

    await page.keyboard.press('+')
    await expect(page.getByTestId('element-handle')).toHaveCount(8)

    // Resize via the south-east handle.
    const before = paragraph(await elements(jobId, pageId)).bbox
    await dragAt(page, [before[2], before[3]], [0.95, 0.9])
    await expect
      .poll(async () => paragraph(await elements(jobId, pageId)).bbox.slice(2))
      .toEqual([expect.closeTo(0.95, 1), expect.closeTo(0.9, 1)])
  })

  test('clicking the same spot again steps through what else is under it', async ({ page }) => {
    await seedEditor(page)

    // A line first, as above - and the moment it is selected its handles cover it, so
    // the next click lands on one of them rather than on the line's body.
    await clickAt(page, [0.5, 0.5])
    await expect(page.getByTestId('line-vertex-handle')).toHaveCount(4)

    // A handle pressed and released without moving is a click on what is underneath,
    // not a reshape that happened to change nothing.
    await page.getByTestId('line-edge-handle').first().click()
    await expect(page.getByTestId('element-handle')).toHaveCount(8)
    await expect(page.getByTestId('line-vertex-handle')).toHaveCount(0)

    // And round again, so nothing under the cursor is out of reach.
    await clickAt(page, [0.5, 0.5])
    await expect(page.getByTestId('line-vertex-handle')).toHaveCount(4)
  })

  test('Escape lets go of the selection before it leaves edit mode', async ({ page }) => {
    await seedEditor(page)
    await clickAt(page, [0.5, 0.5])
    await expect(page.getByTestId('line-vertex-handle')).toHaveCount(4)

    await page.keyboard.press('Escape')

    // The selection goes; the editor stays.
    await expect(page.getByTestId('line-vertex-handle')).toHaveCount(0)
    await expect(page.getByTestId('region-list')).toBeVisible()

    // A second Escape is what leaves, as it always did.
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('region-list')).toHaveCount(0)
  })

  test('moving an element by drag and nudging with shift+arrow', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)

    // Moving is the select tool's: with the pen loaded the same drag draws a new box.
    await page.getByTestId('tool-select').click()
    await clickAt(page, PARAGRAPH_GAP)
    await expect(page.getByTestId('element-handle')).toHaveCount(8)

    await dragAt(page, PARAGRAPH_GAP, [PARAGRAPH_GAP[0] + 0.03, PARAGRAPH_GAP[1] + 0.05])
    await expect
      .poll(async () => paragraph(await elements(jobId, pageId)).bbox[0])
      .toBeGreaterThan(0.11)
    expect((await elements(jobId, pageId)).length).toBe(2)

    const before = paragraph(await elements(jobId, pageId)).bbox
    await page.keyboard.press('Shift+ArrowRight')
    await expect
      .poll(async () => paragraph(await elements(jobId, pageId)).bbox[0])
      .toBeCloseTo(before[0] + 0.002, 5)
  })

  test('a digit hotkey loads its pen and leaves the selected element alone', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)

    await clickAt(page, PARAGRAPH_GAP)
    await expect(page.getByTestId('element-handle')).toHaveCount(8)

    // Display order puts BigParagraph on digit 3.
    await page.keyboard.press('3')
    await expect(page.locator('[data-testid="pen-pill"][data-class="BigParagraph"]'))
      .toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('selected-class')).toHaveValue('Paragraph')
    await dragAt(page, [0.03, 0.3], [0.08, 0.55])
    await expect
      .poll(async () => (await elements(jobId, pageId)).map((e) => e.class_name).sort())
      .toEqual(['BigParagraph', 'Header', 'Paragraph'])
  })
})

test.describe('Scenario: working on several boxes at once', () => {
  const merged = (page: import('@playwright/test').Page) =>
    page.locator('[data-testid="region-box"][data-merged]')

  // A rectangle that wholly contains the given boxes, with room to spare.
  const around = (boxes: number[][]): [[number, number], [number, number]] => {
    const pad = 0.01
    return [
      [Math.min(...boxes.map((b) => b[0])) - pad, Math.min(...boxes.map((b) => b[1])) - pad],
      [Math.max(...boxes.map((b) => b[2])) + pad, Math.max(...boxes.map((b) => b[3])) + pad],
    ]
  }

  test('shift-dragging a box over the page gathers what it wholly covers', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)
    const els = await elements(jobId, pageId)
    expect(els.length).toBe(2)

    const [from, to] = around(els.map((e) => e.bbox))
    await dragAt(page, from, to, { shift: true })

    await expect(merged(page)).toHaveCount(els.length)
    await expect(page.getByText(`${els.length} selected`, { exact: false })).toBeVisible()

    // Paired presence/absence: a sweep that covers only one leaves the other out.
    const [oneFrom, oneTo] = around([paragraph(els).bbox])
    await page.keyboard.press('Escape')
    await expect(merged(page)).toHaveCount(0)
    await dragAt(page, oneFrom, oneTo, { shift: true })
    await expect(merged(page)).toHaveCount(1)
    await expect(merged(page)).toHaveAttribute('data-id', String(paragraph(els).id))
  })

  test('a hidden class is not swept up', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)
    const els = await elements(jobId, pageId)
    const para = paragraph(els)

    await page.getByRole('button', { name: `Hide ${para.class_name}`, exact: true }).click()
    const [from, to] = around(els.map((e) => e.bbox))
    await dragAt(page, from, to, { shift: true })

    // Everything but the hidden class, which cannot be gathered because it is not shown.
    const expected = els.filter((e) => e.class_name !== para.class_name)
    await expect(merged(page)).toHaveCount(expected.length)
    for (const el of expected) {
      await expect(page.locator(`[data-testid="region-box"][data-id="${el.id}"][data-merged]`))
        .toHaveCount(1)
    }
    await expect(page.locator(`[data-testid="region-box"][data-id="${para.id}"][data-merged]`))
      .toHaveCount(0)
  })

  test('the gathered set is deleted in one go', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)
    const els = await elements(jobId, pageId)

    const [from, to] = around(els.map((e) => e.bbox))
    await dragAt(page, from, to, { shift: true })
    await expect(merged(page)).toHaveCount(els.length)

    await page.keyboard.press('Delete')
    // Backend oracle: every gathered element is gone, not just the one that was selected.
    await expect.poll(async () => (await elements(jobId, pageId)).length).toBe(0)
    await expect(merged(page)).toHaveCount(0)
  })

  test('shift-clicking one box still just adds that one', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)
    const els = await elements(jobId, pageId)
    const para = paragraph(els)

    await clickAt(page, PARAGRAPH_GAP, { shift: true })
    await expect(merged(page)).toHaveCount(1)
    await expect(merged(page)).toHaveAttribute('data-id', String(para.id))

    // Clicking it again takes it back off.
    await clickAt(page, PARAGRAPH_GAP, { shift: true })
    await expect(merged(page)).toHaveCount(0)
  })
})

test.describe('Scenario: choosing what the pen draws', () => {
  // The pills carry their digit hint in the label, so their name is not a stable handle.
  const pill = (page: import('@playwright/test').Page, name: string) =>
    page.locator(`[data-testid="pen-pill"][data-class="${name}"]`)

  test('the rail says what the next stroke is, not what happens to be selected', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)

    // Select a line, which no class pill can describe, and load the Paragraph pen.
    await clickAt(page, [0.5, 0.5])
    await expect(page.getByTestId('line-vertex-handle')).toHaveCount(4)
    await pill(page, 'Line').click()
    await expect(pill(page, 'Line')).toHaveAttribute('aria-pressed', 'true')
    await pill(page, 'Paragraph').click()
    await expect(pill(page, 'Paragraph')).toHaveAttribute('aria-pressed', 'true')
    await expect(pill(page, 'Line')).toHaveAttribute('aria-pressed', 'false')

    // And the stroke agrees with the rail.
    await dragAt(page, [0.03, 0.3], [0.08, 0.55])
    await expect.poll(async () => (await elements(jobId, pageId)).length).toBe(3)
    const drawn = (await elements(jobId, pageId)).find((e) => e.bbox[2] < 0.1)!
    expect(drawn.class_name).toBe('Paragraph')
    // What was drawn is what is now selected: eight box handles, and no line handles.
    await expect(page.getByTestId('element-handle')).toHaveCount(8)
    await expect(page.getByTestId('line-vertex-handle')).toHaveCount(0)
  })

  test('two clicks draw the same box a drag would', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)

    await pill(page, 'Paragraph').click()
    await clickAt(page, [0.03, 0.3])
    await expect(page.getByTestId('box-draft-corner')).toBeVisible()
    await clickAt(page, [0.08, 0.55])
    await expect(page.getByTestId('box-draft-corner')).toHaveCount(0)

    await expect.poll(async () => (await elements(jobId, pageId)).length).toBe(3)
    const drawn = (await elements(jobId, pageId)).find((e) => e.bbox[2] < 0.1)!
    expect(drawn.class_name).toBe('Paragraph')
    const target = [0.03, 0.3, 0.08, 0.55]
    drawn.bbox.forEach((v, i) => expect(Math.abs(v - target[i])).toBeLessThan(0.02))
  })

  test('Escape abandons a box that is half drawn', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)

    await pill(page, 'Paragraph').click()
    await clickAt(page, [0.03, 0.3])
    await expect(page.getByTestId('box-draft-corner')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('box-draft-corner')).toHaveCount(0)

    // The next click is a first click again, not the finish of the abandoned one.
    await clickAt(page, [0.08, 0.55])
    await expect(page.getByTestId('box-draft-corner')).toBeVisible()
    await expect.poll(async () => (await elements(jobId, pageId)).length).toBe(2)
  })

  test('putting the pen down lets a drag pick boxes out instead of drawing one', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)
    const els = await elements(jobId, pageId)

    await page.getByTestId('tool-select').click()
    await expect(page.getByTestId('tool-select')).toHaveAttribute('aria-pressed', 'true')
    await expect(pill(page, 'Paragraph')).toHaveAttribute('aria-pressed', 'false')

    // A sweep over the whole page gathers what it covers and draws nothing.
    const pad = 0.01
    await dragAt(page,
      [Math.min(...els.map((e) => e.bbox[0])) - pad, Math.min(...els.map((e) => e.bbox[1])) - pad],
      [Math.max(...els.map((e) => e.bbox[2])) + pad, Math.max(...els.map((e) => e.bbox[3])) + pad])
    await expect(page.locator('[data-testid="region-box"][data-merged]')).toHaveCount(els.length)
    await expect.poll(async () => (await elements(jobId, pageId)).length).toBe(els.length)

    // Paired: the same stroke with the pen loaded does draw.
    await page.keyboard.press('Escape')
    await pill(page, 'Paragraph').click()
    await dragAt(page, [0.03, 0.3], [0.08, 0.55])
    await expect.poll(async () => (await elements(jobId, pageId)).length).toBe(els.length + 1)
  })

  test('the selected box is reclassed from its own control', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)

    await clickAt(page, PARAGRAPH_GAP)
    await expect(page.getByTestId('element-handle')).toHaveCount(8)
    await expect(page.getByTestId('selected-class')).toHaveValue('Paragraph')
    // Loading a pen leaves the selection's class alone.
    await pill(page, 'Header').click()

    await page.getByTestId('selected-class').selectOption('BigParagraph')
    await expect
      .poll(async () => (await elements(jobId, pageId)).map((e) => e.class_name).sort())
      .toEqual(['BigParagraph', 'Header'])
    // The pen is untouched: reclassing is not choosing what to draw next.
    await expect(pill(page, 'Header')).toHaveAttribute('aria-pressed', 'true')
  })

  test('the Select tool picks a box whatever pen was left loaded', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)

    // What drawing lines leaves behind: the Line pen loaded, and its class hidden to
    // read the scan underneath. The pen says what Draw would draw, not what Select
    // may pick up.
    await page.getByTestId('line-pen-box').click()
    await expect(page.getByTestId('line-poly')).toHaveCount(6)
    await page.getByRole('button', { name: 'Hide Line' }).click()
    await expect(page.getByTestId('line-poly')).toHaveCount(0)

    await page.getByTestId('tool-select').click()
    await clickAt(page, PARAGRAPH_GAP)

    // Selected outright - not swept into the merge set, which is what a click does
    // when nothing under it was pickable.
    await expect(page.getByTestId('element-handle')).toHaveCount(8)
    await expect(page.locator('[data-testid="region-box"][data-merged]')).toHaveCount(0)

    const before = paragraph(await elements(jobId, pageId)).bbox
    await dragAt(page, [before[2], before[3]], [0.95, 0.9])
    await expect
      .poll(async () => paragraph(await elements(jobId, pageId)).bbox.slice(2))
      .toEqual([expect.closeTo(0.95, 1), expect.closeTo(0.9, 1)])
  })
})

test.describe('Scenario: the readings list after the listed region is gone', () => {
  // Clicking a line on the page narrows the readings list to its region. When that region
  // is then removed - deleted, deleted as part of a gathered set, or undone out of
  // existence - there is nothing left to list for it, and the list has to be the page's
  // again, with the lines that remain, rather than an emptied list of a region nobody can
  // select any more.
  const paragraphLine = async (jobId: string, pageId: number): Promise<{ polygon: [number, number][] }> =>
    (await getPageDetail(jobId, pageId)).elements
      .find((e: { class_name: string }) => e.class_name === 'Paragraph')!.lines[0]
  const headerRows = (page: import('@playwright/test').Page) =>
    page.getByTestId('line-row').filter({ hasText: 'Sample Header line' })
  const gathered = (page: import('@playwright/test').Page) =>
    page.locator('[data-testid="region-box"][data-merged]')

  test('deleting the listed region lists the page again', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Delete listed region'), 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)
    await openViewer(page, jobId, pageId)
    const rows = page.getByTestId('line-row')
    await clickAt(page, center((await paragraphLine(jobId, pageId)).polygon))
    await expect(rows).toHaveCount(3)
    await expect(headerRows(page)).toHaveCount(0)

    await enterEditMode(page)
    await clickAt(page, PARAGRAPH_GAP)
    const para = paragraph(await elements(jobId, pageId))
    await expect(page.locator(`[data-testid="region-box"][data-id="${para.id}"]`)).toHaveCount(1)
    await page.keyboard.press('Delete')
    await expect.poll(async () => (await elements(jobId, pageId)).map((e) => e.class_name)).toEqual(['Header'])

    // The page's lines are what is left, and they are listed; nothing says "No lines yet.".
    await expect(headerRows(page)).toHaveCount(3)
    await expect(rows).toHaveCount(3)
    await expect(page.getByText('No lines yet.')).toHaveCount(0)
    await expect(page.locator(`[data-testid="region-box"][data-id="${para.id}"]`)).toHaveCount(0)
  })

  test('deleting a gathered set that holds the listed region lists the page again', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Delete gathered listed region'), 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)
    await openViewer(page, jobId, pageId)
    const rows = page.getByTestId('line-row')
    await clickAt(page, center((await paragraphLine(jobId, pageId)).polygon))
    await expect(rows).toHaveCount(3)

    await enterEditMode(page)
    await clickAt(page, PARAGRAPH_GAP, { shift: true })
    await expect(gathered(page)).toHaveCount(1)
    await page.keyboard.press('Delete')
    await expect.poll(async () => (await elements(jobId, pageId)).map((e) => e.class_name)).toEqual(['Header'])

    await expect(headerRows(page)).toHaveCount(3)
    await expect(rows).toHaveCount(3)
    await expect(page.getByText('No lines yet.')).toHaveCount(0)
  })

  test('undoing the box that was selected lists the page again', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Undo selected box'), 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)
    await openViewer(page, jobId, pageId)
    const rows = page.getByTestId('line-row')
    await clickAt(page, center((await paragraphLine(jobId, pageId)).polygon))
    await expect(rows).toHaveCount(3)

    // A box drawn now is selected, and an empty box has nothing to list - that is the one
    // honest "No lines yet.".
    await enterEditMode(page)
    await page.locator('[data-testid="pen-pill"][data-class="Paragraph"]').click()
    await dragAt(page, [0.03, 0.3], [0.08, 0.55])
    await expect.poll(async () => (await elements(jobId, pageId)).length).toBe(3)
    await expect(page.getByText('No lines yet.')).toBeVisible()

    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await elements(jobId, pageId)).length).toBe(2)
    await expect(rows).toHaveCount(6)
    await expect(headerRows(page)).toHaveCount(3)
    await expect(page.getByText('No lines yet.')).toHaveCount(0)
  })
})
