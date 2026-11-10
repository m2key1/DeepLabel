import { test, expect } from '../helpers/test'
import {
  backendFetch, deleteElement, getPageDetail, identity, jobPageIds, pageCandidates, pageLines,
  seedCompletedJob, seedDistinctPagesJob, seedJobWithoutLayout, seedLlmConnection, uniqueName,
} from '../helpers/api'
import { openViewer } from '../helpers/viewer'

const DEV = identity('dev', 'admin')

type Element = { id: number; class_name: string; checked: boolean }

test.describe('Scenario: what a box takes with it', () => {
  test('splitting a box gives neither half a review nobody did', async () => {
    const jobId = await seedCompletedJob(uniqueName('Split review'), 1)
    const [pageId] = await jobPageIds(jobId)
    const before = (await getPageDetail(jobId, pageId)).elements as Element[]
    expect(before.map((e) => e.checked)).toEqual([false, false])
    const paragraph = before.find((e) => e.class_name === 'Paragraph')!

    await backendFetch(`/api/elements/${paragraph.id}/split`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cut_y: 0.5 }),
    })
    const after = (await getPageDetail(jobId, pageId)).elements as Element[]
    expect(after).toHaveLength(3)
    expect(after.map((e) => e.checked)).toEqual([false, false, false])
  })

  test('deleting a box keeps its lines, and what was read on them stays with them', async () => {
    const jobId = await seedDistinctPagesJob(uniqueName('Box with readings'), 1, 85)
    const [pageId] = await jobPageIds(jobId)
    const connection = await seedLlmConnection(uniqueName('Reader'), ['stub-perfect'], DEV)
    await backendFetch(`/api/jobs/${jobId}/llm/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...DEV },
      body: JSON.stringify({ model_ids: [connection.models[0].id] }),
    })
    const paragraphReadings = async () => (await pageCandidates(pageId))
      .filter((c) => c.source === 'llm' && c.text.startsWith('Sample Paragraph'))
    await expect.poll(async () => (await paragraphReadings()).filter((c) => c.line_id !== null).length,
                      { timeout: 30_000 }).toBe(3)
    const readOn = (await paragraphReadings()).map((c) => c.line_id).sort()

    const paragraph = ((await getPageDetail(jobId, pageId)).elements as (Element & { lines: { id: number }[] })[])
      .find((e) => e.class_name === 'Paragraph')!
    await deleteElement(paragraph.id)

    // The box goes; its three lines fall to Unassigned, and the readings stay on them.
    const after = (await getPageDetail(jobId, pageId)).elements as
      { class_name: string; kind: string; lines: { id: number }[] }[]
    expect(after.map((e) => e.class_name)).not.toContain('Paragraph')
    expect(after.find((e) => e.kind === 'orphan')!.lines.map((l) => l.id).sort())
      .toEqual(paragraph.lines.map((l) => l.id).sort())
    expect(await pageLines(jobId, pageId)).toHaveLength(6)
    expect((await paragraphReadings()).map((c) => c.line_id).sort()).toEqual(readOn)
  })
})

test.describe('Scenario: what running layout on one page would replace', () => {
  test('a page with no boxes says how many lines layout detection would replace', async ({ page }) => {
    const jobId = await seedJobWithoutLayout(uniqueName('No boxes yet'), 1)
    const [pageId] = await jobPageIds(jobId)
    const lines = (await pageLines(jobId, pageId)).length
    expect(lines).toBeGreaterThan(0)

    await openViewer(page, jobId, pageId)
    await page.getByTestId('run-menu').click()
    const layout = page.locator('[data-testid="run-phase"][data-phase="layout"]')
    await expect(layout).toContainText(`${lines} line`)
    await expect(layout).not.toContainText('nothing detected here yet')
  })
})
