import { test, expect } from '../helpers/test'
import { backendFetch, getJob, jobPageIds, seedDistinctPagesJob, uniqueName } from '../helpers/api'
import { openViewer } from '../helpers/viewer'

const pageNote = async (jobId: string, pageId: number) =>
  (await backendFetch(`/api/jobs/${jobId}/pages/${pageId}`)).note as { text: string; by: string } | null

test.describe('Scenario: a note on a dataset', () => {
  test('an editor adds one from the title, and the dataset list shows it as a tag', async ({ page }) => {
    const name = uniqueName('Noted dataset')
    const jobId = await seedDistinctPagesJob(name, 1, 300)
    await page.goto(`/jobs/${jobId}`)

    await expect(page.getByTestId('note-tag')).toHaveCount(0)
    await page.getByRole('button', { name: 'Add note', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: `Note on ${name}` })
    await dialog.getByTestId('note-input').fill('Pages 1-40 checked by GW.\n41 onwards open.')
    await dialog.getByRole('button', { name: 'Save' }).click()

    await expect.poll(async () => (await getJob(jobId)).note?.text).toBe('Pages 1-40 checked by GW.\n41 onwards open.')
    const by = (await getJob(jobId)).note.by as string
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Add note', exact: true })).toHaveCount(0)

    await page.goto(`/?q=${encodeURIComponent(name)}`)
    const row = page.getByTestId('job-card').filter({ hasText: name })
    await expect(row).toBeVisible()
    await row.getByRole('button', { name: 'Note', exact: true }).click()
    const shown = page.getByRole('dialog', { name: `Note on ${name}` })
    await expect(shown.getByTestId('note-text')).toHaveText('Pages 1-40 checked by GW.\n41 onwards open.')
    await expect(shown.getByTestId('note-by')).toContainText(by)
    // The tag opens the note, not the dataset.
    await expect(page).toHaveURL(/\/\?q=/)
  })
})

test.describe('Scenario: a note on a page', () => {
  test('written in the viewer, it tags the page row and is found by its filter, then removed',
    async ({ page }) => {
      const jobId = await seedDistinctPagesJob(uniqueName('Noted page'), 2, 310)
      const [, second] = await jobPageIds(jobId)
      await openViewer(page, jobId, second)

      await page.getByRole('button', { name: 'Add note', exact: true }).click()
      await page.getByTestId('note-input').fill('Marginalia not transcribed.')
      await page.getByRole('button', { name: 'Save' }).click()
      await expect.poll(async () => (await pageNote(jobId, second))?.text).toBe('Marginalia not transcribed.')
      await expect(page.getByRole('button', { name: 'Note', exact: true })).toBeVisible()

      await page.goto(`/jobs/${jobId}`)
      const rows = page.locator('[data-page-row]')
      const noteOf = (filename: string) =>
        rows.filter({ hasText: filename }).getByRole('button', { name: 'Note', exact: true })
      await expect(rows).toHaveCount(2)
      await expect(page.getByTestId('page-filter-has-note')).toHaveText('Has note · 1')
      await expect(noteOf('scan_2.png')).toBeVisible()
      await expect(noteOf('scan_1.png')).toHaveCount(0)

      await noteOf('scan_2.png').click()
      const dialog = page.getByRole('dialog', { name: 'Note on scan_2.png' })
      await expect(dialog.getByTestId('note-text')).toHaveText('Marginalia not transcribed.')
      await expect(page).toHaveURL(new RegExp(`/jobs/${jobId}$`))
      await dialog.getByRole('button', { name: 'Edit' }).click()
      await dialog.getByRole('button', { name: 'Remove' }).click()

      await expect.poll(() => pageNote(jobId, second)).toBeNull()
      await expect(page.getByTestId('page-filter-has-note')).toHaveText('Has note · 0')
      await expect(noteOf('scan_2.png')).toHaveCount(0)
    })
})
