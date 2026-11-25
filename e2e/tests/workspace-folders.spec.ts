import type { Browser, Locator, Page } from '@playwright/test'
import { test, expect } from '../helpers/test'
import { backendFetch, getJob, identity, moveJobToGroup, patchJob, seedCompletedJob, shareGroup, uniqueName } from '../helpers/api'
import { seedSession, useSession } from '../helpers/session'

type Folder = { id: number; name: string; parent_id: number | null }

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const rowOf = (page: Page, name: string) => page.getByTestId('job-card').filter({ hasText: name })

const sectionOf = (page: Page, title: string) => page.locator(`[data-testid="list-section"][data-title="${title}"]`)

const workspaceHeader = (page: Page, title: string) => sectionOf(page, title).getByTestId('section-header')

const folderOf = (page: Page, name: string) => page.locator(`[data-testid="folder-section"][data-title="${name}"]`)

const folderHeader = (page: Page, name: string) =>
  page.locator(`[data-testid="folder-section"][data-title="${name}"] > [data-testid="folder-header"]`)

/** One of the actions in a folder heading's menu. */
async function folderAction(page: Page, name: string, action: string) {
  await folderHeader(page, name).getByTestId('folder-menu').click()
  await folderHeader(page, name).getByTestId(action).click()
}

const rail = (page: Page) => page.getByTestId('dataset-sidebar')

const railFolder = (page: Page, name: string) =>
  rail(page).getByTestId('rail-folder').filter({ has: page.getByText(name, { exact: true }) })

async function foldersOf(groupId: number): Promise<{ name: string; parent: string | null }[]> {
  const group = (await backendFetch('/api/groups') as { id: number; folders: Folder[] }[]).find((g) => g.id === groupId)!
  const named = new Map(group.folders.map((f) => [f.id, f.name]))
  return group.folders.map((f) => ({ name: f.name, parent: f.parent_id === null ? null : named.get(f.parent_id)! }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

async function folderId(groupId: number, name: string): Promise<number> {
  const group = (await backendFetch('/api/groups') as { id: number; folders: Folder[] }[]).find((g) => g.id === groupId)!
  return group.folders.find((f) => f.name === name)!.id
}

function makeFolder(groupId: number, name: string, parentId: number | null, who: string): Promise<Folder> {
  return backendFetch(`/api/groups/${groupId}/folders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...identity(who, 'manager') },
    body: JSON.stringify({ name, parent_id: parentId }),
  }) as Promise<Folder>
}

/** A real mouse drag, held over the target long enough to read what it says it will do. */
async function dragOnto(page: Page, source: Locator, target: Locator, whileOver: () => Promise<void>) {
  await source.hover()
  await page.mouse.down()
  await target.hover({ position: { x: 8, y: 8 } })
  await target.hover({ position: { x: 12, y: 8 } })
  await whileOver()
  await page.mouse.up()
}

/** Mona's workspace with datasets the seeder made and moved in; she is a Manager in it. */
async function monasWorkspace(browser: Browser, datasets: string[]) {
  const mona = `mona-${Date.now()}`
  const session = seedSession('manager', mona)
  const name = uniqueName('Pfarre Gars')
  const workspace = await backendFetch('/api/groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...identity(mona, 'manager') },
    body: JSON.stringify({ name }),
  }) as { id: number }
  await shareGroup(workspace.id, [mona])
  const ids: string[] = []
  for (const dataset of datasets) {
    const jobId = await seedCompletedJob(dataset, 1)
    await moveJobToGroup(jobId, workspace.id)
    ids.push(jobId)
  }
  const context = await browser.newContext()
  await useSession(context, session)
  const page = await context.newPage()
  await page.goto('/?sort=name')
  return { mona, name, workspace, ids, page }
}

test.describe('Scenario: a Manager sorts a workspace of datasets into nested folders (#133)', () => {
  test.use({ viewport: { width: 1280, height: 1600 } })

  test('folders are made, datasets filed into them, and the rail lists a folder with everything below it',
    async ({ browser }) => {
    const names = [uniqueName('Taufbuch 1891'), uniqueName('Taufbuch 1892'), uniqueName('Urbar 1750')]
    const { name, workspace, ids, page } = await monasWorkspace(browser, names)
    const matriken = uniqueName('Matriken')
    const taufbuecher = uniqueName('Taufbücher')

    await workspaceHeader(page, name).getByTestId('folder-new').click()
    const make = page.getByRole('dialog', { name: `New folder in "${name}"` })
    await make.getByRole('textbox', { name: 'Name' }).fill(matriken)
    await make.getByRole('button', { name: 'Create' }).click()
    await expect.poll(() => foldersOf(workspace.id)).toEqual([{ name: matriken, parent: null }])

    await folderAction(page, matriken, 'folder-new')
    const inside = page.getByRole('dialog', { name: `New folder in "${matriken}"` })
    await inside.getByRole('textbox', { name: 'Name' }).fill(taufbuecher)
    await inside.getByRole('button', { name: 'Create' }).click()
    await expect.poll(() => foldersOf(workspace.id))
      .toEqual([{ name: matriken, parent: null }, { name: taufbuecher, parent: matriken }])

    // Both Taufbücher go in from the bulk bar, which lists each workspace's folders under it.
    for (const dataset of names.slice(0, 2)) await rowOf(page, dataset).getByRole('checkbox').check()
    await page.getByTestId('bulk-bar').getByRole('button', { name: /Move to/ }).click()
    await page.getByTestId('move-folder').filter({ hasText: taufbuecher }).click()
    const inTaufbuecher = await folderId(workspace.id, taufbuecher)
    for (const jobId of ids.slice(0, 2)) {
      await expect.poll(async () => (await getJob(jobId)).folder_id).toBe(inTaufbuecher)
    }
    await expect(folderOf(page, taufbuecher).getByTestId('job-card')).toHaveCount(2)
    expect((await getJob(ids[2])).folder_id).toBeNull()

    // The Urbar goes into Matriken by a drop on it in the rail, unfolded first.
    await rail(page).getByRole('button', { name: `Show the folders of ${name}` }).click()
    await expect(railFolder(page, matriken)).toBeVisible()
    await expect(railFolder(page, taufbuecher)).toHaveCount(0)
    await rail(page).getByRole('button', { name: `Show the folders of ${matriken}` }).click()
    await expect(railFolder(page, taufbuecher)).toContainText('2')
    await dragOnto(page, rowOf(page, names[2]).getByRole('link', { name: names[2], exact: true }),
                   railFolder(page, matriken), async () => {
      await expect(railFolder(page, matriken).getByTestId('drop-hint')).toHaveText(`Move 1 dataset to ${matriken}`)
    })
    const inMatriken = await folderId(workspace.id, matriken)
    await expect.poll(async () => (await getJob(ids[2])).folder_id).toBe(inMatriken)
    await expect(railFolder(page, matriken)).toContainText('3')

    // Picking a folder lists it with what is below it; the dataset stays in its workspace.
    await railFolder(page, taufbuecher).click()
    await expect(page).toHaveURL(new RegExp(`folder=${inTaufbuecher}`))
    await expect(page.getByTestId('job-card')).toHaveCount(2)
    await railFolder(page, matriken).click()
    await expect(page.getByTestId('job-card')).toHaveCount(3)
    expect((await getJob(ids[2])).group_id).toBe(workspace.id)

    // A folder folds away like a workspace does.
    await folderHeader(page, taufbuecher).getByRole('button', { name: taufbuecher, exact: true }).click()
    await expect(rowOf(page, names[0])).toHaveCount(0)
    await expect(rowOf(page, names[2])).toBeVisible()
    await folderHeader(page, taufbuecher).getByRole('button', { name: taufbuecher, exact: true }).click()
    await expect(rowOf(page, names[0])).toBeVisible()
  })

  test('a folder moves within its workspace, and deleting one moves what it held up a level',
    async ({ browser }) => {
    const names = [uniqueName('Taufbuch 1891'), uniqueName('Sterbebuch 1891')]
    const { mona, name, workspace, ids, page } = await monasWorkspace(browser, names)
    const matriken = await makeFolder(workspace.id, uniqueName('Matriken'), null, mona)
    const taufbuecher = await makeFolder(workspace.id, uniqueName('Taufbücher'), null, mona)
    const beilagen = await makeFolder(workspace.id, uniqueName('Beilagen'), null, mona)
    await patchJob(ids[0], { folder_id: taufbuecher.id })
    await patchJob(ids[1], { folder_id: matriken.id })
    await page.reload()

    // Picking the workspace keeps its empty folder; picking a folder shows only the way down to it.
    const workspaceInRail = rail(page).getByRole('button', { name: new RegExp(`^${escape(name)}`) })
    await workspaceInRail.click()
    await expect(folderOf(page, beilagen.name)).toBeVisible()
    await rail(page).getByRole('button', { name: `Show the folders of ${name}` }).click()
    await railFolder(page, taufbuecher.name).click()
    await expect(folderOf(page, taufbuecher.name).getByTestId('job-card')).toHaveCount(1)
    await expect(folderOf(page, beilagen.name)).toHaveCount(0)
    await workspaceInRail.click()

    // A search hides the folders with nothing matching it.
    await expect(folderOf(page, beilagen.name)).toBeVisible()
    await page.locator('#dataset-search').fill(names[0])
    await expect(folderOf(page, taufbuecher.name)).toBeVisible()
    await expect(folderOf(page, beilagen.name)).toHaveCount(0)
    await page.locator('#dataset-search').fill('')

    await folderAction(page, taufbuecher.name, 'folder-move')
    const move = page.getByRole('dialog', { name: `Move folder "${taufbuecher.name}"` })
    await expect(move.getByRole('combobox', { name: 'Into' }).locator('option'))
      .toHaveText([`The top of ${name}`, beilagen.name, matriken.name])
    await move.getByRole('combobox', { name: 'Into' }).selectOption({ label: matriken.name })
    await move.getByRole('button', { name: 'Move' }).click()
    await expect.poll(() => foldersOf(workspace.id)).toEqual([
      { name: beilagen.name, parent: null }, { name: matriken.name, parent: null },
      { name: taufbuecher.name, parent: matriken.name }].sort((a, b) => a.name.localeCompare(b.name)))
    await expect(folderOf(page, matriken.name).locator('[data-testid="folder-section"]'))
      .toHaveAttribute('data-title', taufbuecher.name)

    // Beilagen goes into Matriken too, by a drag in the rail, and back to the top.
    await dragOnto(page, railFolder(page, beilagen.name), railFolder(page, matriken.name), async () => {
      await expect(railFolder(page, matriken.name).getByTestId('drop-hint'))
        .toHaveText(`Move ${beilagen.name} into ${matriken.name}`)
    })
    await expect.poll(async () => (await foldersOf(workspace.id)).find((f) => f.name === beilagen.name)?.parent)
      .toBe(matriken.name)
    await rail(page).getByRole('button', { name: `Show the folders of ${matriken.name}` }).click()
    await dragOnto(page, railFolder(page, beilagen.name),
                   rail(page).getByRole('button', { name: new RegExp(`^${escape(name)}`) }), async () => {
      await expect(rail(page).getByTestId('drop-hint')).toHaveText(`Move ${beilagen.name} to the top of ${name}`)
    })
    await expect.poll(async () => (await foldersOf(workspace.id)).find((f) => f.name === beilagen.name)?.parent)
      .toBeNull()

    await folderAction(page, matriken.name, 'folder-delete')
    const remove = page.getByRole('dialog', { name: `Delete folder "${matriken.name}"` })
    await expect(remove).toContainText(`The 1 dataset and 1 folder in it move to the top of ${name}.`)
    await remove.getByRole('button', { name: 'Delete' }).click()
    await expect.poll(() => foldersOf(workspace.id)).toEqual([
      { name: beilagen.name, parent: null }, { name: taufbuecher.name, parent: null }]
      .sort((a, b) => a.name.localeCompare(b.name)))
    expect((await getJob(ids[0])).folder_id).toBe(taufbuecher.id)
    expect(await getJob(ids[1])).toMatchObject({ folder_id: null, group_id: workspace.id })
    await expect(folderOf(page, matriken.name)).toHaveCount(0)
  })

  test('a dataset\'s Move dialog picks the folder, and an Annotator sees the folders but makes none',
    async ({ browser }) => {
    const names = [uniqueName('Firmbuch 1900')]
    const { mona, name, workspace, ids, page } = await monasWorkspace(browser, names)
    const matriken = await makeFolder(workspace.id, uniqueName('Matriken'), null, mona)
    const firmbuecher = await makeFolder(workspace.id, uniqueName('Firmbücher'), matriken.id, mona)
    await page.reload()

    await rowOf(page, names[0]).getByTestId('job-menu').click()
    await rowOf(page, names[0]).getByRole('button', { name: 'Move to workspace…' }).click()
    const move = page.getByRole('dialog', { name: `Move "${names[0]}"` })
    await expect(move.getByRole('combobox', { name: 'Folder' }).locator('option'))
      .toHaveText([`The top of ${name}`, matriken.name, `${matriken.name} / ${firmbuecher.name}`])
    await move.getByRole('combobox', { name: 'Folder' }).selectOption({ label: `${matriken.name} / ${firmbuecher.name}` })
    await move.getByRole('button', { name: 'Move' }).click()
    await expect.poll(async () => (await getJob(ids[0])).folder_id).toBe(firmbuecher.id)
    await expect(workspaceHeader(page, name).getByTestId('folder-new')).toBeVisible()
    await expect(folderHeader(page, matriken.name).getByTestId('folder-menu')).toBeVisible()

    const lena = `lena-${Date.now()}`
    const lenaSession = seedSession('annotator', lena)
    await shareGroup(workspace.id, [mona, lena])
    const context = await browser.newContext()
    await useSession(context, lenaSession)
    const annotator = await context.newPage()
    await annotator.goto('/')
    await expect(folderOf(annotator, firmbuecher.name).getByTestId('job-card')).toHaveCount(1)
    await expect(folderHeader(annotator, matriken.name)).toBeVisible()
    await expect(workspaceHeader(annotator, name).getByTestId('folder-new')).toHaveCount(0)
    await expect(folderHeader(annotator, matriken.name).getByTestId('folder-menu')).toHaveCount(0)
  })
})
