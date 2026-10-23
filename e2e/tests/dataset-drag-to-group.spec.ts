import type { Locator, Page } from '@playwright/test'
import { test, expect } from '../helpers/test'
import {
  createGroup, createJob, getJob, identity, moveJobToGroup, seedCompletedJob, shareJob, uniqueName,
  waitForJobStatus,
} from '../helpers/api'
import { asSession, seedSession, useSession } from '../helpers/session'

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const rowOf = (page: Page, name: string) => page.getByTestId('job-card').filter({ hasText: name })

const sectionOf = (page: Page, title: string) =>
  page.locator(`[data-testid="list-section"][data-title="${title}"]`)

const groupHeader = (page: Page, title: string) =>
  sectionOf(page, title).getByRole('button', { name: new RegExp(`${escape(title)}$`) })

const sidebarEntry = (page: Page, title: string) =>
  page.getByTestId('dataset-sidebar').getByRole('button', { name: new RegExp(`^${escape(title)}`) })

/** A real mouse drag, held over the target long enough to read what it says it will do. */
async function dragOnto(page: Page, source: Locator, target: Locator, whileOver: () => Promise<void>) {
  await source.hover()
  await page.mouse.down()
  await target.hover({ position: { x: 8, y: 8 } })
  await target.hover({ position: { x: 12, y: 8 } })
  await whileOver()
  await page.mouse.up()
}

test.describe('Scenario: filing datasets by dragging them onto a group', () => {
  // A drag that has to scroll the list to reach its target loses the drop. Late in a run
  // the list holds every dataset the run made, so the scenarios list newest first - what
  // they just made at the top of its section - on a screen tall enough for the headers.
  test.use({ viewport: { width: 1280, height: 2400 } })

  test('one dataset dropped on a group header moves there', async ({ page }) => {
    const groupName = uniqueName('Drag target')
    const group = await createGroup(groupName)
    const name = uniqueName('Drag one')
    const jobId = await seedCompletedJob(name, 1)
    const bystander = await seedCompletedJob(uniqueName('Drag bystander'), 1)

    await page.goto('/?sort=newest')
    const section = sectionOf(page, groupName)
    await dragOnto(page, rowOf(page, name).getByRole('link', { name, exact: true }),
                   groupHeader(page, groupName), async () => {
      await expect(section.getByTestId('drop-hint')).toHaveText(`Move 1 dataset to ${groupName}`)
      await expect(section.locator('[data-drop-active]')).toHaveCount(1)
    })

    await expect.poll(async () => (await getJob(jobId)).group_id).toBe(group.id)
    expect((await getJob(bystander)).group_id).toBeNull()
    await expect(page.getByTestId('drop-hint')).toHaveCount(0)
    await expect(section.locator('[data-drop-active]')).toHaveCount(0)
  })

  test('dragging a ticked dataset carries the whole selection to a group in the side list',
       async ({ page }) => {
    const groupName = uniqueName('Drag side')
    const group = await createGroup(groupName)
    const names = [uniqueName('Drag picked a'), uniqueName('Drag picked b')]
    const picked = [await seedCompletedJob(names[0], 1), await seedCompletedJob(names[1], 1)]
    const leftName = uniqueName('Drag not picked')
    const left = await seedCompletedJob(leftName, 1)

    await page.goto('/?sort=newest')
    for (const name of names) await rowOf(page, name).getByRole('checkbox').check()
    await expect(page.getByTestId('bulk-bar')).toContainText('2 selected')

    const entry = sidebarEntry(page, groupName)
    await dragOnto(page, rowOf(page, names[1]).getByRole('link', { name: names[1], exact: true }),
                   entry, async () => {
      await expect(entry.getByTestId('drop-hint')).toHaveText(`Move 2 datasets to ${groupName}`)
    })

    for (const jobId of picked) {
      await expect.poll(async () => (await getJob(jobId)).group_id).toBe(group.id)
    }
    expect((await getJob(left)).group_id).toBeNull()
    await expect(rowOf(page, leftName)).toHaveCount(1)
    await expect(page.getByTestId('bulk-bar')).toHaveCount(0)
  })

  test('an unticked dataset dragged beside a selection moves alone and keeps the selection',
       async ({ page }) => {
    const groupName = uniqueName('Drag alone')
    const group = await createGroup(groupName)
    const tickedName = uniqueName('Drag ticked')
    const ticked = await seedCompletedJob(tickedName, 1)
    const draggedName = uniqueName('Drag unticked')
    const dragged = await seedCompletedJob(draggedName, 1)

    await page.goto('/?sort=newest')
    await rowOf(page, tickedName).getByRole('checkbox').check()
    const header = groupHeader(page, groupName)
    await dragOnto(page, rowOf(page, draggedName).getByRole('link', { name: draggedName, exact: true }),
                   header, async () => {
      await expect(sectionOf(page, groupName).getByTestId('drop-hint')).toHaveText(`Move 1 dataset to ${groupName}`)
    })

    await expect.poll(async () => (await getJob(dragged)).group_id).toBe(group.id)
    expect((await getJob(ticked)).group_id).toBeNull()
    await expect(page.getByTestId('bulk-bar')).toContainText('1 selected')
  })

  test('a card dropped on Ungrouped leaves its group', async ({ page }) => {
    const groupName = uniqueName('Drag leave')
    const group = await createGroup(groupName)
    const name = uniqueName('Drag out')
    const jobId = await seedCompletedJob(name, 1)
    await moveJobToGroup(jobId, group.id)

    await page.goto('/?view=cards&sort=newest')
    const header = groupHeader(page, 'Ungrouped')
    await dragOnto(page, rowOf(page, name).getByRole('link', { name, exact: true }), header, async () => {
      await expect(sectionOf(page, 'Ungrouped').getByTestId('drop-hint')).toHaveText('Remove 1 dataset from its group')
    })

    await expect.poll(async () => (await getJob(jobId)).group_id).toBeNull()
  })

  test('a dragged selection holding a dataset that is not yours names it and moves the rest',
       async ({ browser }) => {
    const username = `dragger-${Date.now()}`
    const session = seedSession('member', username)
    const ownName = uniqueName('Drag mine')
    const own = await createJob(ownName, 1, undefined, identity(username, 'member'))
    const sharedName = uniqueName('Drag only shared')
    const shared = await seedCompletedJob(sharedName, 1)
    await shareJob(shared, [username])
    await waitForJobStatus(own, 'done')

    const targetName = uniqueName('Drag member target')
    const created = await asSession(session, '/api/groups', {
      method: 'POST', body: JSON.stringify({ name: targetName }),
    })
    expect(created.status).toBe(200)
    const target = (await created.json()) as { id: number }

    const context = await browser.newContext()
    await useSession(context, session)
    const page = await context.newPage()
    await page.goto('/?sort=newest')
    for (const name of [ownName, sharedName]) await rowOf(page, name).getByRole('checkbox').check()

    const header = groupHeader(page, targetName)
    await dragOnto(page, rowOf(page, ownName).getByRole('link', { name: ownName, exact: true }),
                   header, async () => {
      await expect(sectionOf(page, targetName).getByTestId('drop-hint')).toHaveText(`Move 2 datasets to ${targetName}`)
    })

    await expect.poll(async () => (await getJob(own)).group_id).toBe(target.id)
    expect((await getJob(shared)).group_id).toBeNull()
    await expect(page.getByText(new RegExp(`1 moved; 1 skipped: ${escape(sharedName)} \\(`)))
      .toBeVisible()
    await context.close()
  })

  test('a viewer cannot drag a dataset', async ({ browser, page }) => {
    const name = uniqueName('Drag viewed')
    const jobId = await seedCompletedJob(name, 1)
    const username = `drag-viewer-${Date.now()}`
    await shareJob(jobId, [username])

    await page.goto('/?sort=newest')
    await expect(rowOf(page, name)).toHaveAttribute('draggable', 'true')

    const context = await browser.newContext()
    await useSession(context, seedSession('viewer', username))
    const viewerPage = await context.newPage()
    await viewerPage.goto('/')
    await expect(rowOf(viewerPage, name)).toHaveCount(1)
    await expect(rowOf(viewerPage, name)).toHaveAttribute('draggable', 'false')
    await context.close()
  })
})
