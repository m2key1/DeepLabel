import { useState } from 'react'
import { signUp } from '../api'
import { AccountCard, AccountError, AccountField } from '../components/account/AccountCard'
import { NewPassword } from '../components/account/NewPassword'
import { useNewPassword } from '../components/account/useNewPassword'
import { Button } from '../components/ui/Button'

/** Making an account. It is signed in at once and then waits until an admin lets it in. */
export function SignUpPage() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const password = useNewPassword([name, email])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!password.acceptable) return
    setBusy(true)
    setError(null)
    try {
      const { next } = await signUp(name, email, password.value.password)
      window.location.replace(next)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <AccountCard title="Create an account" testid="sign-up-form" onSubmit={() => void submit()} footer={
      <p>Have an account? <a href="/sign-in" className="text-accent-ink hover:underline">Sign in</a></p>
    }>
      <p className="text-sm text-ink-muted">New accounts need an admin's approval. Until then, signing in shows a
        waiting page.</p>
      <AccountField label="Name" data-testid="sign-up-name" autoFocus autoComplete="name"
                    value={name} onChange={(e) => setName(e.target.value)} />
      <AccountField label="Email" data-testid="sign-up-email" type="email" required autoComplete="email"
                    value={email} onChange={(e) => setEmail(e.target.value)} />
      <NewPassword state={password} />
      <AccountError message={password.problem ?? error} />
      <Button data-testid="sign-up-submit" type="submit" variant="primary" size="md" className="w-full"
              disabled={busy || !password.acceptable}>
        {busy ? 'Creating account…' : 'Create account'}
      </Button>
    </AccountCard>
  )
}
