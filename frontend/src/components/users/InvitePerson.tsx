import { useState } from 'react'
import { inviteUser, type Invitation, type Role } from '../../api'
import { useAutoClear } from '../../messages'
import { Button } from '../ui/Button'
import { Input, Select } from '../ui/Field'
import { Section } from '../ui/Section'
import { PasswordLinkBox } from './PasswordLinkBox'

const ROLES: Role[] = ['viewer', 'member', 'admin']

export function InvitePerson() {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<Role>('viewer')
  const [busy, setBusy] = useState(false)
  const [invited, setInvited] = useState<(Invitation & { email: string }) | null>(null)
  const [error, setError] = useState<string | null>(null)
  useAutoClear(error, setError)

  const invite = async () => {
    setBusy(true)
    setError(null)
    setInvited(null)
    try {
      setInvited({ ...(await inviteUser(email, name, role)), email: email.trim().toLowerCase() })
      setEmail('')
      setName('')
      setRole('viewer')
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
        them choose a password, and they are in with the role you pick, without waiting for
        approval. For someone who already has an account the same link resets their password;
        their current one keeps working until they use it. Each new link cancels the last."
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
        <label className="flex items-center gap-2 text-sm">
          <span className="text-ink-muted">Role</span>
          <Select size="md" data-testid="invite-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </Select>
        </label>
        <Button variant="primary" size="md" onClick={invite} disabled={busy || !email.trim()}>
          {busy ? 'Creating link…' : 'Create link'}
        </Button>
      </div>

      {invited && (
        <div data-testid="invite-link" className="mb-3">
          <PasswordLinkBox link={invited} onDismiss={() => setInvited(null)} note={invited.known
            ? `A new password for ${invited.email}, who already has an account.`
            : `${invited.created ? 'Account created' : 'Invitation'} for ${invited.email}.`} />
        </div>
      )}

      {error && <p className="mb-2 text-sm text-danger">{error}</p>}
    </Section>
  )
}
