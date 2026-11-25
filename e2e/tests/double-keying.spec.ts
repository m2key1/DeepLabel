import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/test'
import { backendFetch, getPageDetail, identity, jobPageIds, moveJobToGroup, seedCompletedJob, shareGroup, uniqueName } from '../helpers/api'
import { openDatasetMenu } from '../helpers/dataset'
import { seedSession, useSession } from '../helpers/session'
import { openViewer } from '../helpers/viewer'

type Line = { id: number; text: string; corrected_text: string | null; checked: boolean; check_source: string | null }

async function linesAs(jobId: string, pageId: number, headers: Record<string, string> = {}): Promise<Line[]> {
  const detail = await backendFetch(`/api/jobs/${jobId}/pages/${pageId}`, { headers }) as
    { elements: { kind: string; lines: Line[] }[] }
  // A container's own lines are not the page's text, which is what keying covers.
  return detail.elements.filter((element) => element.kind !== 'container').flatMap((element) => element.lines)
}

async function lineAs(jobId: string, pageId: number, lineId: number, headers: Record<string, string> = {}) {
  const { text, corrected_text, checked, check_source } = (await linesAs(jobId, pageId, headers))
    .find((line) => line.id === lineId)!
  return { text, corrected_text, checked, check_source }
}

async function reviewState(jobId: string, pageId: number): Promise<string | null> {
  return ((await getPageDetail(jobId, pageId)).review as { state: string | null }).state
}

async function typeLine(page: Page, lineId: number, text: string) {
  await page.locator(`[data-testid="line-row"][data-line-id="${lineId}"]`).getByTestId('line-text').click()
  await expect(page.getByTestId('line-editor')).toBeVisible()
  await page.getByTestId('line-editor').fill(text)
  await page.keyboard.press('Enter')
}

test.describe('Scenario: two people key a page blind and a Reviewer settles where they differ (#37)', () => {
  test('a Manager pairs two keyers, each types unseen by the other, agreement is checked and a mismatch resolved',
    async ({ browser, page }) => {
    const stamp = Date.now()
    const mona = `mona-${stamp}`
    const lena = `lena-${stamp}`
    const ben = `ben-${stamp}`
    const rita = `rita-${stamp}`
    const monaSession = seedSession('manager', mona)
    const lenaSession = seedSession('annotator', lena)
    const benSession = seedSession('annotator', ben)
    const ritaSession = seedSession('reviewer', rita)
    const workspace = await backendFetch('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...identity(mona, 'manager') },
      body: JSON.stringify({ name: uniqueName('Pfarre Gars') }),
    }) as { id: number }
    await shareGroup(workspace.id, [mona, lena, ben, rita])
    const name = uniqueName('Taufbuch 1891')
    const jobId = await seedCompletedJob(name, 1)
    await moveJobToGroup(jobId, workspace.id)
    const [pageId] = await jobPageIds(jobId)
    const lines = await linesAs(jobId, pageId)
    const [first, second] = lines
    const benSecond = `${second.text} Hofner`

    // Mona switches double-keying on and gives page 1 to Lena and Ben.
    await useSession(page.context(), monaSession)
    await page.goto(`/jobs/${jobId}`)
    const more = await openDatasetMenu(page, 'dataset-more')
    await more.getByTestId('assign-pages').click()
    const dialog = page.getByRole('dialog', { name: `Assign pages of "${name}"` })
    await dialog.getByRole('checkbox', { name: 'Two people key each page' }).check()
    await expect.poll(async () => (await backendFetch(`/api/jobs/${jobId}`)).double_keying).toBe(true)
    await dialog.getByRole('textbox', { name: 'Pages' }).fill('1')
    await dialog.getByRole('combobox', { name: 'Assign to' }).selectOption(lena)
    await dialog.getByRole('combobox', { name: 'Second keyer' }).selectOption(ben)
    await dialog.getByRole('button', { name: 'Assign' }).click()
    await expect.poll(async () => ((await backendFetch(`/api/jobs/${jobId}/assignments`)).people as
      { username: string; pages: number[] }[]).filter((person) => person.pages.length > 0))
      .toEqual([{ username: ben, pages: [1] }, { username: lena, pages: [1] }])

    // Lena keys the first line; the boxes and lines are not hers to change.
    const lenaContext = await browser.newContext()
    await useSession(lenaContext, lenaSession)
    const lenaPage = await lenaContext.newPage()
    await openViewer(lenaPage, jobId, pageId)
    const lenaReview = lenaPage.getByTestId('page-review')
    await expect(lenaReview).toHaveAttribute('data-state', 'none')
    await expect(lenaReview).toContainText('Yours to key')
    await expect(lenaPage.getByRole('group', { name: 'Mode' })).toHaveCount(0)
    await typeLine(lenaPage, first.id, 'Johann Mayer')
    await expect.poll(() => lineAs(jobId, pageId, first.id, identity(lena, 'annotator')))
      .toEqual({ text: first.text, corrected_text: 'Johann Mayer', checked: false, check_source: null })
    expect(await lineAs(jobId, pageId, first.id))
      .toEqual({ text: first.text, corrected_text: null, checked: false, check_source: null })
    await lenaReview.getByRole('button', { name: 'Hand in' }).click()
    await expect.poll(() => reviewState(jobId, pageId)).toBe('partly_handed_in')
    await expect(lenaReview.getByTestId('page-review-label')).toHaveText('1 of 2 handed in')
    await expect(lenaReview.getByRole('button', { name: 'Take back' })).toBeVisible()

    // Ben sees the line as it was read, not Lena's typing, keys it alike and changes the second.
    const benContext = await browser.newContext()
    await useSession(benContext, benSession)
    const benPage = await benContext.newPage()
    await openViewer(benPage, jobId, pageId)
    const benFirst = benPage.locator(`[data-testid="line-row"][data-line-id="${first.id}"]`).getByTestId('line-text')
    await expect(benFirst).toHaveText(first.text)
    await typeLine(benPage, first.id, 'Johann Mayer')
    await typeLine(benPage, second.id, benSecond)
    await expect.poll(() => lineAs(jobId, pageId, second.id, identity(ben, 'annotator')))
      .toMatchObject({ corrected_text: benSecond })
    await benPage.getByTestId('page-review').getByRole('button', { name: 'Hand in' }).click()
    await expect.poll(() => reviewState(jobId, pageId)).toBe('handed_in')
    expect(await lineAs(jobId, pageId, first.id))
      .toEqual({ text: first.text, corrected_text: 'Johann Mayer', checked: true, check_source: 'keyed' })
    expect(await lineAs(jobId, pageId, second.id))
      .toEqual({ text: second.text, corrected_text: null, checked: false, check_source: null })
    expect((await linesAs(jobId, pageId)).filter((line) => line.checked)).toHaveLength(lines.length - 1)

    // The page is the Reviewer's now: Lena can neither take her hand-in back nor type on it.
    await lenaPage.reload()
    await expect(lenaReview.getByTestId('page-review-label')).toHaveText('Handed in')
    await expect(lenaReview.getByRole('button', { name: 'Take back' })).toHaveCount(0)
    await lenaPage.locator(`[data-testid="line-row"][data-line-id="${first.id}"]`).getByTestId('line-text').click()
    await expect(lenaPage.getByTestId('line-editor')).toHaveCount(0)

    // Rita finds the one line they differ on, Ben's version offered beside Lena's, and takes his.
    const ritaContext = await browser.newContext()
    await useSession(ritaContext, ritaSession)
    const ritaPage = await ritaContext.newPage()
    await openViewer(ritaPage, jobId, pageId)
    await expect(ritaPage.getByRole('group', { name: 'Mode' })).toBeVisible()
    const ritaReview = ritaPage.getByTestId('page-review')
    await expect(ritaReview.getByTestId('page-review-unchecked')).toHaveText('1 unchecked')
    const row = ritaPage.locator(`[data-testid="line-row"][data-line-id="${second.id}"]`)
    await row.getByTestId('line-text').click()
    const offeredBen = ritaPage.locator(`[data-testid="line-candidate"][data-author="${ben}"]`)
    await expect(offeredBen.locator('[data-changed]')).toHaveText('Hofner')
    await expect(ritaPage.locator(`[data-testid="line-candidate-in-use"][data-author="${lena}"]`)).toHaveCount(1)
    await offeredBen.getByTestId('accept-candidate').click()
    await expect.poll(() => lineAs(jobId, pageId, second.id))
      .toEqual({ text: second.text, corrected_text: benSecond, checked: false, check_source: null })
    await row.getByRole('checkbox').check()
    await expect.poll(() => lineAs(jobId, pageId, second.id))
      .toEqual({ text: second.text, corrected_text: benSecond, checked: true, check_source: null })
    await ritaReview.getByRole('button', { name: 'Sign off' }).click()
    await expect.poll(() => reviewState(jobId, pageId)).toBe('signed_off')
  })
})
