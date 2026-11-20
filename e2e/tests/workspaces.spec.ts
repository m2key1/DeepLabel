import { test, expect } from '../helpers/test'
import { backendFetch, createGroup, createJob, identity, shareGroup, uniqueName, waitForJobStatus } from '../helpers/api'
import { seedSession, useSession } from '../helpers/session'

async function groupOf(jobId: string): Promise<{ id: number; sandbox_of: string | null }> {
  const job = await backendFetch(`/api/jobs/${jobId}?pages=false`)
  const groups = await backendFetch('/api/groups') as { id: number; sandbox_of: string | null }[]
  return groups.find((g) => g.id === job.group_id)!
}

test.describe('Scenario: a dataset starts in its creator\'s Sandbox (#131)', () => {
  test('it stays private until moved into a workspace, whose members then see it', async ({ page, browser }) => {
    const stamp = Date.now()
    const lena = `lena-${stamp}`
    const ben = `ben-${stamp}`
    const workspace = await createGroup(uniqueName('Linz'))
    await shareGroup(workspace.id, [lena, ben])
    const name = uniqueName('Band 1879')
    const jobId = await createJob(name, 1, undefined, identity(lena, 'annotator'))
    await waitForJobStatus(jobId, 'done')
    expect((await groupOf(jobId)).sandbox_of).toBe(lena)

    // An admin sees whose Sandbox it is.
    await page.goto('/')
    await expect(page.locator(`[data-testid="list-section"][data-title="${lena}'s Sandbox"]`)
      .getByTestId('job-card').filter({ hasText: name })).toHaveCount(1)

    const benContext = await browser.newContext()
    await useSession(benContext, seedSession('reviewer', ben))
    const benPage = await benContext.newPage()
    const lenaContext = await browser.newContext()
    await useSession(lenaContext, seedSession('annotator', lena))
    const lenaPage = await lenaContext.newPage()

    await lenaPage.goto('/')
    const card = lenaPage.getByTestId('job-card').filter({ hasText: name })
    await expect(lenaPage.locator('[data-testid="list-section"][data-title="Sandbox"]')
      .getByTestId('job-card').filter({ hasText: name })).toHaveCount(1)
    await benPage.goto('/')
    await expect(benPage.getByTestId('job-card').filter({ hasText: name })).toHaveCount(0)

    // Share says why nobody is added to a Sandbox, without asking for the people she may not list.
    await card.getByTestId('job-menu').click()
    await card.getByRole('button', { name: 'Share…' }).click()
    await expect(lenaPage.getByTestId('share-sandboxed')).toHaveText(
      'It is in your Sandbox, which only you can see. To share it, move it into a group: everyone in that group can then open it.')
    await expect(lenaPage.getByRole('alert')).toHaveCount(0)
    await lenaPage.getByRole('button', { name: 'Cancel' }).click()

    await card.getByRole('checkbox').check()
    await lenaPage.getByRole('button', { name: 'Move to group…' }).click()
    await lenaPage.getByRole('button', { name: workspace.name, exact: true }).click()
    await expect.poll(async () => (await groupOf(jobId)).id).toBe(workspace.id)
    // In the group, adding people is its Managers', so an Annotator is offered no Share.
    await lenaPage.reload()
    await card.getByTestId('job-menu').click()
    await expect(card.getByRole('button', { name: 'Settings…' })).toBeVisible()
    await expect(card.getByRole('button', { name: 'Share…' })).toHaveCount(0)

    await benPage.reload()
    await expect(benPage.getByTestId('job-card').filter({ hasText: name })).toHaveCount(1)
    await benContext.close()
    await lenaContext.close()
  })
})

test.describe('Scenario: a Manager decides who belongs to a group (#131)', () => {
  test('a new, still empty group takes its first member from its header', async ({ browser }) => {
    const stamp = Date.now()
    const manager = `mona-${stamp}`
    const ben = `ben-${stamp}`
    const benSession = seedSession('reviewer', ben)
    const monaContext = await browser.newContext()
    await useSession(monaContext, seedSession('manager', manager))
    const page = await monaContext.newPage()
    const name = uniqueName('Kanzlei')

    await page.goto('/')
    await page.getByRole('button', { name: 'New group' }).click()
    await page.getByPlaceholder('Group name').fill(name)
    await page.keyboard.press('Enter')
    const section = page.locator(`[data-testid="list-section"][data-title="${name}"]`)
    await section.getByTestId('group-share').click()
    await page.getByRole('checkbox', { name: ben }).check()
    await page.getByRole('button', { name: 'Save' }).click()
    const members = async () => ((await backendFetch('/api/groups')) as { name: string; shared_with: string[] }[])
      .find((g) => g.name === name)?.shared_with
    await expect.poll(members).toEqual([ben, manager])
    await expect(section.getByTestId('group-shared')).toHaveText('2 members')

    // Ben belongs to it now, but deciding who else does is a Manager's.
    const benContext = await browser.newContext()
    await useSession(benContext, benSession)
    const benPage = await benContext.newPage()
    await benPage.goto('/')
    const benSection = benPage.locator(`[data-testid="list-section"][data-title="${name}"]`)
    await expect(benSection).toHaveCount(1)
    await expect(benSection.getByTestId('group-share')).toHaveCount(0)
    await benContext.close()
    await monaContext.close()
  })
})
