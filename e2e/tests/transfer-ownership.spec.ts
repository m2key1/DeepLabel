import { test, expect } from '../helpers/test'
import { backendFetch, identity, moveJobToGroup, seedCompletedJob, shareGroup, uniqueName } from '../helpers/api'
import { seedSession, useSession } from '../helpers/session'

type Owned = { owner: string; shared_with: string[] }

async function datasetOf(jobId: string): Promise<Owned> {
  const { owner, shared_with } = await backendFetch(`/api/jobs/${jobId}`) as Owned
  return { owner, shared_with }
}

async function workspaceOf(groupId: number): Promise<Owned> {
  const { owner, shared_with } = (await backendFetch('/api/groups') as ({ id: number } & Owned)[])
    .find((g) => g.id === groupId)!
  return { owner, shared_with: [...shared_with].sort() }
}

test.describe('Scenario: a Manager hands her datasets and her workspace to a colleague (#79)', () => {
  test('a dataset goes from its action menu, then the workspace with the datasets she made in it',
    async ({ browser }) => {
    const stamp = Date.now()
    const mona = `mona-${stamp}`
    const ben = `ben-${stamp}`
    const monaSession = seedSession('manager', mona)
    seedSession('manager', ben)
    const workspaceName = uniqueName('Pfarre Gars')
    const workspace = await backendFetch('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...identity(mona, 'manager') },
      body: JSON.stringify({ name: workspaceName }),
    }) as { id: number }
    await shareGroup(workspace.id, [mona])
    const taufbuch = uniqueName('Taufbuch 1891')
    const sterbebuch = uniqueName('Sterbebuch 1891')
    const ids = [await seedCompletedJob(taufbuch, 1), await seedCompletedJob(sterbebuch, 1)]
    // Seeded by the admin seeder, who hands both to Mona: the scenario starts with her owning them.
    for (const jobId of ids) {
      await moveJobToGroup(jobId, workspace.id)
      await backendFetch(`/api/jobs/${jobId}/transfer`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: mona }),
      })
    }
    // The seeder belongs to no workspace here, so it keeps them by being given them alone.
    expect(await datasetOf(ids[0])).toEqual({ owner: mona, shared_with: ['e2e-seeder'] })

    const context = await browser.newContext()
    await useSession(context, monaSession)
    const page = await context.newPage()
    await page.goto('/')

    // The Taufbuch goes to Ben from its card's menu; Mona belongs to the workspace, so is given nothing.
    const card = page.getByTestId('job-card').filter({ hasText: taufbuch })
    await card.getByTestId('job-menu').click()
    await card.getByTestId('transfer-open').click()
    const dialog = page.getByRole('dialog', { name: `Transfer ownership of "${taufbuch}"` })
    await dialog.getByRole('combobox', { name: 'Transfer to' }).selectOption(ben)
    await expect(dialog.getByTestId('transfer-summary')).toHaveText(`Transfer "${taufbuch}" to ${ben}?`)
    await dialog.getByRole('button', { name: 'Transfer' }).click()
    await expect.poll(() => datasetOf(ids[0])).toEqual({ owner: ben, shared_with: ['e2e-seeder'] })
    await expect(dialog).toHaveCount(0)
    await card.getByTestId('job-menu').click()
    await expect(card.getByRole('button', { name: 'Members…' })).toBeVisible()
    await expect(card.getByTestId('transfer-open')).toHaveCount(0)
    await page.keyboard.press('Escape')

    // The workspace goes too, with the Sterbebuch she still made there.
    const section = page.locator('section').filter({ hasText: workspaceName })
    await section.getByTestId('group-members').click()
    await page.getByRole('dialog', { name: `Members of "${workspaceName}"` }).getByTestId('members-transfer').click()
    const handover = page.getByRole('dialog', { name: `Transfer ownership of "${workspaceName}"` })
    await expect(handover.getByRole('checkbox', { name: `Also transfer the 1 dataset ${mona} made in it` }))
      .toBeChecked()
    await handover.getByRole('combobox', { name: 'Transfer to' }).selectOption(ben)
    await expect(handover.getByTestId('transfer-summary'))
      .toHaveText(`Transfer "${workspaceName}" and the 1 dataset ${mona} made in it to ${ben}?`)
    await handover.getByRole('button', { name: 'Transfer' }).click()
    await expect.poll(() => workspaceOf(workspace.id)).toEqual({ owner: ben, shared_with: [ben, mona].sort() })
    expect((await datasetOf(ids[1])).owner).toBe(ben)
    await section.getByTestId('group-members').click()
    const members = page.getByRole('dialog', { name: `Members of "${workspaceName}"` })
    await expect(members.getByRole('button', { name: 'Done' })).toBeVisible()
    await expect(members.getByTestId('members-transfer')).toHaveCount(0)
    // Its owner stays a member while it is theirs (#160).
    const member = (username: string) => members.locator(`[data-testid="member"][data-username="${username}"]`)
    await expect(member(ben).getByTestId('member-owner')).toHaveText('Owner')
    await expect(member(ben).getByRole('button', { name: `Remove ${ben}` })).toHaveCount(0)
    await expect(member(mona).getByRole('button', { name: `Remove ${mona}` })).toBeVisible()
  })
})
