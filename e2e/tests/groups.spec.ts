import { test, expect } from '../helpers/test'
import {
  createGroup, getJob, markLinesChecked, moveJobToGroup, seedCompletedJob,
  setCollapsedGroups, shareJob, uniqueName,
} from '../helpers/api'
import { seedSession, useSession } from '../helpers/session'
import { taskSection } from '../helpers/training'

test.describe('Scenario: the list as you left it', () => {
  test('a folded section is still folded after a reload', async ({ page }) => {
    // Settings belong to the signed-in person and every spec runs as the same one, so
    // whatever this finds is put back before it leaves.
    await setCollapsedGroups(page, [])
    const name = uniqueName('Folded group')
    const group = await createGroup(name)

    await page.goto('/')
    const section = page.locator('section').filter({ hasText: name })
    const header = section.getByRole('button', { name })
    await expect(header).toHaveAttribute('aria-expanded', 'true')
    await expect(section.getByText('No datasets in this group.')).toBeVisible()

    await header.click()
    await expect(section.getByText('No datasets in this group.')).toHaveCount(0)

    // The fold is kept with the account, not the browser: the server has it before the
    // reload, and the reload gets it back from there.
    await expect.poll(async () =>
      (await (await page.request.get('/api/settings')).json()).collapsed_groups)
      .toEqual([group.id])
    await page.reload()
    await expect(section.getByRole('button', { name })).toHaveAttribute('aria-expanded', 'false')
    await expect(section.getByText('No datasets in this group.')).toHaveCount(0)

    await setCollapsedGroups(page, [])
  })
})

test.describe('Scenario: organizing datasets in groups', () => {
  test('creating a group, moving a dataset in, and dissolving it again', async ({ page }) => {
    const jobName = uniqueName('Grouped')
    await seedCompletedJob(jobName, 1)
    const groupName = uniqueName('Project')

    await page.goto('/')
    await page.getByRole('button', { name: 'New group' }).click()
    await page.getByPlaceholder('Group name').fill(groupName)
    await page.keyboard.press('Enter')
    const header = page.locator('section', { hasText: groupName }).first()
    // The name is in two places now - the sidebar lists the groups and the section
    // heads its own datasets - so the assertion says which one it means.
    await expect(header.getByText(groupName)).toBeVisible()

    const card = page.getByTestId('job-card').filter({ hasText: jobName })
    await card.getByTestId('job-menu').click()
    await card.getByRole('button', { name: 'Move to group…' }).click()
    await page.locator('select').selectOption({ label: groupName })
    await page.getByRole('button', { name: 'Move', exact: true }).click()

    // The card now renders inside the group's section.
    await expect(header.getByTestId('job-card').filter({ hasText: jobName })).toBeVisible()

    // Collapsing hides the cards without losing them.
    await header.getByRole('button', { name: groupName }).click()
    await expect(header.getByTestId('job-card')).toHaveCount(0)
    await header.getByRole('button', { name: groupName }).click()
    await expect(header.getByTestId('job-card').filter({ hasText: jobName })).toBeVisible()

    // Deleting the group keeps the dataset and returns it to Ungrouped.
    page.on('dialog', (dialog) => dialog.accept())
    await header.getByRole('button', { name: 'Delete' }).first().click()
    await expect(page.getByText(groupName)).toHaveCount(0)
    await expect(page.getByTestId('job-card').filter({ hasText: jobName })).toBeVisible()
  })
})

test.describe('Scenario: what a group name gives away', () => {
  test('a member is not handed the names of projects they cannot reach', async ({ page, browser }) => {
    const username = `grouped-${Date.now()}`
    const token = seedSession('member', username)

    const theirs = uniqueName('Theirs')
    const notTheirs = uniqueName('Not theirs')
    const sharedJob = await seedCompletedJob(uniqueName('Shared set'), 1)
    const privateJob = await seedCompletedJob(uniqueName('Private set'), 1)
    const openGroup = await createGroup(theirs)
    const closedGroup = await createGroup(notTheirs)
    await moveJobToGroup(sharedJob, openGroup.id)
    await moveJobToGroup(privateJob, closedGroup.id)
    await shareJob(sharedJob, [username])
    await markLinesChecked(sharedJob, 2)
    await markLinesChecked(privateJob, 2)

    // The admin running the suite reaches both, so the absence below means something.
    const asAdmin = await (await page.request.get('/api/groups')).json()
    expect(asAdmin.map((g: { name: string }) => g.name)).toEqual(
      expect.arrayContaining([theirs, notTheirs]))

    const theirContext = await browser.newContext()
    await useSession(theirContext, token)
    const listed = await (await theirContext.request.get('/api/groups')).json()
    const names = listed.map((g: { name: string }) => g.name)
    expect(names).toContain(theirs)
    expect(names).not.toContain(notTheirs)

    // And the training dialog shows the one and not the other.
    const theirTab = await theirContext.newPage()
    await theirTab.goto('/models')
    const ocr = taskSection(theirTab, 'ocr')
    await ocr.getByTestId('train-model').click()
    await expect(theirTab.locator(`[data-testid="dataset-group"][data-group="${theirs}"]`))
      .toHaveCount(1)
    await expect(theirTab.locator(`[data-testid="dataset-group"][data-group="${notTheirs}"]`))
      .toHaveCount(0)
    await theirContext.close()
  })
})

test.describe('Scenario: one change applied to a whole group', () => {
  test('the settings reach every dataset in the group at once', async ({ page }) => {
    const groupName = uniqueName('Bulk settings')
    const group = await createGroup(groupName)
    const first = await seedCompletedJob(uniqueName('Bulk first'), 1)
    const second = await seedCompletedJob(uniqueName('Bulk second'), 1)
    const outside = await seedCompletedJob(uniqueName('Bulk outside'), 1)
    for (const jobId of [first, second]) await moveJobToGroup(jobId, group.id)
    expect(await getJob(first)).toMatchObject({ ocr_decode: 'beam', line_mode: 'per_crop' })

    await page.goto('/')
    const section = page.locator('section').filter({ hasText: groupName })
    await section.getByTestId('group-settings').click()

    await page.getByTestId('group-pick-decode').selectOption('greedy')
    await page.getByTestId('group-set-processing').check()
    await page.locator('[data-testid="group-line-mode-option"][data-mode="per_page"]').click()
    await page.getByTestId('group-settings-save').click()

    await expect(page.getByTestId('group-settings-changed')).toHaveText('2 datasets changed.')
    await page.getByTestId('group-settings-done').click()

    for (const jobId of [first, second]) {
      await expect.poll(async () => {
        const job = await getJob(jobId)
        return { decode: job.ocr_decode, mode: job.line_mode }
      }).toEqual({ decode: 'greedy', mode: 'per_page' })
    }
    // A dataset that is not in the group is not in the change.
    expect(await getJob(outside)).toMatchObject({ ocr_decode: 'beam', line_mode: 'per_crop' })
  })

  test('nothing is written until something is picked', async ({ page }) => {
    const groupName = uniqueName('Bulk untouched')
    const group = await createGroup(groupName)
    const jobId = await seedCompletedJob(uniqueName('Bulk untouched job'), 1)
    await moveJobToGroup(jobId, group.id)

    await page.goto('/')
    const section = page.locator('section').filter({ hasText: groupName })
    await section.getByTestId('group-settings').click()

    // Everything is on "leave as it is", so there is nothing to apply.
    await expect(page.getByTestId('group-settings-save')).toBeDisabled()
    await page.getByTestId('group-pick-decode').selectOption('greedy')
    await expect(page.getByTestId('group-settings-save')).toBeEnabled()
  })
})
