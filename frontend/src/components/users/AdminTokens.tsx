import { useCallback, useEffect, useState } from 'react'
import { deleteApiToken, listAllApiTokens, type ApiToken } from '../../api'
import { formatDate } from '../../util'
import { useAutoClear } from '../../messages'
import { EmptyState } from '../ui/EmptyState'
import { Section } from '../ui/Section'
import { tableCell, tableHeadRow } from '../ui/Table'

const stamp = (value: string | null) => (value ? formatDate(value) : '-')

export const ADMIN_TOKENS_ID = 'admin-tokens'

export function AdminTokens() {
  const [tokens, setTokens] = useState<ApiToken[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useAutoClear(error, setError)

  const refresh = useCallback(() => {
    listAllApiTokens()
      .then((r) => setTokens(r.tokens))
      .catch((e: Error) => setError(e.message))
  }, [])

  useEffect(refresh, [refresh])

  const revoke = async (token: ApiToken) => {
    if (!confirm(`Revoke ${token.username}'s "${token.name}"? Anything using it stops working immediately.`)) return
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
      id={ADMIN_TOKENS_ID}
      data-testid="admin-tokens"
      description="Every token in the instance, so a leaked one can be revoked by someone other
        than its owner. Only the hash is stored, so no token can be read back here - people
        manage their own under Settings."
    >
      {error && <p className="mb-2 text-sm text-danger">{error}</p>}
      {tokens?.length === 0 ? (
        <EmptyState>No tokens have been created yet.</EmptyState>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className={tableHeadRow}>
              <th className={`${tableCell} py-1.5 font-semibold`}>Owner</th>
              <th className={`${tableCell} py-1.5 font-semibold`}>Name</th>
              <th className={`${tableCell} py-1.5 font-semibold`}>Prefix</th>
              <th className={`${tableCell} py-1.5 font-semibold`}>Access</th>
              <th className={`${tableCell} py-1.5 font-semibold`}>Last used</th>
              <th className={`${tableCell} py-1.5 font-semibold`}>Expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tokens?.map((t) => (
              <tr key={t.id} data-testid="admin-token-row" data-expired={t.expired || undefined}
                  title={t.expired ? 'Expired - refused by the API, listed until revoked' : undefined}
                  className={`border-b border-line ${t.expired ? 'text-ink-subtle opacity-60' : ''}`}>
                <td className="py-1.5">{t.username}</td>
                <td className="py-1.5">{t.name}</td>
                <td className="py-1.5 font-mono text-xs text-ink-muted">{t.prefix}…</td>
                <td className="py-1.5">{t.readonly ? 'read-only' : 'read/write'}</td>
                <td className="py-1.5 text-ink-muted">{stamp(t.last_used_at)}</td>
                <td className="py-1.5 text-ink-muted">{t.expired ? `expired ${stamp(t.expires_at)}` : stamp(t.expires_at)}</td>
                <td className="py-1.5 text-right">
                  <button
                    onClick={() => revoke(t)}
                    className="text-xs text-danger hover:underline"
                  >
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
