import { test, expect } from '../helpers/test'
import {
  BACKEND, createGroup, getJob, jobPageIds, moveJobToGroup, pageDeletedFlags, seedCompletedJob,
  setPagesDeleted, shareGroup, shareJob, uniqueName,
} from '../helpers/api'
import { seedSession, useSession } from '../helpers/session'
import { LANDSCAPE, openViewer } from '../helpers/viewer'

test.describe('Scenario: role-based access', () => {
  test('a viewer gets a read-only interface and the backend refuses writes', async ({ page }) => {
    const name = uniqueName('Readonly')
    const jobId = await seedCompletedJob(name, 1, LANDSCAPE)
    const username = `viewer-${Date.now()}`
    // Its admin creator is offered the download and the dataset's menus, so the locators
    // the viewer is checked against below are sound.
    await page.goto('/')
    await expect(page.getByTestId('job-card').filter({ hasText: name }).getByRole('button', { name: 'Download' }))
      .toBeVisible()
    await page.goto(`/jobs/${jobId}`)
    await expect(page.getByTestId('dataset-more')).toBeVisible()
    await expect(page.getByTestId('dataset-run')).toBeVisible()
    await useSession(page.context(), seedSession('viewer', username))
    await shareJob(jobId, [username])

    await page.goto('/')
    await page.getByTestId('user-menu').click()
    await expect(page.getByTestId('profile-name')).toHaveText(username)
    await expect(page.getByTestId('profile-role')).toHaveText('Viewer')
    await page.goto('/')
    await expect(page.getByRole('link', { name: 'New job' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Admin' })).toHaveCount(0)
    // The dataset's name is the link to it; the card carries no second one.
    const card = page.getByTestId('job-card').filter({ hasText: name })
    await expect(card.getByRole('link', { name })).toBeVisible()

    // A viewer can open it, but exporting is a Manager's, and there is no management menu.
    await expect(card.getByRole('button', { name: 'Download' })).toHaveCount(0)
    await expect(card.getByTestId('job-menu')).toHaveCount(0)

    await page.goto(`/jobs/${jobId}`)
    await expect(page.locator('tbody tr')).toHaveCount(1)
    // Nothing in the Run or More menus is a viewer's to use, so there are no menus.
    await expect(page.getByTestId('dataset-more')).toHaveCount(0)
    await expect(page.getByTestId('dataset-run')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Add pages' })).toHaveCount(0)

    // The backend enforces the role itself, independent of the UI.
    const res = await fetch(`${BACKEND}/api/jobs/${jobId}/cancel`, {
      method: 'POST',
      headers: { 'X-Frontend-Secret': 'e2e-secret', 'X-Auth-User': username, 'X-Auth-Role': 'viewer' },
    })
    expect(res.status).toBe(403)
  })

  test("an Annotator can annotate and create, but not manage someone else's dataset", async ({ page }) => {
    const name = uniqueName('Annotator work')
    const jobId = await seedCompletedJob(name, 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)
    const username = `annotator-${Date.now()}`
    await useSession(page.context(), seedSession('annotator', username))
    await shareJob(jobId, [username])

    await page.goto('/')
    // Annotators create their own datasets - the entry point is visible for them.
    await expect(page.getByRole('link', { name: 'New job' })).toBeVisible()
    // A shared dataset they do not own still offers no management menu.
    await expect(page.getByTestId('job-card').filter({ hasText: name }).getByTestId('job-menu')).toHaveCount(0)

    // The backend enforces the role itself: deleting someone else's dataset is refused.
    const res = await fetch(`${BACKEND}/api/jobs/${jobId}`, {
      method: 'DELETE',
      headers: { 'X-Frontend-Secret': 'e2e-secret', 'X-Auth-User': username, 'X-Auth-Role': 'annotator' },
    })
    expect(res.status).toBe(403)

    await openViewer(page, jobId, pageId)
    await expect(page.getByRole('button', { name: /^Edit/ })).toBeVisible()
  })

  test('a Manager deletes and restores pages, a viewer can do neither', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Member pages'), 2, LANDSCAPE)
    const [firstPageId] = await jobPageIds(jobId)
    await setPagesDeleted(jobId, [firstPageId])
    const stamp = Date.now()
    const viewer = `viewer-${stamp}`
    const member = `member-${stamp}`
    await shareJob(jobId, [viewer, member])
    const row = (filename: string) => page.getByRole('row').filter({ hasText: filename })
    const deleteButton = page.getByRole('button', { name: 'Delete', exact: true })

    await useSession(page.context(), seedSession('viewer', viewer))
    await page.goto(`/jobs/${jobId}`)
    await expect(row('scan_2.png')).toHaveCount(1)
    await expect(row('scan_1.png')).toHaveCount(0)
    await expect(page.getByTestId('page-filter-all')).toHaveText('All · 1')
    await expect(page.getByTestId('page-filter-deleted')).toHaveCount(0)
    await row('scan_2.png').getByRole('checkbox').click()
    await expect(page.getByText('1 selected')).toBeVisible()
    await expect(deleteButton).toHaveCount(0)
    // A deep link into the Deleted filter is no way round it either.
    await page.goto(`/jobs/${jobId}?filter=deleted`)
    await expect(row('scan_2.png')).toHaveCount(1)
    await expect(row('scan_1.png')).toHaveCount(0)

    await useSession(page.context(), seedSession('manager', member))
    await page.goto(`/jobs/${jobId}`)
    await expect(page.getByTestId('page-filter-deleted')).toHaveText('Deleted · 1')
    await page.getByTestId('page-filter-deleted').click()
    await expect(row('scan_1.png')).toHaveCount(1)
    await expect(row('scan_2.png')).toHaveCount(0)
    await row('scan_1.png').getByRole('checkbox').click()
    await page.getByRole('button', { name: 'Restore 1' }).click()
    await expect.poll(() => pageDeletedFlags(jobId)).toEqual([false, false])

    await page.getByTestId('page-filter-all').click()
    await expect(page.getByTestId('page-filter-all')).toHaveText('All · 2')
    await row('scan_2.png').getByRole('checkbox').click()
    await deleteButton.click()
    await expect.poll(() => pageDeletedFlags(jobId)).toEqual([false, true])
    await expect(row('scan_2.png')).toHaveCount(0)
    await expect(page.getByTestId('page-filter-all')).toHaveText('All · 1')
  })

  test('non-admins only see datasets shared with them', async ({ page }) => {
    const visibleName = uniqueName('Shared')
    const hiddenName = uniqueName('Hidden')
    const visibleId = await seedCompletedJob(visibleName, 1, LANDSCAPE)
    const hiddenId = await seedCompletedJob(hiddenName, 1, LANDSCAPE)
    const username = `scoped-${Date.now()}`
    await useSession(page.context(), seedSession('manager', username))
    await shareJob(visibleId, [username])

    await page.goto('/')
    await expect(page.getByTestId('job-card').filter({ hasText: visibleName })).toBeVisible()
    await expect(page.getByTestId('job-card').filter({ hasText: hiddenName })).toHaveCount(0)

    // Deep links to datasets they cannot reach are refused as if they did not exist.
    const res = await fetch(`${BACKEND}/api/jobs/${hiddenId}`, {
      headers: { 'X-Frontend-Secret': 'e2e-secret', 'X-Auth-User': username, 'X-Auth-Role': 'manager' },
    })
    expect(res.status).toBe(404)
  })

  test('sharing a group covers every dataset in it, now and later', async ({ page }) => {
    const groupName = uniqueName('Volume I')
    const insideName = uniqueName('Inside')
    const laterName = uniqueName('Added later')
    const outsideName = uniqueName('Outside')
    const group = await createGroup(groupName)
    const insideId = await seedCompletedJob(insideName, 1, LANDSCAPE)
    const laterId = await seedCompletedJob(laterName, 1, LANDSCAPE)
    const outsideId = await seedCompletedJob(outsideName, 1, LANDSCAPE)
    await moveJobToGroup(insideId, group.id)
    const username = `reader-${Date.now()}`
    await useSession(page.context(), seedSession('reviewer', username))
    await shareGroup(group.id, [username])

    await page.goto('/')
    await expect(page.getByTestId('job-card').filter({ hasText: insideName })).toBeVisible()
    await expect(page.getByTestId('job-card').filter({ hasText: outsideName })).toHaveCount(0)

    // A dataset moved into the group afterwards is covered by the same share.
    await moveJobToGroup(laterId, group.id)
    await page.reload()
    await expect(page.getByTestId('job-card').filter({ hasText: laterName })).toBeVisible()

    // The backend agrees: in-group readable, out-of-group invisible.
    const headers = {
      'X-Frontend-Secret': 'e2e-secret', 'X-Auth-User': username, 'X-Auth-Role': 'reviewer',
    }
    expect((await fetch(`${BACKEND}/api/jobs/${laterId}`, { headers })).status).toBe(200)
    expect((await fetch(`${BACKEND}/api/jobs/${outsideId}`, { headers })).status).toBe(404)

    // Sharing a group with a Reviewer hands out no Manager's powers.
    const del = await fetch(`${BACKEND}/api/jobs/${insideId}`, { method: 'DELETE', headers })
    expect(del.status).toBe(403)
    expect((await getJob(insideId)).name).toBe(insideName)
  })
})
