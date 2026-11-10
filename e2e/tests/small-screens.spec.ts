import type { Locator, Page } from '@playwright/test'
import { test, expect } from '../helpers/test'
import { jobPageIds, seedCompletedJob, uniqueName } from '../helpers/api'
import { seedMapJob, tileIds } from '../helpers/map'
import { unreachable } from '../helpers/smallScreens'

// Runs in the phone and tablet projects only (playwright.config.ts).
const onPhone = (page: Page) => page.viewportSize()!.width < 768

async function settle(page: Page, path: string) {
  await page.goto(path)
  await page.waitForLoadState('networkidle')
  // Lazy panels and the queue chip arrive a moment after the network goes quiet.
  await page.waitForTimeout(500)
}

test.describe('Scenario: DeepLabel on a phone and a tablet', () => {
  test('the check finds what does not fit, so an empty answer means something', async ({ page }) => {
    await settle(page, '/queue')
    await page.evaluate(() => {
      const wide = document.createElement('p')
      wide.textContent = 'far too wide'
      wide.style.cssText = 'width: 3000px; white-space: nowrap'
      document.querySelector('[data-testid="app-main"]')!.prepend(wide)
    })
    const found = await unreachable(page)
    expect(found).toContainEqual(expect.stringMatching(/^main scrolls sideways by \d+px$/))
    expect(found).toContainEqual(expect.stringMatching(/^p\[app-main\] "far too wide" off screen/))
  })

  test('every page fits the screen: nothing is cut off and no page scrolls sideways', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Small screens'), 2)
    const [pageId] = await jobPageIds(jobId)
    const mapJobId = await seedMapJob(uniqueName('Small screens map'))
    const [tileId] = await tileIds(mapJobId)
    const pages = [
      '/', `/jobs/${jobId}`, `/jobs/${jobId}/transcript`, `/jobs/${jobId}/pages/${pageId}`, `/jobs/${jobId}/corpus`,
      `/jobs/${jobId}/settings`, `/jobs/${mapJobId}`, '/models', '/models/evaluations', '/queue', '/new', '/admin',
      '/profile', '/conventions', '/templates', '/augmentations',
    ]
    // An iPad is an editing device; on a phone the editors open as they are.
    if (!onPhone(page)) pages.push(`/jobs/${mapJobId}/tiles/${tileId}`)
    for (const path of pages) {
      await settle(page, path)
      expect.soft(await unreachable(page), path).toEqual([])
    }
    if (!onPhone(page)) {
      await settle(page, `/jobs/${jobId}/pages/${pageId}`)
      await page.getByRole('button', { name: /^Edit/ }).click()
      await expect(page.getByText('Layout complete')).toBeVisible()
      expect.soft(await unreachable(page), 'page editor').toEqual([])
    }
  })

  test('the top bar keeps to one line, and on a phone the menu holds the rest', async ({ page }) => {
    await settle(page, '/')
    const bar = page.getByRole('banner')
    const logo = bar.getByRole('link', { name: 'DeepLabel' })
    await expect(logo).toBeVisible()
    await expect(page.getByTestId('queue-pill')).toBeVisible()
    expect((await bar.boundingBox())!.height).toBeLessThanOrEqual(49)
    const links = ['Queue', 'Models', 'Admin', 'New job']
    if (!onPhone(page)) {
      for (const name of links) await expect(bar.getByRole('link', { name, exact: true })).toBeVisible()
      expect(await textLines(bar.getByRole('link', { name: 'New job', exact: true }))).toBe(1)
      expect(await textLines(page.getByTestId('queue-pill'))).toBe(1)
      await expect(page.getByTestId('nav-menu-button')).toBeHidden()
      return
    }
    for (const name of links) await expect(bar.getByRole('link', { name, exact: true })).toBeHidden()
    await page.getByTestId('nav-menu-button').click()
    const menu = page.getByTestId('nav-menu')
    // Queue says what is running as well, after its name.
    for (const name of links) await expect(menu.getByRole('link', { name: new RegExp(`^${name}`) })).toBeVisible()
    await expect(menu.getByTestId('theme-toggle')).toBeVisible()
    await expect(menu.getByTestId('user-menu')).toBeVisible()
    await menu.getByRole('link', { name: 'Models', exact: true }).click()
    await expect(page).toHaveURL(/\/models$/)
    await expect(menu).toBeHidden()
  })

  test('a wide table scrolls inside its card, with the selection and page number kept in view', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Small screens table'), 2)
    await settle(page, `/jobs/${jobId}`)
    const card = page.getByTestId('pages-table-card')
    const firstRow = card.locator('tbody tr').first()
    await expect(firstRow.locator('td[data-col="idx"]')).toHaveText('1')
    const last = card.locator('thead th').last()
    if (!onPhone(page)) {
      expect(await card.evaluate((c) => c.scrollWidth - c.clientWidth)).toBeLessThanOrEqual(1)
      return
    }
    await firstRow.scrollIntoViewIfNeeded()
    const cardBox = (await card.boundingBox())!
    expect((await last.boundingBox())!.x).toBeGreaterThan(cardBox.x + cardBox.width)
    await card.evaluate((c) => { c.scrollLeft = c.scrollWidth })
    const lastBox = (await last.boundingBox())!
    expect(lastBox.x + lastBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1)
    const number = (await firstRow.locator('td[data-col="idx"]').boundingBox())!
    expect(number.x).toBeGreaterThanOrEqual(cardBox.x)
    expect(number.x + number.width).toBeLessThan(cardBox.x + cardBox.width / 2)
    await expect(firstRow.getByRole('checkbox')).toBeInViewport()
  })

  test('on a phone the transcript is the text, and a line opens its scan', async ({ page }) => {
    test.skip(!onPhone(page), 'a tablet shows the scan beside the text')
    const jobId = await seedCompletedJob(uniqueName('Small screens transcript'), 2)
    await settle(page, `/jobs/${jobId}/transcript`)
    const text = page.getByTestId('transcript-text')
    await expect(text.getByTestId('transcript-line').first()).toHaveText('Sample Header line 1')
    await expect(page.getByTestId('transcript-scans')).toBeHidden()
    expect((await text.boundingBox())!.width).toBeGreaterThan(page.viewportSize()!.width * 0.8)

    await text.getByTestId('transcript-line').nth(1).tap()
    await expectScanSheet(page, 'Sample Header line 2')
  })

  test('on a phone the page viewer shows the lines, and each opens its scan', async ({ page }) => {
    test.skip(!onPhone(page), 'a tablet shows the scan beside the lines')
    const jobId = await seedCompletedJob(uniqueName('Small screens viewer'), 1)
    const [pageId] = await jobPageIds(jobId)
    await settle(page, `/jobs/${jobId}/pages/${pageId}`)
    const row = page.getByTestId('line-row').nth(1)
    await expect(row).toContainText('Sample Header line 2')
    await expect(page.getByTestId('overlay-box')).toBeHidden()
    await row.getByTestId('line-scan').tap()
    await expectScanSheet(page, 'Sample Header line 2')
  })

  test('on a tablet, tapping a transcript line outlines it on the scan, as hovering does', async ({ page }) => {
    test.skip(onPhone(page), 'a phone shows the text only')
    const jobId = await seedCompletedJob(uniqueName('Small screens tap'), 1)
    await settle(page, `/jobs/${jobId}/transcript`)
    const outline = page.getByTestId('transcript-highlight').locator('polygon')
    await expect(page.getByTestId('transcript-scan').first()).toBeVisible()
    await expect(outline).toHaveCount(0)
    await page.getByTestId('transcript-line').nth(1).tap()
    await expect(outline).toHaveCount(1)
  })

  test('on a touch screen every control is a target 44 px across', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Small screens touch'), 1)
    const [pageId] = await jobPageIds(jobId)
    for (const path of [`/jobs/${jobId}`, `/jobs/${jobId}/transcript`, `/jobs/${jobId}/pages/${pageId}`]) {
      await settle(page, path)
      const controls = page.locator('button, input[type="checkbox"], select, [role="button"], [role="switch"], '
        + '[role="slider"], [role="separator"], [role="tab"]')
      await expect(controls.first()).toBeVisible()
      expect.soft(await missedTaps(page), path).toEqual([])
    }
  })
})

/** Controls a finger can miss: a tap 21 px from the centre of each, in any direction along
 *  its axes, must reach it - the control itself, something inside it, or a label that hands
 *  the tap to it. That is a target 44 px across. */
function missedTaps(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const selector = 'button, input[type="checkbox"], select, [role="button"], [role="switch"], '
      + '[role="slider"], [role="separator"], [role="tab"]'
    const missed: string[] = []
    for (const control of document.querySelectorAll<HTMLElement>(selector)) {
      if (control.closest('[aria-hidden="true"], [inert]')) continue
      const { width, height } = control.getBoundingClientRect()
      if (width === 0 || height === 0) continue
      control.scrollIntoView({ block: 'center', inline: 'center' })
      const r = control.getBoundingClientRect()
      const [cx, cy] = [r.left + r.width / 2, r.top + r.height / 2]
      const W = document.documentElement.clientWidth
      const H = document.documentElement.clientHeight
      const reaches = (x: number, y: number) => {
        const hit = document.elementFromPoint(Math.min(W - 1, Math.max(0, x)), Math.min(H - 1, Math.max(0, y)))
        return !!hit && (control.contains(hit) || hit.closest('label')?.control === control)
      }
      // Along the axes rather than at the corners, which a rounded control rightly misses.
      const reach = [[-21, 0], [21, 0], [0, -21], [0, 21]]
      if (!reach.every(([dx, dy]) => reaches(cx + dx, cy + dy))) {
        const name = (control.getAttribute('aria-label') ?? control.innerText ?? '').trim().replace(/\s+/g, ' ')
        missed.push(`${control.closest('[data-testid]')?.getAttribute('data-testid') ?? control.tagName.toLowerCase()} "${name.slice(0, 24)}"`)
      }
    }
    return [...new Set(missed)]
  })
}

/** How many lines the text inside an element is set on. */
function textLines(element: Locator): Promise<number> {
  return element.evaluate((el) => {
    const tops: number[] = []
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent?.trim()) continue
      const range = document.createRange()
      range.selectNodeContents(n)
      for (const r of range.getClientRects()) if (!tops.some((t) => Math.abs(t - r.top) < 4)) tops.push(r.top)
    }
    return tops.length
  })
}

async function expectScanSheet(page: Page, line: string) {
  const sheet = page.getByRole('dialog', { name: line })
  await expect(sheet).toBeVisible()
  const crop = sheet.getByTestId('scan-sheet-crop')
  await expect(crop).toBeVisible()
  expect((await crop.boundingBox())!.width).toBeGreaterThan(page.viewportSize()!.width * 0.8)
  await expect(sheet.getByTestId('scan-sheet-line')).toHaveCount(0)
  await sheet.getByRole('button', { name: 'Whole page' }).tap()
  await expect(sheet.getByTestId('scan-sheet-line')).toHaveCount(1)
  await sheet.getByRole('button', { name: 'Close' }).tap()
  await expect(sheet).toBeHidden()
}
