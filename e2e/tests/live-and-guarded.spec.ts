import { test, expect } from '../helpers/test'
import {
  backendFetch, getJob, getPageDetail, identity, jobPageIds, listJobs, pageLines, seedCompletedJob,
  seedJobWithoutPipeline, shareJob, uniqueName, waitForJobStatus,
} from '../helpers/api'
import { LANDSCAPE, clickAt, enterEditMode, openViewer } from '../helpers/viewer'

const json = { 'Content-Type': 'application/json' }

test.describe('Scenario: a selection holds only what is still listed', () => {
  test('a selected dataset deleted elsewhere leaves the selection, and the rest still acts', async ({ page }) => {
    const keptName = uniqueName('Kept selected')
    const goneName = uniqueName('Deleted while selected')
    const kept = await seedCompletedJob(keptName, 1)
    const gone = await seedCompletedJob(goneName, 1)

    await page.goto('/')
    for (const name of [keptName, goneName]) {
      await page.getByTestId('job-card').filter({ hasText: name }).getByRole('checkbox').check()
    }
    await expect(page.getByTestId('bulk-bar')).toContainText('2 selected')

    await backendFetch(`/api/jobs/${gone}`, { method: 'DELETE' })
    expect((await listJobs()).some((j) => j.id === gone)).toBe(false)
    await expect(page.getByTestId('job-card').filter({ hasText: goneName })).toHaveCount(0)
    await expect(page.getByTestId('job-card').filter({ hasText: keptName })).toHaveCount(1)
    await expect(page.getByTestId('bulk-bar')).toContainText('1 selected')
    expect((await getJob(kept)).status).toBe('done')
  })
})

test.describe('Scenario: two people editing the same box', () => {
  test("a box changed by a colleague since it was loaded is not silently overwritten", async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Box conflict'), 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)
    // This tab hears nothing after loading, as on a dropped connection.
    await page.route('**/api/pages/*/events**', (route) => route.abort())
    await openViewer(page, jobId, pageId)
    await enterEditMode(page)
    // Inside the Paragraph box, between its lines: selects the box itself.
    await clickAt(page, [0.5, 0.42])
    await expect(page.getByTestId('selected-class')).toHaveValue('Paragraph')

    const paragraph = (await getPageDetail(jobId, pageId)).elements
      .find((e: { class_name: string }) => e.class_name === 'Paragraph')
    await backendFetch(`/api/elements/${paragraph.id}`, {
      method: 'PATCH',
      headers: { ...json, ...identity('colleague', 'admin') },
      body: JSON.stringify({ class_name: 'BigParagraph' }),
    })

    const answer = page.waitForResponse((r) => r.url().endsWith(`/api/elements/${paragraph.id}`)
                                             && r.request().method() === 'PATCH')
    await page.getByTestId('selected-class').selectOption('Header')
    expect((await answer).status()).toBe(409)
    // The colleague's change stands.
    const after = (await getPageDetail(jobId, pageId)).elements
      .find((e: { id: number }) => e.id === paragraph.id)
    expect(after.class_name).toBe('BigParagraph')
  })
})

test.describe('Scenario: a dataset page left open', () => {
  test('a run started elsewhere shows up, and so does its end', async ({ page }) => {
    test.setTimeout(150_000)
    // [slow] gives it a reader that takes fifteen seconds over each run, long enough to be seen.
    const jobId = await seedCompletedJob(uniqueName('[slow] Watched'), 1)
    await page.goto(`/jobs/${jobId}`)
    const badge = page.getByTestId('status-badge')
    await expect(badge).toHaveText('done')

    await backendFetch(`/api/jobs/${jobId}/rerun`, {
      method: 'POST', headers: json, body: JSON.stringify({ from_phase: 'ocr' }),
    })
    await expect.poll(async () => (await getJob(jobId)).status).not.toBe('done')
    await expect(badge).not.toHaveText('done', { timeout: 12_000 })

    await waitForJobStatus(jobId, 'done', 60_000)
    await expect(badge).toHaveText('done')
  })
})

test.describe('Scenario: a dataset page left open to a run that is over in a moment', () => {
  // README: a dataset page left open "notices a run started from elsewhere ... within
  // seconds, follows it, and reloads its rows when it ends". A one-page run is over in a
  // second or two, inside the five the page waits between looks - so it has to be noticed
  // by what it changed, not only by being caught in the act.
  test('a run that comes and goes between two looks still reloads the rows', async ({ page }) => {
    const jobId = await seedJobWithoutPipeline(uniqueName('Quick run'), 1)
    const [pageId] = await jobPageIds(jobId)
    // Hold the page's clock, so its look-around fires only when this test lets it.
    await page.clock.install()
    await page.goto(`/jobs/${jobId}`)
    await expect(page.locator('tbody tr')).toHaveCount(1)
    const checked = page.locator('td[data-col="checked"]')
    const confidence = page.locator('td[data-col="confidence"]')
    await expect(checked).toBeEmpty()
    await expect(confidence).toHaveText('-')

    // The whole pipeline, run on the page from elsewhere: detected, segmented and read
    // before the page looks again.
    await backendFetch(`/api/pages/${pageId}/run`, {
      method: 'POST', headers: json, body: JSON.stringify({ phase: 'layout' }),
    })
    await waitForJobStatus(jobId, 'done')
    await expect.poll(async () => {
      const lines = await pageLines(jobId, pageId)
      return lines.length === 6 && lines.every((l) => l.text !== null)
    }).toBe(true)

    // One look. The dataset is idle again, as it was - what changed is its pages.
    await page.clock.runFor(5_000)
    await expect(checked).toHaveText('0/6')
    await expect(confidence).toContainText('55%')
  })
})

test.describe('Scenario: re-reading one line is a re-read like any other', () => {
  test('someone without the OCR capability cannot queue a single line either', async () => {
    const jobId = await seedCompletedJob(uniqueName('Line re-read gate'), 1)
    await shareJob(jobId, ['bob'])
    const [pageId] = await jobPageIds(jobId)
    const [line] = await pageLines(jobId, pageId)
    // Sent straight to the backend with no capabilities at all.
    const bob = { ...json, 'X-Frontend-Secret': 'e2e-secret', 'X-Auth-User': 'bob', 'X-Auth-Role': 'member',
                  'X-Auth-Caps': '' }
    const post = (path: string, body: object) =>
      backendFetch(path, { method: 'POST', headers: bob, body: JSON.stringify(body) })

    await expect(post(`/api/jobs/${jobId}/reocr`, { scope: 'unchecked' })).rejects.toThrow(/403/)
    await expect(post(`/api/lines/${line.id}/reocr`, {})).rejects.toThrow(/403/)
    // Nothing was queued on bob's behalf.
    expect((await getJob(jobId)).status).toBe('done')
  })
})
