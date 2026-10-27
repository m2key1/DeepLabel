import { test, expect } from '../helpers/test'
import {
  backendFetch, createJob, identity, jobPageIds, llmStats, pageCandidates, patchJob,
  resetLlmStats, seedDistinctPagesJob, seedLlmConnection, shareJob, uniqueName,
  waitForJobStatus,
} from '../helpers/api'
import { scanPng } from '../helpers/image'
import { gtReads, llmReadStatus, pickModel, startLlmRead, waitForLlmReads } from '../helpers/llm'
import { seedSession, useSession } from '../helpers/session'
import { openViewer } from '../helpers/viewer'
import { datasetAction } from '../helpers/dataset'

const DEV = identity('dev', 'admin')

// 'stub-perfect' and 'stub-second' answer with the stub runner's own six lines verbatim;
// 'stub-slow' does the same after 15 seconds, which is the only way to catch a run while
// it is in flight; 'stub-echo' answers with the prompt it was given. See e2e/README.md.
const PERFECT = 'stub-perfect'
const SECOND = 'stub-second'
const SLOW = 'stub-slow'
const ECHO = 'stub-echo'

// Those six lines, in the order every page is read in.
const STUB_LINES = ['Header', 'Paragraph']
  .flatMap((cls) => [1, 2, 3].map((i) => `Sample ${cls} line ${i}`))

// What the read dialog says on the agreement settings only the dataset's owner may set.
const OWNER_ONLY = "Only the dataset's owner can change this."

// Two readings of 'stub-slow' queued one behind the other take just over 30 seconds.
const TWO_SLOW_READS_MS = 60_000

const json = (method: string, body: unknown, headers: Record<string, string> = DEV) => ({
  method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
})

function patchModel(modelId: number, body: Record<string, unknown>) {
  return backendFetch(`/api/llm/models/${modelId}`, json('PATCH', body))
}

function readPreview(jobId: string, modelIds: number[]): Promise<{
  pages: number
  calls: number
  stale_prompt: number
  models: { id: number; calls: number; reused: number; stale_prompt: number }[]
}> {
  const query = modelIds.map((id) => `model_ids=${id}`).join('&')
  return backendFetch(`/api/jobs/${jobId}/llm/preview?${query}`, { headers: DEV })
}

function postRead(jobId: string, body: Record<string, unknown>, headers: Record<string, string> = DEV) {
  return backendFetch(`/api/jobs/${jobId}/llm/read`, json('POST', body, headers))
}

async function llmCandidates(pageId: number) {
  return (await pageCandidates(pageId)).filter((c) => c.source === 'llm' && !c.dismissed)
}

/** Like waitForLlmReads, with room for readings that queue behind one another. */
async function waitForSlowReads(jobId: string, expected: number) {
  await expect.poll(async () => {
    const status = await llmReadStatus(jobId)
    return { done: status.done, active: status.active }
  }, { timeout: TWO_SLOW_READS_MS }).toEqual({ done: expected, active: false })
}

test.describe('Scenario: who may start a run', () => {
  test('an assignee can start a read from the dialog', async ({ page }) => {
    test.setTimeout(90_000)
    const connection = uniqueName('Published')
    const seeded = await seedLlmConnection(connection, [PERFECT], DEV)
    // Published by its admin owner, so the endpoint is usable by everyone - which is the
    // README's whole reason for an assignee to be reading with it at all.
    await backendFetch(`/api/llm/connections/${seeded.id}`, json('PATCH', { shared: true }))
    const member = `assignee-${Date.now()}`
    const asMember = identity(member, 'member')

    // Control: the backend lets this member read a dataset they are merely assigned to.
    const control = await seedDistinctPagesJob(uniqueName('Assignee control'), 1, 165)
    await shareJob(control, [member])
    await expect(postRead(control, { model_ids: [seeded.models[0].id] }, asMember))
      .resolves.toMatchObject({ queued: 1, reused: 0 })
    await waitForLlmReads(control, 1)

    const jobId = await seedDistinctPagesJob(uniqueName('Assignee reads'), 1, 160)
    await shareJob(jobId, [member])
    await resetLlmStats()
    await useSession(page.context(), seedSession('member', member))

    await page.goto(`/jobs/${jobId}`)
    await datasetAction(page, 'llm-read-open')
    await pickModel(page, connection, PERFECT).check()
    await page.getByTestId('llm-start').click()

    // The same request the control made, now from the dialog: one page read, run over.
    await expect.poll(async () => {
      const status = await llmReadStatus(jobId)
      return { done: status.done, active: status.active }
    }, { timeout: 20_000 }).toEqual({ done: 1, active: false })
    expect((await llmStats()).calls[PERFECT]).toBe(1)
    const [pageId] = await jobPageIds(jobId)
    expect(await llmCandidates(pageId)).toHaveLength(6)
    await expect(page.getByText('not permitted')).toHaveCount(0)
  })

  test("an assignee's dialog locks the owner's agreement settings and leaves the rest live",
    async ({ page }) => {
      test.setTimeout(90_000)
      const connection = uniqueName('Published lock')
      const seeded = await seedLlmConnection(connection, [PERFECT], DEV)
      await backendFetch(`/api/llm/connections/${seeded.id}`, json('PATCH', { shared: true }))
      const member = `assignee-${Date.now()}`
      const asMember = identity(member, 'member')
      const jobId = await seedDistinctPagesJob(uniqueName('Assignee lock'), 1, 220)
      await shareJob(jobId, [member])

      // Control: the three settings the backend refuses an assignee. The dialog's locks
      // have to fall exactly where these refusals do, and nowhere else.
      const patchAs = (body: Record<string, unknown>) =>
        backendFetch(`/api/jobs/${jobId}`, json('PATCH', body, asMember))
      await expect(patchAs({ llm_autocheck: true })).rejects.toThrow('403')
      await expect(patchAs({ llm_consensus_with_ocr: true })).rejects.toThrow('403')
      await expect(patchAs({ llm_consensus_min: 3 })).rejects.toThrow('403')

      await resetLlmStats()
      await useSession(page.context(), seedSession('member', member))
      await page.goto(`/jobs/${jobId}`)
      await datasetAction(page, 'llm-read-open')

      const autocheck = page.getByTestId('llm-autocheck')
      const withOcr = page.getByTestId('llm-consensus-with-ocr')
      await expect(autocheck).toBeDisabled()
      await expect(withOcr).toBeDisabled()
      await expect(autocheck).toHaveAttribute('title', OWNER_ONLY)
      await expect(withOcr).toHaveAttribute('title', OWNER_ONLY)
      const minAgree = page.getByTestId('llm-consensus-min')
      await expect(minAgree).toBeDisabled()
      await expect(minAgree).toHaveAttribute('title', OWNER_ONLY)

      // The models and the wording are the assignee's to use, and the run goes through.
      await pickModel(page, connection, PERFECT).check()
      const section = page.getByTestId('llm-what-they-see')
      if ((await section.getAttribute('aria-expanded')) === 'false') await section.click()
      await page.getByTestId('dataset-prompt-edit').click()
      await page.getByTestId('dataset-prompt').fill('Assignee wording.')
      await page.getByTestId('llm-start').click()

      await waitForLlmReads(jobId, 1)
      expect((await llmStats()).calls[PERFECT]).toBe(1)
      const [pageId] = await jobPageIds(jobId)
      expect(await llmCandidates(pageId)).toHaveLength(6)
      const job = await backendFetch(`/api/jobs/${jobId}`, { headers: DEV })
      expect({
        prompt: job.llm_prompt, autocheck: job.llm_autocheck, withOcr: job.llm_consensus_with_ocr,
        minAgree: job.llm_consensus_min,
      }).toEqual({ prompt: 'Assignee wording.', autocheck: false, withOcr: false, minAgree: 2 })

      // The same person on a dataset of their own: the settings are theirs to change.
      const own = await createJob(uniqueName('Assignee owns'), 1, undefined, asMember)
      await waitForJobStatus(own, 'done')
      await page.goto(`/jobs/${own}`)
      await datasetAction(page, 'llm-read-open')
      await expect(autocheck).toBeEnabled()
      await expect(withOcr).toBeEnabled()
      await expect(autocheck).not.toHaveAttribute('title', OWNER_ONLY)
      await expect(minAgree).toBeEnabled()
      await expect(minAgree).not.toHaveAttribute('title', OWNER_ONLY)
    })
})

test.describe('Scenario: what the dialog says about readings under other wording', () => {
  test('the stale-wording offer counts pages, not readings', async ({ page }) => {
    const jobId = await seedDistinctPagesJob(uniqueName('Stale pages'), 1, 170)
    const connection = uniqueName('Two readers')
    const seeded = await seedLlmConnection(connection, [PERFECT, SECOND], DEV)
    await resetLlmStats()
    await startLlmRead(page, jobId, connection, [PERFECT, SECOND])
    expect((await llmStats()).total).toBe(2)

    await patchJob(jobId, { llm_prompt: 'New wording.' })

    // One page, read twice under the old wording: two calls to take it again.
    const modelIds = seeded.models.map((m) => m.id)
    const preview = await readPreview(jobId, modelIds)
    expect({ pages: preview.pages, stale: preview.models.map((m) => m.stale_prompt) })
      .toEqual({ pages: 1, stale: [1, 1] })

    await page.goto(`/jobs/${jobId}`)
    await datasetAction(page, 'llm-read-open')
    await pickModel(page, connection, PERFECT).check()
    await pickModel(page, connection, SECOND).check()
    await expect(page.getByTestId('llm-stale-prompt'))
      .toHaveText('1 page read with a different prompt. Read again (2 calls).')
  })
})

// A corpus arrives as whole documents; the cut hands each page a span of one. These are
// corpus-reference.spec.ts's second letter and its 'adrift' setup: uploaded without
// transcribing the scans, so no line anchors and every span is what its neighbours left.
const LETTER_TWO = [
  'An den wohlehrwuerdigen Pfarrer zu Sankt Michael',
  'Die Fastenzeit hat uns heuer frueh getroffen',
  'und der Wein im Keller ist merklich geringer',
  'Ich bitte um zwei Eimer aus dem Stiftskeller',
  'sobald der Fuhrmann wieder nach Krems faehrt',
  'Der Bote wartet auf Antwort bis Donnerstag',
  'Zum zweiten melde ich den Tod des Schaffners',
  'der am Sonntag nach der Vesper verschieden ist',
]

async function seedCorpusJob(name: string, pageCount: number, variantBase: number): Promise<string> {
  const form = new FormData()
  form.append('name', name)
  form.append('line_mode', 'per_crop')
  form.append('gt_autocheck', 'true')
  for (let i = 0; i < pageCount; i++) {
    const png = scanPng(600, 800, variantBase + i + 1)
    form.append('files', new Blob([new Uint8Array(png)], { type: 'image/png' }), `scan_${i + 1}.png`)
  }
  const { job_id: jobId } = await backendFetch('/api/jobs', { method: 'POST', body: form, headers: DEV })
  await waitForJobStatus(jobId, 'done')
  return jobId
}

async function putDocuments(jobId: string, documents: Record<string, string[]>) {
  const form = new FormData()
  for (const [name, lines] of Object.entries(documents)) {
    form.append('files', new Blob([`${lines.join('\n')}\n`], { type: 'text/plain' }), `${name}.txt`)
  }
  return backendFetch(`/api/jobs/${jobId}/documents`, { method: 'POST', body: form, headers: DEV })
}

async function referenceSources(jobId: string): Promise<(string | null)[]> {
  const body = await backendFetch(`/api/jobs/${jobId}/reference`, { headers: DEV })
  return (body.pages as { gt_source: string | null }[]).map((page) => page.gt_source)
}

async function readTally(jobId: string) {
  const status = await backendFetch(`/api/jobs/${jobId}/groundtruth/status`, { headers: DEV })
  const { done, pending, running, error } = status
  return { done, pending, running, error }
}

/** Each diplomatic reading's status, and the lines of the answer it still holds. */
function gtAnswers(jobId: string) {
  return gtReads(jobId).map((read) => ({
    page_id: read.page_id,
    status: read.status,
    lines: read.raw_text === null ? null : (JSON.parse(read.raw_text) as string[]),
  }))
}

test.describe('Scenario: cancelling a re-read that already has an answer', () => {
  test('cancelling a diplomatic re-read keeps the answer on file', async ({ page }) => {
    test.setTimeout(180_000)
    const jobId = await seedCorpusJob(uniqueName('Corpus re-read'), 2, 180)
    await putDocuments(jobId, { 'tagebuch-eintrag': LETTER_TWO })
    const connection = uniqueName('Slow diplomat')
    const seeded = await seedLlmConnection(connection, [SLOW], DEV)
    // One page in flight at a time, so the second waits as pending.
    await patchModel(seeded.models[0].id, { max_concurrency: 1 })
    await resetLlmStats()

    await page.goto(`/jobs/${jobId}/corpus`)
    await page.getByTestId('reference-cut').click()
    await expect(page.getByTestId('cut-note'))
      .toHaveText('Placed 2 of 2 pages from 1 document. 2 anchored nothing of their own.')

    const pick = page.locator(`[data-testid="gt-pick"][data-label="${connection} ${SLOW}"]`)
      .getByRole('checkbox')
    await pick.check()
    await expect(page.getByTestId('gt-cost')).toHaveText('2 calls over 2 placed pages.')
    await page.getByTestId('gt-start').click()
    await expect(page.getByTestId('gt-note')).toHaveText('2 readings queued over 2 pages.')

    await expect.poll(() => readTally(jobId), { timeout: TWO_SLOW_READS_MS })
      .toEqual({ done: 2, pending: 0, running: 0, error: 0 })
    expect((await llmStats()).calls[SLOW]).toBe(2)
    // The last answer queues the dataset for alignment; it is seen out so the one job
    // worker is idle again, and so that the pages' ground truth is what the run gave them.
    await waitForJobStatus(jobId, 'done', 60_000)
    expect(await referenceSources(jobId)).toEqual(['llm', 'llm'])

    await page.goto(`/jobs/${jobId}/corpus`)
    await pick.check()
    await expect(page.getByTestId('gt-cost'))
      .toHaveText('0 calls over 2 placed pages, 2 already read and free.')

    // Asked again under the same wording, then thought better of before the second page
    // was sent.
    await page.getByTestId('gt-refresh').check()
    await page.getByTestId('gt-start').click()
    await expect(page.getByTestId('gt-note')).toHaveText('2 readings queued over 2 pages.')
    await expect.poll(async () => {
      const tally = await readTally(jobId)
      return { running: tally.running, pending: tally.pending }
    }).toEqual({ running: 1, pending: 1 })

    await page.getByTestId('gt-cancel').click()
    await expect(page.getByTestId('gt-note'))
      .toHaveText('1 reading dropped. Anything already in flight is paid for and is left to finish.')
    await expect.poll(async () => {
      const tally = await readTally(jobId)
      return tally.running + tally.pending
    }, { timeout: TWO_SLOW_READS_MS }).toBe(0)

    // The page whose re-read was dropped still has the answer it was read with before: the
    // run is complete, and asking again costs nothing.
    expect(await readTally(jobId)).toEqual({ done: 2, pending: 0, running: 0, error: 0 })
    expect(await referenceSources(jobId)).toEqual(['llm', 'llm'])
    expect((await llmStats()).calls[SLOW]).toBe(3)

    await waitForJobStatus(jobId, 'done', 60_000)
    await page.goto(`/jobs/${jobId}/corpus`)
    await pick.check()
    await expect(page.getByTestId('gt-cost'))
      .toHaveText('0 calls over 2 placed pages, 2 already read and free.')
  })

  test('cancelling a line re-read falls back to the answer on file', async () => {
    test.setTimeout(180_000)
    const connection = uniqueName('Slow reader')
    const seeded = await seedLlmConnection(connection, [SLOW], DEV)
    const model = seeded.models[0]
    await patchModel(model.id, { max_concurrency: 1 })
    const jobId = await seedDistinctPagesJob(uniqueName('Line re-read'), 2, 190)
    await resetLlmStats()

    await postRead(jobId, { model_ids: [model.id] })
    await waitForSlowReads(jobId, 2)
    expect((await llmStats()).calls[SLOW]).toBe(2)

    // New wording makes both readings stale; asking for them again queues both, one
    // behind the other.
    await patchJob(jobId, { llm_prompt: 'Different wording.' })
    expect((await readPreview(jobId, [model.id])).stale_prompt).toBe(2)
    await postRead(jobId, { model_ids: [model.id], refresh: true })
    await expect.poll(async () => {
      const status = await llmReadStatus(jobId)
      return { running: status.running, pending: status.pending }
    }).toEqual({ running: 1, pending: 1 })

    const answer = await backendFetch(`/api/jobs/${jobId}/llm/cancel`, { method: 'POST', headers: DEV })
    expect(answer).toEqual({ cancelled: 1 })
    await expect.poll(async () => {
      const status = await llmReadStatus(jobId)
      return { done: status.done, pending: status.pending, active: status.active }
    }, { timeout: TWO_SLOW_READS_MS }).toEqual({ done: 2, pending: 0, active: false })

    // One page was re-read and paid for; the other went back to what it had, which still
    // counts as read - and still as read under the old wording.
    expect((await llmStats()).calls[SLOW]).toBe(3)
    const preview = await readPreview(jobId, [model.id])
    expect(preview).toMatchObject({ calls: 0, stale_prompt: 1 })
    expect(preview.models[0].reused).toBe(2)
    const [, second] = await jobPageIds(jobId)
    expect(await llmCandidates(second)).toHaveLength(6)
  })
})

test.describe('Scenario: a re-read that fails', () => {
  test('a failed diplomatic re-read keeps the answer on file', async ({ page }) => {
    test.setTimeout(120_000)
    const jobId = await seedCorpusJob(uniqueName('Corpus failed re-read'), 2, 230)
    await putDocuments(jobId, { 'tagebuch-eintrag': LETTER_TWO })
    const connection = uniqueName('Diplomat gone wrong')
    const seeded = await seedLlmConnection(connection, [PERFECT], DEV)
    await resetLlmStats()

    await page.goto(`/jobs/${jobId}/corpus`)
    await page.getByTestId('reference-cut').click()
    await expect(page.getByTestId('cut-note'))
      .toHaveText('Placed 2 of 2 pages from 1 document. 2 anchored nothing of their own.')
    const pick = page.locator(`[data-testid="gt-pick"][data-label="${connection} ${PERFECT}"]`)
      .getByRole('checkbox')
    await pick.check()
    await page.getByTestId('gt-start').click()
    await expect(page.getByTestId('gt-note')).toHaveText('2 readings queued over 2 pages.')
    await expect.poll(() => readTally(jobId), { timeout: 30_000 })
      .toEqual({ done: 2, pending: 0, running: 0, error: 0 })
    await waitForJobStatus(jobId, 'done', 60_000)
    expect(await referenceSources(jobId)).toEqual(['llm', 'llm'])
    const [first, second] = await jobPageIds(jobId)
    expect(gtAnswers(jobId)).toEqual([
      { page_id: first, status: 'done', lines: STUB_LINES },
      { page_id: second, status: 'done', lines: STUB_LINES },
    ])

    // The same model asked again, now failing: under this id the stub answers 500.
    await patchModel(seeded.models[0].id, { model: 'stub-error' })
    await page.goto(`/jobs/${jobId}/corpus`)
    await pick.check()
    await expect(page.getByTestId('gt-cost'))
      .toHaveText('0 calls over 2 placed pages, 2 already read and free.')
    await page.getByTestId('gt-refresh').check()
    await page.getByTestId('gt-start').click()
    await expect(page.getByTestId('gt-note')).toHaveText('2 readings queued over 2 pages.')
    await expect.poll(() => readTally(jobId), { timeout: 30_000 })
      .toEqual({ done: 0, pending: 0, running: 0, error: 2 })
    expect((await llmStats()).calls).toEqual({ [PERFECT]: 2, 'stub-error': 2 })

    // Said the way the viewer says a failed line reading: counted, and each one named
    // with its reason.
    await expect(page.getByTestId('gt-status'))
      .toHaveText('0 done · 0 pending · 0 running · 2 failed, over 2 placed pages.')
    const failures = page.getByTestId('gt-failure')
    await expect(failures).toHaveCount(2)
    const reason = 'the provider had a temporary failure (500) - try again later: {"error": {"message": "the model is overloaded"}}'
    await expect(failures.nth(0)).toHaveText(`page ${first} · ${connection} ${PERFECT}: ${reason}`)
    await expect(failures.nth(1)).toHaveText(`page ${second} · ${connection} ${PERFECT}: ${reason}`)

    // Nothing came back, so nothing replaces what the pages were read with before: the
    // ground truth stands, and so does the answer it was taken from - as a failed line
    // re-read keeps the answer it was meant to replace.
    await waitForJobStatus(jobId, 'done', 60_000)
    expect(await referenceSources(jobId)).toEqual(['llm', 'llm'])
    expect(gtAnswers(jobId)).toEqual([
      { page_id: first, status: 'error', lines: STUB_LINES },
      { page_id: second, status: 'error', lines: STUB_LINES },
    ])
  })
})

test.describe('Scenario: watching a run with a slow model in it', () => {
  test('readings land one at a time and the pill names only the model still out',
    async ({ page }) => {
      test.setTimeout(90_000)
      const jobId = await seedDistinctPagesJob(uniqueName('Mixed pace'), 1, 200)
      const connection = uniqueName('Mixed pair')
      await seedLlmConnection(connection, [SLOW, PERFECT], DEV)
      await resetLlmStats()

      await page.goto(`/jobs/${jobId}`)
      await datasetAction(page, 'llm-read-open')
      await pickModel(page, connection, SLOW).check()
      await pickModel(page, connection, PERFECT).check()
      await page.getByTestId('llm-start').click()

      // The quick model's answer is banked while the slow one is still out.
      await expect.poll(async () => {
        const status = await llmReadStatus(jobId)
        return { done: status.done, running: status.running, active: status.active }
      }, { timeout: 10_000 }).toEqual({ done: 1, running: 1, active: true })
      const [pageId] = await jobPageIds(jobId)
      const landed = await llmCandidates(pageId)
      expect(landed).toHaveLength(6)
      expect(landed.map((c) => c.author)).toEqual(Array(6).fill(`llm:${connection} ${PERFECT}`))

      await openViewer(page, jobId, pageId)
      // The pill carries its dismiss button, so the label is matched by content: the model
      // still out is named, the one that has landed is not.
      const pill = page.getByTestId('llm-run-pill')
      await expect(pill).toContainText(`Reading with ${connection} ${SLOW}…`)
      await expect(pill).not.toContainText(PERFECT)

      await waitForLlmReads(jobId, 2)
      await expect(pill).toHaveCount(0)
      expect(await llmCandidates(pageId)).toHaveLength(12)
      expect((await llmStats()).total).toBe(2)
    })
})

test.describe('Scenario: stopping a page being read', () => {
  test("the chip's x drops the reading in flight, and its answer never lands", async ({ page }) => {
    test.setTimeout(90_000)
    const jobId = await seedDistinctPagesJob(uniqueName('Stopped read'), 1, 230)
    const connection = uniqueName('Slow alone')
    await seedLlmConnection(connection, [SLOW], DEV)
    await resetLlmStats()

    await page.goto(`/jobs/${jobId}`)
    await datasetAction(page, 'llm-read-open')
    await pickModel(page, connection, SLOW).check()
    await page.getByTestId('llm-start').click()
    const sent = Date.now()
    await expect.poll(async () => (await llmReadStatus(jobId)).running, { timeout: 10_000 }).toBe(1)

    const [pageId] = await jobPageIds(jobId)
    await openViewer(page, jobId, pageId)
    const pill = page.getByTestId('llm-run-pill')
    await expect(pill).toContainText(`Reading with ${connection} ${SLOW}…`)
    await pill.getByTestId('llm-run-pill-dismiss').click()

    await expect(pill).toHaveCount(0)
    await expect.poll(async () => {
      const status = await llmReadStatus(jobId)
      return { active: status.active, running: status.running, done: status.done }
    }).toEqual({ active: false, running: 0, done: 0 })
    // The slow stub answers after SLOW_SECONDS (15 s); past that, its answer has landed and
    // been thrown away rather than put on the page.
    expect((await llmStats()).total).toBe(1)
    await page.waitForTimeout(Math.max(0, sent + 20_000 - Date.now()))
    expect(await llmCandidates(pageId)).toEqual([])
    expect((await llmReadStatus(jobId)).done).toBe(0)
    await page.reload()
    await expect(page.getByTestId('line-row').first()).toBeVisible()
    await expect(pill).toHaveCount(0)
  })
})

test.describe('Scenario: giving a dataset wording when the picked models disagree', () => {
  test.afterEach(async () => {
    // The personal default is the signed-in person's, and every spec signs in as them.
    await backendFetch('/api/llm/prompt', json('PUT', { prompt: '' }))
    await expect.poll(async () => (await backendFetch('/api/llm/prompt', { headers: DEV })).prompt)
      .toBe('')
  })

  test('picked models in different wordings seed the editor from your default and say it replaces them all',
    async ({ page }) => {
      const own = uniqueName('Echo own words')
      const seededOwn = await seedLlmConnection(own, [ECHO], DEV)
      await patchModel(seededOwn.models[0].id, { prompt: 'Model rules.' })
      const usual = uniqueName('Echo usual')
      await seedLlmConnection(usual, [ECHO], DEV)
      await backendFetch('/api/llm/prompt', json('PUT', { prompt: 'My usual rules.' }))
      const jobId = await seedDistinctPagesJob(uniqueName('Divergent wording'), 1, 210)
      await resetLlmStats()

      await page.goto(`/jobs/${jobId}`)
      await datasetAction(page, 'llm-read-open')
      await pickModel(page, own, ECHO).check()
      await pickModel(page, usual, ECHO).check()

      // One model has words of its own, the other follows the personal default: no single
      // wording is "used anyway", so the editor starts from the default and says so.
      const section = page.getByTestId('llm-what-they-see')
      if ((await section.getAttribute('aria-expanded')) === 'false') await section.click()
      await page.getByTestId('dataset-prompt-edit').click()
      await expect(page.getByTestId('dataset-prompt')).toHaveValue('My usual rules.')
      await expect(page.getByTestId('dataset-prompt-divergent')).toHaveText(
        'The picked models are asked in 2 different wordings. This starts from your usual one, '
        + 'and whatever is saved here replaces all of them.')

      await page.getByTestId('dataset-prompt').fill('Dataset rules.')
      await page.getByTestId('llm-start').click()

      // Both models were asked with the dataset's wording - the echo is what reached them.
      const [pageId] = await jobPageIds(jobId)
      await expect.poll(async () => (await llmCandidates(pageId)).map((c) => c.text),
                        { timeout: 30_000 }).toEqual(['Dataset rules.', 'Dataset rules.'])
      const job = await backendFetch(`/api/jobs/${jobId}`, { headers: DEV })
      expect(job.llm_prompt).toBe('Dataset rules.')
    })
})
