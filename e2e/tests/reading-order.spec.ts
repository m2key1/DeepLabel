import { test, expect } from '../helpers/test'
import { openSettings, saveSettings } from '../helpers/dataset-settings'
import {
  backendFetch, correctLine, deleteElement, getPageDetail, jobPageIds, pageLines, seedCompletedJob,
  seedJobWithoutLayout, uniqueName,
} from '../helpers/api'
import { LANDSCAPE, clickAt, dragAt, enterEditMode, openViewer } from '../helpers/viewer'

/** A line as a rectangle, in page coordinates. */
const quad = (x0: number, x1: number, y: number) =>
  [[x0, y], [x1, y], [x1, y + 0.04], [x0, y + 0.04]]

const drawLine = (pageId: number, polygon: number[][]) =>
  backendFetch(`/api/pages/${pageId}/lines`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ polygon }),
  })

/**
 * A page of two columns, drawn as four lines: 1 and 3 down the left, 2 and 4 down the
 * right, created in the interleaved order a sort by height produces. Unassigned, because
 * this dataset never ran layout - which is exactly the page the setting is for.
 */
async function twoColumnPage(name: string) {
  const jobName = uniqueName(name)
  const jobId = await seedJobWithoutLayout(jobName)
  const [pageId] = await jobPageIds(jobId)
  for (const line of await pageLines(jobId, pageId)) {
    await backendFetch(`/api/lines/${line.id}`, { method: 'DELETE' })
  }
  const ids: number[] = []
  for (const [x0, x1, y] of [[0.08, 0.45, 0.10], [0.55, 0.92, 0.10],
                             [0.08, 0.45, 0.40], [0.55, 0.92, 0.40]] as const) {
    ids.push((await drawLine(pageId, quad(x0, x1, y))).id)
  }
  return { jobId, jobName, pageId, ids }
}

const orderOf = async (jobId: string, pageId: number) =>
  (await pageLines(jobId, pageId)).map((l) => l.id)

test.describe('Scenario: what order the lines of a page are read in', () => {
  test('what the dataset says beats what the page looks like', async ({ page }) => {
    const { jobId, jobName, pageId, ids } = await twoColumnPage('Columns')
    const [topLeft, topRight, bottomLeft, bottomRight] = ids
    const byColumn = [topLeft, bottomLeft, topRight, bottomRight]
    const byHeight = [topLeft, topRight, bottomLeft, bottomRight]
    // Left to itself, the channel down the middle is found and the columns read in turn.
    expect(await orderOf(jobId, pageId)).toEqual(byColumn)

    await openSettings(page, jobName)
    await page.getByTestId('reading-order-choice').selectOption('1x1')
    await saveSettings(page)

    // Told the volume is set solid, the same page is read straight down - the guess is
    // overruled, and the pages already detected are put right rather than only the next
    // run. A volume of ragged single-column pages is exactly why that has to be sayable.
    await expect.poll(async () => orderOf(jobId, pageId)).toEqual(byHeight)

    await openSettings(page, jobName)
    await expect(page.getByTestId('reading-order-choice')).toHaveValue('1x1')
    await page.getByTestId('reading-order-choice').selectOption('1x2')
    await saveSettings(page)

    await expect.poll(async () => orderOf(jobId, pageId)).toEqual(byColumn)
  })

  test('one page may be set apart from the rest of its dataset', async ({ page }) => {
    const { jobId, pageId, ids } = await twoColumnPage('One page apart')
    const [topLeft, topRight, bottomLeft, bottomRight] = ids

    await openViewer(page, jobId, pageId)
    await enterEditMode(page)
    const choice = page.getByTestId('page-reading-order')
    // It follows the dataset until it is told otherwise, and says which that is.
    await expect(choice).toHaveValue('')
    await expect(choice.locator('option').first()).toHaveText('Dataset: Work it out per page')

    // This one page is set solid, whatever the rest of the volume does.
    await choice.selectOption('1x1')
    await expect.poll(async () => orderOf(jobId, pageId))
      .toEqual([topLeft, topRight, bottomLeft, bottomRight])

    // And back to following the dataset, which works it out and finds the columns.
    await choice.selectOption('')
    await expect.poll(async () => orderOf(jobId, pageId))
      .toEqual([topLeft, bottomLeft, topRight, bottomRight])
  })
})

test.describe('Scenario: taking back a page set apart', () => {
  test('Ctrl+Z puts the page back to following the dataset', async ({ page }) => {
    const { jobId, pageId, ids } = await twoColumnPage('Undo page apart')
    const [topLeft, topRight, bottomLeft, bottomRight] = ids
    const byColumn = [topLeft, bottomLeft, topRight, bottomRight]
    expect(await orderOf(jobId, pageId)).toEqual(byColumn)

    await openViewer(page, jobId, pageId)
    await enterEditMode(page)
    const choice = page.getByTestId('page-reading-order')
    await choice.selectOption('1x1')
    await expect.poll(async () => orderOf(jobId, pageId))
      .toEqual([topLeft, topRight, bottomLeft, bottomRight])

    await choice.blur()
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => orderOf(jobId, pageId)).toEqual(byColumn)
    await expect(choice).toHaveValue('')
  })
})

test.describe('Scenario: a page whose layout boxed only some of its lines', () => {
  test('the lines outside every box are read where they stand', async ({ page }) => {
    // The stub boxes a Header at y .05-.15 and a Paragraph at .20-.85, three lines each.
    const jobId = await seedCompletedJob(uniqueName('Boxed in part'), 1)
    const [pageId] = await jobPageIds(jobId)
    const boxed = await pageLines(jobId, pageId)
    expect(boxed.map((l) => l.text)).toEqual([
      'Sample Header line 1', 'Sample Header line 2', 'Sample Header line 3',
      'Sample Paragraph line 1', 'Sample Paragraph line 2', 'Sample Paragraph line 3',
    ])
    const [h1, h2, h3, p1, p2, p3] = boxed.map((l) => l.id)

    // Three lines no box holds: above the header, in the gap under it, below the paragraph.
    const strays: Record<string, number> = {}
    for (const [name, y] of [['Above the header', 0.005], ['Between the boxes', 0.155],
                             ['Under the paragraph', 0.9]] as const) {
      strays[name] = (await drawLine(pageId, quad(0.1, 0.9, y))).id
      await correctLine(strays[name], name)
    }

    await expect.poll(async () => orderOf(jobId, pageId)).toEqual([
      strays['Above the header'], h1, h2, h3,
      strays['Between the boxes'], p1, p2, p3,
      strays['Under the paragraph'],
    ])

    await page.goto(`/jobs/${jobId}/transcript`)
    await expect(page.getByTestId('transcript-counts')).toBeVisible()
    await expect(page.getByTestId('transcript-line')).toHaveText([
      'Above the header',
      'Sample Header line 1', 'Sample Header line 2', 'Sample Header line 3',
      'Between the boxes',
      'Sample Paragraph line 1', 'Sample Paragraph line 2', 'Sample Paragraph line 3',
      'Under the paragraph',
    ])
  })
})

interface OrderedElement {
  id: number
  kind: string
  class_name: string
  order_idx: number
}

/** The page's boxes that are read, in the order the server reads them. */
const boxOrder = async (jobId: string, pageId: number) =>
  ((await getPageDetail(jobId, pageId)).elements as OrderedElement[])
    .filter((e) => e.kind === 'content')
    .sort((a, b) => a.order_idx - b.order_idx)
    .map((e) => e.id)

const drawBox = async (pageId: number, className: string, bbox: number[]) =>
  (await backendFetch(`/api/pages/${pageId}/elements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ class_name: className, bbox }),
  })).id as number

test.describe('Scenario: the regions renumber as the boxes are edited', () => {
  const numbered = (page: import('@playwright/test').Page, id: number, name: string) =>
    page.locator(`[data-testid="region-row"][data-region-id="${id}"]`).getByRole('button', { name: `Hide ${name}` })

  test('a box drawn above the others is read first, and moved below them it is read last', async ({ page }) => {
    // The stub boxes a Header at y .05-.15 and a Paragraph at .20-.85.
    const jobId = await seedCompletedJob(uniqueName('Live order'), 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)
    const [header, paragraph] = await boxOrder(jobId, pageId)
    await openViewer(page, jobId, pageId)
    await enterEditMode(page)

    await page.locator('[data-testid="pen-pill"][data-class="Paragraph"]').click()
    await dragAt(page, [0.3, 0.005], [0.7, 0.04])
    await expect.poll(async () => (await boxOrder(jobId, pageId)).length).toBe(3)
    const drawn = (await boxOrder(jobId, pageId)).find((id) => id !== header && id !== paragraph)!
    expect(await boxOrder(jobId, pageId)).toEqual([drawn, header, paragraph])
    await expect(numbered(page, drawn, 'Paragraph 1')).toBeVisible()
    await expect(numbered(page, header, 'Header 2')).toBeVisible()
    await expect(numbered(page, paragraph, 'Paragraph 3')).toBeVisible()

    await page.getByTestId('tool-select').click()
    await clickAt(page, [0.5, 0.02])
    await expect(page.getByTestId('element-handle')).toHaveCount(8)
    await dragAt(page, [0.5, 0.02], [0.5, 0.92])
    await expect.poll(async () => boxOrder(jobId, pageId)).toEqual([header, paragraph, drawn])
    await expect(numbered(page, header, 'Header 1')).toBeVisible()
    await expect(numbered(page, paragraph, 'Paragraph 2')).toBeVisible()
    await expect(numbered(page, drawn, 'Paragraph 3')).toBeVisible()

    // Taking the move back takes its renumbering back with it.
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => boxOrder(jobId, pageId)).toEqual([drawn, header, paragraph])
    await expect(numbered(page, drawn, 'Paragraph 1')).toBeVisible()
    await expect(numbered(page, paragraph, 'Paragraph 3')).toBeVisible()
  })

  test('a table keeps the boxes of each column together, the left column first', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Table order'), 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)
    const [header, paragraph] = await boxOrder(jobId, pageId)
    await deleteElement(paragraph)
    await drawBox(pageId, 'Table', [0.1, 0.2, 0.9, 0.85])
    await drawBox(pageId, 'Column', [0.1, 0.2, 0.49, 0.85])
    await drawBox(pageId, 'Column', [0.51, 0.2, 0.9, 0.85])
    // Drawn highest first, so reading by height alone would hop between the columns.
    const rightTop = await drawBox(pageId, 'Paragraph', [0.55, 0.25, 0.85, 0.35])
    const leftTop = await drawBox(pageId, 'Paragraph', [0.15, 0.3, 0.45, 0.4])
    const leftBottom = await drawBox(pageId, 'Paragraph', [0.15, 0.5, 0.45, 0.6])
    const rightBottom = await drawBox(pageId, 'Paragraph', [0.55, 0.6, 0.85, 0.7])

    await expect.poll(async () => boxOrder(jobId, pageId))
      .toEqual([header, leftTop, leftBottom, rightTop, rightBottom])

    await openViewer(page, jobId, pageId)
    await enterEditMode(page)
    await expect(numbered(page, header, 'Header 1')).toBeVisible()
    await expect(numbered(page, leftTop, 'Paragraph 2')).toBeVisible()
    await expect(numbered(page, leftBottom, 'Paragraph 3')).toBeVisible()
    await expect(numbered(page, rightTop, 'Paragraph 4')).toBeVisible()
    await expect(numbered(page, rightBottom, 'Paragraph 5')).toBeVisible()
  })
})
