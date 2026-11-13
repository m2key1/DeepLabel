import { useCallback, useEffect, useState } from 'react'
import { getRecognitionUsage, setRecognitionCap } from '../../api'
import type { AppUser, RecognitionCounts, RecognitionUsage as Usage } from '../../api'
import { useAutoClear } from '../../messages'
import { formatRunTime } from '../../util'
import { EmptyState } from '../ui/EmptyState'
import { Input } from '../ui/Field'
import { Section } from '../ui/Section'
import { tableCell, tableHeadRow } from '../ui/Table'

const NONE: RecognitionCounts = { requests: 0, pages: 0, lines: 0, seconds: 0 }

const gpuTime = (seconds: number) =>
  seconds === 0 ? '-' : seconds < 60 ? `${seconds.toFixed(1)} s` : formatRunTime(seconds)

function Counts({ counts }: { counts: RecognitionCounts }) {
  const cell = `${tableCell} py-1.5 text-right font-mono text-xs tabular-nums`
  return (
    <>
      <td data-stat="requests" className={cell}>{counts.requests.toLocaleString()}</td>
      <td data-stat="pages" className={cell}>{counts.pages.toLocaleString()}</td>
      <td data-stat="lines" className={cell}>{counts.lines.toLocaleString()}</td>
      <td data-stat="gpu" className={`${cell} text-ink-muted`}>{gpuTime(counts.seconds)}</td>
    </>
  )
}

/** A cap is saved when it is left or Enter is pressed; empty lifts it. */
function CapField({ account, cap, onSave }: { account: string; cap: number | null; onSave: (cap: number | null) => void }) {
  const [draft, setDraft] = useState(cap === null ? '' : String(cap))
  useEffect(() => setDraft(cap === null ? '' : String(cap)), [cap])
  const save = () => {
    const next = draft.trim() === '' ? null : Math.max(0, Math.floor(Number(draft)))
    if (next !== cap && (next === null || Number.isFinite(next))) onSave(next)
  }
  return (
    <Input size="sm" type="number" min={0} inputMode="numeric" placeholder="none" value={draft}
           aria-label={`Monthly cap for ${account}`} className="w-28 text-right"
           onChange={(e) => setDraft(e.target.value)} onBlur={save}
           onKeyDown={(e) => e.key === 'Enter' && save()} />
  )
}

/** What each account read through the recognition API, this month and last, and the cap on
 *  its lines read. Everyone who may recognize is listed, so a cap can be set before the
 *  first request. */
export function RecognitionUsage({ users }: { users: AppUser[] | null }) {
  const [usage, setUsage] = useState<Usage | null>(null)
  const [error, setError] = useState<string | null>(null)
  useAutoClear(error, setError)

  const refresh = useCallback(() => {
    getRecognitionUsage().then(setUsage).catch((e: Error) => setError(e.message))
  }, [])
  useEffect(refresh, [refresh])

  const save = (account: string, cap: number | null) =>
    setRecognitionCap(account, cap).then(refresh).catch((e: Error) => setError(e.message))

  const permitted = (users ?? []).filter((u) => !u.pending && u.capabilities.includes('recognize'))
    .map((u) => u.username || u.subject)
  const known = new Map((usage?.accounts ?? []).map((a) => [a.account, a]))
  const rows = [...new Set([...known.keys(), ...permitted])].sort().map((account) => known.get(account)
    ?? { account, cap: null, this_month: NONE, last_month: NONE })
  const head = `${tableCell} py-1.5 font-semibold`

  return (
    <Section title="API usage" className="mb-0" data-testid="recognition-usage"
             description="What each account read through the recognition API, by calendar month (UTC). A cap counts lines read; once an account reaches it, its requests are refused until the 1st of next month.">
      {error && <p className="mb-2 text-sm text-danger">{error}</p>}
      {usage && rows.length === 0 && <EmptyState>Nobody may use the recognition API yet.</EmptyState>}
      {usage && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full whitespace-nowrap text-sm">
            <thead>
              <tr className={tableHeadRow}>
                <th />
                <th colSpan={4} className={`${head} text-center`}>This month ({usage.month})</th>
                <th colSpan={4} className={`${head} text-center`}>Last month ({usage.last_month})</th>
                <th />
              </tr>
              <tr className={`${tableHeadRow} border-b border-line`}>
                <th className={head}>Account</th>
                {['this', 'last'].map((month) => ['Requests', 'Pages', 'Lines', 'GPU'].map((label) => (
                  <th key={`${month}-${label}`} className={`${head} text-right`}>{label}</th>
                )))}
                <th className={`${head} text-right`}>Monthly cap, lines</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.account} data-testid="usage-row" className="border-b border-line">
                  <td className={`${tableCell} py-1.5`}>{row.account}</td>
                  <Counts counts={row.this_month} />
                  <Counts counts={row.last_month} />
                  <td className={`${tableCell} py-1 text-right`}>
                    <CapField account={row.account} cap={row.cap} onSave={(cap) => void save(row.account, cap)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}
