import { test, expect } from '../helpers/test'
import { backendFetch, getJob, identity, moveJobToGroup, seedCompletedJob, shareGroup, uniqueName } from '../helpers/api'
import { seedSession, useSession } from '../helpers/session'

async function createWorkspaceAs(username: string, name: string): Promise<{ id: number; name: string }> {
  return backendFetch('/api/groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...identity(username, 'manager') },
    body: JSON.stringify({ name }),
  })
}

async function membersOf(groupId: number): Promise<string[] | undefined> {
  const groups = await backendFetch('/api/groups') as { id: number; shared_with: string[] }[]
  return groups.find((g) => g.id === groupId)?.shared_with
}

test.describe('Scenario: a Manager decides who belongs to a workspace (#132)', () => {
  test('the Members dialog finds people by name, shows their roles and takes them out again', async ({ browser }) => {
    const stamp = Date.now()
    const mona = `mona-${stamp}`
    const ben = `ben-${stamp}`
    const lena = `lena-${stamp}`
    const monaSession = seedSession('manager', mona)
    seedSession('reviewer', ben)
    const lenaSession = seedSession('annotator', lena)
    const name = uniqueName('Kanzlei')
    const workspace = await createWorkspaceAs(mona, name)

    const monaContext = await browser.newContext()
    await useSession(monaContext, monaSession)
    const page = await monaContext.newPage()
    await page.goto('/')
    const section = page.locator(`[data-testid="list-section"][data-title="${name}"]`)
    await section.getByTestId('group-members').click()
    const dialog = page.getByRole('dialog', { name: `Members of "${name}"` })
    const member = (username: string) => dialog.locator(`[data-testid="member"][data-username="${username}"]`)
    await expect(member(mona).getByTestId('member-role')).toHaveText('Manager')

    // The search offers everyone matching who is not in yet: Ben and Lena, not Mona.
    const search = dialog.getByRole('combobox', { name: 'Add someone' })
    await search.fill(`-${stamp}`)
    const offered = dialog.getByRole('option')
    await expect(offered).toHaveCount(2)
    await expect(offered.nth(0)).toHaveAttribute('data-username', ben)
    await expect(offered.nth(1)).toHaveAttribute('data-username', lena)

    await offered.nth(0).click()
    await expect(member(ben).getByTestId('member-role')).toHaveText('Reviewer')
    await expect.poll(() => membersOf(workspace.id)).toEqual([ben, mona])

    await search.fill(lena)
    await dialog.getByRole('option', { name: new RegExp(lena) }).click()
    await expect(member(lena).getByTestId('member-role')).toHaveText('Annotator')
    await expect.poll(() => membersOf(workspace.id)).toEqual([ben, lena, mona])
    await search.fill(`-${stamp}`)
    await expect(dialog.getByRole('option')).toHaveCount(0)

    await member(ben).getByRole('button', { name: `Remove ${ben}` }).click()
    await expect(member(ben)).toHaveCount(0)
    await expect.poll(() => membersOf(workspace.id)).toEqual([lena, mona])
    await dialog.getByRole('button', { name: 'Done' }).click()
    await expect(section.getByTestId('group-shared')).toHaveText('2 members')

    // Lena belongs now, but deciding who else does stays with the Managers.
    const lenaContext = await browser.newContext()
    await useSession(lenaContext, lenaSession)
    const lenaPage = await lenaContext.newPage()
    await lenaPage.goto('/')
    const lenaSection = lenaPage.locator(`[data-testid="list-section"][data-title="${name}"]`)
    await expect(lenaSection.getByTestId('group-shared')).toHaveText('2 members')
    await expect(lenaSection.getByTestId('group-members')).toHaveCount(0)
    await lenaContext.close()
    await monaContext.close()
  })
})

test.describe('Scenario: changes made faster than they save (#132)', () => {
  test('someone added while a removal is still saving is added too', async ({ browser }) => {
    const stamp = Date.now()
    const mona = `mona-${stamp}`
    const ben = `ben-${stamp}`
    const lena = `lena-${stamp}`
    const monaSession = seedSession('manager', mona)
    seedSession('reviewer', ben)
    seedSession('annotator', lena)
    const name = uniqueName('Kanzlei')
    const workspace = await createWorkspaceAs(mona, name)
    await shareGroup(workspace.id, [mona, ben])

    const monaContext = await browser.newContext()
    await useSession(monaContext, monaSession)
    const page = await monaContext.newPage()
    // The first save takes a while, as on a slow connection.
    let slowed = false
    await page.route(`**/api/groups/${workspace.id}/share`, async (route) => {
      if (!slowed) {
        slowed = true
        await new Promise((resolve) => setTimeout(resolve, 1500))
      }
      await route.continue()
    })
    await page.goto('/')
    await page.locator(`[data-testid="list-section"][data-title="${name}"]`).getByTestId('group-members').click()
    const dialog = page.getByRole('dialog', { name: `Members of "${name}"` })
    const member = (username: string) => dialog.locator(`[data-testid="member"][data-username="${username}"]`)

    await member(ben).getByRole('button', { name: `Remove ${ben}` }).click()
    await dialog.getByRole('combobox', { name: 'Add someone' }).fill(lena)
    await dialog.getByRole('option', { name: new RegExp(lena) }).click()

    await expect.poll(() => membersOf(workspace.id)).toEqual([lena, mona])
    await expect(member(lena).getByTestId('member-role')).toHaveText('Annotator')
    await expect(member(ben)).toHaveCount(0)
    await monaContext.close()
  })
})

test.describe('Scenario: the people of one dataset (#132)', () => {
  test('a workspace member is made Reviewer on it alone, and someone outside is given it on its own',
    async ({ browser }) => {
    const stamp = Date.now()
    const mona = `mona-${stamp}`
    const lena = `lena-${stamp}`
    const rita = `rita-${stamp}`
    const monaSession = seedSession('manager', mona)
    seedSession('annotator', lena)
    seedSession('reviewer', rita)
    const workspace = await createWorkspaceAs(mona, uniqueName('Pfarre'))
    await shareGroup(workspace.id, [mona, lena])
    const name = uniqueName('Brief 1912')
    const jobId = await seedCompletedJob(name, 1)
    await moveJobToGroup(jobId, workspace.id)

    const monaContext = await browser.newContext()
    await useSession(monaContext, monaSession)
    const page = await monaContext.newPage()
    await page.goto('/')
    const card = page.getByTestId('job-card').filter({ hasText: name })
    await card.getByTestId('job-menu').click()
    await card.getByRole('button', { name: 'Members…' }).click()
    const dialog = page.getByRole('dialog', { name: `Members of "${name}"` })
    const throughWorkspace = dialog.getByTestId('members-through-workspace')
    const givenAlone = dialog.getByTestId('members-given-alone')
    const member = (username: string) => dialog.locator(`[data-testid="member"][data-username="${username}"]`)

    // Its creator is not in the workspace, and is listed apart, managing it all the same.
    await expect(dialog.getByTestId('members-creator').getByTestId('member'))
      .toHaveAttribute('data-username', 'e2e-seeder')
    await expect(dialog.getByTestId('members-creator').getByTestId('member-role')).toHaveText('Creator')
    await expect(throughWorkspace.locator('[data-testid="member"][data-username="e2e-seeder"]')).toHaveCount(0)

    // The workspace's members are listed, and an Annotator among them can be made Reviewer here.
    await expect(throughWorkspace.locator(`[data-testid="member"][data-username="${mona}"]`)
      .getByTestId('member-role')).toHaveText('Manager')
    const lenaRole = throughWorkspace.getByRole('combobox', { name: `Role of ${lena} on this dataset` })
    await expect(lenaRole).toHaveValue('annotator')
    await lenaRole.selectOption('reviewer')
    await expect.poll(async () => (await getJob(jobId)).roles).toEqual({ [lena]: 'reviewer' })
    const asLena = await backendFetch(`/api/jobs/${jobId}?pages=false`, { headers: identity(lena, 'annotator') })
    expect([asLena.my_role, asLena.shared_with]).toEqual(['reviewer', []])

    // Rita is not in the workspace: she is given this dataset alone, and can be taken off it.
    await dialog.getByRole('combobox', { name: 'Add someone' }).fill(rita)
    await dialog.getByRole('option', { name: new RegExp(rita) }).click()
    await expect(givenAlone.locator(`[data-testid="member"][data-username="${rita}"]`)
      .getByRole('combobox', { name: `Role of ${rita} on this dataset` })).toHaveValue('reviewer')
    await expect.poll(async () => (await getJob(jobId)).shared_with).toEqual([rita])

    await member(rita).getByRole('button', { name: `Remove ${rita}` }).click()
    await expect(member(rita)).toHaveCount(0)
    await expect(member(lena)).toHaveCount(1)
    await expect.poll(async () => (await getJob(jobId)).shared_with).toEqual([])
    expect((await getJob(jobId)).roles).toEqual({ [lena]: 'reviewer' })
    await monaContext.close()
  })
})
