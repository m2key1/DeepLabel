import { useEffect, useState } from 'react'
import { getSignInOptions, signIn } from '../api'
import type { SecondFactorStep } from '../api'
import { AccountCard, AccountError, AccountField } from '../components/account/AccountCard'
import { SecondFactor } from '../components/account/SecondFactor'
import { Button } from '../components/ui/Button'

/** Where the page asked to go back to, as the auth service handed it over. The service
 *  checks it again, so a link to another site never gets further than this. */
function nextPage(): string {
  return new URLSearchParams(window.location.search).get('next') ?? '/'
}

const footerLink = 'text-accent-ink hover:underline'

/** DeepLabel's own sign-in. Drawn outside the signed-in app, which would otherwise ask who
 *  is there and send the visitor straight back here. */
export function SignInPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [signUp, setSignUp] = useState(false)
  const [asked, setAsked] = useState<{ step: SecondFactorStep; pending: string } | null>(null)

  useEffect(() => {
    getSignInOptions().then((o) => setSignUp(o.sign_up)).catch(() => undefined)
  }, [])

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const answer = await signIn(email, password, nextPage())
      if ('next' in answer) {
        window.location.replace(answer.next)
        return
      }
      setPassword('')
      setAsked(answer)
    } catch (err) {
      setError((err as Error).message)
      setPassword('')
      setBusy(false)
    }
  }

  if (asked) return <SecondFactor first={asked} />
  return (
    <AccountCard title="Sign in" testid="sign-in-form" onSubmit={() => void submit()} footer={
      <>
        {signUp && (
          <p className="mb-1">
            New here? <a href="/sign-up" data-testid="sign-up-link" className={footerLink}>Create an account</a>
          </p>
        )}
        <p>Forgot your password? Ask an admin for a new one.</p>
      </>
    }>
      <AccountField label="Email or username" data-testid="sign-in-email" required autoFocus
                    autoComplete="username" autoCapitalize="none" spellCheck={false}
                    value={email} onChange={(e) => setEmail(e.target.value)} />
      <AccountField label="Password" data-testid="sign-in-password" type="password" required
                    autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <AccountError message={error} />
      <Button data-testid="sign-in-submit" type="submit" variant="primary" size="md" className="w-full" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </Button>
    </AccountCard>
  )
}
