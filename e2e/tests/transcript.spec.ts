import { test, expect } from '../helpers/test'
import type { Page } from '@playwright/test'
import {
  backendFetch, correctLine, identity, jobPageIds, pageLines, seedCompletedJob,
  setTranscriptView, uniqueName,
} from '../helpers/api'

const DEV = identity('dev', 'admin')

const lines = (page: Page) => page.getByTestId('transcript-line')
const ticks = (page: Page) => page.getByTestId('transcript-tick')
const at = (page: Page) => page.getByTestId('transcript-page-at')

async function openTranscript(page: Page, jobId: string) {
  await page.goto(`/jobs/${jobId}/transcript`)
  await expect(page.getByTestId('transcript-counts')).toBeVisible()
}

/** How light the given patch of the screen actually is, on average. Taken by handing the
 *  screenshot back to the browser to decode: geometry says where a thing was drawn, and
 *  only the pixels say whether anything came of it. */
async function brightness(page: Page, clip: { x: number; y: number; width: number; height: number }) {
  const shot = (await page.screenshot({ clip })).toString('base64')
  return page.evaluate(async (data) => {
    const img = new Image()
    img.src = `data:image/png;base64,${data}`
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.width
    canvas.height = img.height
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const { data: px } = ctx.getImageData(0, 0, canvas.width, canvas.height)
    let sum = 0
    for (let i = 0; i < px.length; i += 4) sum += (px[i] + px[i + 1] + px[i + 2]) / 3
    return sum / (px.length / 4)
  }, shot)
}

/** The scan on the wall, which the viewer draws from a tile pyramid rather than an image. */
const wall = (page: Page) => page.getByTestId('transcript-scan').locator('[data-scan="ready"]')

/** Which page the gallery is actually showing, taken from the scan on the wall rather than
 *  from the counter beside it - the counter is what the page says about itself, the tiles
 *  it asked the server for are what it is. */
function showing(page: Page, pageId: number) {
  return expect(wall(page)).toHaveAttribute('data-scan-src', new RegExp(`/api/pages/${pageId}/tiles/`))
}

/** One page gives way to the next over a moment; this waits that out, so a measurement
 *  reads the page on the wall rather than the pair of them mid-change. */
const settledOnTheWall = (page: Page) =>
  expect(wall(page)).not.toHaveAttribute('data-fading', '1')

/** And this waits for the last tile of it, for anything measuring what the scan looks
 *  like rather than where it is. */
const paintedOnTheWall = async (page: Page) => {
  await settledOnTheWall(page)
  await expect(wall(page)).toHaveAttribute('data-scan-loaded', '1')
}

test.describe('Scenario: reading a volume one page at a time', () => {
  test('the open page is the only one on the wall, and the only one in the text',
    async ({ page }) => {
      const jobId = await seedCompletedJob(uniqueName('Diptych'), 2)
      const [first, second] = await jobPageIds(jobId)
      await openTranscript(page, jobId)

      // The stub reads every page as two elements of three lines, so a volume of two is
      // twelve lines - and six of them are on screen.
      await expect(lines(page)).toHaveCount(6)
      await expect(page.getByTestId('transcript-scan')).toHaveCount(1)
      await expect(page.getByRole('heading', { name: 'Page 1' })).toBeVisible()
      await showing(page, first)
      await expect(at(page)).toHaveText(/^1 \/ 2 /)

      // The header counts the whole volume even though one page of it is shown.
      await expect(page.getByTestId('transcript-counts')).toHaveText('0/12 lines reviewed')

      await page.getByTestId('transcript-page-next').click()

      await showing(page, second)
      await expect(at(page)).toHaveText(/^2 \/ 2 /)
      await expect(page.getByRole('heading', { name: 'Page 2' })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Page 1' })).toHaveCount(0)
      await expect(lines(page)).toHaveCount(6)
      await expect(page.getByTestId('transcript-scan')).toHaveCount(1)
    })

  test('each block says what the layout model called it', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Classed'), 1)

    await openTranscript(page, jobId)

    await expect(page.getByText('Header', { exact: true })).toBeVisible()
    await expect(page.getByText('Paragraph', { exact: true })).toBeVisible()
  })

  test('a correction is what the transcript shows, not what the model read',
    async ({ page }) => {
      const jobId = await seedCompletedJob(uniqueName('Corrected'), 1)
      const [pageId] = await jobPageIds(jobId)
      const [first] = await pageLines(jobId, pageId)
      await correctLine(first.id, 'What a person actually read')

      await openTranscript(page, jobId)

      await expect(lines(page).first()).toHaveText('What a person actually read')
      await expect(page.getByText('Sample Header line 1')).toHaveCount(0)
    })

  test('a reviewed line is marked as such and an unreviewed one is not', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Half reviewed'), 1)
    const [pageId] = await jobPageIds(jobId)
    const [first] = await pageLines(jobId, pageId)
    await correctLine(first.id, 'Verified by hand')

    await openTranscript(page, jobId)

    await expect(page.locator('[data-testid="transcript-line"][data-checked="true"]'))
      .toHaveCount(1)
    await expect(page.locator('[data-testid="transcript-line"][data-checked="false"]'))
      .toHaveCount(5)
  })

  test('reviewed only drops the pages that have nothing reviewed on them at all',
    async ({ page }) => {
      const jobId = await seedCompletedJob(uniqueName('One page reviewed'), 2)
      const [firstPage] = await jobPageIds(jobId)
      const [first] = await pageLines(jobId, firstPage)
      await correctLine(first.id, 'The only reviewed line')

      await openTranscript(page, jobId)
      await expect(ticks(page)).toHaveCount(2)
      await expect(at(page)).toHaveText(/^1 \/ 2 /)

      await page.getByRole('checkbox', { name: 'reviewed only' }).check()

      await expect(lines(page)).toHaveCount(1)
      await expect(at(page)).toHaveText(/^1 \/ 1 /)
      await expect(ticks(page)).toHaveCount(1)
      await showing(page, firstPage)
    })

  test('a volume with nothing reviewed says so rather than showing an empty wall',
    async ({ page }) => {
      const jobId = await seedCompletedJob(uniqueName('None reviewed'), 1)

      await openTranscript(page, jobId)
      await expect(lines(page)).toHaveCount(6)

      await page.getByRole('checkbox', { name: 'reviewed only' }).check()

      await expect(page.getByTestId('transcript-empty'))
        .toHaveText('Nothing has been reviewed yet.')
      await expect(lines(page)).toHaveCount(0)
      await expect(page.getByTestId('transcript-scan')).toHaveCount(0)

      await page.getByRole('checkbox', { name: 'reviewed only' }).uncheck()
      await expect(lines(page)).toHaveCount(6)
    })

  test('a box that only holds other boxes is not a block of text', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('With a container'), 1)
    const [pageId] = await jobPageIds(jobId)
    await backendFetch(`/api/pages/${pageId}/elements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...DEV },
      body: JSON.stringify({ class_name: 'Column', bbox: [0.05, 0.05, 0.95, 0.95] }),
    })

    await openTranscript(page, jobId)

    await expect(page.getByText('Column', { exact: true })).toHaveCount(0)
    // The text under it is still there - only the container itself is not a block.
    await expect(lines(page)).toHaveCount(6)
  })

  test('it links back to the dataset it came from', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Back'), 1)

    await openTranscript(page, jobId)

    await page.getByRole('link', { name: 'back to dataset' }).click()

    await expect(page).toHaveURL(new RegExp(`/jobs/${jobId}$`))
  })

  test('a dataset that cannot be read says why instead of showing an empty document',
    async ({ page }) => {
      const jobId = await seedCompletedJob(uniqueName('Broken'), 1)
      await page.route(`**/api/jobs/${jobId}/export*`, (route) =>
        route.fulfill({ status: 500, json: { detail: 'the dataset could not be read' } }))

      await page.goto(`/jobs/${jobId}/transcript`)

      await expect(page.getByText('the dataset could not be read')).toBeVisible()
      await expect(page.getByTestId('transcript-counts')).toHaveCount(0)
    })
})

test.describe('Scenario: turning the pages', () => {
  test('the arrows, the keys and the spine all turn both panes together', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Turning'), 8)
    const pageIds = await jobPageIds(jobId)
    await openTranscript(page, jobId)

    await expect(page.getByTestId('transcript-page-prev')).toBeDisabled()
    await expect(page.getByTestId('transcript-page-next')).toBeEnabled()

    await page.getByTestId('transcript-page-next').click()
    await showing(page, pageIds[1])
    await expect(at(page)).toHaveText(/^2 \/ 8 /)

    await page.keyboard.press('j')
    await showing(page, pageIds[2])
    await expect(at(page)).toHaveText(/^3 \/ 8 /)

    await page.keyboard.press('k')
    await showing(page, pageIds[1])
    await expect(at(page)).toHaveText(/^2 \/ 8 /)

    // The spine is the whole volume in one bar: its foot is the last page.
    const spine = (await page.getByTestId('transcript-spine').boundingBox())!
    await page.mouse.move(spine.x + spine.width / 2, spine.y + spine.height - 2)
    await page.mouse.down()
    await page.mouse.up()

    await showing(page, pageIds[7])
    await expect(at(page)).toHaveText(/^8 \/ 8 /)
    await expect(page.getByTestId('transcript-page-next')).toBeDisabled()
    // Exactly one tick is the page being read, and it is the last of the eight.
    await expect(page.locator('[data-testid="transcript-tick"][data-at="true"]')).toHaveCount(1)
    await expect(ticks(page).nth(7)).toHaveAttribute('data-at', 'true')
    await expect(ticks(page).nth(6)).toHaveAttribute('data-at', 'false')
  })

  test('the wheel over the scan never turns the page', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Wheeled'), 4)
    const pageIds = await jobPageIds(jobId)
    await openTranscript(page, jobId)

    await page.getByTestId('transcript-scans').hover()
    await page.mouse.wheel(0, 600)
    await page.mouse.wheel(0, -600)
    await page.mouse.wheel(0, 600)
    // A turn asked for right after the wheel lands on the second page, not the third: the
    // wheel over the scan turned nothing, while the keys still turn.
    await page.keyboard.press('j')
    await showing(page, pageIds[1])
    await expect(at(page)).toHaveText(/^2 \/ 4 /)
  })

  // Turning faster than the fade used to leave the page being left behind on the wall under
  // the one arriving, because a timer took it down and the next turn cancelled that timer.
  // Nothing is timed now: which of the two layers is in front is the whole of it.
  test('turning fast never leaves two pages on the wall', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Flicked'), 12)
    const pageIds = await jobPageIds(jobId)
    await openTranscript(page, jobId)

    for (let i = 0; i < 8; i++) await page.keyboard.press('j')

    // One page on the wall, and it is the one the counter names - the eight turns arrive at
    // the ninth page rather than dissolving through the seven in between.
    await expect(at(page)).toHaveText(/^9 \/ 12 /)
    await settledOnTheWall(page)
    await expect(wall(page)).toHaveCount(1)
    await showing(page, pageIds[8])

    // Turning used to have to decode a whole scan off the main thread, or the wheel events
    // arriving during it were swallowed. A page is drawn from tiles of a few kilobytes now,
    // so there is no decode big enough to block on - and the turn back below is what says
    // the wheel is still being heard.

    // And back the other way, so the two scans really are trading rather than one growing.
    await page.keyboard.press('k')
    await expect(at(page)).toHaveText(/^8 \/ 12 /)
    await settledOnTheWall(page)
    await showing(page, pageIds[7])
  })

  // The whole point of the paged reader: a page is read through before it is left, and the
  // text pane does not hand over halfway down a column.
  test('the text scrolls through its own page before the page turns', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Long page'), 3)
    const pageIds = await jobPageIds(jobId)
    const [first] = await pageLines(jobId, pageIds[0])
    await correctLine(first.id, 'lorem ipsum dolor sit amet '.repeat(300), false)

    await openTranscript(page, jobId)
    const text = page.getByTestId('transcript-text')
    const room = () => text.evaluate((el) => el.scrollHeight - el.clientHeight)
    // The premise: page one is longer than its pane. Without that, a pane that refused to
    // scroll and a pane that had nowhere to scroll would look the same.
    await expect.poll(room).toBeGreaterThan(200)

    // A wheel at the head of a long page reads it; it does not turn it.
    await text.hover()
    await page.mouse.wheel(0, 200)
    await expect.poll(async () => text.evaluate((el) => el.scrollTop)).toBeGreaterThan(100)
    await expect(at(page)).toHaveText(/^1 \/ 3 /)
    await showing(page, pageIds[0])

    // At the foot it holds for one more push - proved by asking for a turn straight after
    // the push that was not enough, which lands on the second page rather than the third.
    await text.evaluate((el) => { el.scrollTop = el.scrollHeight })
    await page.mouse.wheel(0, 60)
    await page.keyboard.press('j')
    await showing(page, pageIds[1])
    await expect(at(page)).toHaveText(/^2 \/ 3 /)
    // The page it turned to is read from its head.
    await expect.poll(async () => text.evaluate((el) => el.scrollTop)).toBe(0)

    // And a push that does reach the seam turns it.
    await page.keyboard.press('k')
    await text.evaluate((el) => { el.scrollTop = el.scrollHeight })
    await text.hover()
    await page.mouse.wheel(0, 200)
    await showing(page, pageIds[1])
    await expect(at(page)).toHaveText(/^2 \/ 3 /)

    // Turning back is a gesture of its own, and a gesture begins with the wheel at rest -
    // otherwise the push that turned this page would carry straight on through the next.
    await page.waitForTimeout(500)

    // Back up over the seam lands at the foot of the page before it, where the reader left
    // off, rather than at its head.
    await page.mouse.wheel(0, -200)
    await showing(page, pageIds[0])
    await expect.poll(async () => text.evaluate((el) => el.scrollHeight - el.clientHeight
      - el.scrollTop)).toBeLessThan(2)
  })
})

test.describe('Scenario: the line being read, on the page it came from', () => {
  test('reading a line lifts it out of the scan it is written on', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Beside'), 2)
    await openTranscript(page, jobId)

    // Nothing is lifted until a line is read, and then exactly one is.
    await expect(page.getByTestId('transcript-highlight')).toHaveCount(0)
    await lines(page).first().hover()
    await expect(page.getByTestId('transcript-highlight')).toHaveCount(1)

    const drawn = await page.getByTestId('transcript-highlight').locator('polygon')
      .getAttribute('points')
    // Page-normalised, so every corner lands on the scan rather than off it.
    for (const corner of drawn!.split(' ')) {
      for (const n of corner.split(',').map(Number)) {
        expect(n).toBeGreaterThanOrEqual(0)
        expect(n).toBeLessThanOrEqual(1)
      }
    }

    // The box is drawn over the scan, where the ink is, not somewhere off the plate.
    const scan = (await page.getByTestId('transcript-scan').boundingBox())!
    const box = (await page.getByTestId('transcript-highlight').boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(scan.x - 1)
    expect(box.y).toBeGreaterThanOrEqual(scan.y - 1)
    expect(box.x + box.width).toBeLessThanOrEqual(scan.x + scan.width + 1)
    expect(box.y + box.height).toBeLessThanOrEqual(scan.y + scan.height + 1)

    await page.getByTestId('transcript-counts').hover()
    await expect(page.getByTestId('transcript-highlight')).toHaveCount(0)
  })

  // Moving off a line and onto the next is two events, not one, so putting the line down on
  // the way out drew a frame with nothing lifted between every pair of them - and held that
  // frame for as long as the pointer sat in the gap between two blocks. It blinked.
  test('the lifted line stays lifted while the pointer crosses the gap to the next',
    async ({ page }) => {
      const jobId = await seedCompletedJob(uniqueName('Steady'), 2)
      await openTranscript(page, jobId)
      const polygon = page.getByTestId('transcript-highlight').locator('polygon')

      // The stub reads each page as a Header block of three lines and a Paragraph block of
      // three, so the gap between the two blocks is the one a reader crosses.
      await lines(page).nth(2).hover()
      await expect(page.getByTestId('transcript-highlight')).toHaveCount(1)
      const lifted = await polygon.getAttribute('points')

      const above = (await lines(page).nth(2).boundingBox())!
      const below = (await lines(page).nth(3).boundingBox())!
      const gap = { x: above.x + above.width / 2, y: (above.y + above.height + below.y) / 2 }
      expect(below.y - (above.y + above.height)).toBeGreaterThan(4)
      // The premise: this really is a gap, and not another line that happens to sit there.
      expect(await page.evaluate(({ x, y }) =>
        document.elementFromPoint(x, y)?.closest('[data-testid="transcript-line"]') !== null,
      gap)).toBe(false)

      await page.mouse.move(gap.x, gap.y)
      await expect(page.getByTestId('transcript-highlight')).toHaveCount(1)
      await expect(polygon).toHaveAttribute('points', lifted!)

      // Nor does going over to the scan to look at what was lifted put it down.
      await page.getByTestId('transcript-scan').hover()
      await expect(page.getByTestId('transcript-highlight')).toHaveCount(1)
      await expect(polygon).toHaveAttribute('points', lifted!)

      // The next line takes its place, rather than the two of them trading.
      await lines(page).nth(3).hover()
      await expect(page.getByTestId('transcript-highlight')).toHaveCount(1)
      await expect(polygon).not.toHaveAttribute('points', lifted!)

      // And leaving the reading area altogether puts it down.
      await page.getByTestId('transcript-counts').hover()
      await expect(page.getByTestId('transcript-highlight')).toHaveCount(0)
    })

  // A lift that outlives its page draws one page's polygon over the next one's scan. It
  // cannot be caught by turning off a line - the pointer leaving the line is what used to
  // clear it, and a line of the new page arriving under a resting pointer lifts itself.
  // From the gap, nothing is under the pointer on either page.
  test('the lift does not follow the reader onto the next page', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Turned away'), 2)
    await openTranscript(page, jobId)

    await lines(page).nth(2).hover()
    const above = (await lines(page).nth(2).boundingBox())!
    const below = (await lines(page).nth(3).boundingBox())!
    await page.mouse.move(above.x + above.width / 2,
      (above.y + above.height + below.y) / 2)
    await expect(page.getByTestId('transcript-highlight')).toHaveCount(1)

    // Turned with the keyboard, so the pointer stays in that gap.
    await page.keyboard.press('j')
    await expect(at(page)).toHaveText(/^2 \/ 2 /)
    await expect(page.getByTestId('transcript-highlight')).toHaveCount(0)
  })

  // Magnifying has to take the ink with it: the scan and the dim drawn over it line up
  // only because both letterbox by the same rule, and scaling either alone drifts them.
  test('the scan magnifies, and the ink on it magnifies with it', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Magnified'), 2)
    await openTranscript(page, jobId)
    const scan = page.getByTestId('transcript-scan')
    const box = page.getByTestId('transcript-highlight')

    await lines(page).first().hover()
    await expect(box).toHaveCount(1)
    const plain = (await box.boundingBox())!
    await expect(scan).toHaveAttribute('data-zoom', '1.00')

    // Magnifying is asked for with the modifier, as on every other canvas.
    const over = (await scan.boundingBox())!
    await page.mouse.move(over.x + over.width / 2, over.y + over.height / 2)
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, -120)
    await page.keyboard.up('Control')

    await expect.poll(async () => Number(await scan.getAttribute('data-zoom')))
      .toBeGreaterThan(1.1)
    await expect(at(page)).toHaveText(/^1 \/ 2 /)  // it magnified rather than turning

    // The box over the line grew by the same factor the scan did.
    const zoom = Number(await scan.getAttribute('data-zoom'))
    await lines(page).first().hover()
    const grown = (await box.boundingBox())!
    expect(grown.width / plain.width).toBeGreaterThan(zoom - 0.05)
    expect(grown.width / plain.width).toBeLessThan(zoom + 0.05)

    // Double-click puts the whole page back.
    await scan.dblclick()
    await expect(scan).toHaveAttribute('data-zoom', '1.00')

    // And turning the page starts from the whole page again, not halfway into the last one.
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, -120)
    await page.keyboard.up('Control')
    await expect.poll(async () => Number(await scan.getAttribute('data-zoom')))
      .toBeGreaterThan(1.1)
    await page.getByTestId('transcript-page-next').click()
    await expect(at(page)).toHaveText(/^2 \/ 2 /)
    await expect(scan).toHaveAttribute('data-zoom', '1.00')
  })

  // The overlay was drawn exactly where it belonged and painted underneath the scan, which
  // every assertion about its geometry survived. Only the pixels tell.
  test('the rest of the page is taken down while a line is being read', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Dimmed'), 1)
    await openTranscript(page, jobId)

    const plate = (await page.getByTestId('transcript-scan').boundingBox())!
    // The scan arrives tile by tile, and measuring during that would read the arrival
    // rather than the dim.
    await paintedOnTheWall(page)
    const lit = await brightness(page, plate)

    await lines(page).first().hover()
    await expect(page.getByTestId('transcript-highlight')).toHaveCount(1)
    const dimmed = await brightness(page, plate)

    // Near-black at 45% over everything but the line takes this plate down by 53 of the
    // 255. An overlay hidden behind the scan moves it by exactly none; one that covered the
    // line as well would take it further.
    expect(lit - dimmed).toBeGreaterThan(40)
    expect(lit - dimmed).toBeLessThan(70)

    await page.getByTestId('transcript-counts').hover()
    await expect(page.getByTestId('transcript-highlight')).toHaveCount(0)
    expect(Math.abs(await brightness(page, plate) - lit)).toBeLessThan(2)
  })
})

test.describe('Scenario: finding a name the scan spells differently', () => {
  test('a search one letter out still finds it, and marks the word that answered',
    async ({ page }) => {
      const jobId = await seedCompletedJob(uniqueName('Near spelling'), 1)
      await openTranscript(page, jobId)
      await expect(lines(page)).toHaveCount(6)

      // 'Paragraf' is one edit from 'Paragraph', which is what the page actually says.
      await page.getByTestId('transcript-search').fill('Paragraf')
      await expect(page.getByTestId('transcript-found')).toHaveText('3 lines')

      // A search marks and steps; it does not cut the page down to the lines that answered.
      await expect(lines(page)).toHaveCount(6)
      await expect(page.locator('[data-testid="transcript-line"][data-hit="true"]'))
        .toHaveCount(3)
      await expect(page.locator('[data-testid="transcript-line"][data-hit="false"]'))
        .toHaveCount(3)
      const answered = page.locator('[data-testid="transcript-line"][data-hit="true"]')
      for (const line of await answered.all()) {
        await expect(line).toContainText('Paragraph')
      }
      // The word that answered is marked, not the whole line it sits in.
      await expect(page.getByTestId('transcript-match').first()).toHaveText('Paragraph')

      // A word no line reads anything like finds nothing, and leaves the page it found
      // nothing on exactly where it was.
      await page.getByTestId('transcript-search').fill('Zwetschkenroester')
      await expect(page.getByTestId('transcript-found')).toHaveText('0 lines')
      await expect(page.getByTestId('transcript-match')).toHaveCount(0)
      await expect(lines(page)).toHaveCount(6)
      await expect(page.locator('[data-testid="transcript-line"][data-hit="true"]'))
        .toHaveCount(0)
    })

  test('the first answer is opened, and the steps walk the rest of the volume',
    async ({ page }) => {
      const jobId = await seedCompletedJob(uniqueName('Stepped'), 3)
      const pageIds = await jobPageIds(jobId)
      for (const pageId of [pageIds[1], pageIds[2]]) {
        const [line] = await pageLines(jobId, pageId)
        await correctLine(line.id, 'Zwetschkenroester', false)
      }

      await openTranscript(page, jobId)
      await expect(at(page)).toHaveText(/^1 \/ 3 /)

      await page.getByTestId('transcript-search').fill('Zwetschkenroester')

      // Searching opens the page the first answer is on, rather than reporting a count for
      // a page the reader would then have to go and find.
      await expect(page.getByTestId('transcript-found')).toHaveText('2 lines')
      await expect(page.getByTestId('transcript-hit-at')).toHaveText('1 of 2')
      await expect(at(page)).toHaveText(/^2 \/ 3 /)
      await showing(page, pageIds[1])

      // The spine says which pages hold answers, and which do not.
      await expect(page.locator('[data-testid="transcript-tick"][data-hit="true"]'))
        .toHaveCount(2)
      await expect(page.locator('[data-testid="transcript-tick"][data-hit="false"]'))
        .toHaveCount(1)

      await page.getByTestId('transcript-hit-next').click()
      await expect(page.getByTestId('transcript-hit-at')).toHaveText('2 of 2')
      await showing(page, pageIds[2])

      // Past the last answer it comes round to the first, rather than stopping dead.
      await page.getByTestId('transcript-hit-next').click()
      await expect(page.getByTestId('transcript-hit-at')).toHaveText('1 of 2')
      await showing(page, pageIds[1])

      // And the keys do the same, once the search box is not the thing being typed into.
      await page.getByTestId('transcript-scans').click()
      await page.keyboard.press('n')
      await expect(page.getByTestId('transcript-hit-at')).toHaveText('2 of 2')
      await page.keyboard.press('p')
      await expect(page.getByTestId('transcript-hit-at')).toHaveText('1 of 2')

      // The sieve is still there for whoever wants it, behind a name that says so.
      await page.getByRole('checkbox', { name: 'pages with hits' }).check()
      await expect(at(page)).toHaveText(/^1 \/ 2 /)
      await expect(ticks(page)).toHaveCount(2)
      await expect(page.locator('[data-testid="transcript-tick"][data-hit="false"]'))
        .toHaveCount(0)

      await page.getByRole('checkbox', { name: 'pages with hits' }).uncheck()
      await expect(ticks(page)).toHaveCount(3)
    })
})

test.describe('Scenario: searching a transcript the way you mean it', () => {
  test('exact, matching case, and a pattern each find their own', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Search modes'), 1)
    await openTranscript(page, jobId)
    const found = page.getByTestId('transcript-found')
    const search = page.getByTestId('transcript-search')

    // Fuzzy forgives the spelling; exact does not.
    await search.fill('Paragraf')
    await expect(found).toHaveText('3 lines')
    await page.getByRole('button', { name: 'Exact', exact: true }).click()
    await expect(found).toHaveText('0 lines')

    // Exact ignores case until told not to.
    await search.fill('paragraph')
    await expect(found).toHaveText('3 lines')
    await page.getByRole('button', { name: 'Aa', exact: true }).click()
    await expect(found).toHaveText('0 lines')
    await search.fill('Paragraph')
    await expect(found).toHaveText('3 lines')

    // A pattern is the user's own, and an unfinished one says so rather than throwing.
    await page.getByRole('button', { name: '.*', exact: true }).click()
    await search.fill('line [13]$')
    await expect(found).toHaveText('4 lines')
    await search.fill('line (')
    await expect(found).toHaveText('not a pattern yet')
    await expect(page.getByTestId('transcript-match')).toHaveCount(0)
    // Half a bracket marks nothing. It does not take the volume off the wall.
    await expect(lines(page)).toHaveCount(6)
  })
})

test.describe('Scenario: how much of the page the scan is worth', () => {
  test('the divider is dragged, and the account opens the next volume the same way',
    async ({ page }) => {
      await setTranscriptView(page, { split: 0.55 })
      const jobId = await seedCompletedJob(uniqueName('Widened'), 2)
      await openTranscript(page, jobId)

      const scans = page.getByTestId('transcript-scans')
      const frame = await scans.evaluate((el) => {
        const box = el.parentElement!.getBoundingClientRect()
        return { x: box.x, width: box.width }
      })
      const missBy = async (share: number) =>
        Math.abs((await scans.boundingBox())!.width - frame.width * share)
      expect(await missBy(0.55)).toBeLessThan(2)

      const grip = (await page.getByTestId('transcript-divider').boundingBox())!
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
      await page.mouse.down()
      await page.mouse.move(frame.x + frame.width * 0.65, grip.y + grip.height / 2,
        { steps: 5 })
      await page.mouse.up()

      await expect.poll(() => missBy(0.65)).toBeLessThan(2)

      // Kept with the account, not the tab: the server has it before the reload, and the
      // reload gets it back from there.
      await expect.poll(async () =>
        (await (await page.request.get('/api/settings')).json()).transcript_split)
        .toBe(0.65)

      await page.reload()
      await expect(page.getByTestId('transcript-counts')).toBeVisible()
      await expect.poll(() => missBy(0.65)).toBeLessThan(2)

      // Settings belong to the signed-in person and every spec runs as the same one, so
      // what this found is put back before it leaves.
      await setTranscriptView(page, { split: 0.55 })
    })
})

test.describe('Scenario: the whole volume at a glance', () => {
  test('the strip holds every page, opens the one picked, and is there next time',
    async ({ page }) => {
      await setTranscriptView(page, { filmstrip: false })
      const jobId = await seedCompletedJob(uniqueName('Stripped'), 6)
      const pageIds = await jobPageIds(jobId)
      await openTranscript(page, jobId)
      const thumbs = page.getByTestId('transcript-thumb')

      // Off until it is asked for, so the count below is the toggle's doing.
      await expect(page.getByTestId('transcript-strip')).toHaveCount(0)
      await expect(thumbs).toHaveCount(0)

      await page.getByTestId('transcript-strip-toggle').click()
      await expect(thumbs).toHaveCount(6)
      // Exactly one plate in the strip is the one on the wall, and it is the open page.
      await expect(page.locator('[data-testid="transcript-thumb"][aria-current="page"]'))
        .toHaveCount(1)
      await expect(thumbs.nth(0)).toHaveAttribute('aria-current', 'page')

      await thumbs.nth(4).click()
      await showing(page, pageIds[4])
      await expect(at(page)).toHaveText(/^5 \/ 6 /)
      await expect(thumbs.nth(4)).toHaveAttribute('aria-current', 'page')
      await expect(page.locator('[data-testid="transcript-thumb"][aria-current="page"]'))
        .toHaveCount(1)

      // Kept with the account, like the divider beside it.
      await expect.poll(async () =>
        (await (await page.request.get('/api/settings')).json()).transcript_filmstrip)
        .toBe(true)
      await page.reload()
      await expect(page.getByTestId('transcript-counts')).toBeVisible()
      await expect(thumbs).toHaveCount(6)

      await setTranscriptView(page, { filmstrip: false })
    })
})

test.describe('Scenario: the reading room', () => {
  test('the chrome goes when it is in the way, and there is always a way back',
    async ({ page }) => {
      const jobId = await seedCompletedJob(uniqueName('Bare'), 2)
      await openTranscript(page, jobId)
      await expect(page.getByTestId('transcript-search')).toBeVisible()

      await page.getByTestId('transcript-immersive').click()
      await expect(page.getByTestId('transcript-search')).toHaveCount(0)
      await expect(page.getByTestId('transcript-counts')).toHaveCount(0)
      // The scan and the text stay. Only what stood around them goes.
      await expect(page.getByTestId('transcript-scan')).toHaveCount(1)
      await expect(lines(page)).toHaveCount(6)
      await expect(page.getByTestId('transcript-spine')).toBeVisible()
      // Hiding the controls without leaving something on the screen to bring them back is
      // how a reading mode becomes a trap.
      await expect(page.getByTestId('transcript-immersive-exit')).toBeVisible()

      await page.keyboard.press('Escape')
      await expect(page.getByTestId('transcript-search')).toBeVisible()
      await expect(page.getByTestId('transcript-immersive-exit')).toHaveCount(0)

      await page.keyboard.press('f')
      await expect(page.getByTestId('transcript-search')).toHaveCount(0)
      await page.getByTestId('transcript-immersive-exit').click()
      await expect(page.getByTestId('transcript-search')).toBeVisible()
    })
})

test.describe('Scenario: an exact search for a phrase', () => {
  test('the words of the phrase are marked, not only counted', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Phrase search'), 1)
    await openTranscript(page, jobId)
    await page.getByRole('button', { name: 'Exact', exact: true }).click()
    await page.getByTestId('transcript-search').fill('Paragraph line 2')

    await expect(page.getByTestId('transcript-found')).toHaveText('1 line')
    await expect(page.getByTestId('transcript-match')).toHaveText(['Paragraph', 'line', '2'])
  })
})

test.describe('Scenario: half a pattern while only pages with hits are shown', () => {
  test('an unfinished pattern finds nothing, rather than bringing every page back', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Half a pattern'), 3)
    const pageIds = await jobPageIds(jobId)
    for (const pageId of pageIds.slice(1)) {
      const [first] = await pageLines(jobId, pageId)
      await correctLine(first.id, 'Zwetschkenroester')
    }
    await openTranscript(page, jobId)
    await page.getByRole('button', { name: '.*', exact: true }).click()
    await page.getByTestId('transcript-search').fill('Zwetschken')
    await page.getByRole('checkbox', { name: 'pages with hits' }).check()
    await expect(ticks(page)).toHaveCount(2)

    await page.getByTestId('transcript-search').fill('Zwetschken(')
    await expect(page.getByTestId('transcript-found')).toHaveText('not a pattern yet')
    await expect(ticks(page)).toHaveCount(0)
    await expect(page.getByTestId('transcript-empty')).toBeVisible()
  })
})
