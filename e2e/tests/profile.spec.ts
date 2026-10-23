import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/test'
import { backendFetch, getPageDetail, identity, jobPageIds, seedCompletedJob, shareJob, uniqueName } from '../helpers/api'
import { avatarUrl, pictureColours } from '../helpers/avatar'
import { twoColourPng } from '../helpers/image'
import { asSession, seedSession, useSession } from '../helpers/session'

const RED: [number, number, number] = [255, 0, 0]
const BLUE: [number, number, number] = [0, 0, 255]
const today = () => new Date().toISOString().slice(0, 10)

async function profileOf(session: string, username: string) {
  return (await asSession(session, `/api/people/${username}/profile`)).json()
}

async function personAs(session: string, username: string) {
  return (await asSession(session, `/api/people/${username}`)).json()
}

/** Two datasets shared with `author`, the second also with `colleague`; the author
 *  corrects two lines of the first, checks one of the second and signs off the first's
 *  page - four edits, all today. */
async function seedWork(author: string, colleague: string) {
  const hidden = uniqueName('Profile hidden')
  const open = uniqueName('Profile open')
  const hiddenId = await seedCompletedJob(hidden, 1)
  const openId = await seedCompletedJob(open, 1)
  await shareJob(hiddenId, [author])
  await shareJob(openId, [author, colleague])
  const as = { ...identity(author, 'member'), 'Content-Type': 'application/json' }
  const linesOf = async (jobId: string) => {
    const [pageId] = await jobPageIds(jobId)
    const detail = await getPageDetail(jobId, pageId)
    return { pageId, lines: detail.elements.flatMap((e: { lines: { id: number }[] }) => e.lines) }
  }
  const first = await linesOf(hiddenId)
  const second = await linesOf(openId)
  for (const [line, text] of [[first.lines[0], 'eins'], [first.lines[1], 'zwei']] as const) {
    await backendFetch(`/api/lines/${line.id}`, {
      method: 'PATCH', headers: as, body: JSON.stringify({ corrected_text: text, checked: false }),
    })
  }
  await backendFetch(`/api/lines/${second.lines[0].id}`, {
    method: 'PATCH', headers: as, body: JSON.stringify({ checked: true }),
  })
  await backendFetch(`/api/pages/${first.pageId}`, {
    method: 'PATCH', headers: as, body: JSON.stringify({ layout_checked: true }),
  })
  return { hidden, open }
}

const EXPECTED_STATS = {
  lines_corrected: 2,
  lines_checked: 1,
  pages_signed_off: 1,
  regions_drawn: 0,
  datasets_owned: 0,
  datasets_shared: 2,
  groups: [],
  trainings: { started: 0, done: 0, failed: 0 },
  models_trained: 0,
  evaluations: 0,
  best_cer: null,
}

const stat = (page: Page, id: string) => page.locator(`[data-stat="${id}"]`)

test.describe('Scenario: a person\'s profile', () => {
  // README: "Clicking your own picture in the top bar opens your profile ... statistics ...
  // a year calendar of edits per day ... recently worked on".
  test('your avatar opens your profile: header, the figures of what you did, the calendar, the datasets',
    async ({ browser }) => {
      const stamp = Date.now()
      const author = `ada-${stamp}`
      const colleague = `bob-${stamp}`
      const session = seedSession('member', author, { email: `${author}@example.org`, displayName: 'Ada Lovelace' })
      seedSession('member', colleague)
      const { hidden, open } = await seedWork(author, colleague)

      const own = await profileOf(session, author)
      expect(own.stats).toMatchObject(EXPECTED_STATS)
      expect(own.activity).toEqual([{ day: today(), edits: 4 }])
      expect(own.recent_datasets.map((d: { name: string }) => d.name).sort()).toEqual([hidden, open].sort())

      const context = await browser.newContext()
      await useSession(context, session)
      const page = await context.newPage()
      await page.goto('/')
      await page.getByTestId('user-menu').click()
      await expect(page).toHaveURL(new RegExp(`/people/${author}$`))

      await expect(page.getByTestId('profile-name')).toHaveText('Ada Lovelace')
      await expect(page.getByTestId('profile-username')).toHaveText(author)
      await expect(page.getByTestId('profile-role')).toHaveText('member')
      await expect(page.getByTestId('profile-email')).toHaveText(`${author}@example.org`)
      await expect(page.getByTestId('profile-since')).toContainText('Member since')

      for (const [id, value] of [['lines_corrected', '2'], ['lines_checked', '1'], ['pages_signed_off', '1'],
        ['regions_drawn', '0'], ['trainings_started', '0'], ['best_cer', '-'], ['datasets_owned', '0'],
        ['datasets_shared', '2'], ['groups', '0']] as const) {
        await expect(stat(page, id), id).toHaveText(new RegExp(`\\D${value}$`))
      }
      await expect(page.getByTestId('profile-last-active')).toHaveText('Last active just now')

      const calendar = page.getByTestId('activity-calendar')
      await expect(calendar).toHaveAttribute('data-total', '4')
      const todayCell = calendar.locator(`[data-day="${today()}"]`)
      await expect(todayCell).toHaveAttribute('data-edits', '4')
      await expect(todayCell).toHaveAttribute('data-level', '4')
      await expect(calendar.locator('[data-level="0"]').first()).toBeVisible()
      // Today is the calendar's one stop for the keyboard, and the arrows walk from it.
      await expect(calendar.locator('[tabindex="0"]')).toHaveAttribute('data-day', today())
      await todayCell.focus()
      await expect(page.getByTestId('activity-readout')).toHaveText(/^4 edits on /)
      await page.keyboard.press('ArrowLeft')
      await expect(page.getByTestId('activity-readout')).toHaveText(/^0 edits on /)
      await expect(calendar.locator('[tabindex="0"]')).toHaveCount(1)
      await expect(calendar.locator('[tabindex="0"]')).not.toHaveAttribute('data-day', today())

      const recent = page.getByTestId('profile-recent-dataset')
      await expect(recent).toHaveCount(2)
      await expect(recent.filter({ hasText: hidden })).toHaveCount(1)
      await expect(recent.filter({ hasText: open }).getByRole('link')).toHaveAttribute('href', /^\/jobs\//)

      // Your own profile carries your settings as tabs.
      await expect(page.getByTestId('section-nav-item')).toHaveText([
        'Overview', 'Working together', 'Opening a page', 'Keyboard shortcuts', 'Character keyboard',
        'API tokens', 'LLM connections',
      ])
      await page.getByTestId('section-nav-item').filter({ hasText: 'Working together' }).click()
      await expect(page).toHaveURL(new RegExp(`/people/${author}\\?section=together$`))
      await expect(page.getByTestId('share-activity')).toBeVisible()
      await context.close()
    })

  test('a colleague sees the picture, name and figures, but not the email, the settings, or a dataset hidden from them',
    async ({ page, browser }) => {
      const stamp = Date.now()
      const author = `cleo-${stamp}`
      const colleague = `dan-${stamp}`
      const authorSession = seedSession('member', author, { email: `${author}@example.org`, displayName: 'Cleo Profile' })
      const colleagueSession = seedSession('member', colleague)
      const { hidden, open } = await seedWork(author, colleague)

      // The backend: the numbers count everything, the names only what the viewer may open.
      const seen = await profileOf(colleagueSession, author)
      expect(seen.stats).toMatchObject(EXPECTED_STATS)
      expect(seen.recent_datasets.map((d: { name: string }) => d.name)).toEqual([open])
      expect(await personAs(colleagueSession, author)).not.toHaveProperty('email')
      expect(await personAs(authorSession, author)).toHaveProperty('email', `${author}@example.org`)

      const context = await browser.newContext()
      await useSession(context, colleagueSession)
      const theirs = await context.newPage()
      // A colleague's avatar on a dataset's access stack opens their profile.
      await theirs.goto('/')
      const row = theirs.getByTestId('job-card').filter({ hasText: open })
      await row.locator(`[data-testid="person-link"][data-username="${author}"]`).click()
      await expect(theirs).toHaveURL(new RegExp(`/people/${author}$`))

      await expect(theirs.getByTestId('profile-name')).toHaveText('Cleo Profile')
      await expect(theirs.getByTestId('profile-role')).toHaveText('member')
      await expect(stat(theirs, 'lines_corrected')).toHaveText(/\D2$/)
      await expect(stat(theirs, 'datasets_shared')).toHaveText(/\D2$/)
      await expect(theirs.getByTestId('profile-email')).toHaveCount(0)
      await expect(theirs.getByTestId('section-nav')).toHaveCount(0)
      await expect(theirs.getByTestId('profile-recent-dataset')).toHaveText([new RegExp(open)])
      await expect(theirs.getByTestId('profile-recent-dataset').filter({ hasText: hidden })).toHaveCount(0)
      await expect(theirs.getByRole('button', { name: 'Log out' })).toHaveCount(0)

      // Paired: on their own profile the same locators are there.
      await theirs.getByTestId('user-menu').click()
      await expect(theirs).toHaveURL(new RegExp(`/people/${colleague}$`))
      await expect(theirs.getByTestId('section-nav')).toBeVisible()
      await expect(theirs.getByRole('button', { name: 'Log out' })).toBeVisible()
      await context.close()

      // And an admin reads the email a colleague may not.
      await page.goto(`/people/${author}`)
      await expect(page.getByTestId('profile-email')).toHaveText(`${author}@example.org`)
      await expect(page.getByTestId('profile-recent-dataset')).toHaveCount(2)
    })

  test('an unknown name is a page that says so', async ({ page }) => {
    await page.goto('/people/nobody-by-this-name')
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
    await expect(page.getByTestId('profile')).toHaveCount(0)
    await page.goto('/people/dev')
    await expect(page.getByTestId('profile')).toBeVisible()
  })

  test('your own profile names the release this deployment runs, a colleague\'s does not', async ({ page }) => {
    expect(await backendFetch('/api/meta')).toEqual({ version: '0.1.0', commit: null })
    await page.goto('/people/dev')
    await expect(page.getByTestId('app-version')).toHaveText('DeepLabel 0.1.0')
    const colleague = `cleo-${Date.now()}`
    seedSession('member', colleague)
    await page.goto(`/people/${colleague}`)
    await expect(page.getByTestId('profile')).toHaveAttribute('data-username', colleague)
    await expect(page.getByTestId('app-version')).toHaveCount(0)
  })

  test('the old Settings addresses open the matching tab of your profile', async ({ page }) => {
    await page.goto('/settings?section=keys')
    await expect(page).toHaveURL(/\/people\/dev\?section=keys$/)
    await expect(page.getByTestId('hotkey-row').first()).toBeVisible()
    await page.goto('/settings')
    await expect(page).toHaveURL(/\/people\/dev$/)
    await expect(page.getByTestId('profile-overview')).toBeVisible()
    await expect(page.getByTestId('hotkey-row')).toHaveCount(0)
    await page.goto('/profile?section=tokens')
    await expect(page).toHaveURL(/\/people\/dev\?section=tokens$/)
  })

  test('the theme switch lives on your profile and its choice is kept', async ({ page }) => {
    await page.goto('/people/dev')
    const theme = page.getByTestId('theme-choice')
    await theme.getByRole('button', { name: 'Dark' }).click()
    await expect(page.locator('html')).toHaveClass(/\bdark\b/)
    await expect(theme.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true')
    expect(await page.evaluate(() => localStorage.getItem('deeplabel.theme'))).toBe('dark')
    await theme.getByRole('button', { name: 'Light' }).click()
    await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
    expect(await page.evaluate(() => localStorage.getItem('deeplabel.theme'))).toBe('light')
    await page.evaluate(() => localStorage.removeItem('deeplabel.theme'))
  })
})

test.describe('Scenario: cropping your picture', () => {
  // The dev user's picture is shared state for every spec that follows.
  test.afterEach(async ({ page }) => {
    await page.request.delete('/api/users/me/avatar')
  })

  // A multipart body with a file in it is not readable off a Playwright request, so the
  // page keeps a copy of what it sends.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const send = window.fetch
      window.fetch = (input, init) => {
        const body = init?.body
        if (String(input).endsWith('/api/users/me/avatar') && body instanceof FormData) {
          (window as unknown as { sentAvatar?: unknown }).sentAvatar = body.get('file')
        }
        return send(input, init)
      }
    })
  })

  const pick = async (page: Page) => {
    await page.goto('/people/dev')
    await page.getByTestId('avatar-file').setInputFiles({
      name: 'halves.png', mimeType: 'image/png', buffer: twoColourPng(400, 200, RED, BLUE),
    })
    const dialog = page.getByRole('dialog', { name: 'Your picture' })
    await expect(dialog).toBeVisible()
    return dialog
  }

  test('zooming in and dragging to the left half keeps only the red, uploaded as a 512 square', async ({ page }) => {
    // README: "Choosing a picture opens a crop: drag it inside the round frame, zoom with the
    // slider, the wheel or a pinch, nudge it with the arrow keys ... Save uploads only the chosen
    // square, 512 pixels a side".
    expect(await avatarUrl(page, 'dev')).toBeNull()
    const dialog = await pick(page)
    await expect(dialog.getByTestId('avatar-crop-preview')).toHaveCount(3)

    const zoom = dialog.getByTestId('avatar-crop-zoom')
    await zoom.focus()
    await page.keyboard.press('End')
    await expect(zoom).toHaveValue('4')

    const area = dialog.getByTestId('avatar-crop-area')
    const box = (await area.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 600, box.y + box.height / 2, { steps: 12 })
    await page.mouse.up()
    // The arrow keys nudge it too: one step back towards the middle, then home again.
    await area.focus()
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowRight')

    await dialog.getByTestId('avatar-crop-save').click()
    // What left the browser: the cropped square, not the picture that was picked.
    await expect.poll(() => page.evaluate(async () => {
      const sent = (window as unknown as { sentAvatar?: File }).sentAvatar
      if (!sent) return null
      const bitmap = await createImageBitmap(sent)
      return { type: sent.type, size: [bitmap.width, bitmap.height] }
    })).toEqual({ type: 'image/jpeg', size: [512, 512] })

    await expect(dialog).toHaveCount(0)
    await expect.poll(() => avatarUrl(page, 'dev')).toMatch(/^\/api\/users\/dev\/avatar\?v=[0-9a-f]{16}$/)
    const stored = (await avatarUrl(page, 'dev'))!
    const { size, colours } = await pictureColours(page, stored)
    expect(size[0]).toBe(size[1])
    expect(colours).toEqual(['red', 'red', 'red', 'red', 'red'])
    await expect(page.getByTestId('user-menu').locator('img')).toHaveAttribute('src', stored)
    await expect(page.getByTestId('avatar-pick').locator('img')).toHaveAttribute('src', stored)

    // Remove takes it off again, back to the initials.
    await page.getByTestId('avatar-clear').click()
    await expect.poll(() => avatarUrl(page, 'dev')).toBeNull()
    await expect(page.getByTestId('user-menu')).toHaveText('DE')
  })

  test('saving without moving keeps the middle square, and Cancel uploads nothing', async ({ page }) => {
    const puts: string[] = []
    page.on('request', (r) => {
      if (r.url().endsWith('/api/users/me/avatar') && r.method() === 'PUT') puts.push(r.url())
    })
    let dialog = await pick(page)
    await dialog.getByTestId('avatar-crop-cancel').click()
    await expect(dialog).toHaveCount(0)
    // Escape is a cancel too.
    dialog = await pick(page)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    expect(puts).toEqual([])
    expect(await avatarUrl(page, 'dev')).toBeNull()
    await expect(page.getByTestId('avatar-pick').locator('img')).toHaveCount(0)

    // Paired: the same picture saved as it opened is the centre square, half and half.
    dialog = await pick(page)
    await dialog.getByTestId('avatar-crop-save').click()
    await expect.poll(() => avatarUrl(page, 'dev')).not.toBeNull()
    expect(puts).toHaveLength(1)
    const { colours } = await pictureColours(page, (await avatarUrl(page, 'dev'))!)
    expect(colours.slice(0, 4)).toEqual(['red', 'blue', 'red', 'blue'])
    await expect(page.getByTestId('avatar-pick').locator('img')).toHaveCount(1)
  })
})
