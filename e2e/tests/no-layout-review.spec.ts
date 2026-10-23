import { test, expect } from '../helpers/test'
import { getPageDetail, jobPageIds, pageLines, seedJobWithoutLayout, uniqueName } from '../helpers/api'
import { backendFetch, identity } from '../helpers/api'

const DEV = identity('dev', 'admin')

test.describe('Scenario: a dataset that skipped layout', () => {
  test('is reviewed and counted by its lines, not by boxes it never had', async ({ page }) => {
    const name = uniqueName('No layout')
    const jobId = await seedJobWithoutLayout(name)
    const [pageId] = await jobPageIds(jobId)

    // Every line sits in one invisible orphan bucket, so the element counters are zero.
    const detail = await getPageDetail(jobId, pageId)
    expect(detail.elements.filter((e: { kind: string }) => e.kind === 'content')).toHaveLength(0)
    expect(await pageLines(jobId, pageId)).toHaveLength(6)

    const summary = (await backendFetch(`/api/jobs/${jobId}`, { headers: DEV })).pages[0]
    expect(summary.elements_total).toBe(0)
    expect({ total: summary.lines_total, reviewed: summary.lines_reviewed })
      .toEqual({ total: 6, reviewed: 0 })

    await page.goto(`/jobs/${jobId}`)
    // The column counts lines and says so; there is no layout column to leave empty.
    await expect(page.getByRole('columnheader', { name: 'Lines checked' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: 'OCR checked' })).toHaveCount(0)
    await expect(page.getByRole('columnheader', { name: 'Layout' })).toHaveCount(0)
    // ...and no chip that could only ever match every page.
    await expect(page.getByRole('button', { name: /Layout unchecked/ })).toHaveCount(0)
    await expect(page.locator('tbody').getByText('0/6')).toBeVisible()
  })

  test('checking its lines moves the count and satisfies the reviewed filter',
    async ({ page }) => {
      const jobId = await seedJobWithoutLayout(uniqueName('No layout reviewed'))
      const [pageId] = await jobPageIds(jobId)
      for (const line of await pageLines(jobId, pageId)) {
        await backendFetch(`/api/lines/${line.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...DEV },
          body: JSON.stringify({ checked: true }),
        })
      }

      await page.goto(`/jobs/${jobId}`)
      await expect(page.locator('tbody').getByText('6/6')).toBeVisible()
      // The filter was unsatisfiable before: it wanted boxes this dataset never had.
      await page.getByRole('button', { name: /Lines reviewed/ }).click()
      await expect(page.locator('tbody tr')).toHaveCount(1)
    })
})
