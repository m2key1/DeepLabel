import { test, expect } from '../helpers/test'
import {
  backendFetch, getPageDetail, identity, jobPageIds, moveJobToGroup, seedCompletedJob, setElementChecked, shareGroup,
  uniqueName,
} from '../helpers/api'
import { seedSession, useSession } from '../helpers/session'
import { pickDataset, taskSection } from '../helpers/training'
import { openViewer } from '../helpers/viewer'

type Review = { state: string | null; by: string | null; note: string | null }

async function reviewOf(jobId: string, pageId: number): Promise<Review> {
  const { state, by, note } = (await getPageDetail(jobId, pageId)).review as Review
  return { state, by, note }
}

async function checkEveryLine(jobId: string, pageId: number) {
  for (const element of (await getPageDetail(jobId, pageId)).elements as { id: number }[]) {
    await setElementChecked(element.id)
  }
}

test.describe('Scenario: an assignee hands a page in and a Reviewer signs it off (#36)', () => {
  test('a page is handed in, sent back with a note, handed in again, signed off, and an edit takes the sign-off back',
    async ({ browser, page }) => {
    const stamp = Date.now()
    const mona = `mona-${stamp}`
    const lena = `lena-${stamp}`
    const rita = `rita-${stamp}`
    const monaSession = seedSession('manager', mona)
    const lenaSession = seedSession('annotator', lena)
    const ritaSession = seedSession('reviewer', rita)
    const workspace = await backendFetch('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...identity(mona, 'manager') },
      body: JSON.stringify({ name: uniqueName('Pfarre Gars') }),
    }) as { id: number }
    await shareGroup(workspace.id, [mona, lena, rita])
    const name = uniqueName('Taufbuch 1891')
    const jobId = await seedCompletedJob(name, 2)
    await moveJobToGroup(jobId, workspace.id)
    const ids = await jobPageIds(jobId)
    await backendFetch(`/api/jobs/${jobId}/assignments`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...identity(mona, 'manager') },
      body: JSON.stringify({ assignee: lena, page_ids: [ids[0]] }),
    })

    // Lena hands her page in; she cannot sign it off herself.
    const lenaContext = await browser.newContext()
    await useSession(lenaContext, lenaSession)
    const lenaPage = await lenaContext.newPage()
    await openViewer(lenaPage, jobId, ids[0])
    const lenaReview = lenaPage.getByTestId('page-review')
    await expect(lenaReview).toHaveAttribute('data-state', 'none')
    await lenaReview.getByRole('button', { name: 'Hand in' }).click()
    await expect.poll(() => reviewOf(jobId, ids[0])).toEqual({ state: 'handed_in', by: lena, note: null })
    await expect(lenaReview.getByTestId('page-review-label')).toHaveText('Handed in')
    await expect(lenaReview.getByRole('button', { name: 'Take back' })).toBeVisible()
    await expect(lenaReview.getByRole('button', { name: 'Sign off' })).toHaveCount(0)

    // Rita's sign-off waits for the six lines nobody checked yet, so she sends the page back.
    const ritaContext = await browser.newContext()
    await useSession(ritaContext, ritaSession)
    const ritaPage = await ritaContext.newPage()
    await openViewer(ritaPage, jobId, ids[0])
    const ritaReview = ritaPage.getByTestId('page-review')
    await expect(ritaReview.getByTestId('page-review-label')).toHaveText('Handed in')
    await expect(ritaReview.getByTestId('page-review-unchecked')).toHaveText('6 unchecked')
    await ritaReview.getByRole('button', { name: 'Sign off' }).click()
    await expect(ritaPage.getByRole('alert')).toHaveText('6 lines on this page are not checked yet')
    expect((await reviewOf(jobId, ids[0])).state).toBe('handed_in')
    await ritaReview.getByRole('button', { name: 'Send back…' }).click()
    const dialog = ritaPage.getByRole('dialog', { name: 'Send the page back' })
    await dialog.getByRole('textbox', { name: 'What is to be done' }).fill('Die Namen in Zeile 2 fehlen')
    await dialog.getByRole('button', { name: 'Send back' }).click()
    await expect.poll(() => reviewOf(jobId, ids[0]))
      .toEqual({ state: 'sent_back', by: rita, note: 'Die Namen in Zeile 2 fehlen' })
    await expect(ritaReview.getByTestId('page-review-label')).toHaveText('Sent back')

    // Lena reads the note and hands the page in again.
    await lenaPage.reload()
    await expect(lenaReview.getByTestId('page-review-note')).toHaveText('Die Namen in Zeile 2 fehlen')
    await lenaReview.getByRole('button', { name: 'Hand in' }).click()
    await expect.poll(() => reviewOf(jobId, ids[0])).toEqual({ state: 'handed_in', by: lena, note: null })
    await expect(lenaReview.getByTestId('page-review-note')).toHaveCount(0)

    // With every line checked Rita signs it off.
    await checkEveryLine(jobId, ids[0])
    await ritaPage.reload()
    await expect(ritaReview.getByTestId('page-review-label')).toHaveText('Handed in')
    await expect(ritaReview.getByTestId('page-review-unchecked')).toHaveCount(0)
    await ritaReview.getByRole('button', { name: 'Sign off' }).click()
    await expect.poll(() => reviewOf(jobId, ids[0])).toEqual({ state: 'signed_off', by: rita, note: null })
    await expect(ritaReview.getByTestId('page-review-label')).toHaveText('Signed off')
    await ritaContext.close()

    // The page table says where each page stands, and counts them.
    const monaContext = await browser.newContext()
    await useSession(monaContext, monaSession)
    const monaPage = await monaContext.newPage()
    await monaPage.goto(`/jobs/${jobId}`)
    const row = (pageId: number) => monaPage.locator(`[data-page-row="${pageId}"]`)
    await expect(monaPage.getByRole('columnheader', { name: 'Review' })).toBeVisible()
    await expect(row(ids[0]).getByTestId('page-review')).toHaveText('Signed off')
    await expect(row(ids[1]).getByTestId('page-review')).toHaveCount(0)
    await expect(monaPage.getByTestId('page-filter-signed-off')).toHaveText('Signed off · 1')
    await monaContext.close()

    // A run may train on the signed-off page alone: its 6 lines of the dataset's 12 checked.
    await checkEveryLine(jobId, ids[1])
    await page.goto('/models')
    await taskSection(page, 'ocr').getByTestId('train-model').click()
    await pickDataset(page, name)
    await expect(page.getByText('12 checked lines selected')).toBeVisible()
    await expect(page.getByTestId('signed-off-count')).toHaveText('6 of 12 checked lines are on signed-off pages.')
    await page.getByTestId('signed-off-only').check()
    await expect(page.getByText('6 checked lines selected')).toBeVisible()

    // Lena's correction takes the line's check off, and with it the sign-off.
    await lenaPage.reload()
    await expect(lenaReview.getByTestId('page-review-label')).toHaveText('Signed off')
    await lenaPage.getByTestId('line-row').first().getByTestId('line-text').click()
    await lenaPage.getByTestId('line-editor').fill('Johann Maier, Bauer')
    await lenaPage.keyboard.press('Enter')
    await expect.poll(() => reviewOf(jobId, ids[0])).toEqual({ state: 'handed_in', by: lena, note: null })
    await expect(lenaReview.getByTestId('page-review-label')).toHaveText('Handed in')
    await lenaContext.close()
  })
})
