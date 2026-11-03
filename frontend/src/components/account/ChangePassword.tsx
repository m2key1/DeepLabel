import { useState } from 'react'
import { changeMyPassword } from '../../api'
import { useAuth } from '../../auth'
import { Button } from '../ui/Button'
import { Section } from '../ui/Section'
import { AccountError } from './AccountCard'
import { NewPassword } from './NewPassword'
import { useNewPassword } from './useNewPassword'
import { EMPTY_PASSWORD } from './passwordCheck'

/** A new password for the person signed in, set without asking the old one: being signed
 *  in is the proof. Every other browser they are signed in on is signed out. */
export function ChangePassword() {
  const { user } = useAuth()
  const password = useNewPassword([user])
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const { ended_sessions: ended } = await changeMyPassword(password.value.password)
      password.setValue(EMPTY_PASSWORD)
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
        <NewPassword state={{ ...password, setValue: (next) => { password.setValue(next); setDone(null) } }} />
        <AccountError message={password.problem ?? error} />
        {done && <p data-testid="change-password-done" role="status" className="text-sm text-ok">{done}</p>}
        <Button data-testid="change-password-save" type="submit" variant="primary" size="md"
                disabled={busy || !password.acceptable}>
          {busy ? 'Saving…' : 'Change password'}
        </Button>
      </form>
    </Section>
  )
}
