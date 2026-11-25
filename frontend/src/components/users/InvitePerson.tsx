import { useState } from 'react'
import { addToWorkspaces, inviteUser, type Invitation, type Role } from '../../api'
import { ROLES, ROLE_DESCRIPTION, ROLE_LABEL } from '../../lib/roles'
import { useAutoClear } from '../../messages'
import { Button } from '../ui/Button'
import { Input, Select } from '../ui/Field'
import { Section } from '../ui/Section'
import { PasswordLinkBox } from './PasswordLinkBox'
import { WorkspacePicker } from './WorkspacePicker'

// Lowest first: a new person starts with the least and is given more.
const LOWEST_FIRST = [...ROLES].reverse()

/** What adding someone to workspaces came to, said in a sentence: where they are now, and the
 *  workspaces deleted meanwhile. */
function joinedNote(added: string[], missing: number): string {
  const joined = added.length > 0 ? `Added to ${added.join(', ')}.` : ''
  const gone = missing > 0 ? ` ${missing} workspace${missing === 1 ? ' was' : 's were'} deleted meanwhile and skipped.` : ''
  return (joined + gone).trim()
}

export function InvitePerson() {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<Role>('viewer')
  const [workspaces, setWorkspaces] = useState<number[]>([])
  const [busy, setBusy] = useState(false)
  const [invited, setInvited] = useState<(Invitation & { email: string; joined: string; notJoined: string }) | null>(null)
  const [error, setError] = useState<string | null>(null)
  useAutoClear(error, setError)

  const invite = async () => {
    setBusy(true)
    setError(null)
    setInvited(null)
    try {
      const invitation = await inviteUser(email, name, role)
      // Into the workspaces at once; the link stands whatever comes of that.
      let joined = ''
      let notJoined = ''
      if (workspaces.length > 0) {
        try {
          const { added, missing } = await addToWorkspaces(invitation.username, workspaces)
          joined = joinedNote(added, missing.length)
        } catch (e) {
          notJoined = `The link stands, but they could not be added to the workspaces (${(e as Error).message}). `
            + "Add them from each workspace's Members."
        }
      }
      setInvited({ ...invitation, email: email.trim().toLowerCase(), joined, notJoined })
      setEmail('')
      setName('')
      setRole('viewer')
      setWorkspaces([])
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
            {LOWEST_FIRST.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </Select>
          <span data-testid="invite-role-description" className="text-xs text-ink-muted">{ROLE_DESCRIPTION[role]}</span>
        </label>
        <WorkspacePicker testId="invite-workspaces" chosen={workspaces} onChange={setWorkspaces} disabled={busy} />
        <Button variant="primary" size="md" onClick={invite} disabled={busy || !email.trim()}>
          {busy ? 'Creating link…' : 'Create link'}
        </Button>
      </div>

      {invited && (
        <div data-testid="invite-link" className="mb-3">
          <PasswordLinkBox link={invited} onDismiss={() => setInvited(null)} note={invited.known
            ? `A new password for ${invited.email}, who already has an account.`
            : `${invited.created ? 'Account created' : 'Invitation'} for ${invited.email}.`} />
          {invited.joined && <p data-testid="invite-joined" className="mt-1 text-sm text-ink-muted">{invited.joined}</p>}
          {invited.notJoined && <p role="alert" className="mt-1 text-sm text-warn">{invited.notJoined}</p>}
        </div>
      )}

      {error && <p className="mb-2 text-sm text-danger">{error}</p>}
    </Section>
  )
}
