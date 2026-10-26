import { test, expect } from '../helpers/test'
import {
  backendFetch, identity, jobPageIds, pageCandidates, resetLlmStats, seedDistinctPagesJob,
  seedLlmConnection, uniqueName,
} from '../helpers/api'
import { pickModel } from '../helpers/llm'
import { datasetAction } from '../helpers/dataset'

const DEV = identity('dev', 'admin')
// Answers with the prompt it was given: the only honest oracle for whose wording won.
const ECHO = 'stub-echo'

async function setPersonalPrompt(text: string | null) {
  await backendFetch('/api/llm/prompt', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...DEV },
    body: JSON.stringify({ prompt: text ?? '' }),
  })
  expect((await backendFetch('/api/llm/prompt', { headers: DEV })).prompt).toBe(text ?? '')
}

async function seedEchoWithOwnWording(connection: string, wording: string) {
  const seeded = await seedLlmConnection(connection, [ECHO], DEV)
  const model = seeded.models[0]
  await backendFetch(`/api/llm/models/${model.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...DEV },
    body: JSON.stringify({ prompt: wording }),
  })
  const after = await backendFetch('/api/llm/connections', { headers: DEV })
  const stored = after.connections.find((c: { id: number }) => c.id === seeded.id).models[0]
  expect(stored.prompt).toBe(wording)
}

test.describe('Scenario: a model with wording of its own', () => {
  test.afterEach(async () => setPersonalPrompt(null))

  test("the model's wording beats the personal default", async ({ page }) => {
    const connection = uniqueName('Echo own words')
    await seedEchoWithOwnWording(connection, 'Model rules.')
    await setPersonalPrompt('My usual rules.')
    const jobId = await seedDistinctPagesJob(uniqueName('Model wording'), 1, 50)
    await resetLlmStats()

    await page.goto(`/jobs/${jobId}`)
    await datasetAction(page, 'llm-read-open')
    await pickModel(page, connection, ECHO).check()
    await page.getByTestId('llm-start').click()

    const [pageId] = await jobPageIds(jobId)
    await expect.poll(async () =>
      (await pageCandidates(pageId)).filter((c) => c.source === 'llm').map((c) => c.text),
    { timeout: 30_000 }).toEqual(['Model rules.'])
  })

  test("a dataset's own wording starts from the picked model's, the one that would be used",
    async ({ page }) => {
      const connection = uniqueName('Echo seeded editor')
      await seedEchoWithOwnWording(connection, 'Model rules.')
      await setPersonalPrompt('My usual rules.')
      const jobId = await seedDistinctPagesJob(uniqueName('Editor seed'), 1, 60)

      await page.goto(`/jobs/${jobId}`)
      await datasetAction(page, 'llm-read-open')
      await pickModel(page, connection, ECHO).check()
      const section = page.getByTestId('llm-what-they-see')
      if ((await section.getAttribute('aria-expanded')) === 'false') await section.click()
      await page.getByTestId('dataset-prompt-edit').click()

      await expect(page.getByTestId('dataset-prompt')).toHaveValue('Model rules.')
    })
})
