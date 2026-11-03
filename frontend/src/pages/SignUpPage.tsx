import { useState } from 'react'
import { signUp } from '../api'
import { AccountCard, AccountError, AccountField } from '../components/account/AccountCard'
import { NewPassword } from '../components/account/NewPassword'
import { EMPTY_PASSWORD, newPasswordProblem } from '../components/account/passwordCheck'
import { Button } from '../components/ui/Button'

/** Making an account. It is signed in at once and then waits until an admin lets it in. */
export function SignUpPage() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState(EMPTY_PASSWORD)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const problem = newPasswordProblem(password)

  const submit = async () => {
    if (problem) return
    setBusy(true)
    setError(null)
    try {
      const { next } = await signUp(name, email, password.password)
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
      <p className="text-sm text-ink-muted">An admin lets new accounts in. You can sign in right away and will see
        when they have.</p>
      <AccountField label="Name" data-testid="sign-up-name" autoFocus autoComplete="name"
                    value={name} onChange={(e) => setName(e.target.value)} />
      <AccountField label="Email" data-testid="sign-up-email" type="email" required autoComplete="email"
                    value={email} onChange={(e) => setEmail(e.target.value)} />
      <NewPassword value={password} onChange={setPassword} />
      <AccountError message={problem ?? error} />
      <Button data-testid="sign-up-submit" type="submit" variant="primary" size="md" className="w-full"
              disabled={busy || !!problem}>
        {busy ? 'Creating account…' : 'Create account'}
      </Button>
    </AccountCard>
  )
}
