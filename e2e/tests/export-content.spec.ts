import { test, expect } from '../helpers/test'
import {
  backendFetch, correctLine, createGroup, exportText, getPageDetail, jobPageIds, moveJobToGroup,
  pageLines, seedCompletedJob, uniqueName,
} from '../helpers/api'

const STUB_LINES = [
  'Sample Header line 1', 'Sample Header line 2', 'Sample Header line 3',
  'Sample Paragraph line 1', 'Sample Paragraph line 2', 'Sample Paragraph line 3',
]

test.describe('Scenario: exporting what a dataset holds', () => {
  test('a dataset named outside plain Latin exports like any other', async () => {
    const jobId = await seedCompletedJob(uniqueName('Księga – Briefe'), 1)
    expect(await exportText(jobId, 'txt')).toBe(STUB_LINES.join('\n'))
  })

  test('reviewed-only leaves out the pages that have nothing reviewed on them', async () => {
    const jobId = await seedCompletedJob(uniqueName('Half reviewed export'), 2)
    const [, second] = await jobPageIds(jobId)
    const [firstOfSecond] = await pageLines(jobId, second)
    await correctLine(firstOfSecond.id, 'Only this was reviewed')

    expect(await exportText(jobId, 'txt', true)).toBe('Only this was reviewed')
    const md = await exportText(jobId, 'md', true)
    expect(md).toContain('scan_2.png')
    expect(md).not.toContain('scan_1.png')
  })

  test('splitting a box keeps both halves where the box stood in reading order', async () => {
    const jobId = await seedCompletedJob(uniqueName('Split in order'), 1)
    const [pageId] = await jobPageIds(jobId)
    const header = (await getPageDetail(jobId, pageId)).elements
      .find((e: { class_name: string }) => e.class_name === 'Header')
    // The Header box spans y 0.05-0.15 with its lines centred at 0.067, 0.100 and 0.133,
    // so a cut at 0.09 leaves line 1 above it and lines 2 and 3 below.
    await backendFetch(`/api/elements/${header.id}/split`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cut_y: 0.09 }),
    })
    const classes = (await getPageDetail(jobId, pageId)).elements
      .map((e: { class_name: string }) => e.class_name)
    expect(classes).toEqual(['Header', 'Header', 'Paragraph'])

    expect(await exportText(jobId, 'txt')).toBe(STUB_LINES.join('\n'))
  })
})

test.describe('Scenario: a project whose names share a shelfmark', () => {
  test('the shared part is said once only when every name really starts with it', async ({ page }) => {
    const shelved = uniqueName('Shelfmark project')
    const mixed = uniqueName('Mixed project')
    const shelvedGroup = await createGroup(shelved)
    const mixedGroup = await createGroup(mixed)
    const stamp = Date.now()
    for (const name of [`AKB_VN-16-K-1-10 ${stamp}`, `AKB_VN-16-K-1-132 ${stamp}`, `AKB_VN-16-K-1-7 ${stamp}`]) {
      await moveJobToGroup(await seedCompletedJob(name, 1), shelvedGroup.id)
    }
    // "Akte" is common to all three, but no separator follows it in every name.
    for (const name of [`Akte 1 ${stamp}`, `Akte 2 ${stamp}`, `Akte-3 ${stamp}`]) {
      await moveJobToGroup(await seedCompletedJob(name, 1), mixedGroup.id)
    }

    await page.goto('/')
    const section = (title: string) => page.locator(`[data-testid="list-section"][data-title="${title}"]`)
    await expect(section(shelved).getByTestId('shared-prefix')).toHaveText('AKB_VN-16-K-1-')
    await expect(section(mixed).getByTestId('job-card')).toHaveCount(3)
    await expect(section(mixed).getByTestId('shared-prefix')).toHaveCount(0)
  })
})
