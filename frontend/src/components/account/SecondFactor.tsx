import { useState } from 'react'
import { ApiError, signInStep } from '../../api'
import type { SecondFactorStep, SignInAnswer } from '../../api'
import { Button, buttonClass } from '../ui/Button'
import { AccountCard, AccountError, AccountField } from './AccountCard'

const TITLES: Record<SecondFactorStep['kind'], string> = {
  enrol: 'Set up an authenticator app',
  recovery: 'Store your recovery codes',
  code: 'Enter your code',
}

/** The key an app is set up with, in groups of four, as people type it. */
const grouped = (secret: string) => secret.match(/.{1,4}/g)?.join(' ') ?? secret

/** The rest of a sign-in once the password is right: setting up an authenticator app and
 *  recovery codes the first time, a code from either every time after. Each answer goes to the
 *  auth service, which hands back the next step or the page to open. */
export function SecondFactor({ first }: { first: { step: SecondFactorStep; pending: string } }) {
  const [now, setNow] = useState(first)
  const [code, setCode] = useState('')
  const [stored, setStored] = useState(false)
  const [recovery, setRecovery] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // The token is spent or out of time: nothing on this page can be answered any more.
  const [ended, setEnded] = useState<string | null>(null)
  const { step } = now

  const answer = async (reply: { code?: string; stored?: boolean }) => {
    setBusy(true)
    setError(null)
    try {
      const next: SignInAnswer = await signInStep(now.pending, reply)
      if ('next' in next) {
        window.location.replace(next.next)
        return
      }
      setNow(next)
      setCode('')
      setStored(false)
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) setEnded(err.message)
      else setError((err as Error).message)
    }
    setBusy(false)
  }

  if (ended) {
    return (
      <AccountCard title="Sign in again" testid="second-factor-ended">
        <p className="text-sm text-ink-muted">{ended}</p>
        <a href="/sign-in" data-testid="second-factor-restart" className={buttonClass({ variant: 'primary', size: 'md' }, 'w-full')}>
          Start again
        </a>
      </AccountCard>
    )
  }
  const submit = () => void answer(step.kind === 'recovery' ? { stored: true } : { code })
  const said = error ?? ('error' in step ? step.error ?? null : null)

  const codes = step.kind === 'recovery' ? step.codes.join('\n') : ''
  return (
    <AccountCard title={TITLES[step.kind]} testid="second-factor" onSubmit={submit}
                 footer={<a href="/sign-in" className="text-accent-ink hover:underline">Start again</a>}>
      <div data-testid="second-factor-step" data-kind={step.kind} className="space-y-4">
        {step.kind === 'enrol' && (
          <>
            <p className="text-sm text-ink-muted">
              Signing in to DeepLabel takes a code from an authenticator app on your phone as well as your password.
              Scan this with an app such as Aegis, Google Authenticator or Microsoft Authenticator, then type the
              six-digit code it shows.
            </p>
            <img src={step.qr} alt="QR code to scan with your authenticator app" data-testid="second-factor-qr"
                 className="mx-auto size-48 rounded bg-white p-1" />
            <p className="text-xs text-ink-muted">
              Cannot scan it? Type this key into the app instead:
              <span data-testid="second-factor-secret" className="mt-1 block select-all break-all font-mono text-sm text-ink">
                {grouped(step.secret)}
              </span>
            </p>
          </>
        )}
        {step.kind === 'code' && (
          <p className="text-sm text-ink-muted">
            {recovery
              ? 'Type one of the recovery codes you stored. Each one works once.'
              : 'Type the six-digit code your authenticator app shows for DeepLabel.'}
          </p>
        )}
        {step.kind === 'recovery' ? (
          <>
            <p className="text-sm text-ink-muted">
              If you lose your phone, each of these codes signs you in once instead of the app. Store them somewhere
              safe - they are shown only now.
            </p>
            <ol data-testid="second-factor-codes" className="grid grid-cols-2 gap-1.5 rounded bg-raised p-3 font-mono text-sm text-ink">
              {step.codes.map((c) => <li key={c} className="select-all">{c}</li>)}
            </ol>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void navigator.clipboard?.writeText(codes)}>Copy</Button>
              <a className="inline-flex" download="deeplabel-recovery-codes.txt"
                 href={`data:text/plain;charset=utf-8,${encodeURIComponent(codes + '\n')}`}>
                <Button size="sm" tabIndex={-1}>Download</Button>
              </a>
            </div>
            <label className="flex items-start gap-2 text-sm text-ink">
              <input type="checkbox" data-testid="second-factor-stored" checked={stored}
                     onChange={(e) => setStored(e.target.checked)} className="mt-0.5 cursor-pointer accent-accent" />
              I have stored these codes somewhere safe
            </label>
          </>
        ) : (
          <AccountField label={recovery ? 'Recovery code' : 'Code'} data-testid="second-factor-code" required autoFocus
                        inputMode={recovery ? 'text' : 'numeric'} autoComplete="one-time-code" autoCapitalize="none"
                        spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} />
        )}
        <AccountError message={said} />
        <Button data-testid="second-factor-submit" type="submit" variant="primary" size="md" className="w-full"
                disabled={busy || (step.kind === 'recovery' ? !stored : !code.trim())}>
          {busy ? 'Checking…' : step.kind === 'recovery' ? 'Continue to DeepLabel' : step.kind === 'enrol' ? 'Continue' : 'Sign in'}
        </Button>
        {step.kind === 'code' && step.recovery && (
          <button type="button" data-testid="second-factor-use-recovery" onClick={() => { setRecovery(!recovery); setCode('') }}
                  className="w-full text-center text-xs text-accent-ink hover:underline">
            {recovery ? 'Use the app instead' : 'Use a recovery code instead'}
          </button>
        )}
      </div>
    </AccountCard>
  )
}
