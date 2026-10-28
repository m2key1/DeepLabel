import type { Locator, Page } from '@playwright/test'
import { test, expect } from '../helpers/test'
import {
  backendFetch, createGroup, createJob, identity, jobPageIds, moveJobToGroup, seedCompletedJob,
  shareGroup, shareJob, uniqueName, waitForJobStatus,
} from '../helpers/api'
import { asSession, expireToken, seedSession, useSession, userRecord, type UserRecord } from '../helpers/session'
import { FRONTEND } from '../helpers/frontend'
import { pngSize, scanPng } from '../helpers/image'
import { accountControls, adminTokens } from '../helpers/admin'

/** Through nginx as a script would: the token alone, no cookie to fall back on. */
const asBearer = (token: string, path: string) =>
  fetch(`${FRONTEND}${path}`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'manual' })

const credentialsOf = (user: UserRecord) =>
  ({ active: user.active, sessions: user.sessions, tokens: user.tokens })

test.describe('Scenario: disabling an account', () => {
  // README: an Admin page where each account shows its "status", and each row opens into
  // "live sessions with a sign-out-everywhere action, and a history of every role, status and
  // grant change with who made it". Sessions are server-side "so logout and deactivate revoke
  // instantly" (auth/app/store.py), and a token "acts as its owner".
  test('disabling an account ends its sessions and tokens at once, and enabling it later restores neither',
    async ({ page }) => {
      const username = `doomed-${Date.now()}`
      const session = seedSession('member', username)
      const minted = await asSession(session, '/api/tokens', {
        method: 'POST', body: JSON.stringify({ name: 'laptop' }),
      })
      expect(minted.status).toBe(200)
      const bearer = (await minted.json()).token as string
      // Both credentials work first, so the 401s below are the disabling and nothing else.
      expect((await asSession(session, '/api/me')).status).toBe(200)
      expect((await asBearer(bearer, '/api/jobs')).status).toBe(200)
      expect(credentialsOf(await userRecord(page, username))).toEqual({ active: 1, sessions: 1, tokens: 1 })

      await page.goto('/admin')
      const row = page.getByTestId('user-row').filter({ hasText: username })
      const account = await accountControls(page, username)
      await expect(account).toContainText('Active')
      await expect(row).not.toContainText('Disabled')
      await account.getByRole('button', { name: 'Disable', exact: true }).click()
      await expect(row).toContainText('Disabled')
      await expect(account.getByRole('button', { name: 'Enable', exact: true })).toBeVisible()

      // Auth-service oracle: the account is off and holds no live session or token.
      await expect.poll(async () => credentialsOf(await userRecord(page, username)))
        .toEqual({ active: 0, sessions: 0, tokens: 0 })
      expect((await asSession(session, '/api/me')).status).toBe(401)
      expect((await asBearer(bearer, '/api/jobs')).status).toBe(401)

      const detail = page.getByTestId('user-detail')
      await expect(detail.getByTestId('session-count')).toHaveText('0')
      const entries = detail.getByTestId('user-audit').getByRole('listitem')
      await expect(entries).toHaveCount(1)
      await expect(entries.first()).toContainText('status: active → disabled')
      await expect(entries.first()).toContainText('by dev')

      await account.getByRole('button', { name: 'Enable', exact: true }).click()
      await expect(account).toContainText('Active')
      await expect(row).not.toContainText('Disabled')
      await expect(account.getByRole('button', { name: 'Disable', exact: true })).toBeVisible()
      await expect.poll(async () => credentialsOf(await userRecord(page, username)))
        .toEqual({ active: 1, sessions: 0, tokens: 0 })
      // Enabled is not signed in: the old cookie and the old token stay dead.
      expect((await asSession(session, '/api/me')).status).toBe(401)
      expect((await asBearer(bearer, '/api/jobs')).status).toBe(401)

      // The history is read when the panel opens, so open it again for the new entry.
      await row.getByRole('button', { name: `Hide details for ${username}` }).click()
      await expect(detail).toHaveCount(0)
      await row.getByRole('button', { name: `Show details for ${username}` }).click()
      await expect(entries).toHaveCount(2)
      await expect(entries.nth(0)).toContainText('status: disabled → active')
      await expect(entries.nth(0)).toContainText('by dev')
      await expect(entries.nth(1)).toContainText('status: active → disabled')
    })
})

/** A stamp as the auth service writes it - UTC, 'YYYY-MM-DD HH:MM:SS', no marker. */
const parseStamp = (iso: string) => Date.parse(`${iso.replace(' ', 'T')}Z`)

/** What AdminTokens.tsx shows for a stamp: util.formatDate, de-AT, day first, 24 hours, in
 *  the browser's own zone. Node and the browser share this machine's zone and ICU, so the
 *  same call here is the text to expect. */
const asAdminStamp = (iso: string) =>
  new Date(parseStamp(iso)).toLocaleString('de-AT', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  })

interface TokenRow {
  id: number
  name: string
  created_at: string
  last_used_at: string | null
  expires_at: string | null
}

async function ownTokens(page: Page): Promise<TokenRow[]> {
  const res = await page.request.get('/api/tokens')
  return (await res.json()).tokens
}

async function tokenNamed(page: Page, name: string): Promise<TokenRow> {
  return (await ownTokens(page)).find((t) => t.name === name)!
}

/** Mints a token from the Settings page and returns its secret. `expires` is the label of
 *  the Expires choice as the page offers it. */
async function mintToken(page: Page, name: string, expires: string): Promise<string> {
  // Dismiss any secret still on screen first: otherwise the read below can return the
  // previous token, and the test would go on to use the wrong one.
  const secretBox = page.getByTestId('token-secret')
  if (await secretBox.count()) await secretBox.getByRole('button', { name: 'Dismiss' }).click()
  await expect(secretBox).toHaveCount(0)

  await page.getByLabel('Token name').fill(name)
  await page.getByLabel('Expires').selectOption({ label: expires })
  await page.getByRole('button', { name: 'Create token' }).click()

  await expect(secretBox).toHaveCount(1)
  const secret = await secretBox.locator('code').innerText()
  expect(secret).toMatch(/^dlp_/)
  return secret
}

// The columns of the two token tables, so a cell is named rather than counted at each use.
// Each table ends in an unlabelled column holding the Revoke button.
const SETTINGS_COLUMNS = ['Name', 'Prefix', 'Access', 'Last used', 'Expires']
const ADMIN_COLUMNS = ['Owner', 'Name', 'Prefix', 'Access', 'Last used', 'Expires']
const headingsOf = (columns: string[]) => [...columns, '']
const cell = (row: Locator, columns: string[], column: string) =>
  row.getByRole('cell').nth(columns.indexOf(column))

// SQLite stamps created_at and Python computes the expiry from its own clock, so the two can
// sit a tick apart around a second boundary.
const CLOCK_SKEW_SECONDS = 2
const DAY_SECONDS = 86_400
const TOUCH_RESOLUTION_SECONDS = 60

test.describe('Scenario: how long a token lives, and when it was last used', () => {
  // README: "Tokens are stored hashed, expire when you say so, and are revoked from the same
  // page (admins see and revoke everyone's)"; the Admin page "lists every API token in the
  // instance".
  test('a token expires when its owner said, and its last use is recorded at a minute\'s resolution',
    async ({ page }) => {
      await page.goto('/settings?section=tokens')
      const monthName = uniqueName('month')
      const foreverName = uniqueName('forever')
      const monthSecret = await mintToken(page, monthName, '30 days')
      await mintToken(page, foreverName, 'never')

      const month = await tokenNamed(page, monthName)
      const forever = await tokenNamed(page, foreverName)
      expect(month.expires_at).not.toBeNull()
      const lifetime = (parseStamp(month.expires_at!) - parseStamp(month.created_at)) / 1000
      expect(Math.abs(lifetime - 30 * DAY_SECONDS)).toBeLessThanOrEqual(CLOCK_SKEW_SECONDS)
      expect(forever.expires_at).toBeNull()
      expect(month.last_used_at).toBeNull()
      expect(forever.last_used_at).toBeNull()

      // The cells below are picked by column, so the columns have to be where the names say.
      await expect(page.getByTestId('api-tokens').getByRole('columnheader'))
        .toHaveText(headingsOf(SETTINGS_COLUMNS))
      const rows = page.getByTestId('api-tokens').getByTestId('token-row')
      const monthRow = rows.filter({ hasText: monthName })
      const foreverRow = rows.filter({ hasText: foreverName })
      await expect(cell(monthRow, SETTINGS_COLUMNS, 'Expires')).toHaveText(month.expires_at!.slice(0, 10))
      await expect(cell(foreverRow, SETTINGS_COLUMNS, 'Expires')).toHaveText('-')
      await expect(cell(monthRow, SETTINGS_COLUMNS, 'Last used')).toHaveText('-')
      await expect(cell(foreverRow, SETTINGS_COLUMNS, 'Last used')).toHaveText('-')

      // One use through nginx, as a script would make it.
      expect((await asBearer(monthSecret, '/api/jobs')).status).toBe(200)
      await expect.poll(async () => (await tokenNamed(page, monthName)).last_used_at).not.toBeNull()
      const firstUse = (await tokenNamed(page, monthName)).last_used_at!
      const sinceMinted = (parseStamp(firstUse) - parseStamp(month.created_at)) / 1000
      expect(sinceMinted).toBeGreaterThanOrEqual(-CLOCK_SKEW_SECONDS)
      expect(sinceMinted).toBeLessThan(TOUCH_RESOLUTION_SECONDS)
      // The token that was never used says so still.
      expect((await tokenNamed(page, foreverName)).last_used_at).toBeNull()

      await page.reload()
      await expect(cell(monthRow, SETTINGS_COLUMNS, 'Last used')).toHaveText(firstUse.slice(0, 10))
      await expect(cell(foreverRow, SETTINGS_COLUMNS, 'Last used')).toHaveText('-')

      // A second use inside the same minute is not written: the stamp is kept at a minute's
      // resolution so a scripted batch does not cost one commit per call. The write, had
      // there been one, happened before the answer came back, so this read is conclusive.
      expect((await asBearer(monthSecret, '/api/jobs')).status).toBe(200)
      expect((await tokenNamed(page, monthName)).last_used_at).toBe(firstUse)

      await page.goto('/admin')
      const tokens = await adminTokens(page)
      await expect(tokens.getByRole('columnheader')).toHaveText(headingsOf(ADMIN_COLUMNS))
      const all = tokens.getByTestId('admin-token-row')
      const monthAdminRow = all.filter({ hasText: monthName })
      const foreverAdminRow = all.filter({ hasText: foreverName })
      await expect(cell(monthAdminRow, ADMIN_COLUMNS, 'Last used')).toHaveText(asAdminStamp(firstUse))
      await expect(cell(monthAdminRow, ADMIN_COLUMNS, 'Expires')).toHaveText(asAdminStamp(month.expires_at!))
      await expect(cell(foreverAdminRow, ADMIN_COLUMNS, 'Last used')).toHaveText('-')
      await expect(cell(foreverAdminRow, ADMIN_COLUMNS, 'Expires')).toHaveText('-')

      // No token lives for less than a day, and asking leaves the list as it was.
      const before = (await ownTokens(page)).length
      const refused = await page.request.post('/api/tokens', { data: { name: 'blink', expires_days: 0 } })
      expect(refused.status()).toBe(400)
      expect((await refused.json()).detail).toBe('expires_days must be at least 1')
      expect((await ownTokens(page)).length).toBe(before)
    })
})

test.describe('Scenario: a token that has expired', () => {
  // README: "An expired token stays in the list, greyed, until it is revoked, and the
  // account's token count names it apart - so the list and the count agree."
  test('an expired token is listed greyed and counted apart from the live ones',
    async ({ page, browser }) => {
      const username = `expiry-${Date.now()}`
      const session = seedSession('member', username)
      for (const name of ['stale', 'live']) {
        const minted = await asSession(session, '/api/tokens', {
          method: 'POST', body: JSON.stringify({ name }),
        })
        expect(minted.status).toBe(200)
      }
      expireToken(username, 'stale')
      await expect.poll(async () => {
        const record = await userRecord(page, username) as UserRecord & { expired_tokens: number }
        return [record.tokens, record.expired_tokens]
      }).toEqual([1, 1])

      await page.goto('/admin')
      await page.getByRole('button', { name: `Show details for ${username}` }).click()
      const detail = page.getByTestId('user-detail')
      await expect(detail.getByTestId('token-count')).toHaveText('1')
      await expect(detail.getByTestId('expired-token-count')).toHaveText('+ 1 expired')

      const theirs = (await adminTokens(page)).getByTestId('admin-token-row').filter({ hasText: username })
      await expect(theirs).toHaveCount(2)
      const staleRow = theirs.filter({ hasText: 'stale' })
      const liveRow = theirs.filter({ hasText: 'live' })
      await expect(staleRow).toHaveAttribute('data-expired', 'true')
      await expect(cell(staleRow, ADMIN_COLUMNS, 'Expires')).toHaveText(/^expired /)
      await expect(liveRow).not.toHaveAttribute('data-expired')
      await expect(cell(liveRow, ADMIN_COLUMNS, 'Expires')).toHaveText('-')

      // The owner's own list says the same.
      const ownerContext = await browser.newContext()
      await useSession(ownerContext, session)
      const ownerTab = await ownerContext.newPage()
      await ownerTab.goto('/settings?section=tokens')
      const own = ownerTab.getByTestId('api-tokens').getByTestId('token-row')
      await expect(own).toHaveCount(2)
      await expect(own.filter({ hasText: 'stale' })).toHaveAttribute('data-expired', 'true')
      await expect(own.filter({ hasText: 'live' })).not.toHaveAttribute('data-expired')
      await ownerContext.close()
    })
})

// auth/app/config.py AVATAR_SIZE, which compose.e2e.yml leaves at its default.
const AVATAR_SIZE = 512
const DEV_AVATAR_URL = /^\/api\/users\/dev\/avatar\?v=[0-9a-f]{16}$/
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Where the dev user's picture is, as everything that draws a person asks for it. */
async function devAvatar(page: Page): Promise<string | null> {
  const res = await page.request.get('/api/users/names')
  const users = (await res.json()).users as { username: string; avatar: string | null }[]
  return users.find((u) => u.username === 'dev')!.avatar
}

test.describe('Scenario: your own picture', () => {
  // README: "A person can set their own picture ... Whatever arrives is decoded and re-encoded
  // square at one size ... The address carries a hash of the picture, so it can be cached
  // forever without a new one being hidden behind the old. An account with none draws its
  // initials".
  // The dev user's picture is shared state for every spec that follows; the clearing step
  // below is the behaviour under test, not the clean-up.
  test.afterEach(async ({ page }) => {
    await page.request.delete('/api/users/me/avatar')
  })

  test('your own picture is uploaded, served immutable at a hashed address, replaced, and cleared',
    async ({ page }) => {
      await page.goto('/people/dev')
      const input = page.getByTestId('avatar-file')
      const save = page.getByRole('dialog', { name: 'Your picture' }).getByTestId('avatar-crop-save')
      await input.setInputFiles({ name: 'face.png', mimeType: 'image/png', buffer: scanPng(300, 200, 1) })
      await save.click()
      await expect.poll(() => devAvatar(page)).toMatch(DEV_AVATAR_URL)
      const first = (await devAvatar(page))!

      // What is served is the server's re-encoding, square at the configured size, and
      // marked to be kept for ever because the address changes with the picture.
      const served = await page.request.get(first)
      expect(served.status()).toBe(200)
      expect(served.headers()['content-type']).toBe('image/png')
      expect(served.headers()['cache-control']).toContain('immutable')
      const png = await served.body()
      expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
      expect(pngSize(png)).toEqual([AVATAR_SIZE, AVATAR_SIZE])

      const menuPicture = page.getByTestId('user-menu').locator('img')
      await expect(menuPicture).toHaveAttribute('src', first)
      await page.goto('/admin')
      await expect(page.getByTestId('user-row').filter({ hasText: '(you)' }).locator('img'))
        .toHaveAttribute('src', first)

      // A different picture is a different address.
      await page.goto('/people/dev')
      await input.setInputFiles({ name: 'face.png', mimeType: 'image/png', buffer: scanPng(300, 200, 2) })
      await save.click()
      await expect.poll(() => devAvatar(page)).not.toBe(first)
      const second = (await devAvatar(page))!
      expect(second).toMatch(DEV_AVATAR_URL)
      expect((await page.request.get(second)).status()).toBe(200)
      await expect(menuPicture).toHaveAttribute('src', second)

      await page.getByTestId('avatar-clear').click()
      await expect.poll(() => devAvatar(page)).toBeNull()
      expect((await page.request.get(second)).status()).toBe(404)
      // Back to the initials: the start of the username, since dev has no display name.
      await expect(menuPicture).toHaveCount(0)
      await expect(page.getByTestId('user-menu')).toHaveText('DE')

      // Something that is not a picture is refused before any crop, and changes nothing.
      await input.setInputFiles({
        name: 'x.png', mimeType: 'image/png', buffer: Buffer.from('this is not a picture'),
      })
      await expect(page.getByTestId('avatar-error')).toHaveText('that file is not a picture this browser can read')
      await expect(save).toHaveCount(0)
      expect(await devAvatar(page)).toBeNull()
      await expect(menuPicture).toHaveCount(0)
    })
})

interface PresenceUser {
  username: string
  job_id: string | null
  page_id: number | null
}

async function whereIs(username: string): Promise<PresenceUser | null> {
  const res = await backendFetch('/api/presence')
  return res.users.find((u: PresenceUser) => u.username === username) ?? null
}

async function settingOf(page: Page, name: 'show_activity' | 'share_activity'): Promise<boolean> {
  const res = await page.request.get('/api/settings')
  return (await res.json())[name]
}

test.describe('Scenario: what you see of others, and what they see of you', () => {
  // /api/settings belongs to the signed-in person, and every spec runs as the same one, so
  // what this scenario switches off has to come back on even when it fails halfway.
  test.afterEach(async ({ page }) => {
    await page.request.patch('/api/settings', { data: { show_activity: true, share_activity: true } })
  })

  // README: "Two settings control it: *share what I am working on* (off makes you invisible;
  // read-only accounts never broadcast) and *show where others are*; the Online or Hidden
  // state on your profile opens the settings tab that changes it."
  test('"show where others are" off hides presence everywhere while the backend still lists people, and the state on your profile names the setting',
    async ({ page, browser }) => {
      const colleague = `colleague-${Date.now()}`
      const token = seedSession('member', colleague)
      const jobId = await seedCompletedJob(uniqueName('Together'), 1)
      await shareJob(jobId, [colleague])
      const [pageId] = await jobPageIds(jobId)
      const theirs = await browser.newContext()
      await useSession(theirs, token)
      const theirTab = await theirs.newPage()
      await theirTab.goto(`/jobs/${jobId}/pages/${pageId}`)
      await expect.poll(async () => (await whereIs(colleague))?.page_id ?? null).toBe(pageId)

      await page.goto('/')
      const pill = page.getByTestId('presence-pill')
      // The colleague was just confirmed listed, so a count of none would be the bug.
      await expect(pill).toHaveText(/^[1-9]\d* online$/)
      await page.getByTestId('user-menu').click()
      const state = page.getByTestId('visibility-state')
      await expect(state).toHaveText('Online')
      await expect(state).toHaveAttribute('title', 'Change under Working together')
      await state.click()
      await expect(page).toHaveURL(/\/people\/dev\?section=together$/)

      const show = page.getByTestId('show-activity')
      await expect(show).toBeChecked()
      await show.uncheck()
      await expect.poll(() => settingOf(page, 'show_activity')).toBe(false)
      await expect(pill).toHaveCount(0)
      // Nothing changed on the server's side: the colleague is listed where they were.
      expect((await whereIs(colleague))?.page_id).toBe(pageId)

      await page.goto(`/jobs/${jobId}`)
      const pageRow = page.getByRole('row').filter({ hasText: 'scan_1.png' })
      await expect(pageRow).toBeVisible()
      await expect(pageRow.getByTestId('presence-avatars')).toHaveCount(0)
      await page.goto(`/jobs/${jobId}/pages/${pageId}`)
      // The scan is drawn, so the banner's absence is a choice and not a page still loading.
      await expect(page.getByTestId('overlay-box')).toHaveAttribute('data-scan', 'ready')
      await expect(page.getByTestId('presence-banner')).toHaveCount(0)

      // Switched back on, the same three places show the same person again.
      await page.goto('/settings?section=together')
      await show.check()
      await expect.poll(() => settingOf(page, 'show_activity')).toBe(true)
      await expect(pill).toHaveText(/^[1-9]\d* online$/)
      await page.goto(`/jobs/${jobId}`)
      await expect(pageRow.getByTestId('presence-avatars').getByLabel(colleague)).toBeVisible()
      await page.goto(`/jobs/${jobId}/pages/${pageId}`)
      await expect(page.getByTestId('presence-banner')).toHaveText(`${colleague} has this page open`)

      // The other switch is about being seen, and the state on the profile reports it.
      await page.goto('/settings?section=together')
      await page.getByTestId('share-activity').uncheck()
      await expect.poll(() => settingOf(page, 'share_activity')).toBe(false)
      await page.getByTestId('user-menu').click()
      await expect(state).toHaveText('Hidden')
      await expect(state).toHaveAttribute('title', 'Change under Working together')

      // A read-only account has no such choice: it is never broadcast, and says so.
      const viewerName = `viewer-${Date.now()}`
      const viewerContext = await browser.newContext()
      await useSession(viewerContext, seedSession('viewer', viewerName))
      const viewerTab = await viewerContext.newPage()
      await viewerTab.goto('/')
      await viewerTab.getByTestId('user-menu').click()
      const viewerState = viewerTab.getByTestId('visibility-state')
      await expect(viewerState).toHaveText('Hidden')
      await expect(viewerState).toHaveAttribute('title', 'A read-only account is never broadcast')
      // And not for want of trying: a heartbeat from a read-only account is refused outright.
      await expect(backendFetch('/api/presence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...identity(viewerName, 'viewer') },
        body: JSON.stringify({ tab: 'e2e-viewer-tab' }),
      })).rejects.toThrow(/403/)

      await viewerContext.close()
      await theirs.close()
    })
})

test.describe('Scenario: a colleague\'s face and your own other tabs', () => {
  // README: "dataset cards and page rows carry the avatars of the people inside them" -
  // for a read-only account as for anyone else, since nothing about a picture is sensitive.
  test('a viewer sees a colleague\'s picture where a member sees it', async ({ browser }) => {
    const stamp = Date.now()
    const colleague = `pictured-${stamp}`
    const viewerName = `looker-${stamp}`
    const memberName = `peer-${stamp}`
    const colleagueSession = seedSession('member', colleague)
    const sessions = { viewer: seedSession('viewer', viewerName), member: seedSession('member', memberName) }
    const jobId = await seedCompletedJob(uniqueName('Faces'), 1)
    await shareJob(jobId, [colleague, viewerName, memberName])
    const [pageId] = await jobPageIds(jobId)

    const theirs = await browser.newContext()
    await useSession(theirs, colleagueSession)
    const uploaded = await theirs.request.put('/api/users/me/avatar', {
      multipart: { file: { name: 'face.png', mimeType: 'image/png', buffer: scanPng(300, 200, 3) } },
    })
    expect(uploaded.status()).toBe(200)
    const picture = (await uploaded.json()).avatar as string
    expect(picture).toMatch(new RegExp(`^/api/users/${colleague}/avatar\\?v=[0-9a-f]{16}$`))

    await (await theirs.newPage()).goto(`/jobs/${jobId}/pages/${pageId}`)
    await expect.poll(async () => (await whereIs(colleague))?.page_id ?? null).toBe(pageId)

    for (const role of ['member', 'viewer'] as const) {
      const context = await browser.newContext()
      await useSession(context, sessions[role])
      const tab = await context.newPage()
      await tab.goto(`/jobs/${jobId}`)
      const face = tab.getByRole('row').filter({ hasText: 'scan_1.png' })
        .getByTestId('presence-avatars').getByLabel(colleague)
      await expect(face, `the ${role}'s page row`).toBeVisible()
      await expect(face.locator('img'), `the ${role}'s page row`).toHaveAttribute('src', picture)
      await context.close()
    }
    await theirs.close()
  })

  // README: "Settings follow you into every open tab: a change made in one reaches the
  // others in the same browser at once".
  test('a setting changed in one tab reaches the other tab of the same browser at once, both ways',
    async ({ browser }) => {
      const context = await browser.newContext()
      await useSession(context, seedSession('member', `onebrowser-${Date.now()}`))
      const stored = async () => (await (await context.request.get('/api/settings')).json()).share_activity
      const tabA = await context.newPage()
      await tabA.goto('/settings?section=together')
      const tabB = await context.newPage()
      await tabB.goto('/settings?section=together')
      await expect(tabA.getByTestId('share-activity')).toBeChecked()
      await expect(tabB.getByTestId('share-activity')).toBeChecked()

      // Well inside the five-second re-read, so only a message between the tabs can pass it.
      await tabA.getByTestId('share-activity').uncheck()
      await expect(tabB.getByTestId('share-activity')).not.toBeChecked({ timeout: 2_000 })
      await expect.poll(stored).toBe(false)

      await tabB.getByTestId('share-activity').check()
      await expect(tabA.getByTestId('share-activity')).toBeChecked({ timeout: 2_000 })
      await expect.poll(stored).toBe(true)
      await context.close()
    })

  // README: "and those on another device within seconds, sharing what you work on
  // included, so a second window stops broadcasting too".
  test('switching sharing off in one tab switches it off in the person\'s other tab, which stops broadcasting',
    async ({ browser }) => {
      const username = `twotabs-${Date.now()}`
      const contexts = await Promise.all([browser.newContext(), browser.newContext()])
      const [tabA, tabB] = await Promise.all(contexts.map(async (context) => {
        await useSession(context, seedSession('member', username))
        const tab = await context.newPage()
        await tab.goto('/settings?section=together')
        return tab
      }))
      await expect(tabB.getByTestId('share-activity')).toBeChecked()
      await expect.poll(async () => (await whereIs(username)) !== null).toBe(true)

      await tabA.getByTestId('share-activity').uncheck()
      await expect.poll(async () => (await (await tabA.request.get('/api/settings')).json()).share_activity)
        .toBe(false)

      await expect(tabB.getByTestId('share-activity')).not.toBeChecked({ timeout: 20_000 })
      await expect.poll(async () => whereIs(username), { timeout: 20_000 }).toBeNull()
      await Promise.all(contexts.map((context) => context.close()))
    })
})

test.describe('Scenario: an admin reads the list as one person sees it', () => {
  // README: "An admin can read the list as one person sees it. Picking a name narrows it to
  // the datasets that person owns, was shared directly, or reaches through a group - the same
  // rules the access column draws."
  test('the lens shows exactly the datasets the access record says that person reaches',
    async ({ page }) => {
      const username = `lens-${Date.now()}`
      seedSession('member', username)
      const ownedName = uniqueName('Owned')
      const sharedName = uniqueName('Shared')
      const viaGroupName = uniqueName('Via group')
      const hiddenName = uniqueName('Hidden')
      const owned = await createJob(ownedName, 1, undefined, identity(username, 'member'))
      await waitForJobStatus(owned, 'done')
      const shared = await seedCompletedJob(sharedName, 1)
      await shareJob(shared, [username])
      const group = await createGroup(uniqueName('Lens group'))
      const viaGroup = await seedCompletedJob(viaGroupName, 1)
      await moveJobToGroup(viaGroup, group.id)
      await shareGroup(group.id, [username])
      const hidden = await seedCompletedJob(hiddenName, 1)

      // The backend's answer first: three datasets, each for its own reason, and not the fourth.
      const access = await backendFetch(`/api/contributors/${encodeURIComponent(username)}/access`)
      const reasons = Object.fromEntries(
        access.datasets.map((d: { id: string; access: string }) => [d.id, d.access]))
      expect(Object.keys(reasons).sort()).toEqual([owned, shared, viaGroup].sort())
      expect(reasons).toEqual({ [owned]: 'owner', [shared]: 'shared', [viaGroup]: 'group' })
      expect(reasons[hidden]).toBeUndefined()
      expect(access.groups).toEqual([{ id: group.id, name: group.name, access: 'shared' }])

      await page.goto(`/?as=${encodeURIComponent(username)}`)
      const strip = page.getByTestId('lens-strip')
      await expect(strip).toContainText(`Showing what ${username} reaches`)
      const card = (name: string) => page.getByTestId('job-card').filter({ hasText: name })
      for (const name of [ownedName, sharedName, viaGroupName]) await expect(card(name)).toHaveCount(1)
      await expect(card(hiddenName)).toHaveCount(0)

      // Taking the lens off brings the fourth back, and keeps the three.
      await strip.getByRole('button', { name: 'Show all datasets' }).click()
      await expect(card(hiddenName)).toHaveCount(1)
      await expect(strip).toHaveCount(0)
      for (const name of [ownedName, sharedName, viaGroupName]) await expect(card(name)).toHaveCount(1)
    })
})
