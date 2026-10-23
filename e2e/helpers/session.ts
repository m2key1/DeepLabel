import { execSync } from 'node:child_process'
import type { BrowserContext, Page } from '@playwright/test'
import { FRONTEND } from './frontend'

export type SeededRole = 'viewer' | 'member' | 'admin'

// Creates a user with a live session directly in the auth container's database;
// the dev bypass can only ever mint admin sessions for the dev user.
export function seedSession(
  role: SeededRole, username: string, profile: { email?: string; displayName?: string } = {},
): string {
  const script = [
    'from app import auth, config, store',
    'conn = store.connect(config.DB_PATH)',
    `user = store.upsert_user(conn, 'e2e-${username}', '${username}', '${role}', `
      + `'${profile.email ?? ''}', '${profile.displayName ?? ''}')`,
    'token = auth.new_token()',
    "store.create_session(conn, user['id'], token, auth.session_expiry())",
    'print(token)',
  ].join('; ')
  const out = execSync(`docker compose -f ../compose.e2e.yml exec -T auth python -c "${script}"`)
  return out.toString().trim()
}

/** Somebody who was here once and has not been since - what the online dot must not
 *  claim, and what nothing else in the suite produces: a seeded session is a fresh login. */
export function seedStaleUser(role: SeededRole, username: string, daysAgo = 7): void {
  const script = [
    'from datetime import datetime, timedelta, timezone',
    'from app import config, store',
    'conn = store.connect(config.DB_PATH)',
    `user = store.upsert_user(conn, 'e2e-${username}', '${username}', '${role}')`,
    `stamp = (datetime.now(timezone.utc) - timedelta(days=${daysAgo})).strftime('%Y-%m-%d %H:%M:%S')`,
    "conn.execute('UPDATE users SET last_login_at = ?, last_seen_at = ? WHERE id = ?', (stamp, stamp, user['id']))",
    'conn.commit()',
  ].join('; ')
  execSync(`docker compose -f ../compose.e2e.yml exec -T auth python -c "${script}"`)
}

/** Pushes one of a person's tokens past its expiry, which no API call can do. */
export function expireToken(username: string, name: string): void {
  const script = [
    'from app import config, store',
    'conn = store.connect(config.DB_PATH)',
    "conn.execute(\\\"UPDATE api_tokens SET expires_at = datetime('now', '-1 day') WHERE name = ? AND "
      + "user_id = (SELECT id FROM users WHERE username = ?)\\\", "
      + `('${name}', '${username}'))`,
    'conn.commit()',
  ].join('; ')
  execSync(`docker compose -f ../compose.e2e.yml exec -T auth python -c "${script}"`)
}

export async function useSession(context: BrowserContext, token: string) {
  await context.clearCookies()
  await context.addCookies([{ name: 'sid', value: token, domain: 'localhost', path: '/' }])
}

/** Through nginx with a session cookie - the path a browser signed in as that person takes,
 *  so the capability set the auth service resolved is what the backend sees. Redirects are
 *  left unfollowed so a 401 is read as the 401 it is, not as the login page it bounces to. */
export function asSession(session: string, path: string, init: RequestInit = {}) {
  return fetch(`${FRONTEND}${path}`, {
    ...init,
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', cookie: `sid=${session}`, ...(init.headers ?? {}) },
  })
}

/** An account as the auth service's admin list serves it. */
export interface UserRecord {
  id: number
  username: string
  role: SeededRole
  active: number
  sessions: number
  tokens: number
  capabilities: string[]
  permissions: Record<string, boolean>
}

/** One account's record, read through the signed-in admin's own browser context - the
 *  oracle for what a matrix click or a Disable button really changed. */
export async function userRecord(page: Page, username: string): Promise<UserRecord> {
  const res = await page.request.get('/api/users')
  const users = (await res.json()).users as UserRecord[]
  return users.find((u) => u.username === username)!
}
