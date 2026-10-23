import type { Locator, Page } from '@playwright/test'
import { test, expect } from '../helpers/test'
import { createGroup, getJob, seedCompletedJob, uniqueName } from '../helpers/api'

const rowOf = (page: Page, name: string) => page.getByTestId('job-card').filter({ hasText: name })
const searchBox = (page: Page) => page.getByRole('textbox', { name: 'Search datasets' })

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox()
  if (!box) throw new Error('element has no bounding box')
  return box
}

/** The selection's actions used to sit at the foot of the window, where they went unseen.
 *  They now take the toolbar's own row at the top of the list for as long as anything is
 *  ticked, and the filters come back the moment nothing is. */
test.describe('Scenario: the selection takes the toolbar row', () => {
  test('ticking a dataset swaps the filters for its actions in the same place and size', async ({ page }) => {
    const name = uniqueName('Toolbar pick')
    await seedCompletedJob(name, 1)

    await page.goto('/')
    const row = rowOf(page, name)
    await expect(row).toBeVisible()
    await expect(searchBox(page)).toBeVisible()
    await expect(page.getByTestId('sort-menu')).toBeVisible()
    await expect(page.getByTestId('groupby-menu')).toBeVisible()
    await expect(page.getByTestId('columns-menu')).toBeVisible()
    const toolbar = await boxOf(searchBox(page).locator('..'))

    const tick = row.getByRole('checkbox')
    await tick.focus()
    await page.keyboard.press('Space')
    await expect(tick).toBeChecked()
    await expect(tick).toBeFocused()

    const bar = page.getByTestId('bulk-bar')
    await expect(bar).toContainText('1 selected')
    await expect(searchBox(page)).toHaveCount(0)
    await expect(page.getByTestId('sort-menu')).toBeHidden()
    await expect(page.getByTestId('groupby-menu')).toBeHidden()
    await expect(page.getByTestId('columns-menu')).toBeHidden()

    const barBox = await boxOf(bar)
    expect(Math.abs(barBox.y - toolbar.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(barBox.height - toolbar.height)).toBeLessThanOrEqual(1)
    expect(barBox.y + barBox.height).toBeLessThanOrEqual((await boxOf(row)).y)

    await page.keyboard.press('Space')
    await expect(tick).not.toBeChecked()
    await expect(searchBox(page)).toBeVisible()
    await expect(page.getByTestId('sort-menu')).toBeVisible()
    await expect(bar).toHaveCount(0)
  })

  test('Clear brings the filters back', async ({ page }) => {
    const name = uniqueName('Toolbar clear')
    await seedCompletedJob(name, 1)

    await page.goto('/')
    await rowOf(page, name).getByRole('checkbox').check()
    const bar = page.getByTestId('bulk-bar')
    await expect(bar).toContainText('1 selected')
    await expect(searchBox(page)).toHaveCount(0)

    await bar.getByRole('button', { name: 'Clear', exact: true }).click()
    await expect(bar).toHaveCount(0)
    await expect(searchBox(page)).toBeVisible()
    // The button that had the focus went with the bar, so the focus lands on the search box
    // rather than falling to the page.
    await expect(searchBox(page)).toBeFocused()
    await expect(page.getByTestId('result-count')).toBeVisible()
    await expect(rowOf(page, name).getByRole('checkbox')).not.toBeChecked()
  })

  test('Move to group opens downward from the top, closes on Escape, and files the selection', async ({ page }) => {
    const target = uniqueName('Toolbar target')
    const group = await createGroup(target)
    const one = uniqueName('Toolbar one')
    const two = uniqueName('Toolbar two')
    const ids = [await seedCompletedJob(one, 1), await seedCompletedJob(two, 1)]

    await page.goto('/')
    for (const name of [one, two]) await rowOf(page, name).getByRole('checkbox').check()
    const bar = page.getByTestId('bulk-bar')
    await expect(bar).toContainText('2 selected')

    const opener = bar.getByRole('button', { name: 'Move to group…' })
    const option = bar.getByRole('button', { name: target, exact: true })
    await opener.click()
    await expect(option).toBeVisible()
    expect((await boxOf(option)).y).toBeGreaterThan((await boxOf(opener)).y)

    await page.keyboard.press('Escape')
    await expect(option).toHaveCount(0)
    await expect(bar).toContainText('2 selected')

    await opener.click()
    await option.click()
    for (const jobId of ids) {
      await expect.poll(async () => (await getJob(jobId)).group_id).toBe(group.id)
    }
    await expect(bar).toHaveCount(0)
    await expect(searchBox(page)).toBeVisible()
  })
})
