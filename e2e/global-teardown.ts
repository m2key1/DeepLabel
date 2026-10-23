import { execSync } from 'node:child_process'

export default async function globalTeardown() {
  if (process.env.E2E_KEEP_STACK) return
  execSync('docker compose -f ../compose.e2e.yml down -v', { stdio: 'inherit' })
}
