import { useEffect } from 'react'
import { getMe, logout, type Me } from '../api'
import { AccountCard } from '../components/account/AccountCard'
import { Button } from '../components/ui/Button'

// How often the page asks whether an admin has let the person in yet.
const LOOK_EVERY_MS = 30_000

/** All a signed-up account sees until an admin approves it. It opens DeepLabel by itself
 *  once they have. */
export function PendingPage({ me }: { me: Me }) {
  useEffect(() => {
    const timer = setInterval(() => {
      getMe().then((now) => { if (!now.pending) window.location.reload() }).catch(() => undefined)
    }, LOOK_EVERY_MS)
    return () => clearInterval(timer)
  }, [])

  const logOut = async () => {
    const done = await logout().catch(() => null)
    window.location.href = done?.redirect ?? '/sign-in'
  }

  return (
    <AccountCard title="Waiting for approval" testid="pending-approval">
      <p className="text-sm text-ink">
        Your account{me.name ? `, ${me.name},` : ''} is waiting for an admin to let you in.
      </p>
      <p className="text-sm text-ink-muted">
        Signed in as <span data-testid="pending-email" className="text-ink">{me.email || me.user}</span>. This page
        opens DeepLabel by itself once you are approved.
      </p>
      <Button data-testid="pending-log-out" variant="outline" size="md" className="w-full" onClick={() => void logOut()}>
        Log out
      </Button>
    </AccountCard>
  )
}
