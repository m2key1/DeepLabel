import { test, expect } from '../helpers/test'
import type { Page } from '@playwright/test'
import { backendFetch, getJob, identity, jobPageIds, seedCompletedJob, shareJob, uniqueName } from '../helpers/api'
import { seedSession, useSession } from '../helpers/session'
import { openViewer } from '../helpers/viewer'

// Pipelines are private to whoever saved them, and the browser is logged in as this account.
const DEV = identity('dev', 'admin')
const json = { 'Content-Type': 'application/json' }
const NOTHING = { transform: { __class_fullname__: 'Compose', p: 1.0, transforms: [] } }

// Settings belong to the auth service, which the backend port does not serve.
async function palette(page: Page): Promise<string[]> {
  return (await (await page.request.get('/api/settings')).json()).keyboard
}

async function documentNames(jobId: string): Promise<string[]> {
  const body = await backendFetch(`/api/jobs/${jobId}/documents`)
  return (body.documents as { name: string }[]).map((document) => document.name)
}

test.describe('Scenario: working the dialogs and menus from the keyboard', () => {
  test('a dialog is announced, holds the focus, closes on Escape and hands the focus back', async ({ page }) => {
    const name = uniqueName('Dialog keys')
    const jobId = await seedCompletedJob(name, 1)

    const bulkWrites: string[] = []
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (request.method() === 'POST' && path.startsWith('/api/bulk/') && path !== '/api/bulk/preview') bulkWrites.push(path)
    })

    await page.goto('/')
    const card = page.getByTestId('job-card').filter({ hasText: name })
    await card.getByRole('checkbox').check()
    const opener = page.getByTestId('bulk-bar').getByRole('button', { name: 'Re-read OCR…' })
    await opener.click()

    const dialog = page.getByRole('dialog', { name: 'Re-read OCR' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAttribute('aria-modal', 'true')
    await expect(dialog.getByTestId('bulk-preview')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Re-read OCR', exact: true })).toBeEnabled()
    expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true)

    // Tab wraps around the dialog's own two buttons instead of walking into the page.
    const cancel = dialog.getByRole('button', { name: 'Cancel' })
    const confirm = dialog.getByRole('button', { name: 'Re-read OCR', exact: true })
    await page.keyboard.press('Shift+Tab')
    await expect(confirm).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(cancel).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(confirm).toBeFocused()

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(opener).toBeFocused()
    // Escape is the cancel path: nothing was sent, and nothing was queued.
    expect(bulkWrites).toEqual([])
    expect((await getJob(jobId)).status).toBe('done')

    await opener.click()
    await expect(dialog).toBeVisible()
  })

  test('the dataset list menus say they open, and Escape shuts them', async ({ page }) => {
    const name = uniqueName('Menu keys')
    await seedCompletedJob(name, 1)

    await page.goto('/')
    const sort = page.getByTestId('sort-menu')
    await expect(sort).toHaveAttribute('aria-haspopup', 'menu')
    await expect(sort).toHaveAttribute('aria-expanded', 'false')
    await sort.click()
    await expect(sort).toHaveAttribute('aria-expanded', 'true')
    const mostPages = page.getByRole('button', { name: 'Most pages', exact: true })
    await expect(mostPages).toBeVisible()
    // Escape from inside the menu hands the focus back to the button that opened it.
    await page.keyboard.press('Tab')
    await expect(sort).not.toBeFocused()
    await page.keyboard.press('Escape')
    await expect(mostPages).toHaveCount(0)
    await expect(sort).toHaveAttribute('aria-expanded', 'false')
    await expect(sort).toBeFocused()

    const card = page.getByTestId('job-card').filter({ hasText: name })
    const kebab = card.getByTestId('job-menu')
    await expect(kebab).toHaveAttribute('aria-haspopup', 'menu')
    await kebab.click()
    await expect(kebab).toHaveAttribute('aria-expanded', 'true')
    await expect(card.getByRole('button', { name: 'Share…' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(card.getByRole('button', { name: 'Share…' })).toHaveCount(0)
    await expect(kebab).toHaveAttribute('aria-expanded', 'false')
  })

  test('a dialog opened from a menu item hands the focus back to the menu button', async ({ page }) => {
    const name = uniqueName('Menu dialog keys')
    const jobId = await seedCompletedJob(name, 1)

    await page.goto('/')
    const card = page.getByTestId('job-card').filter({ hasText: name })
    const kebab = card.getByTestId('job-menu')
    await kebab.click()
    await card.getByRole('button', { name: 'Share…' }).click()
    const dialog = page.getByRole('dialog', { name: `Share "${name}"` })
    await expect(dialog).toBeVisible()
    await expect(card.getByRole('button', { name: 'Share…' })).toHaveCount(0)

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(kebab).toBeFocused()
    expect((await getJob(jobId)).shared_with).toEqual([])
  })

  test('the dataset page export menu says it opens, and Escape shuts it', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Export keys'), 1)

    await page.goto(`/jobs/${jobId}`)
    const exportMenu = page.getByRole('button', { name: 'Export', exact: true })
    await expect(exportMenu).toHaveAttribute('aria-haspopup', 'menu')
    await exportMenu.click()
    await expect(exportMenu).toHaveAttribute('aria-expanded', 'true')
    const zip = page.getByRole('link', { name: 'DeepLabel zip', exact: true })
    await expect(zip).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(zip).toHaveCount(0)
    await expect(exportMenu).toHaveAttribute('aria-expanded', 'false')
  })

  test('the online list says it opens and Escape shuts it; the account avatar is a plain link to your profile',
    async ({ page, browser }) => {
    const username = `escape-${Date.now()}`
    const jobId = await seedCompletedJob(uniqueName('Nav keys'), 1)
    await shareJob(jobId, [username])
    const colleague = await browser.newContext()
    await useSession(colleague, seedSession('member', username))
    await (await colleague.newPage()).goto(`/jobs/${jobId}`)
    await expect.poll(async () => ((await backendFetch('/api/presence')).users as { username: string }[])
      .some((u) => u.username === username)).toBe(true)

    await page.goto('/')
    const online = page.getByTestId('presence-pill')
    await expect(online).toHaveAttribute('aria-haspopup', 'menu')
    await online.click()
    await expect(online).toHaveAttribute('aria-expanded', 'true')
    const list = page.getByTestId('presence-list')
    await expect(list.getByText(username)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(list).toHaveCount(0)
    await expect(online).toHaveAttribute('aria-expanded', 'false')

    // A colleague's avatar in the list opens their profile, and the list shuts behind it.
    await online.click()
    await list.locator(`[data-testid="person-link"][data-username="${username}"]`).click()
    await expect(page).toHaveURL(new RegExp(`/people/${username}$`))
    await expect(list).toHaveCount(0)

    const account = page.getByTestId('user-menu')
    await expect(account).toHaveAttribute('href', '/people/dev')
    await expect(account).not.toHaveAttribute('aria-haspopup')
    await account.focus()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/people\/dev$/)
    await expect(page.getByRole('button', { name: 'Log out', exact: true })).toBeVisible()
    await colleague.close()
  })

  test("the page viewer's run menu says it opens, and Escape shuts it", async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Run keys'), 1)
    const [pageId] = await jobPageIds(jobId)

    await openViewer(page, jobId, pageId)
    const run = page.getByTestId('run-menu')
    await expect(run).toHaveAttribute('aria-haspopup', 'menu')
    await expect(run).toHaveAttribute('aria-expanded', 'false')
    await run.click()
    await expect(run).toHaveAttribute('aria-expanded', 'true')
    const items = page.getByTestId('run-menu-items')
    await expect(items.locator('[data-testid="run-phase"][data-phase="ocr"]')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(items).toHaveCount(0)
    await expect(run).toHaveAttribute('aria-expanded', 'false')
    // Escape shut the menu and nothing else: the page is still open in the viewer.
    await expect(page).toHaveURL(new RegExp(`/jobs/${jobId}/pages/${pageId}$`))
  })
})

test.describe('Scenario: a dialog covers the page it opens over', () => {
  test("the page viewer's pane divider stays behind the language-model dialog", async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Divider behind'), 1)
    const [pageId] = await jobPageIds(jobId)
    await openViewer(page, jobId, pageId)

    const divider = page.getByTestId('pane-divider')
    await expect(divider).toBeVisible()
    const box = (await divider.boundingBox())!
    const topmost = () => page.evaluate(([x, y]) => {
      const hit = document.elementFromPoint(x, y)
      return hit?.closest('[data-testid="pane-divider"]') ? 'divider' : hit?.closest('[role="dialog"]') ? 'dialog' : 'backdrop'
    }, [box.x + box.width / 2, box.y + box.height / 2])
    expect(await topmost()).toBe('divider')

    await page.getByTestId('run-menu').click()
    await page.getByTestId('run-llm-read').click()
    await expect(page.getByRole('dialog')).toBeVisible()
    expect(await topmost()).not.toBe('divider')
  })
})

test.describe('Scenario: state that reads out loud', () => {
  test('a palette key and a preset say whether they are on', async ({ page }) => {
    await page.goto('/settings?section=characters')
    await page.getByTestId('palette-reset').click()
    await expect.poll(() => palette(page)).toContain('ä')

    const alpha = page.locator('[data-testid="vocab-group"][data-group="Greek"]')
      .getByRole('button', { name: 'α', exact: true })
    await expect(alpha).toHaveAttribute('aria-pressed', 'false')
    await alpha.click()
    await expect.poll(() => palette(page)).toContain('α')
    await expect(alpha).toHaveAttribute('aria-pressed', 'true')

    const nordic = page.getByRole('button', { name: /Nordic$/ })
    await expect(nordic).toHaveAttribute('aria-pressed', 'false')
    await nordic.click()
    await expect.poll(() => palette(page)).toEqual(expect.arrayContaining(['ø', 'Ø', 'æ', 'Æ', 'ð', 'þ']))
    await expect(nordic).toHaveAttribute('aria-pressed', 'true')

    await page.getByTestId('palette-reset').click()
    await expect.poll(() => palette(page)).not.toContain('α')
    await expect(alpha).toHaveAttribute('aria-pressed', 'false')
  })

  test('the open augmentation pipeline is the current one in the list', async ({ page }) => {
    const first = uniqueName('Current first')
    const second = uniqueName('Current second')
    for (const name of [first, second]) {
      await backendFetch('/api/augmentations/pipelines', {
        method: 'POST', headers: { ...DEV, ...json }, body: JSON.stringify({ task: 'ocr', name, spec: NOTHING }),
      })
    }

    await page.goto('/augmentations')
    const row = (name: string) => page.getByTestId('pipeline-row').filter({ hasText: name })
    await row(first).click()
    await expect(row(first)).toHaveAttribute('aria-current', 'true')
    await expect(row(second)).not.toHaveAttribute('aria-current', 'true')
    await row(second).click()
    await expect(row(second)).toHaveAttribute('aria-current', 'true')
    await expect(row(first)).not.toHaveAttribute('aria-current', 'true')
  })

  test('removing a corpus document names it and asks first', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Corpus remove'), 1)
    const form = new FormData()
    for (const name of ['letter-a', 'letter-b']) {
      form.append('files', new Blob([`${name} text\n`], { type: 'text/plain' }), `${name}.txt`)
    }
    await backendFetch(`/api/jobs/${jobId}/documents`, { method: 'POST', body: form })
    await expect.poll(() => documentNames(jobId)).toEqual(['letter-a', 'letter-b'])

    await page.goto(`/jobs/${jobId}/corpus`)
    const remove = page.getByRole('button', { name: 'Remove letter-a', exact: true })
    await expect(page.getByRole('button', { name: 'Remove letter-b', exact: true })).toBeVisible()

    page.once('dialog', (dialog) => void dialog.dismiss())
    await remove.click()
    await expect(page.getByTestId('document-row')).toHaveCount(2)
    expect(await documentNames(jobId)).toEqual(['letter-a', 'letter-b'])

    let asked = ''
    page.once('dialog', (dialog) => {
      asked = dialog.message()
      void dialog.accept()
    })
    await remove.click()
    await expect.poll(() => asked).toContain('letter-a')
    await expect.poll(() => documentNames(jobId)).toEqual(['letter-b'])
    await expect(page.getByTestId('document-row')).toHaveCount(1)
    await expect(remove).toHaveCount(0)
  })
})
