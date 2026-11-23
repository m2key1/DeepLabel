import { useEffect, useState } from 'react'
import { getPasswordLink, setPasswordWithLink } from '../api'
import type { SecondFactorStep } from '../api'
import { AccountCard, AccountError } from '../components/account/AccountCard'
import { SecondFactor } from '../components/account/SecondFactor'
import { NewPassword } from '../components/account/NewPassword'
import { useNewPassword } from '../components/account/useNewPassword'
import { Button } from '../components/ui/Button'

const token = () => new URLSearchParams(window.location.search).get('token') ?? ''

/** Where an invitation or a password reset link leads: the person sets a password and is
 *  signed in with it. */
export function SetPasswordPage() {
  const [link, setLink] = useState<{ email: string; purpose: 'invite' | 'reset' } | null>(null)
  const [dead, setDead] = useState<string | null>(null)
  const password = useNewPassword(link ? [link.email] : [])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // A new account sets up its second factor before DeepLabel opens.
  const [asked, setAsked] = useState<{ step: SecondFactorStep; pending: string } | null>(null)

  useEffect(() => {
    getPasswordLink(token()).then(setLink).catch((err: Error) => setDead(err.message))
  }, [])

  const submit = async () => {
    if (!password.acceptable) return
    setBusy(true)
    setError(null)
    try {
      const answer = await setPasswordWithLink(token(), password.value.password)
      if ('next' in answer) {
        window.location.replace(answer.next)
        return
      }
      setAsked(answer)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  if (asked) return <SecondFactor first={asked} />
  if (dead) {
    return (
      <AccountCard title="This link cannot be used" testid="set-password-dead" footer={
        <a href="/sign-in" className="text-accent-ink hover:underline">Go to sign in</a>
      }>
        <p data-testid="set-password-dead-reason" className="text-sm text-ink-muted">{dead}</p>
      </AccountCard>
    )
  }
  if (!link) return null
  return (
    <AccountCard title={link.purpose === 'invite' ? 'Set your password' : 'Choose a new password'}
                 testid="set-password-form" onSubmit={() => void submit()}>
      <p className="text-sm text-ink-muted">
        For <span data-testid="set-password-email" className="text-ink">{link.email}</span>. You sign in with
        this email and the password you choose here.
      </p>
      <NewPassword state={password} />
      <AccountError message={password.problem ?? error} />
      <Button data-testid="set-password-submit" type="submit" variant="primary" size="md" className="w-full"
              disabled={busy || !password.acceptable}>
        {busy ? 'Saving…' : 'Set password and sign in'}
      </Button>
    </AccountCard>
  )
}
