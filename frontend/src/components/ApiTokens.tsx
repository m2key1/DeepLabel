import { useCallback, useEffect, useState } from 'react'
import { createApiToken, deleteApiToken, listApiTokens } from '../api'
import type { ApiToken } from '../api'
import { useAutoClear } from '../messages'
import { Section } from './ui/Section'
import { Button } from './ui/Button'
import { Check, Input, Select } from './ui/Field'
import { EmptyState } from './ui/EmptyState'

const EXPIRY_CHOICES: { label: string; days: number | null }[] = [
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: '1 year', days: 365 },
  { label: 'never', days: null },
]


const stamp = (value: string | null) => (value ? value.slice(0, 10) : '-')

export function ApiTokens() {
  const [tokens, setTokens] = useState<ApiToken[]>([])
  const [name, setName] = useState('')
  const [readonly, setReadonly] = useState(false)
  const [expiryDays, setExpiryDays] = useState<number | null>(90)
  const [minted, setMinted] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useAutoClear(error, setError)

  const refresh = useCallback(() => {
    listApiTokens()
      .then((r) => setTokens(r.tokens))
      .catch((e: Error) => setError(e.message))
  }, [])

  useEffect(refresh, [refresh])

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const created = await createApiToken({ name: name.trim(), readonly, expires_days: expiryDays })
      setMinted(created.token)
      setName('')
      refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (token: ApiToken) => {
    if (!confirm(`Revoke "${token.name}"? Anything using it stops working immediately.`)) return
    try {
      await deleteApiToken(token.id)
      refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <Section
      title="API tokens"
      className="mb-0"
      data-testid="api-tokens"
      description={<>
        For scripts and notebooks: send one as <code>Authorization: Bearer …</code> to reach the same
        API this page uses. A token acts as you, so it can never do more than your role allows.
        These are yours alone - nobody else sees them here, not even an admin.
        The full list of endpoints is at <a href="/docs" className="underline underline-offset-2">/docs</a>.
      </>}
    >

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          size="md"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && name.trim() && create()}
          placeholder="What is it for?"
          aria-label="Token name"
          className="min-w-40 flex-1"
        />
        <Select
          size="md"
          value={expiryDays === null ? 'never' : String(expiryDays)}
          onChange={(e) => setExpiryDays(e.target.value === 'never' ? null : Number(e.target.value))}
          aria-label="Expires"
          className="cursor-pointer"
        >
          {EXPIRY_CHOICES.map((c) => (
            <option key={c.label} value={c.days === null ? 'never' : String(c.days)}>
              {c.label}
            </option>
          ))}
        </Select>
        <label className="flex items-center gap-1.5 text-sm text-ink">
          <Check checked={readonly} onChange={(e) => setReadonly(e.target.checked)}
                 data-testid="token-readonly" />
          Read-only
        </label>
        <Button variant="primary" size="md" onClick={create} disabled={busy || !name.trim()}>
          {busy ? 'Creating…' : 'Create token'}
        </Button>
      </div>

      {minted && (
        <div data-testid="token-secret"
             className="mb-3 rounded border border-ok/40 bg-ok/10 p-3">
          <p className="mb-1 text-xs text-ok">
            Copy it now - it is stored only as a hash and cannot be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all text-xs">{minted}</code>
            <button
              onClick={() => navigator.clipboard?.writeText(minted)}
              className="rounded border border-ok/50 px-2 py-1 text-xs text-ok"
            >
              Copy
            </button>
            <button onClick={() => setMinted(null)}
                    className="text-xs text-ink-muted hover:text-ink">
              Dismiss
            </button>
          </div>
        </div>
      )}

      {error && <p className="mb-2 text-sm text-danger">{error}</p>}

      {tokens.length === 0 ? (
        <EmptyState>No tokens yet. One minted here reaches the same API this page uses.</EmptyState>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-ink-muted">
              <th className="py-1 font-medium">Name</th>
              <th className="py-1 font-medium">Prefix</th>
              <th className="py-1 font-medium">Access</th>
              <th className="py-1 font-medium">Last used</th>
              <th className="py-1 font-medium">Expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id} data-testid="token-row" data-expired={t.expired || undefined}
                  title={t.expired ? 'Expired - refused by the API, listed until revoked' : undefined}
                  className={`border-b border-line ${t.expired ? 'text-ink-subtle opacity-60' : ''}`}>
                <td className="py-1.5">{t.name}</td>
                <td className="py-1.5 font-mono text-xs text-ink-muted">{t.prefix}…</td>
                <td className="py-1.5">{t.readonly ? 'read-only' : 'read/write'}</td>
                <td className="py-1.5 text-ink-muted">{stamp(t.last_used_at)}</td>
                <td className="py-1.5 text-ink-muted">{t.expired ? `expired ${stamp(t.expires_at)}` : stamp(t.expires_at)}</td>
                <td className="py-1.5 text-right">
                  <button onClick={() => revoke(t)}
                          className="text-xs text-danger hover:underline">
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  )
}
