import { useState } from 'react'
import { inviteUser, type Invitation } from '../../api'
import { useAutoClear } from '../../messages'
import { Button } from '../ui/Button'
import { Input } from '../ui/Field'
import { Section } from '../ui/Section'

export function InvitePerson() {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [invited, setInvited] = useState<(Invitation & { email: string }) | null>(null)
  const [error, setError] = useState<string | null>(null)
  useAutoClear(error, setError)

  const invite = async () => {
    setBusy(true)
    setError(null)
    setInvited(null)
    try {
      setInvited({ ...(await inviteUser(email, name)), email: email.trim() })
      setEmail('')
      setName('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section
      title="Invite someone"
      data-testid="invite-person"
      description="Gives you a link to send them yourself - nothing is emailed. Opening it lets
        them choose a password, then they log in with their email. For someone who already
        has an account the same link resets their password; their current one keeps
        working until they use it. Each new link cancels the previous one for that person."
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          size="md"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && email.trim() && invite()}
          placeholder="Email"
          aria-label="Email"
          className="min-w-56 flex-1"
        />
        <Input
          size="md"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && email.trim() && invite()}
          placeholder="Name (optional)"
          aria-label="Name"
          className="min-w-40 flex-1"
        />
        <Button variant="primary" size="md" onClick={invite} disabled={busy || !email.trim()}>
          {busy ? 'Creating link…' : 'Create link'}
        </Button>
      </div>

      {invited && (
        <div data-testid="invite-link" className="mb-3 rounded border border-ok/40 bg-ok/10 p-3">
          <p className="mb-1 text-xs text-ok">
            {invited.created ? 'Account created for' : 'Password reset link for'} {invited.email}.
            Send them this link - it works once, within {invited.valid_days} days.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all text-xs">{invited.link}</code>
            <button
              onClick={() => navigator.clipboard?.writeText(invited.link)}
              className="rounded border border-ok/50 px-2 py-1 text-xs text-ok"
            >
              Copy
            </button>
            <button onClick={() => setInvited(null)} className="text-xs text-ink-muted hover:text-ink">
              Dismiss
            </button>
          </div>
        </div>
      )}

      {error && <p className="mb-2 text-sm text-danger">{error}</p>}
    </Section>
  )
}
