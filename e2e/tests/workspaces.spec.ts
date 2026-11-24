import { test, expect } from '../helpers/test'
import {
  SEEDER_SANDBOX, backendFetch, createGroup, createJob, identity, shareGroup, uniqueName, waitForJobStatus,
} from '../helpers/api'
import { scanPng } from '../helpers/image'
import { createDataset } from '../helpers/new-dataset'
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

    // Members says why nobody is added to a Sandbox, without asking for the people she may not list.
    await card.getByTestId('job-menu').click()
    await card.getByRole('button', { name: 'Members…' }).click()
    await expect(lenaPage.getByTestId('share-sandboxed')).toHaveText(
      'It is in your Sandbox, which only you can see. To share it, move it into a workspace: everyone in that workspace can then open it.')
    await expect(lenaPage.getByRole('alert')).toHaveCount(0)
    await lenaPage.getByRole('button', { name: 'Cancel' }).click()

    await card.getByRole('checkbox').check()
    await lenaPage.getByRole('button', { name: 'Move to workspace…' }).click()
    await lenaPage.getByRole('button', { name: workspace.name, exact: true }).click()
    await expect.poll(async () => (await groupOf(jobId)).id).toBe(workspace.id)
    // In the workspace, adding people is its Managers', so an Annotator is offered no Members.
    await lenaPage.reload()
    await card.getByTestId('job-menu').click()
    await expect(card.getByRole('button', { name: 'Settings…' })).toBeVisible()
    await expect(card.getByRole('button', { name: 'Members…' })).toHaveCount(0)

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
    await page.getByRole('button', { name: 'New workspace' }).click()
    await page.getByPlaceholder('Workspace name').fill(name)
    await page.keyboard.press('Enter')
    const section = page.locator(`[data-testid="list-section"][data-title="${name}"]`)
    await section.getByTestId('group-members').click()
    await page.getByRole('combobox', { name: 'Add someone' }).fill(ben)
    await page.getByRole('option', { name: new RegExp(ben) }).click()
    await page.getByRole('button', { name: 'Done' }).click()
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
    await expect(benSection.getByTestId('group-members')).toHaveCount(0)
    await benContext.close()
    await monaContext.close()
  })
})

test.describe('Scenario: making a dataset in a workspace (#131)', () => {
  test('a workspace\'s + opens the wizard there, and the next one starts there too', async ({ browser }) => {
    const stamp = Date.now()
    const lena = `lena-${stamp}`
    const workspace = await createGroup(uniqueName('Kanzlei'))
    await shareGroup(workspace.id, [lena])
    const context = await browser.newContext()
    await useSession(context, seedSession('annotator', lena))
    const page = await context.newPage()

    await page.goto('/')
    const sidebar = page.getByTestId('dataset-sidebar')
    await expect(sidebar.getByRole('link', { name: `New dataset in ${workspace.name}` })).toHaveCount(1)
    await page.locator(`[data-testid="list-section"][data-title="${workspace.name}"]`)
      .getByRole('link', { name: `New dataset in ${workspace.name}` }).click()
    const field = page.getByLabel('Workspace')
    await expect(field.locator('option:checked')).toHaveText(workspace.name)
    await expect(page.getByTestId('job-workspace-note')).toHaveText(`Everyone in ${workspace.name} can open it.`)

    const name = uniqueName('Made in a workspace')
    await page.getByLabel('Job name').fill(name)
    await page.locator('input[type="file"]').setInputFiles(
      [{ name: 'page_a.png', mimeType: 'image/png', buffer: scanPng() }])
    await createDataset(page)
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)
    const jobId = page.url().split('/').pop()!
    await expect.poll(async () => (await groupOf(jobId)).id).toBe(workspace.id)

    // Opened plainly, the wizard starts where the newest dataset was made.
    await page.goto('/new')
    await expect(page.getByLabel('Workspace').locator('option:checked')).toHaveText(workspace.name)
    await page.getByLabel('Workspace').selectOption({ label: 'Your Sandbox' })
    await expect(page.getByTestId('job-workspace-note')).toHaveText(
      'Only you can see it there, until you move it into a workspace.')
    await context.close()
  })
})

test.describe('Scenario: what someone given one dataset sees of its workspace (#131)', () => {
  test('the dataset is shared with them; the workspace and its name stay out of sight', async ({ page, browser }) => {
    const stamp = Date.now()
    const rita = `rita-${stamp}`
    const lena = `lena-${stamp}`
    const workspace = await createGroup(uniqueName('Pfarre'))
    await shareGroup(workspace.id, [lena])
    const name = uniqueName('Taufbuch')
    const jobId = await createJob(name, 1)
    await waitForJobStatus(jobId, 'done')
    await backendFetch(`/api/jobs/${jobId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ group_id: workspace.id }) })
    await backendFetch(`/api/jobs/${jobId}/share`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usernames: [rita] }) })

    // A member sees the workspace with the dataset in it: the locators are sound.
    const lenaContext = await browser.newContext()
    await useSession(lenaContext, seedSession('annotator', lena))
    const lenaPage = await lenaContext.newPage()
    await lenaPage.goto('/')
    await expect(lenaPage.locator(`[data-testid="list-section"][data-title="${workspace.name}"]`)
      .getByTestId('job-card').filter({ hasText: name })).toHaveCount(1)
    await expect(lenaPage.getByText(workspace.name).first()).toBeVisible()
    await lenaContext.close()

    await useSession(page.context(), seedSession('reviewer', rita))
    await page.goto('/')
    await expect(page.locator('[data-testid="list-section"][data-title="Shared with you"]')
      .getByTestId('job-card').filter({ hasText: name })).toHaveCount(1)
    await expect(page.locator(`[data-testid="list-section"][data-title="${workspace.name}"]`)).toHaveCount(0)
    await expect(page.getByText(workspace.name)).toHaveCount(0)
  })
})

test.describe('Scenario: moving a dataset back into its Sandbox (#131)', () => {
  test('the Move dialog names who loses it, and they do', async ({ page }) => {
    const ben = `ben-${Date.now()}`
    seedSession('reviewer', ben)
    const workspace = await createGroup(uniqueName('Briefe'))
    const name = uniqueName('Brief 1802')
    const jobId = await createJob(name, 1)
    await waitForJobStatus(jobId, 'done')
    await backendFetch(`/api/jobs/${jobId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ group_id: workspace.id }) })
    await backendFetch(`/api/jobs/${jobId}/share`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usernames: [ben] }) })

    await page.goto('/')
    const card = page.getByTestId('job-card').filter({ hasText: name })
    await card.getByTestId('job-menu').click()
    await card.getByRole('button', { name: 'Move to workspace…' }).click()
    const warning = page.getByTestId('move-loses-people')
    await expect(warning).toHaveCount(0)
    await page.getByLabel('Move to').selectOption({ label: SEEDER_SANDBOX })
    await expect(warning).toHaveText(`${ben} was given this dataset. In e2e-seeder's Sandbox it is private, so they lose it.`)
    await page.getByRole('button', { name: 'Move', exact: true }).click()

    await expect.poll(async () => (await groupOf(jobId)).sandbox_of).toBe('e2e-seeder')
    expect((await backendFetch(`/api/jobs/${jobId}?pages=false`)).shared_with).toEqual([])
  })
})

test.describe('Scenario: an admin\'s list keeps other people\'s Sandboxes apart (#131)', () => {
  test('they come last, under their own heading, each marked private', async ({ page }) => {
    const lena = `lena-${Date.now()}`
    const name = uniqueName('Lenas own')
    const jobId = await createJob(name, 1, undefined, identity(lena, 'annotator'))
    await waitForJobStatus(jobId, 'done')

    await page.goto('/')
    const sections = page.getByTestId('list-section')
    await expect(page.locator(`[data-testid="list-section"][data-title="${lena}'s Sandbox"]`)
      .getByTestId('job-card').filter({ hasText: name })).toHaveCount(1)
    const titles = await sections.evaluateAll((all) => all.map((s) => s.getAttribute('data-title')))
    const theirs = titles.indexOf(`${lena}'s Sandbox`)
    expect(theirs).toBeGreaterThan(-1)
    // Everything after the first other Sandbox is another Sandbox: none of them sit among the workspaces.
    const firstOther = titles.findIndex((t) => t !== null && t.endsWith("'s Sandbox"))
    expect(titles.slice(firstOther).every((t) => t !== null && t.endsWith("'s Sandbox"))).toBe(true)
    await expect(page.getByTestId('other-sandboxes')).toHaveCount(1)
    await expect(sections.nth(theirs).getByTestId('sandbox-private')).toHaveText('Private')
    await expect(page.getByTestId('dataset-sidebar').getByRole('button', { name: new RegExp(`^${lena}`) }))
      .toHaveCount(1)
  })
})
