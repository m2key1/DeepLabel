import { test, expect } from '../helpers/test'
import {
  exportText,
  getPageDetail,
  jobPageIds,
  markLayoutChecked,
  markLinesChecked,
  seedCompletedJob,
  setElementChecked,
  uniqueName,
} from '../helpers/api'

test.describe('Scenario: finding and consuming reviewed data', () => {
  test('page filters isolate finished work and the card bars deep-link to it', async ({ page }) => {
    const name = uniqueName('Filterable')
    const jobId = await seedCompletedJob(name, 2)
    const [firstPage] = await jobPageIds(jobId)
    // Page 1 is reviewed both ways: layout checked plus every element checked.
    await markLayoutChecked(firstPage)
    const detail = await getPageDetail(jobId, firstPage)
    for (const element of detail.elements) await setElementChecked(element.id)

    await page.goto(`/jobs/${jobId}`)
    await expect(page.getByTestId('page-filter-all')).toHaveText('All · 2')
    await expect(page.getByTestId('page-filter-lines-reviewed')).toHaveText('Lines reviewed · 1')
    await expect(page.getByTestId('page-filter-layout-reviewed')).toHaveText('Layout reviewed · 1')
    await expect(page.getByTestId('page-filter-unreviewed-lines')).toHaveText('Unreviewed lines · 1')
    await expect(page.getByTestId('page-filter-layout-unchecked')).toHaveText('Layout unchecked · 1')

    // Lines reviewed shows exactly page 1; the unfinished page is filtered out.
    const row = (filename: string) => page.getByRole('row').filter({ hasText: filename })
    await page.getByTestId('page-filter-lines-reviewed').click()
    await expect(page).toHaveURL(/filter=lines-reviewed$/)
    await expect(row('scan_1.png')).toHaveCount(1)
    await expect(row('scan_2.png')).toHaveCount(0)

    await page.getByTestId('page-filter-layout-unchecked').click()
    await expect(row('scan_2.png')).toHaveCount(1)
    await expect(row('scan_1.png')).toHaveCount(0)

    // The dataset card's OCR bar links straight into the filtered table.
    await page.goto('/')
    await page
      .getByTestId('job-card')
      .filter({ hasText: name })
      .getByTestId('ocr-progress-link')
      .click()
    await expect(page).toHaveURL(new RegExp(`/jobs/${jobId}\\?filter=unreviewed-lines$`))
    await expect(row('scan_2.png')).toHaveCount(1)
    await expect(row('scan_1.png')).toHaveCount(0)
  })

  test('reviewed-only export and transcript carry exactly the checked lines', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Reviewable'), 1)
    await markLinesChecked(jobId, 2)
    const [pageId] = await jobPageIds(jobId)
    const lines = (await getPageDetail(jobId, pageId)).elements.flatMap(
      (e: { lines: { text: string; checked: boolean }[] }) => e.lines)
    const checkedTexts = lines.filter((l: { checked: boolean }) => l.checked).map((l: { text: string }) => l.text)
    expect(checkedTexts).toHaveLength(2)

    // The reviewed-only text export is exactly the checked lines, nothing else.
    expect(await exportText(jobId, 'txt', true)).toBe(checkedTexts.join('\n'))
    const full = await exportText(jobId, 'txt')
    for (const line of lines) expect(full).toContain(line.text)

    // The transcript renders every line, reviewed ones distinguished per line.
    await page.goto(`/jobs/${jobId}/transcript`)
    await expect(page.getByTestId('transcript-counts')).toHaveText('2/6 lines reviewed')
    await expect(page.getByTestId('transcript-line')).toHaveCount(6)
    const reviewed = page.locator('[data-testid="transcript-line"][data-checked="true"]')
    await expect(reviewed).toHaveCount(2)
    await expect(reviewed.first()).toHaveText(checkedTexts[0])

    // The reviewed-only toggle collapses the view to the checked lines.
    await page.getByRole('checkbox', { name: 'reviewed only' }).check()
    await expect(page.getByTestId('transcript-line')).toHaveCount(2)
  })
})
