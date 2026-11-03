import { useState } from 'react'
import { changeMyPassword } from '../../api'
import { Button } from '../ui/Button'
import { Section } from '../ui/Section'
import { AccountError } from './AccountCard'
import { NewPassword } from './NewPassword'
import { EMPTY_PASSWORD, newPasswordProblem } from './passwordCheck'

/** A new password for the person signed in, set without asking the old one: being signed
 *  in is the proof. Every other browser they are signed in on is signed out. */
export function ChangePassword() {
  const [password, setPassword] = useState(EMPTY_PASSWORD)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const problem = newPasswordProblem(password)

  const save = async () => {
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const { ended_sessions: ended } = await changeMyPassword(password.password)
      setPassword(EMPTY_PASSWORD)
      setDone(ended
        ? `Password changed. ${ended === 1 ? 'One other browser was' : `${ended} other browsers were`} signed out.`
        : 'Password changed.')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title="Password" description="Choose a new password. Every other browser you are signed in on is signed out.">
      <form data-testid="change-password" className="max-w-sm space-y-3"
            onSubmit={(e) => { e.preventDefault(); void save() }}>
        <NewPassword value={password} onChange={(next) => { setPassword(next); setDone(null) }} />
        <AccountError message={problem ?? error} />
        {done && <p data-testid="change-password-done" role="status" className="text-sm text-ok">{done}</p>}
        <Button data-testid="change-password-save" type="submit" variant="primary" size="md"
                disabled={busy || !!problem || !password.password || !password.repeat}>
          {busy ? 'Saving…' : 'Change password'}
        </Button>
      </form>
    </Section>
  )
}
