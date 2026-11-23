import { test, expect } from '../helpers/test'
import { backendFetch, correctLine, jobPageIds, pageLines, seedCompletedJob, uniqueName } from '../helpers/api'

test.describe('Scenario: looking for a name across every dataset', () => {
  test('a name spelled two ways is found in both datasets, and a hit opens its line (#41)', async ({ page }) => {
    test.setTimeout(120_000)
    // A surname no stub reading holds, so only the two lines given it can answer.
    const surname = `Qwz${Date.now().toString(36)}`
    const [first, second] = [uniqueName('Search A'), uniqueName('Search B')]
    const lines: { jobId: string; pageId: number; lineId: number }[] = []
    for (const [name, spelling, checked] of [[first, `${surname}müller`, true], [second, `${surname}mueller`, false]] as const) {
      const jobId = await seedCompletedJob(name, 1)
      const [pageId] = await jobPageIds(jobId)
      const [line] = await pageLines(jobId, pageId)
      await correctLine(line.id, `Johann ${spelling} Pfarrer`, checked)
      lines.push({ jobId, pageId, lineId: line.id })
    }
    // Backend oracle: the index found both corrections, and the checked filter keeps one.
    const both = await backendFetch(`/api/search?q=${encodeURIComponent(`${surname}Mueller`)}`)
    expect(both.hits.map((h: { line_id: number }) => h.line_id).sort()).toEqual(lines.map((l) => l.lineId).sort())

    await page.goto('/')
    await page.getByTestId('nav-search').click()
    await page.getByTestId('search-input').fill(`${surname}Müller`)
    await expect(page.getByTestId('search-summary')).toHaveText('2 lines in 2 datasets')
    await expect(page.getByTestId('search-group')).toHaveCount(2)
    const firstHit = page.locator(`[data-testid="search-hit"][data-line="${lines[0].lineId}"]`)
    await expect(firstHit.getByTestId('search-match')).toHaveText(`${surname}müller`)
    await expect(page.locator(`[data-testid="search-hit"][data-line="${lines[1].lineId}"]`).getByTestId('search-match'))
      .toHaveText(`${surname}mueller`)

    await page.getByTestId('search-dataset').selectOption(lines[1].jobId)
    await expect(page.getByTestId('search-summary')).toHaveText('1 line in 1 dataset')
    await expect(page.getByTestId('search-hit')).toHaveCount(1)
    await expect(page.locator(`[data-testid="search-hit"][data-line="${lines[1].lineId}"]`)).toHaveCount(1)
    await page.getByTestId('search-dataset').selectOption('')
    await expect(page.getByTestId('search-summary')).toHaveText('2 lines in 2 datasets')

    // The box follows the address, which the click changes a moment later.
    await page.getByTestId('search-checked').click()
    await expect(page.getByTestId('search-checked')).toBeChecked()
    await expect(page.getByTestId('search-summary')).toHaveText('1 line in 1 dataset')
    await expect(page).toHaveURL(/checked=1/)
    await expect(page.getByTestId('search-hit')).toHaveCount(1)
    await expect(page.locator(`[data-testid="search-hit"][data-line="${lines[1].lineId}"]`)).toHaveCount(0)

    await firstHit.click()
    await expect(page).toHaveURL(new RegExp(`/jobs/${lines[0].jobId}/pages/${lines[0].pageId}\\?line=${lines[0].lineId}$`))
  })
})
