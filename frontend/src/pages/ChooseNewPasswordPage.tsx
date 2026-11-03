import { useState } from 'react'
import { changeMyPassword, logout, type Me } from '../api'
import { AccountCard, AccountError } from '../components/account/AccountCard'
import { NewPassword } from '../components/account/NewPassword'
import { useNewPassword } from '../components/account/useNewPassword'
import { Button } from '../components/ui/Button'

/** All someone sees after signing in with a password that no longer meets the rules,
 *  until they have chosen a new one. */
export function ChooseNewPasswordPage({ me }: { me: Me }) {
  const password = useNewPassword([me.user, me.email, me.name])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    if (!password.acceptable) return
    setBusy(true)
    setError(null)
    try {
      await changeMyPassword(password.value.password)
      window.location.reload()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const logOut = async () => {
    const done = await logout().catch(() => null)
    window.location.href = done?.redirect ?? '/sign-in'
  }

  return (
    <AccountCard title="Choose a new password" testid="choose-new-password" onSubmit={() => void save()} footer={
      <button type="button" data-testid="choose-new-password-log-out" onClick={() => void logOut()}
              className="text-accent-ink hover:underline">
        Log out instead
      </button>
    }>
      <p className="text-sm text-ink-muted">
        Your password is too easy to guess by today's rules. Choose a new one to go on; any other browser you
        are signed in on is signed out.
      </p>
      <NewPassword state={password} />
      <AccountError message={password.problem ?? error} />
      <Button data-testid="choose-new-password-save" type="submit" variant="primary" size="md" className="w-full"
              disabled={busy || !password.acceptable}>
        {busy ? 'Saving…' : 'Save and continue'}
      </Button>
    </AccountCard>
  )
}
