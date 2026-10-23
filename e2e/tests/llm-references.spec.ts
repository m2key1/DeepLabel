import { test, expect } from '../helpers/test'
import {
  TINY_PNG, addLlmReference, backendFetch, identity, jobPageIds, llmReferenceImage,
  llmReferences, llmStats, pageCandidates, resetLlmStats, seedDistinctPagesJob,
  seedLlmConnection, uniqueName,
} from '../helpers/api'
import { pickModel, startLlmRead } from '../helpers/llm'

const DEV = identity('dev', 'admin')
const PERFECT = 'stub-perfect'
// 'stub-echo' answers with the prompt it was given, so the reading it produces is the
// exact wording that reached the provider.
const ECHO = 'stub-echo'
const NOTE = 'Before the page you are shown 1 reference image. The last image is the page '
  + 'to transcribe; everything before it is reference material and is never transcribed.'

/** The wording as the provider saw it - 'stub-echo' answers with it whole, so it comes
 *  back as one reading rather than one per line of it. */
async function echoedPrompt(jobId: string): Promise<string[]> {
  const [pageId] = await jobPageIds(jobId)
  return (await pageCandidates(pageId)).filter((c) => c.source === 'llm').map((c) => c.text)
}

async function setDatasetPrompt(jobId: string, prompt: string): Promise<void> {
  await backendFetch(`/api/jobs/${jobId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...DEV },
    body: JSON.stringify({ llm_prompt: prompt }),
  })
}

test.describe('Scenario: showing the models a reference chart', () => {
  test('a chart set on the dataset reaches the provider ahead of the page',
    async ({ page }) => {
      const jobId = await seedDistinctPagesJob(uniqueName('Charted'), 1)
      const connection = uniqueName('Charted reader')
      await seedLlmConnection(connection, [PERFECT], DEV)
      await addLlmReference('chart.png', TINY_PNG, 'image/png', jobId, DEV)
      await resetLlmStats()

      await startLlmRead(page, jobId, connection, [PERFECT])

      // The provider's own account of what it was sent: the chart, then the page. The
      // order is the whole point - a prompt may say "the first image is a chart".
      const stats = await llmStats()
      expect(stats.images[PERFECT]).toEqual(['image/png', 'image/jpeg'])
    })

  test('a dataset with no chart sends the page and nothing else', async ({ page }) => {
    const jobId = await seedDistinctPagesJob(uniqueName('Uncharted'), 1)
    const connection = uniqueName('Plain reader')
    await seedLlmConnection(connection, [PERFECT], DEV)
    await resetLlmStats()

    await startLlmRead(page, jobId, connection, [PERFECT])

    expect((await llmStats()).images[PERFECT]).toEqual(['image/jpeg'])
  })

  test('the wording says which of the images the model is meant to transcribe',
    async ({ page }) => {
      const connection = uniqueName('Echoing reader')
      await seedLlmConnection(connection, [ECHO], DEV)

      const charted = await seedDistinctPagesJob(uniqueName('Told about it'), 1, 70)
      await setDatasetPrompt(charted, 'Read it.')
      await addLlmReference('chart.png', TINY_PNG, 'image/png', charted, DEV)
      await resetLlmStats()

      await startLlmRead(page, charted, connection, [ECHO])

      // Without this sentence the model is looking at two pictures with no reason to think
      // the chart is not the page, and transcribes the chart.
      expect(await echoedPrompt(charted)).toEqual([`Read it.\n\n${NOTE}`])

      // The same wording, no chart: nothing is said about pictures that were not sent.
      const plain = await seedDistinctPagesJob(uniqueName('Nothing to tell'), 1, 80)
      await setDatasetPrompt(plain, 'Read it.')

      await startLlmRead(page, plain, connection, [ECHO])

      expect(await echoedPrompt(plain)).toEqual(['Read it.'])
    })

  test('a chart can be added from the read dialog, and replaces the inherited set',
    async ({ page }) => {
      const jobId = await seedDistinctPagesJob(uniqueName('Dialog chart'), 1)
      const connection = uniqueName('Dialog reader')
      await seedLlmConnection(connection, [PERFECT], DEV)

      await page.goto(`/jobs/${jobId}`)
      await page.getByTestId('llm-read-open').click()
      await page.getByTestId('llm-what-they-see').click()
      const references = page.getByTestId('llm-references')
      await expect(references.getByTestId('llm-reference')).toHaveCount(0)

      await page.getByTestId('llm-reference-file').setInputFiles({
        name: 'corpus.png', mimeType: 'image/png', buffer: Buffer.from(TINY_PNG),
      })

      await expect(references.getByTestId('llm-reference')).toHaveCount(1)
      await expect(references.locator('[data-testid="llm-reference"][data-name="corpus.png"]'))
        .toBeVisible()
      // Backend oracle: it belongs to this dataset, not to the person who added it.
      const held = await llmReferences(jobId, DEV)
      expect(held.references.map((r) => r.filename)).toEqual(['corpus.png'])
      expect(held.inherited).toBe(false)
    })

  test('a chart added after a reading makes that reading stale rather than re-billing it',
    async ({ page }) => {
      const jobId = await seedDistinctPagesJob(uniqueName('Stale by chart'), 1)
      const connection = uniqueName('Stale reader')
      await seedLlmConnection(connection, [PERFECT], DEV)
      await resetLlmStats()
      await startLlmRead(page, jobId, connection, [PERFECT])
      expect((await llmStats()).total).toBe(1)

      await addLlmReference('chart.png', TINY_PNG, 'image/png', jobId, DEV)

      await page.reload()
      await page.getByTestId('llm-read-open').click()
      await pickModel(page, connection, PERFECT).check()
      // Showing a model something new does not silently re-read a whole volume.
      await expect(page.getByTestId('llm-stale-prompt')).toContainText('1 page')
      expect((await llmStats()).total).toBe(1)
    })

  test('a reading taken with the chart is not stale, and the picture is served back',
    async ({ page }) => {
      const jobId = await seedDistinctPagesJob(uniqueName('Fresh with chart'), 1)
      const connection = uniqueName('Fresh reader')
      await seedLlmConnection(connection, [PERFECT], DEV)
      const reference = await addLlmReference('chart.png', TINY_PNG, 'image/png', jobId, DEV)
      await resetLlmStats()
      await startLlmRead(page, jobId, connection, [PERFECT])

      await page.reload()
      await page.getByTestId('llm-read-open').click()
      await pickModel(page, connection, PERFECT).check()
      await expect(page.getByTestId('llm-stale-prompt')).toHaveCount(0)
      await expect(page.getByTestId('llm-cost')).toContainText('already read and free')

      // The stored picture is the one that was uploaded, byte for byte.
      expect(Array.from(await llmReferenceImage(reference.id, DEV))).toEqual(Array.from(TINY_PNG))
    })
})
