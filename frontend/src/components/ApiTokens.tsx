import { Fragment, useCallback, useEffect, useState } from 'react'
import { createApiToken, deleteApiToken, listApiTokens } from '../api'
import type { ApiToken } from '../api'
import { useAuth } from '../auth'
import { useAutoClear } from '../messages'
import { ModelChooser, TokenModelsEditor } from './TokenModels'
import { modelsLabel, readsSomething, useRecognitionOffer } from '../tokenModels'
import { Section } from './ui/Section'
import { Button } from './ui/Button'
import { Input, Select } from './ui/Field'
import { EmptyState } from './ui/EmptyState'

const EXPIRY_CHOICES: { label: string; days: number | null }[] = [
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: '1 year', days: 365 },
  { label: 'never', days: null },
]

const stamp = (value: string | null) => (value ? value.slice(0, 10) : '-')

type Access = 'all' | 'readonly' | 'recognize'

const ACCESS_CHOICES: { value: Access; label: string }[] = [
  { value: 'all', label: 'Read/write' },
  { value: 'readonly', label: 'Read-only' },
  { value: 'recognize', label: 'Recognition only' },
]

export const tokenAccess = (t: ApiToken) =>
  t.scope === 'recognize' ? 'recognition only' : t.readonly ? 'read-only' : 'read/write'

export function ApiTokens() {
  const [tokens, setTokens] = useState<ApiToken[]>([])
  const [name, setName] = useState('')
  const { can } = useAuth()
  const [access, setAccess] = useState<Access>('all')
  const offer = useRecognitionOffer(can('recognize'))
  const [models, setModels] = useState<number[] | null>(null)
  const [changing, setChanging] = useState<number | null>(null)
  const [expiryDays, setExpiryDays] = useState<number | null>(365)
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
      const created = await createApiToken({
        name: name.trim(), readonly: access === 'readonly', scope: access === 'recognize' ? 'recognize' : 'all',
        expires_days: expiryDays, models: access === 'recognize' ? models : null,
      })
      setMinted(created.token)
      setName('')
      setModels(null)
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
        Lets scripts and notebooks use the API as you - send it as{' '}
        <code>Authorization: Bearer &lt;token&gt;</code>.{' '}
        <a href="/docs" className="underline underline-offset-2">API docs</a>
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
        <Select
          size="md"
          value={access}
          onChange={(e) => setAccess(e.target.value as Access)}
          aria-label="Access"
          title="A token can never do more than your role allows."
          className="cursor-pointer"
        >
          {ACCESS_CHOICES.filter((c) => c.value !== 'recognize' || can('recognize')).map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </Select>
        <Button variant="primary" size="md" onClick={create}
                disabled={busy || !name.trim() || (access === 'recognize' && offer !== null && !readsSomething(models, offer))}>
          {busy ? 'Creating…' : 'Create token'}
        </Button>
      </div>
      {access === 'recognize' && offer && (
        <div className="mb-3">
          <ModelChooser offer={offer} value={models} onChange={setModels} />
        </div>
      )}

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
        <EmptyState>No tokens yet.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
        <table className="w-full whitespace-nowrap text-sm [&_td]:pr-3 [&_th]:pr-3">
          <thead>
            <tr className="border-b border-line text-left text-xs text-ink-muted">
              <th className="py-1 font-medium">Name</th>
              <th className="py-1 font-medium">Prefix</th>
              <th className="py-1 font-medium">Access</th>
              <th className="py-1 font-medium">Models</th>
              <th className="py-1 font-medium">Last used</th>
              <th className="py-1 font-medium">Expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <Fragment key={t.id}>
              <tr data-testid="token-row" data-expired={t.expired || undefined}
                  title={t.expired ? 'Expired - refused by the API, listed until revoked' : undefined}
                  className={`border-b border-line ${t.expired ? 'text-ink-subtle opacity-60' : ''}`}>
                <td className="py-1.5">{t.name}</td>
                <td className="py-1.5 font-mono text-xs text-ink-muted">{t.prefix}…</td>
                <td className="py-1.5">{tokenAccess(t)}</td>
                <td data-testid="token-models-label" className="max-w-56 truncate py-1.5" title={modelsLabel(t, offer)}>
                  {modelsLabel(t, offer)}
                </td>
                <td className="py-1.5 text-ink-muted">{stamp(t.last_used_at)}</td>
                <td className="py-1.5 text-ink-muted">{t.expired ? `expired ${stamp(t.expires_at)}` : stamp(t.expires_at)}</td>
                <td className="space-x-3 py-1.5 text-right">
                  {t.scope === 'recognize' && offer && (
                    <button onClick={() => setChanging(changing === t.id ? null : t.id)} aria-expanded={changing === t.id}
                            className="text-xs text-ink-muted hover:text-accent-ink hover:underline">
                      Change models
                    </button>
                  )}
                  <button onClick={() => revoke(t)}
                          className="text-xs text-danger hover:underline">
                    Revoke
                  </button>
                </td>
              </tr>
              {changing === t.id && offer && (
                <TokenModelsEditor token={t} offer={offer} columns={7} onCancel={() => setChanging(null)}
                                   onSaved={() => { setChanging(null); refresh() }} />
              )}
              </Fragment>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </Section>
  )
}
