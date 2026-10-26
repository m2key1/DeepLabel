import { test, expect } from '../helpers/test'
import {
  backendFetch, correctLine, getPageDetail, identity, jobPageIds, pageLines, seedCompletedJob,
  seedDistinctPagesJob, seedLlmConnection, uniqueName,
} from '../helpers/api'
import { pickModel, waitForLlmReads } from '../helpers/llm'
import { LANDSCAPE, center, clickAt, enterEditMode, openViewer } from '../helpers/viewer'
import { datasetAction } from '../helpers/dataset'

const DEV = identity('dev', 'admin')
// 'stub-perfect' reads the six lines as the OCR model did; 'stub-typo' misreads one word of
// 'Sample Paragraph line 2', so that line - under the 0.85 bar at 0.82 - carries a reading.
const PERFECT = 'stub-perfect'
const TYPO = 'stub-typo'
const DISPUTED = 'Sample Paragraph line 2'
const TYPO_READING = 'Sample Paragraf line 2'

const rowOf = (page: import('@playwright/test').Page, text: string) =>
  page.getByTestId('line-row').filter({ hasText: text })

test.describe('Scenario: the keyboard keeps walking the page after a click', () => {
  test('ticking a line with the mouse does not take the arrow keys away', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Tick then walk'), 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)
    await openViewer(page, jobId, pageId)

    await page.keyboard.press('ArrowDown')
    await expect(rowOf(page, 'Sample Header line 1')).toHaveAttribute('data-hot', 'true')

    await rowOf(page, 'Sample Header line 2').getByTitle('Checked').click()
    await expect.poll(async () =>
      (await pageLines(jobId, pageId)).find((l) => l.text === 'Sample Header line 2')!.checked,
    ).toBe(true)

    await page.keyboard.press('ArrowDown')
    await expect(rowOf(page, 'Sample Header line 2')).toHaveAttribute('data-hot', 'true')
  })

  test('a key pressed while a dropdown has focus belongs to the dropdown', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Select owns keys'), 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)
    await openViewer(page, jobId, pageId)
    await enterEditMode(page)

    // A point inside the Paragraph box, between its lines, selects the element itself.
    await clickAt(page, [0.5, 0.42])
    const classPicker = page.getByTestId('selected-class')
    await expect(classPicker).toHaveValue('Paragraph')
    await classPicker.focus()
    await page.keyboard.press('Delete')

    // The box is still there: Delete in a dropdown is not "delete the selection".
    await expect(classPicker).toHaveValue('Paragraph')
    expect((await getPageDetail(jobId, pageId)).elements.map((e: { class_name: string }) => e.class_name).sort())
      .toEqual(['Header', 'Paragraph'])
  })
})

test.describe('Scenario: review mode on a page with nothing left to review', () => {
  test('the next key goes on to the next page that has something flagged', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Empty review page'), 2, LANDSCAPE)
    const pageIds = await jobPageIds(jobId)
    // The two Paragraph lines under 0.85 on the first page are already checked, so the
    // queue holds only the second page's two.
    for (const line of await pageLines(jobId, pageIds[0])) {
      if (line.text === 'Sample Paragraph line 1' || line.text === 'Sample Paragraph line 2') {
        await correctLine(line.id, line.text, true)
      }
    }

    await page.goto(`/jobs/${jobId}/pages/${pageIds[0]}?review=0.85`)
    await expect(page.getByText('Nothing flagged on this page.')).toBeVisible()
    await page.mouse.move(2, 2)

    // Pressed until the viewer has left its brief entry stage, after which the key acts.
    await expect(async () => {
      await page.keyboard.press('ArrowDown')
      await expect(page).toHaveURL(new RegExp(`/pages/${pageIds[1]}\\?review=0.85$`), { timeout: 1_000 })
    }).toPass({ timeout: 10_000 })
    await expect(page.getByText(/Review 1 \/ 2/)).toBeVisible()
    await expect(rowOf(page, 'Sample Paragraph line 1')).toHaveAttribute('data-hot', 'true')
  })
})

test.describe('Scenario: letting go of a line with Escape', () => {
  // Clicking a line narrows the readings list to its region. Escape lets go of the line and
  // nothing else: the list is the page's again, with the line still in it, rather than the
  // emptied list of a region nobody has selected.
  test('Escape unselects the line and the readings list shows the page again', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Escape list'), 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)
    const detail = await getPageDetail(jobId, pageId)
    const header = detail.elements.find((e: { class_name: string }) => e.class_name === 'Header')!
    const [line] = header.lines
    await openViewer(page, jobId, pageId)

    const rows = page.getByTestId('line-row')
    const row = rows.filter({ hasText: 'Sample Header line 1' })
    await expect(rows).toHaveCount(6)
    await clickAt(page, center(line.polygon))
    await expect(rows).toHaveCount(3)
    await expect(row).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(rows).toHaveCount(6)
    await expect(row).toBeVisible()
    await expect(page.getByText('No lines yet.')).toHaveCount(0)
  })

  // The way into editing a line is often through its region: click it on the page, then
  // open the editor on it. Escape there has to drop the handles and the narrowed list both.
  test('in edit mode Escape drops the handles and keeps the page listed', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Escape list editing'), 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)
    const detail = await getPageDetail(jobId, pageId)
    const header = detail.elements.find((e: { class_name: string }) => e.class_name === 'Header')!
    const [line] = header.lines
    await openViewer(page, jobId, pageId)

    const rows = page.getByTestId('line-row')
    await clickAt(page, center(line.polygon))
    await expect(rows).toHaveCount(3)
    await enterEditMode(page)
    await page.getByTestId('tool-select').click()
    await clickAt(page, center(line.polygon))
    await expect(page.getByTestId('line-vertex-handle')).toHaveCount(4)

    await page.keyboard.press('Escape')
    await expect(page.getByTestId('line-vertex-handle')).toHaveCount(0)
    await expect(rows).toHaveCount(6)
    await expect(rows.filter({ hasText: 'Sample Header line 1' })).toBeVisible()
    // Still editing: the second Escape is what leaves, as edit-elements.spec says.
    await expect(page.getByText('Layout complete')).toBeVisible()
  })
})

test.describe('Scenario: review mode keeps the arrows on the flagged lines', () => {
  // README: "Walking a page is ↑/↓ through the lines and on into the readings offered under
  // the open one [...] In review mode the same keys walk the flagged lines of the whole
  // dataset". The readings keep a key of their own there, which the hint names.
  test('↓ walks past a flagged line\'s readings to the next flagged line, and the hint names the readings key',
    async ({ page }) => {
      const jobId = await seedDistinctPagesJob(uniqueName('Review readings key'), 2, 300)
      const connection = uniqueName('Disagreeing pair')
      await seedLlmConnection(connection, [PERFECT, TYPO], DEV)
      // Two pages, so startLlmRead's one-page wait would stop short: each model reads both.
      await page.goto(`/jobs/${jobId}`)
      await datasetAction(page, 'llm-read-open')
      for (const model of [PERFECT, TYPO]) await pickModel(page, connection, model).check()
      // Three must agree, so nothing settles: a line the models settled without a check is
      // review work itself (review-settled.spec), and this test is about the key, not that.
      await page.getByTestId('llm-consensus-min').fill('3')
      await page.getByTestId('llm-start').click()
      await waitForLlmReads(jobId, 4)

      // Oracle: under 0.85 the queue is the two Paragraph lines of each page, in order.
      const pageIds = await jobPageIds(jobId)
      const flaggedOn = async (pageId: number) => {
        const lines = await pageLines(jobId, pageId)
        return ['Sample Paragraph line 1', DISPUTED].map((text) => lines.find((l) => l.text === text)!.id)
      }
      const queue = await backendFetch(`/api/jobs/${jobId}/review?max_conf=0.85`)
      expect(queue.lines.map((l: { id: number }) => l.id))
        .toEqual([...await flaggedOn(pageIds[0]), ...await flaggedOn(pageIds[1])])

      // On the page, ↓ walks into the disputed line's readings...
      await openViewer(page, jobId, pageIds[0])
      const onReading = page.locator('[data-testid="line-candidate"][data-cursor="true"]')
      await expect(onReading).toHaveCount(0)
      const reached = async () =>
        (await onReading.count()) === 1
        && (await onReading.getByTestId('candidate-text').innerText()).trim() === TYPO_READING
      for (let press = 0; press < 40 && !(await reached()); press++) {
        await page.keyboard.press('ArrowDown')
      }
      await expect(onReading.getByTestId('candidate-text')).toHaveText(TYPO_READING)

      // ...and in review mode it does not: the reading is shown under the flagged line, and
      // the same key walks on to the next flagged line, over the page break.
      await page.goto(`/jobs/${jobId}/pages/${pageIds[0]}?review=0.85`)
      await expect(page.getByText(/Review 1 \/ 4/)).toBeVisible()
      await page.mouse.move(2, 2)
      await expect(rowOf(page, 'Sample Paragraph line 1')).toHaveAttribute('data-hot', 'true')
      await expect(page.getByTestId('line-loupe')).toBeVisible()
      await page.keyboard.press('ArrowDown')
      await expect(page.getByText(/Review 2 \/ 4/)).toBeVisible()
      await expect(rowOf(page, DISPUTED)).toHaveAttribute('data-hot', 'true')
      await expect(page.getByTestId('line-candidate').filter({ hasText: TYPO_READING })).toHaveCount(1)
      await page.keyboard.press('ArrowDown')
      await expect(page).toHaveURL(new RegExp(`/pages/${pageIds[1]}\\?review=0.85$`))
      await expect(page.getByText(/Review 3 \/ 4/)).toBeVisible()
      await expect(onReading).toHaveCount(0)

      // So the readings need a key of their own here, and it has to be named: the badge
      // says a line has readings, and the sheet and the footer hint say how to reach them.
      await page.keyboard.press('?')
      const sheet = page.getByTestId('shortcut-sheet')
      await expect(sheet).toBeVisible()
      const readingsRow = sheet.locator('dl > div').filter({ has: page.locator('dd', { hasText: /readings/ }) })
      await expect(readingsRow).toHaveCount(1)
      const key = (await readingsRow.locator('dt').innerText()).trim()
      expect(key).not.toBe('')
      await page.keyboard.press('Escape')
      await expect(sheet).toHaveCount(0)
      await expect(page.getByText(/flagged lines/)).toContainText(key)
    })
})
