import { test, expect } from '../helpers/test'
import {
  OCR_AUTHOR, backendFetch, createJob, datasetInfo, deleteElement, getJob, getPageDetail,
  getReocrPreview, greedyLines, identity, jobPageIds, listRegistryModels, markLinesChecked,
  moveJobToGroup, pageDeletedFlags, pageLines, patchJob, seedCompletedJob, setPagesDeleted,
  shareJob, uniqueName, waitForJobStatus,
} from '../helpers/api'
import type { DatasetInfo } from '../helpers/api'
import { scanPng } from '../helpers/image'
import { textPdf } from '../helpers/pdf'
import { openViewer } from '../helpers/viewer'
import { asSession, seedSession, useSession } from '../helpers/session'

/** What a page layout found nothing on looks like: no content box, and with it no lines.
 *  Reached by deleting the boxes the stub drew, which takes their lines with them. */
async function stripTheLayoutFrom(jobId: string, pageId: number) {
  const detail = await getPageDetail(jobId, pageId)
  for (const element of detail.elements) await deleteElement(element.id)
  expect(await pageLines(jobId, pageId)).toHaveLength(0)
}

async function selectEveryRow(page: import('@playwright/test').Page, rows: number) {
  await expect(page.locator('tbody tr')).toHaveCount(rows)
  await page.locator('thead input[type="checkbox"]').check()
  await expect(page.getByText(`${rows} selected`)).toBeVisible()
}

test.describe('Scenario: a page that was deleted', () => {
  // README: "Deleting pages reads as permanent: the rows leave the table, every filter and
  // the page-to-page navigation."
  test('a deleted page leaves the page-to-page navigation and every chip count', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Deleted page'), 3)
    const ids = await jobPageIds(jobId)
    await setPagesDeleted(jobId, [ids[1]])
    await expect.poll(() => pageDeletedFlags(jobId)).toEqual([false, true, false])

    // The arrow keys step over the deleted page, in both directions. The crumb numbers the
    // page by its place in the upload, so the third page is still "Page 3".
    await openViewer(page, jobId, ids[0])
    await expect(page.getByText('Page 1', { exact: true })).toBeVisible()
    await page.keyboard.press('ArrowRight')
    await expect(page).toHaveURL(new RegExp(`/pages/${ids[2]}$`))
    // The URL changes ahead of React, and a stale handler would refuse the way back.
    await expect(page.getByText('Page 3', { exact: true })).toBeVisible()
    await page.keyboard.press('ArrowLeft')
    await expect(page).toHaveURL(new RegExp(`/pages/${ids[0]}$`))
    await expect(page.getByText('Page 1', { exact: true })).toBeVisible()

    // Every chip counts the two live pages: a count of three anywhere would mean one of
    // the filters forgot to look at the deleted flag.
    await page.goto(`/jobs/${jobId}`)
    await expect(page.getByTestId('page-filter-all')).toHaveText('All · 2')
    await expect(page.getByTestId('page-filter-unreviewed-lines')).toHaveText('Unreviewed lines · 2')
    await expect(page.getByTestId('page-filter-layout-unchecked')).toHaveText('Layout unchecked · 2')
    await expect(page.locator(`[data-page-row="${ids[2]}"]`)).toHaveCount(1)
    await expect(page.locator(`[data-page-row="${ids[1]}"]`)).toHaveCount(0)
  })
})

test.describe('Scenario: a run over a selection where a page has nothing to do', () => {
  // README: "A page the phase has nothing to do on - every line already checked, or no lines
  // at all - is reported rather than failing the batch."
  test('a page with no lines is named and left alone, and the rest is re-read', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Partly empty'), 2)
    const [first, second] = await jobPageIds(jobId)
    await stripTheLayoutFrom(jobId, first)
    await patchJob(jobId, { ocr_decode: 'greedy' })
    expect(await greedyLines(jobId)).toBe(0)

    await page.goto(`/jobs/${jobId}`)
    await selectEveryRow(page, 2)
    await page.getByTestId('bulk-run-ocr').click()
    // The notice is the route's own answer: one page staged, one skipped with its reason.
    await expect(page.getByTestId('job-notice')).toHaveText(
      'A re-read queued for 1 page. 1 left alone: there are no lines on this page')

    // Polled on the provenance rather than the status: the dataset was already "done" when
    // the re-read was queued, so that status alone cannot say the worker has been through.
    await expect.poll(() => greedyLines(jobId), { timeout: 30_000 }).toBe(6)
    await waitForJobStatus(jobId, 'done', 60_000)
    // The six live lines of the dataset are the second page's, and every one was re-read.
    expect((await getReocrPreview(jobId)).authors)
      .toEqual([{ author: `${OCR_AUTHOR}#greedy`, lines: 6 }])
    expect(await pageLines(jobId, second)).toHaveLength(6)
    // The page with nothing to do was left exactly as it was: no boxes, no lines.
    expect((await getPageDetail(jobId, first)).elements).toHaveLength(0)
    expect(await pageLines(jobId, first)).toHaveLength(0)
  })

  test('a page whose every line is checked is named and left alone, and the rest is re-read',
    async ({ page }) => {
      const jobId = await seedCompletedJob(uniqueName('Half checked'), 2)
      const [first, second] = await jobPageIds(jobId)
      // Six is exactly the first page: three lines under each of its two boxes.
      expect(await markLinesChecked(jobId, 6)).toBe(6)
      expect((await pageLines(jobId, first)).map((l) => l.checked)).toEqual(Array(6).fill(true))
      expect((await pageLines(jobId, second)).map((l) => l.checked)).toEqual(Array(6).fill(false))
      await patchJob(jobId, { ocr_decode: 'greedy' })

      await page.goto(`/jobs/${jobId}`)
      await selectEveryRow(page, 2)
      await page.getByTestId('bulk-run-ocr').click()
      await expect(page.getByTestId('job-notice')).toHaveText(
        'A re-read queued for 1 page. 1 left alone: every line on this page is already checked')

      await expect.poll(() => greedyLines(jobId), { timeout: 30_000 }).toBe(6)
      await waitForJobStatus(jobId, 'done', 60_000)
      // Six lines read again, six kept under the first run's name - and the kept six are
      // the checked ones, still checked.
      const authors = (await getReocrPreview(jobId)).authors
      expect(Object.fromEntries(authors.map((a) => [a.author, a.lines])))
        .toEqual({ [OCR_AUTHOR]: 6, [`${OCR_AUTHOR}#greedy`]: 6 })
      expect((await pageLines(jobId, first)).map((l) => l.checked)).toEqual(Array(6).fill(true))
    })
})

test.describe('Scenario: looking through a volume from its page table', () => {
  // README: "The preview is not a hover any more - it opens on the first page with its
  // layout drawn, stays on what you left it on, and the arrow keys walk it down the list"
  test('the preview opens on the first page with its layout drawn, stays where it was left, and the arrow keys walk it',
    async ({ page }) => {
      const jobId = await seedCompletedJob(uniqueName('Previewed'), 3)
      const ids = await jobPageIds(jobId)
      const boxes = (await getPageDetail(jobId, ids[0])).elements
        .filter((e: { kind: string }) => e.kind === 'content')
      expect(boxes).toHaveLength(2)

      await page.goto(`/jobs/${jobId}`)
      await expect(page.locator('tbody tr')).toHaveCount(3)
      const preview = page.locator('aside img')
      const screenOf = (id: number) => `/api/pages/${id}/rendition?kind=screen`
      await expect(preview).toHaveAttribute('src', screenOf(ids[0]))
      // One rectangle per content box the backend holds for that page.
      await expect(page.locator('aside svg rect')).toHaveCount(2)

      // Hovering a row previews it - after a short delay, which the retrying expect absorbs.
      await page.locator(`[data-page-row="${ids[2]}"]`).hover()
      await expect(preview).toHaveAttribute('src', screenOf(ids[2]))
      // Leaving the table empties nothing: give a hover-driven pane longer than its own
      // delay to clear, and check it did not.
      await page.mouse.move(5, 5)
      await page.waitForTimeout(300)
      await expect(preview).toHaveAttribute('src', screenOf(ids[2]))

      await page.keyboard.press('ArrowUp')
      await expect(preview).toHaveAttribute('src', screenOf(ids[1]))
      await page.keyboard.press('ArrowDown')
      await expect(preview).toHaveAttribute('src', screenOf(ids[2]))
      // Past the last row the preview stays on it rather than wrapping or going blank. React
      // renders after the keydown returns, so a wrap to the first row would only show a beat
      // later - the pause gives it that beat before the row is checked.
      await page.keyboard.press('ArrowDown')
      await page.waitForTimeout(200)
      await expect(preview).toHaveAttribute('src', screenOf(ids[2]))
    })
})

test.describe('Scenario: what the Info panel says a dataset is made of', () => {
  // README: "Every dataset card carries an Info panel: ... how many pages came from documents
  // and how many were loose images, ... the models pinned to it"
  test('the Info panel counts documents against loose images and names the pinned model',
    async ({ page }) => {
      const name = uniqueName('Mixed sources')
      // A two-page document beside one loose scan, with no phase to run: three pages, of
      // which two came out of one document and one did not.
      const form = new FormData()
      form.append('name', name)
      form.append('line_mode', 'per_crop')
      for (const phase of ['run_layout', 'run_lines', 'run_ocr']) form.append(phase, 'false')
      form.append('files', new Blob([new Uint8Array(textPdf([['a'], ['b']]))],
                                    { type: 'application/pdf' }), 'letter.pdf')
      form.append('files', new Blob([new Uint8Array(scanPng())], { type: 'image/png' }), 'loose.png')
      const { job_id: jobId } = await backendFetch('/api/jobs', { method: 'POST', body: form })
      await waitForJobStatus(jobId, 'done')

      const builtinOcr = (await listRegistryModels())
        .find((m) => m.task === 'ocr' && m.source === 'backend')!
      await patchJob(jobId, { model_ocr_id: builtinOcr.id })

      // Backend oracle for what the panel is about to show.
      const info = await datasetInfo(jobId) as DatasetInfo & { models: Record<string, string | null> }
      expect({ pages: info.pages, documents: info.documents, images: info.images, models: info.models })
        .toEqual({ pages: 3, documents: 1, images: 1, models: { layout: null, lines: null, ocr: builtinOcr.name } })

      await page.goto('/')
      const card = page.getByTestId('job-card').filter({ hasText: name })
      await card.getByTestId('job-info-toggle').click()
      const panel = card.getByTestId('job-info')
      // The value cell alone, so the label cannot pad a wrong number into a match.
      const value = (key: string) => panel.locator(`[data-field="${key}"] dd`)
      await expect(value('pages')).toHaveText('3 pages')
      await expect(value('sources')).toHaveText('1 document · 1 image')
      // Only the pinned task is named; the two left on the task default are not listed.
      await expect(value('models')).toHaveText(`ocr: ${builtinOcr.name}`)
    })
})

test.describe('Scenario: one change applied to a group holding a dataset that is not yours', () => {
  // README: "a group is refused for the same reasons, in the same words, one dataset at a
  // time. A dataset that is already queued, or that a selection cannot move because it is
  // not yours, is named with its reason and left alone rather than failing the rest."
  test('group settings name the dataset that refused and still change the rest', async ({ browser }) => {
    const username = `grouper-${Date.now()}`
    const session = seedSession('member', username)
    // The group is the member's own, made the way they would make it: through the front
    // door with their session, since the seeding admin's groups would not be theirs to manage.
    const groupName = uniqueName('Member project')
    const created = await asSession(session, '/api/groups', {
      method: 'POST', body: JSON.stringify({ name: groupName }),
    })
    expect(created.status).toBe(200)
    const group = (await created.json()) as { id: number }

    const ownName = uniqueName('Mine to set')
    const own = await createJob(ownName, 1, undefined, identity(username, 'member'))
    const theirsName = uniqueName('Only shared with me')
    const theirs = await seedCompletedJob(theirsName, 1)
    await shareJob(theirs, [username])
    await moveJobToGroup(own, group.id)
    await moveJobToGroup(theirs, group.id)
    await waitForJobStatus(own, 'done')
    expect([(await getJob(own)).ocr_decode, (await getJob(theirs)).ocr_decode]).toEqual(['beam', 'beam'])

    const context = await browser.newContext()
    await useSession(context, session)
    const page = await context.newPage()
    await page.goto('/')
    const section = page.locator('section').filter({ hasText: groupName })
    await expect(section.getByTestId('job-card')).toHaveCount(2)
    await section.getByTestId('group-settings').click()
    await page.getByTestId('group-pick-decode').selectOption('greedy')
    // Both datasets are reachable, so both are counted - the refusal comes from the
    // setting, not from the list.
    const save = page.getByTestId('group-settings-save')
    await expect(save).toHaveText('Apply to 2 datasets')
    await save.click()

    await expect(page.getByTestId('group-settings-changed')).toHaveText('1 dataset changed.')
    const skipped = page.getByTestId('group-settings-skip')
    await expect(skipped).toHaveCount(1)
    // The same words a single dataset's PATCH would have refused with.
    await expect(skipped).toHaveText(`${theirsName} - not permitted`)
    await expect(skipped).toHaveAttribute('data-job', theirs)

    // Backend oracle: the member's own dataset changed, the one merely shared with them
    // did not.
    await expect.poll(async () => (await getJob(own)).ocr_decode).toBe('greedy')
    expect((await getJob(theirs)).ocr_decode).toBe('beam')
    await context.close()
  })
})
