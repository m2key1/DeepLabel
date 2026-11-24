import { test, expect } from '../helpers/test'
import { backendFetch, identity, jobPageIds, moveJobToGroup, seedCompletedJob, shareGroup, uniqueName } from '../helpers/api'
import { openDatasetMenu } from '../helpers/dataset'
import { seedSession, useSession } from '../helpers/session'
import { openViewer } from '../helpers/viewer'

type Assignments = { people: { username: string; pages: number[] }[]; unassigned: number[] }

async function assignmentsOf(jobId: string): Promise<Record<string, number[]>> {
  const held = await backendFetch(`/api/jobs/${jobId}/assignments`) as Assignments
  return {
    ...Object.fromEntries(held.people.filter((p) => p.pages.length).map((p) => [p.username, p.pages])),
    nobody: held.unassigned,
  }
}

test.describe('Scenario: a Manager hands out a volume\'s pages (#137)', () => {
  test('ranges and a selection are handed out, and an Annotator keeps to their pages and the unassigned',
    async ({ browser }) => {
    const stamp = Date.now()
    const mona = `mona-${stamp}`
    const lena = `lena-${stamp}`
    const ben = `ben-${stamp}`
    const monaSession = seedSession('manager', mona)
    const lenaSession = seedSession('annotator', lena)
    const benSession = seedSession('annotator', ben)
    const workspace = await backendFetch('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...identity(mona, 'manager') },
      body: JSON.stringify({ name: uniqueName('Pfarre Gars') }),
    }) as { id: number }
    await shareGroup(workspace.id, [mona, lena, ben])
    const jobId = await seedCompletedJob(uniqueName('Taufbuch 1890'), 5)
    await moveJobToGroup(jobId, workspace.id)
    const ids = await jobPageIds(jobId)
    const row = (number: number) => `[data-page-row="${ids[number - 1]}"]`

    const monaContext = await browser.newContext()
    await useSession(monaContext, monaSession)
    const page = await monaContext.newPage()
    await page.goto(`/jobs/${jobId}`)
    await expect(page.locator('[data-page-row]')).toHaveCount(5)
    // Nothing is handed out yet, so nothing says whose a page is.
    await expect(page.getByTestId('page-filter-all')).toHaveText('All · 5')
    await expect(page.getByTestId('page-filter-unassigned')).toHaveCount(0)
    await expect(page.getByRole('columnheader', { name: 'Assigned to' })).toHaveCount(0)

    // Pages 1, 2 and 4 to Lena, as ranges.
    const more = await openDatasetMenu(page, 'dataset-more')
    await more.getByTestId('assign-pages').click()
    const dialog = page.getByRole('dialog', { name: /^Assign pages of/ })
    await dialog.getByRole('textbox', { name: 'Pages' }).fill('1-2, 4')
    await dialog.getByRole('combobox', { name: 'Assign to' }).selectOption(lena)
    await dialog.getByRole('button', { name: 'Assign' }).click()
    await expect.poll(() => assignmentsOf(jobId)).toEqual({ [lena]: [1, 2, 4], nobody: [3, 5] })
    await expect(dialog.locator(`[data-testid="assignment"][data-username="${lena}"]`)
      .getByTestId('assignment-pages')).toHaveText('1-2, 4')
    await expect(dialog.getByTestId('assignment-unassigned').getByTestId('assignment-pages')).toHaveText('3, 5')
    await dialog.getByRole('button', { name: 'Done' }).click()

    await expect(page.getByRole('columnheader', { name: 'Assigned to' })).toBeVisible()
    await expect(page.locator(row(4)).getByTestId('page-assignee')).toHaveText(lena)
    await expect(page.locator(row(3)).getByTestId('page-assignee')).toHaveCount(0)
    await expect(page.getByTestId('page-filter-unassigned')).toHaveText('Unassigned · 2')
    // After the avatar's initials.
    await expect(page.getByTestId(`page-filter-assigned:${lena}`)).toHaveText(new RegExp(`^[A-Z]{2}${lena} · 3$`))

    // Page 3 to Ben, from a selection in the table.
    await page.locator(row(3)).getByRole('checkbox').click()
    await page.getByTestId('bulk-assign').selectOption(ben)
    await expect.poll(() => assignmentsOf(jobId)).toEqual({ [ben]: [3], [lena]: [1, 2, 4], nobody: [5] })
    await expect(page.locator(row(3)).getByTestId('page-assignee')).toHaveText(ben)
    await expect(page.getByTestId(`page-filter-assigned:${ben}`)).toHaveText(new RegExp(`^[A-Z]{2}${ben} · 1$`))
    await page.getByTestId('page-filter-unassigned').click()
    await expect(page.locator('[data-page-row]')).toHaveCount(1)
    await expect(page.locator(row(5))).toHaveCount(1)
    await monaContext.close()

    // Lena's table holds her pages and the one nobody has, not Ben's.
    const lenaContext = await browser.newContext()
    await useSession(lenaContext, lenaSession)
    const lenaPage = await lenaContext.newPage()
    await lenaPage.goto(`/jobs/${jobId}`)
    await expect(lenaPage.locator('[data-page-row]')).toHaveCount(4)
    for (const number of [1, 2, 4, 5]) await expect(lenaPage.locator(row(number))).toHaveCount(1)
    await expect(lenaPage.locator(row(3))).toHaveCount(0)
    await expect(lenaPage.getByTestId('page-filter-mine')).toHaveText('Assigned to me · 3')
    await expect(lenaPage.getByTestId('page-filter-unassigned')).toHaveText('Unassigned · 1')
    await expect(lenaPage.getByTestId(`page-filter-assigned:${ben}`)).toHaveCount(0)
    await expect(lenaPage.locator(row(1)).getByTestId('page-assignee')).toHaveText('You')

    // Next keeps to her pages: from page 2 past Ben's page 3 to her page 4, and no further.
    await openViewer(lenaPage, jobId, ids[1])
    await expect(lenaPage.getByText('Page 2')).toBeVisible()
    await lenaPage.keyboard.press('ArrowRight')
    await expect(lenaPage).toHaveURL(new RegExp(`/pages/${ids[3]}$`))
    await expect(lenaPage.getByText('Page 4')).toBeVisible()
    // Page 5 is nobody's, so Next stays; Previous then goes back past page 3 to page 2.
    await lenaPage.keyboard.press('ArrowRight')
    await lenaPage.keyboard.press('ArrowLeft')
    await expect(lenaPage).toHaveURL(new RegExp(`/pages/${ids[1]}$`))
    await lenaContext.close()

    // Ben opens Lena's page 1 from a link: it is not locked, and Next takes him on to his page 3.
    const benContext = await browser.newContext()
    await useSession(benContext, benSession)
    const benPage = await benContext.newPage()
    await openViewer(benPage, jobId, ids[0])
    await expect(benPage.getByText('Page 1')).toBeVisible()
    await benPage.keyboard.press('ArrowRight')
    await expect(benPage).toHaveURL(new RegExp(`/pages/${ids[2]}$`))
    await benContext.close()
  })
})
