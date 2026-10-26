import { test, expect } from '../helpers/test'
import {
  correctLine, getPageDetail, jobPageIds, pageLines, pageRendition, seedCompletedJob,
  seedJobWithoutPipeline, setTranscriptView, uniqueName, waitForJobStatus,
} from '../helpers/api'
import { pngSize, scanPng } from '../helpers/image'
import { dragPixels, openViewer } from '../helpers/viewer'

async function openRunMenu(page: import('@playwright/test').Page) {
  // In the toolbar, not behind edit mode: a page with nothing on it has nothing to edit,
  // and that is exactly the page this is for.
  await page.getByTestId('run-menu').click()
  await expect(page.getByTestId('run-menu-items')).toBeVisible()
}

const phase = (page: import('@playwright/test').Page, name: string) =>
  page.locator(`[data-testid="run-phase"][data-phase="${name}"]`)

test.describe('Scenario: running a phase on one page', () => {
  test('a dataset whose pipeline never ran can be given all of it from the page',
    async ({ page }) => {
      // Phases are chosen once at creation, so this dataset could never be given any of
      // them afterwards - an import arrives in exactly this state.
      const jobId = await seedJobWithoutPipeline(uniqueName('Never run'))
      const [pageId] = await jobPageIds(jobId)
      expect((await getPageDetail(jobId, pageId)).elements).toEqual([])

      await openViewer(page, jobId, pageId)
      await openRunMenu(page)
      await expect(phase(page, 'layout')).toContainText('nothing detected here yet')
      await phase(page, 'layout').click()

      await waitForJobStatus(jobId, 'done')
      // Polled on the text, not on the elements: layout creates those a moment before
      // line detection and reading fill them, so the count is true before the page is.
      await expect.poll(async () => (await pageLines(jobId, pageId)).map((l) => l.text),
                        { timeout: 30_000 }).toEqual([
        'Sample Header line 1', 'Sample Header line 2', 'Sample Header line 3',
        'Sample Paragraph line 1', 'Sample Paragraph line 2', 'Sample Paragraph line 3',
      ])
      // The stub reads every page as two elements of three lines.
      expect((await getPageDetail(jobId, pageId)).elements).toHaveLength(2)
    })

  test('a phase that has already run says what it would replace, and runs again',
    async ({ page }) => {
      const jobId = await seedJobWithoutPipeline(uniqueName('Run twice'))
      const [pageId] = await jobPageIds(jobId)
      await openViewer(page, jobId, pageId)
      await openRunMenu(page)
      await phase(page, 'layout').click()
      await waitForJobStatus(jobId, 'done')
      await expect.poll(async () => (await pageLines(jobId, pageId)).length,
                        { timeout: 30_000 }).toBe(6)

      // The banner this replaced would have offered nothing here: the page now has
      // everything, and running it again is still a thing a person may want.
      await page.reload()
      await openRunMenu(page)
      await expect(phase(page, 'lines')).toContainText('replaces 6 lines')
      await expect(phase(page, 'ocr')).toContainText('re-reads 6 lines')
    })

  test('re-reading leaves a checked line alone and says so', async ({ page }) => {
    const jobId = await seedJobWithoutPipeline(uniqueName('Keeps checked'))
    const [pageId] = await jobPageIds(jobId)
    await openViewer(page, jobId, pageId)
    await openRunMenu(page)
    await phase(page, 'layout').click()
    await waitForJobStatus(jobId, 'done')
    await expect.poll(async () => (await pageLines(jobId, pageId)).length,
                      { timeout: 30_000 }).toBe(6)

    const first = (await pageLines(jobId, pageId))[0]
    await correctLine(first.id, 'Verified by hand')

    await page.reload()
    await openRunMenu(page)
    await expect(phase(page, 'ocr')).toContainText('re-reads 5, leaves 1 checked')
    await phase(page, 'ocr').click()
    await waitForJobStatus(jobId, 'done')

    // Backend oracle: the verified line kept its text; the rest were read again.
    await expect.poll(async () =>
      (await pageLines(jobId, pageId)).find((l) => l.id === first.id)?.corrected_text,
    { timeout: 30_000 }).toBe('Verified by hand')
  })

  test('a run that fails in the runner says why, instead of going quiet', async ({ page }) => {
    const jobId = await seedJobWithoutPipeline(uniqueName('Run fails'))
    const [pageId] = await jobPageIds(jobId)
    await openViewer(page, jobId, pageId)

    // The runner can die on a page the API was happy to queue - a scan that moved, a
    // model that will not load. The dataset carries the reason; showing nothing leaves
    // the user with an emptied page and no idea it even ran.
    await page.route(`**/api/jobs/${jobId}`, async (route) => {
      const job = await (await route.fetch()).json()
      await route.fulfill({ json: { ...job, status: 'error', error: 'the scan is missing' } })
    })

    await openRunMenu(page)
    await phase(page, 'layout').click()

    await expect(page.getByText('the scan is missing')).toBeVisible()
    // The button lets go, so the page can be run again once the reason is dealt with.
    await expect(page.getByTestId('run-menu')).toHaveText('Run')
  })
})

test.describe('Scenario: what the Run menu is, and is not, drawn over', () => {
  // The menu and the pane splitter were both z-20 and the splitter comes later in the
  // document, so its line was drawn straight through the open panel.
  test('the splitter runs behind the open panel, not through it', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Over the splitter'), 1)
    const [pageId] = await jobPageIds(jobId)
    await openViewer(page, jobId, pageId)

    // The menu hangs off the right of its button, and where the splitter rests it need not
    // reach that far - so the splitter is dragged under it first. Whether they overlap by
    // default is a matter of how wide the panes happen to be; that one is drawn over the
    // other where they do meet is the rule this is about.
    await openRunMenu(page)
    const items = page.getByTestId('run-menu-items')
    const where = (await items.boundingBox())!
    // Put the menu away first: a drag's press is a click on the page, which is what
    // dismisses it, so leaving it open would make what follows depend on that.
    await page.getByTestId('viewer-header').click()
    await expect(items).toHaveCount(0)

    const divider = page.getByTestId('pane-divider')
    const resting = (await divider.boundingBox())!
    const mid = { x: resting.x + resting.width / 2, y: resting.y + resting.height / 2 }
    await dragPixels(page, mid, { x: where.x + where.width / 2, y: mid.y })

    await openRunMenu(page)
    const panel = (await items.boundingBox())!
    const splitter = (await divider.boundingBox())!
    const x = splitter.x + splitter.width / 2
    // The splitter starts partway down the panel, so the two only share the band below
    // its top. Probing above that band asks nothing at all.
    const y = Math.max(panel.y, splitter.y) + 10
    // That the two overlap at all is the premise here. If a layout change ever parts them
    // this fails rather than passing on a question nobody asked.
    expect(x).toBeGreaterThan(panel.x)
    expect(x).toBeLessThan(panel.x + panel.width)
    expect(y).toBeLessThan(panel.y + panel.height)

    const covered = await page.evaluate(([px, py]) => !!document.elementFromPoint(px, py)
      ?.closest('[data-testid="run-menu-items"]'), [x, y])
    expect(covered).toBe(true)
  })

  test('turning the scan is on the bar, not behind the menu', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Turns on the bar'), 1)
    const [pageId] = await jobPageIds(jobId)
    await openViewer(page, jobId, pageId)

    // Both turns are reachable without opening anything, and carry a name for a reader
    // since all they show is a glyph.
    await expect(page.getByTestId('turn-page')).toHaveCount(2)
    await expect(page.getByRole('button', { name: 'Turn the scan clockwise' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Turn the scan anticlockwise' })).toBeVisible()

    await openRunMenu(page)
    await expect(page.getByTestId('run-menu-items').getByTestId('turn-page')).toHaveCount(0)
  })
})

test.describe('Scenario: a scan that arrived the wrong way up', () => {
  // /api/settings belongs to the signed-in person, and every spec runs as the same one, so
  // the transcript strip switched on below has to go back off even when a test fails halfway.
  test.afterEach(async ({ page }) => {
    await setTranscriptView(page, { filmstrip: false })
  })

  test('turning the page turns the boxes and the lines with it', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Upside down'), 1)
    const [pageId] = await jobPageIds(jobId)
    const page_ = await getPageDetail(jobId, pageId)
    const before = page_.elements[0]

    await openViewer(page, jobId, pageId)
    await page.locator('[data-testid="turn-page"][data-degrees="90"]').click()

    // Turned clockwise, in the page's own coordinates: (x, y) becomes (1 - y, x).
    const [x0, y0, x1, y1] = before.bbox
    await expect.poll(async () => (await getPageDetail(jobId, pageId)).elements[0].bbox)
      .toEqual([
        expect.closeTo(1 - y1, 6), expect.closeTo(x0, 6),
        expect.closeTo(1 - y0, 6), expect.closeTo(x1, 6),
      ])
    const [firstLine] = before.lines
    const turnedLine = (await getPageDetail(jobId, pageId)).elements[0].lines
      .find((l: { id: number }) => l.id === firstLine.id)!
    expect(turnedLine.polygon).toEqual(
      firstLine.polygon.map(([x, y]: [number, number]) =>
        [expect.closeTo(1 - y, 6), expect.closeTo(x, 6)]))

    // The scan itself was turned, not the view of it, so the page is on its side now.
    const detail = await getPageDetail(jobId, pageId)
    expect([detail.width, detail.height]).toEqual([page_.height, page_.width])
  })

  // README: "The scan as it arrived is kept beside it and is what each further turn is
  // derived from, so a page turned twice is a scan encoded once, and turning back to where
  // it started puts the original file back untouched."
  test('the turn is on record, and turning back restores what arrived', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Turned back'), 1)
    const [pageId] = await jobPageIds(jobId)
    const before = (await getPageDetail(jobId, pageId))
    // scanPng is byte-deterministic, so what was uploaded can be rebuilt here and compared
    // against what the backend serves - not merely sized.
    const uploaded = scanPng()
    expect(pngSize(uploaded)).toEqual([600, 800])
    expect((await pageRendition(pageId, 'full')).equals(uploaded)).toBe(true)

    await openViewer(page, jobId, pageId)
    await page.locator('[data-testid="turn-page"][data-degrees="90"]').click()
    await expect.poll(async () => (await getPageDetail(jobId, pageId)).rotation).toBe(90)
    // The file itself was turned, not a flag set beside it: it is on its side and no longer
    // the bytes that arrived.
    const turned = await pageRendition(pageId, 'full')
    expect(pngSize(turned)).toEqual([800, 600])
    expect(turned.equals(uploaded)).toBe(false)

    await page.locator('[data-testid="turn-page"][data-degrees="-90"]').click()

    await expect.poll(async () => (await getPageDetail(jobId, pageId)).rotation).toBe(0)
    const after = await getPageDetail(jobId, pageId)
    expect([after.width, after.height]).toEqual([before.width, before.height])
    expect(after.elements[0].bbox).toEqual(before.elements[0].bbox.map((v: number) =>
      expect.closeTo(v, 6)))
    // Not a re-encoding turned back: the original, byte for byte.
    const restored = await pageRendition(pageId, 'full')
    expect(pngSize(restored)).toEqual([600, 800])
    expect(restored.equals(uploaded)).toBe(true)
  })

  // README: "nothing downstream has to be told about rotation" - the dataset page's table
  // and preview, and the transcript page's strip of pages, all draw the scan as it stands.
  test('the dataset page and the transcript strip show the scan as it stands now, not as it arrived',
    async ({ page }) => {
      const jobId = await seedCompletedJob(uniqueName('Turned thumb'), 1)
      const [pageId] = await jobPageIds(jobId)
      const shape = (img: import('@playwright/test').Locator) =>
        img.evaluate((el: HTMLImageElement) => [el.naturalWidth, el.naturalHeight])
      const thumb = page.locator('tbody img')
      const preview = page.locator('aside img')
      const stripThumb = page.getByTestId('transcript-thumb').locator('img')

      // The scan arrived upright, 600 by 800, and the browser has now seen every rendition
      // at the backend's own sizes: a thumbnail 256 across. The strip is off by default, so it is switched on
      // for this test.
      const detail = await getPageDetail(jobId, pageId)
      expect([detail.width, detail.height]).toEqual([600, 800])
      await setTranscriptView(page, { filmstrip: true })
      await page.goto(`/jobs/${jobId}/transcript`)
      await expect.poll(() => shape(stripThumb)).toEqual([256, 341])
      await page.goto(`/jobs/${jobId}`)
      await expect.poll(() => shape(thumb)).toEqual([256, 341])
      await expect.poll(() => shape(preview)).toEqual([600, 800])

      await openViewer(page, jobId, pageId)
      await page.locator('[data-testid="turn-page"][data-degrees="90"]').click()
      await expect.poll(async () => (await getPageDetail(jobId, pageId)).rotation).toBe(90)
      // Back the way a person goes back, without reloading the application.
      await page.mouse.move(2, 2)
      await page.keyboard.press('Escape')
      await expect(page).toHaveURL(new RegExp(`/jobs/${jobId}$`))

      // The page knows its new shape, and the pictures have to agree with it. Renditions
      // are served immutable, so a turned page needs an address of its own or the browser
      // keeps showing the old way up. The turn rewrote them at the backend's own sizes: a
      // thumbnail 256 across, and a screen copy no larger than the 800 by 600 scan.
      const turned = await getPageDetail(jobId, pageId)
      expect([turned.width, turned.height]).toEqual([800, 600])
      await expect.poll(() => shape(thumb)).toEqual([256, 192])
      await expect.poll(() => shape(preview)).toEqual([800, 600])
      // The strip carries the same thumbnail at its new address, the new way up.
      await page.goto(`/jobs/${jobId}/transcript`)
      await expect.poll(() => shape(stripThumb)).toEqual([256, 192])
    })
})
