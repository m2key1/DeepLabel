import { test, expect } from '../helpers/test'
import { backendFetch, identity, uniqueName } from '../helpers/api'
import { signInSite, signedInPage } from '../helpers/signIn'

const ROOT = 'root@example.org'
const ROOT_PASSWORD = 'copper willow tandem fjord'

async function membersOf(groupId: number): Promise<string[]> {
  const group = (await backendFetch('/api/groups') as { id: number; shared_with: string[] }[])
    .find((g) => g.id === groupId)
  return [...(group?.shared_with ?? [])].sort()
}

async function makeWorkspace(name: string): Promise<{ id: number }> {
  return backendFetch('/api/groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...identity('mona-invites', 'manager') },
    body: JSON.stringify({ name }),
  }) as Promise<{ id: number }>
}

test.describe('Scenario: an admin invites someone straight into workspaces (#134)', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('the invitation puts the new account into the workspaces picked, before its first sign-in',
    async ({ browser }) => {
    const site = await signInSite()
    const email = `julia-${Date.now()}@example.org`
    const names = [uniqueName('Pfarre Gars'), uniqueName('Stift Melk')]
    const workspaces = []
    for (const name of names) workspaces.push(await makeWorkspace(name))

    const admin = await signedInPage(browser, ROOT, ROOT_PASSWORD)
    await admin.goto(`${site}/admin`)
    const invite = admin.getByTestId('invite-person')
    await invite.getByRole('textbox', { name: 'Email' }).fill(email)
    await invite.getByTestId('invite-role').selectOption('annotator')
    await expect(invite.getByTestId('invite-workspaces')).toContainText('None')
    await invite.getByTestId('invite-workspaces').click()
    for (const name of names) await invite.getByRole('checkbox', { name }).check()
    await expect(invite.getByTestId('invite-workspaces')).toContainText(names.join(', '))
    await invite.getByRole('button', { name: 'Create link' }).click()

    await expect(admin.getByTestId('password-link-url')).toBeVisible()
    await expect(invite.getByTestId('invite-joined')).toHaveText(`Added to ${names.join(', ')}.`)
    for (const workspace of workspaces) {
      await expect.poll(() => membersOf(workspace.id)).toEqual([email, 'mona-invites'])
    }
    await expect(invite.getByTestId('invite-workspaces')).toContainText('None')

    // The workspace's Members already lists them, as invited until they first sign in.
    await admin.goto(`${site}/`)
    await admin.locator('section').filter({ hasText: names[0] }).getByTestId('group-members').click()
    const members = admin.getByRole('dialog', { name: `Members of "${names[0]}"` })
    await expect(members.locator(`[data-testid="member"][data-username="${email}"]`).getByTestId('member-role'))
      .toHaveText('Invited, not signed in yet')
    await expect(members.locator('[data-testid="member"][data-username="mona-invites"]').getByTestId('member-role'))
      .toHaveText('No active account')
  })

  test('approving a sign-up puts the person into the workspaces picked beside the role', async ({ page, browser }) => {
    const site = await signInSite()
    const email = `mia-${Date.now()}@example.org`
    const name = uniqueName('Stift Melk')
    const workspace = await makeWorkspace(name)
    await page.goto(`${site}/sign-up`)
    await page.getByTestId('sign-up-name').fill('Mia Example')
    await page.getByTestId('sign-up-email').fill(email)
    await page.getByTestId('new-password').fill('violet hinge saddle parade')
    await page.getByTestId('new-password-repeat').fill('violet hinge saddle parade')
    await page.getByTestId('sign-up-submit').click()
    await expect(page.getByTestId('pending-approval')).toBeVisible()

    const admin = await signedInPage(browser, ROOT, ROOT_PASSWORD)
    await admin.goto(`${site}/admin`)
    const row = admin.locator(`[data-testid="pending-user"][data-user="${email}"]`)
    await row.getByTestId('pending-role').selectOption('annotator')
    await row.getByTestId('pending-workspaces').click()
    await row.getByRole('checkbox', { name }).check()
    await expect(row.getByTestId('pending-workspaces')).toContainText(name)
    await row.getByTestId('approve').click()

    await expect(row).toHaveCount(0)
    await expect.poll(() => membersOf(workspace.id)).toEqual([email, 'mona-invites'])
  })
})
