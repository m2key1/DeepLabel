import { test, expect } from '../helpers/test'
import {
  backendFetch, identity, jobPageIds, pageCandidates, resetLlmStats, seedDistinctPagesJob,
  seedLlmConnection, uniqueName,
} from '../helpers/api'
import { pickModel } from '../helpers/llm'
import { datasetAction } from '../helpers/dataset'

const DEV = identity('dev', 'admin')

// 'stub-echo' answers with the prompt it was given, so the one line it produces is the
// exact wording that reached the provider - the only honest oracle for whose prompt won.
const ECHO = 'stub-echo'

/** The prompt lives in the dialog's "What they see" section, folded away unless the
 *  dataset already has wording of its own. */
async function openPromptEditor(page: import('@playwright/test').Page) {
  const section = page.getByTestId('llm-what-they-see')
  if ((await section.getAttribute('aria-expanded')) === 'false') await section.click()
  await page.getByTestId('dataset-prompt-edit').click()
}

async function readAndEcho(page: import('@playwright/test').Page, jobId: string,
                           connection: string, options: { refresh?: boolean } = {}): Promise<string[]> {
  await page.goto(`/jobs/${jobId}`)
  await datasetAction(page, 'llm-read-open')
  await pickModel(page, connection, ECHO).check()
  if (options.refresh) await page.getByTestId('llm-refresh').check()
  await page.getByTestId('llm-start').click()
  const [pageId] = await jobPageIds(jobId)
  // Polled on the reading itself: a click resolves before the request it triggers is even
  // sent, so asking whether the dataset is idle would answer "yes" about the moment before.
  const readings = () => pageCandidates(pageId)
    .then((all) => all.filter((c) => c.source === 'llm' && !c.dismissed).map((c) => c.text))
  await expect.poll(readings, { timeout: 30_000 }).not.toEqual([])
  return readings()
}

/** Sets - or clears, with null - the personal default, and waits until the backend agrees.
 *  Every test here reads as the same person, so a half-applied change would be the next
 *  test's wording. */
async function setPersonalPrompt(page: import('@playwright/test').Page, text: string | null) {
  await page.goto('/settings?section=llm')
  await page.getByTestId('edit-default-prompt').click()
  if (text === null) {
    await page.getByTestId('reset-default-prompt').click()
  } else {
    await page.getByTestId('default-prompt-editor').fill(text)
    await page.getByTestId('save-default-prompt').click()
  }
  await expect.poll(async () => (await backendFetch('/api/llm/prompt', { headers: DEV })).prompt)
    .toBe(text ?? '')
}

test.describe('Scenario: deciding how the models are asked', () => {
  test('the shipped wording is shown, and a personal one replaces it everywhere at once',
    async ({ page }) => {
      const connection = uniqueName('Echo')
      await seedLlmConnection(connection, [ECHO], DEV)

      await page.goto('/settings?section=llm')
      // What every model with no wording of its own is asked with, there to read.
      await expect(page.getByTestId('default-prompt')).toContainText('Never modernise')

      const jobId = await seedDistinctPagesJob(uniqueName('Shipped wording'), 1, 20)
      await resetLlmStats()
      expect((await readAndEcho(page, jobId, connection))[0]).toContain('Never modernise')

      // A personal default reaches the same model without touching it.
      await setPersonalPrompt(page, 'Kurrent script, 1750s. Transcribe verbatim.')
      await expect(page.getByTestId('default-prompt'))
        .toHaveText('Kurrent script, 1750s. Transcribe verbatim.')

      // Scans of its own: a dataset holding the first one's scan would reuse the reading
      // already paid for, which is the point of the cache and not what this is about.
      const second = await seedDistinctPagesJob(uniqueName('Personal wording'), 1, 30)
      expect(await readAndEcho(page, second, connection))
        .toEqual(['Kurrent script, 1750s. Transcribe verbatim.'])

      await setPersonalPrompt(page, null)
    })

  test('a dataset can be given wording of its own, seeded from what is in force',
    async ({ page }) => {
      const connection = uniqueName('Echo dataset')
      await seedLlmConnection(connection, [ECHO], DEV)
      await setPersonalPrompt(page, 'My usual rules.')
      const jobId = await seedDistinctPagesJob(uniqueName('Own wording'), 1, 40)
      await resetLlmStats()

      await page.goto(`/jobs/${jobId}`)
      await datasetAction(page, 'llm-read-open')
      await openPromptEditor(page)
      // It starts from what would be used anyway, so replacing means editing rather than
      // starting from nothing and losing the rules underneath.
      await expect(page.getByTestId('dataset-prompt')).toHaveValue('My usual rules.')
      await page.getByTestId('dataset-prompt')
        .fill('My usual rules.\nThis volume is a parish register; Coop. stays Coop.')
      await pickModel(page, connection, ECHO).check()
      await page.getByTestId('llm-start').click()

      const [pageId] = await jobPageIds(jobId)
      await expect.poll(async () =>
        (await pageCandidates(pageId)).filter((c) => c.source === 'llm').map((c) => c.text),
      { timeout: 30_000 }).toEqual([
        'My usual rules.\nThis volume is a parish register; Coop. stays Coop.',
      ])

      // The dataset keeps it, and says so when the dialog reopens.
      const job = await backendFetch(`/api/jobs/${jobId}`, { headers: DEV })
      expect(job.llm_prompt).toContain('parish register')
      await setPersonalPrompt(page, null)
    })

  test('changing the wording costs nothing until the pages are asked for again',
    async ({ page }) => {
      const connection = uniqueName('Echo reread')
      await seedLlmConnection(connection, [ECHO], DEV)
      const jobId = await seedDistinctPagesJob(uniqueName('Reread'), 1, 50)
      await resetLlmStats()
      expect((await readAndEcho(page, jobId, connection))[0]).toContain('Never modernise')

      // The dataset is given its own wording, which does not touch what was read.
      await page.goto(`/jobs/${jobId}`)
      await datasetAction(page, 'llm-read-open')
      await openPromptEditor(page)
      await page.getByTestId('dataset-prompt').fill('Entirely new instructions.')
      await pickModel(page, connection, ECHO).check()
      await page.getByTestId('llm-start').click()

      const [pageId] = await jobPageIds(jobId)
      // Still the old reading: a prompt edit re-bills nothing on its own.
      await expect.poll(async () =>
        (await pageCandidates(pageId)).filter((c) => c.source === 'llm' && !c.dismissed)[0].text,
      ).toContain('Never modernise')

      // Reopening says so, with the price of asking again.
      await datasetAction(page, 'llm-read-open')
      await pickModel(page, connection, ECHO).check()
      await expect(page.getByTestId('llm-stale-prompt'))
        .toContainText('1 page read with a different prompt')

      await page.getByTestId('llm-refresh').check()
      await page.getByTestId('llm-start').click()

      // Now it reads by the new wording, and what it said before is kept but set aside.
      await expect.poll(async () =>
        (await pageCandidates(pageId)).filter((c) => c.source === 'llm' && !c.dismissed)
          .map((c) => c.text),
      { timeout: 30_000 }).toEqual(['Entirely new instructions.'])

      const superseded = (await pageCandidates(pageId))
        .filter((c) => c.source === 'llm' && c.dismissed)
      expect(superseded).toHaveLength(1)
      expect(superseded[0].text).toContain('Never modernise')
    })
})

test.describe('Scenario: a model that thinks before it answers', () => {
  // 'stub-thinking' answers with its working and no transcription until the request turns
  // thinking off - which is what a real vLLM-served reasoning model does.
  const THINKING = 'stub-thinking'

  test('it is asked not to, without anyone configuring anything', async ({ page }) => {
    const connection = uniqueName('Thinker')
    await seedLlmConnection(connection, [THINKING], DEV)
    const jobId = await seedDistinctPagesJob(uniqueName('Thinking'), 1, 60)

    await page.goto(`/jobs/${jobId}`)
    await datasetAction(page, 'llm-read-open')
    await pickModel(page, connection, THINKING).check()
    await page.getByTestId('llm-start').click()

    // Every request carries the switch, so the page is transcribed rather than reasoned at.
    const [pageId] = await jobPageIds(jobId)
    await expect.poll(async () =>
      (await pageCandidates(pageId)).filter((c) => c.source === 'llm' && !c.dismissed).length,
    { timeout: 30_000 }).toBe(6)
  })

  test('an endpoint that refuses to be quietened is asked again without the switch',
    async ({ page }) => {
      // OpenRouter answers 400 for a mandatory-reasoning model rather than ignoring the
      // field, which would fail the reading over a saving.
      const connection = uniqueName('Mandatory')
      await seedLlmConnection(connection, ['stub-mandatory-reasoning'], DEV)
      const jobId = await seedDistinctPagesJob(uniqueName('Mandatory'), 1, 62)

      await page.goto(`/jobs/${jobId}`)
      await datasetAction(page, 'llm-read-open')
      await pickModel(page, connection, 'stub-mandatory-reasoning').check()
      await page.getByTestId('llm-start').click()

      const [pageId] = await jobPageIds(jobId)
      await expect.poll(async () =>
        (await pageCandidates(pageId)).filter((c) => c.source === 'llm' && !c.dismissed).length,
      { timeout: 30_000 }).toBe(6)
      await expect(page.getByTestId('llm-progress-failed')).toHaveCount(0)
    })

  test('a model whose endpoint refuses the switch still says what went wrong',
    async ({ page }) => {
      const connection = uniqueName('Unquietable')
      const seeded = await seedLlmConnection(connection, [THINKING], DEV)
      const jobId = await seedDistinctPagesJob(uniqueName('Still thinking'), 1, 61)

      // A null in a model's own fields means "do not send this field at all" - which is
      // how an endpoint that refuses what it does not recognise is served, and the only
      // way left to reach a model that answers with its working.
      await page.goto('/settings?section=llm')
      const row = page.locator(`[data-testid="llm-connection"][data-name="${connection}"]`)
        .locator(`[data-testid="llm-model"][data-label="${connection} ${THINKING}"]`)
      await row.getByTestId('llm-model-edit').click()
      await row.getByTestId('llm-model-extra').fill('{"chat_template_kwargs": null}')
      await row.getByTestId('llm-prompt-save').click()
      await expect.poll(async () => {
        const models = (await backendFetch('/api/llm/models', { headers: DEV })).models
        return models.find((m: { id: number }) => m.id === seeded.models[0].id).extra_body
      }).toContain('chat_template_kwargs')

      await page.goto(`/jobs/${jobId}`)
      await datasetAction(page, 'llm-read-open')
      await pickModel(page, connection, THINKING).check()
      await page.getByTestId('llm-start').click()

      // The failure names the switch rather than reporting an empty transcription.
      await page.getByTestId('llm-progress-failed').click({ timeout: 30_000 })
      await expect(page.getByTestId('llm-progress-error')).toContainText('answered with its reasoning')
      await expect(page.getByTestId('llm-progress-error')).toContainText('enable_thinking')
    })
})
