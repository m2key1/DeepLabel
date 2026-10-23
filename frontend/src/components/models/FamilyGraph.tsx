import { useState } from 'react'
import { Link } from 'react-router-dom'
import { lineage, type Family, type Score, type Version } from './families'
import { formatDate } from '../../util'

const ROW = 40
const LANE = 18
const PAD = 14
const BEND = 12

export function formatScore(score: Score | null): string {
  if (!score) return 'not scored'
  const value = score.metric === 'CER' ? `${(score.value * 100).toFixed(2)}%` : `${score.metric} ${score.value.toFixed(3)}`
  return score.kind === 'test' ? value : `${value} ${score.kind}`
}

const scoreTitle: Record<Score['kind'], string> = {
  test: "CER on its run's test set, default decode",
  valid: "CER on its run's validation split, default decode",
  eval: 'CER of its newest evaluation, default decode',
  training: "the trainer's own validation figure",
}

function Tags({ version }: { version: Version }) {
  const tag = 'rounded px-1.5 py-px text-[10px] font-semibold tracking-wide whitespace-nowrap'
  return (
    <span className="flex shrink-0 gap-1">
      {version.isDefault && <span data-testid="version-tag" className={`${tag} bg-accent-wash text-accent-ink`}>★ DEFAULT</span>}
      {version.state === 'running' && (
        <span data-testid="version-tag" className={`${tag} border border-dashed border-accent text-accent-ink`}>RUNNING</span>
      )}
      {version.state === 'failed' && (
        <span data-testid="version-tag" className={`${tag} border border-danger/40 text-danger`}>FAILED</span>
      )}
      {version.archived && <span data-testid="version-tag" className={`${tag} border border-line text-ink-subtle`}>ARCHIVED</span>}
    </span>
  )
}

function Graph({ versions, path }: { versions: Version[]; path: Version[] }) {
  const lanes = [...new Set(versions.map((v) => v.lane))].sort((a, b) => a - b)
  const column = new Map(lanes.map((lane, i) => [lane, i]))
  const row = new Map(versions.map((v, i) => [v.key, i]))
  const byKey = new Map(versions.map((v) => [v.key, v]))
  const x = (v: Version) => PAD + column.get(v.lane)! * LANE
  const y = (v: Version) => row.get(v.key)! * ROW + ROW / 2
  const width = PAD * 2 + (lanes.length - 1) * LANE
  const onPath = new Set(path.map((v) => v.key))
  const lit = path.length > 0
  const edge = (child: Version, parent: Version) => (child.lane === parent.lane
    ? `M ${x(child)} ${y(child)} V ${y(parent)}`
    : `M ${x(child)} ${y(child)} V ${y(parent) - BEND} Q ${x(child)} ${y(parent)} ${x(child) - BEND} ${y(parent)} H ${x(parent)}`)

  // A lane can carry several branches one above the other, so lines follow branches: the
  // run of versions linked by parent on one lane, down to the one that forked.
  const baseOf = (v: Version) => {
    let at = v
    for (let up = byKey.get(at.parentKey ?? ''); up && up.lane === v.lane; up = byKey.get(at.parentKey ?? '')) at = up
    return at.key
  }
  const branches = new Map<string, Version[]>()
  for (const v of versions) branches.set(baseOf(v), [...(branches.get(baseOf(v)) ?? []), v])

  const paths: { key: string; d: string; retired: boolean }[] = []
  for (const [base, members] of branches) {
    const retired = members.every((v) => v.archived)
    const top = members[0]
    const bottom = members[members.length - 1]
    const parent = bottom.parentKey ? byKey.get(bottom.parentKey) : undefined
    if (!parent) {
      if (members.length > 1) paths.push({ key: base, d: `M ${x(top)} ${y(top)} V ${y(bottom)}`, retired })
      continue
    }
    paths.push({ key: base, d: edge(top, parent), retired })
  }

  return (
    <svg aria-hidden width={width} height={versions.length * ROW} className="shrink-0 overflow-visible">
      {paths.map((p) => (
        <path key={p.key} d={p.d} fill="none" strokeWidth={2}
              className={`transition-opacity ${p.retired ? 'stroke-line' : 'stroke-accent/60'} ${lit ? 'opacity-25' : ''}`} />
      ))}
      {path.slice(0, -1).map((v, i) => (
        <path key={`lit-${v.key}`} data-testid="graph-path" data-version={v.key} d={edge(v, path[i + 1])}
              fill="none" strokeWidth={3} className="stroke-accent" />
      ))}
      {versions.map((v) => {
        const hovered = lit && v.key === path[0].key
        const r = v.isDefault || hovered ? 7 : v.archived ? 4 : 5
        const fill = v.isDefault || hovered ? 'fill-accent' : v.archived ? 'fill-line' : 'fill-surface'
        const stroke = v.state === 'failed' ? 'stroke-danger' : v.archived ? 'stroke-line' : 'stroke-accent'
        return (
          <g key={v.key} data-testid="graph-dot" data-version={v.key} data-lane={v.lane}
             data-on-path={lit ? onPath.has(v.key) : undefined} data-hovered={hovered || undefined}
             className={`transition-opacity ${lit && !onPath.has(v.key) ? 'opacity-25' : ''}`}>
            <circle cx={x(v)} cy={y(v)} r={r} strokeWidth={2} className={`${fill} ${stroke}`}
                    strokeDasharray={v.state === 'running' ? '3 2' : undefined} />
            {v.state === 'failed' && (
              <path d={`M ${x(v) - 2.5} ${y(v) - 2.5} l 5 5 m 0 -5 l -5 5`} strokeWidth={1.5} className="stroke-danger" />
            )}
          </g>
        )
      })}
    </svg>
  )
}

/** One family's versions as git log --graph draws commits: newest on top, the main line
 *  straight down, forks on lanes to the right curving back into what they came from. */
export function FamilyGraph({ family }: { family: Family }) {
  const nameOf = new Map(family.versions.map((v) => [v.key, v.name]))
  const [hovered, setHovered] = useState<string | null>(null)
  const path = hovered ? lineage(family.versions, hovered) : []
  const onPath = new Set(path.map((v) => v.key))
  return (
    <div className="flex overflow-x-auto" data-testid="family-graph">
      <Graph versions={family.versions} path={path} />
      <ol className="min-w-0 flex-1" onMouseLeave={() => setHovered(null)} onBlur={() => setHovered(null)}>
        {family.versions.map((v) => (
          <li key={v.key} data-testid="version-row" data-version={v.key} data-state={v.state}
              data-on-path={hovered ? onPath.has(v.key) : undefined}
              onMouseEnter={() => setHovered(v.key)} onFocus={() => setHovered(v.key)}
              className={`flex items-center gap-3 border-b border-line/60 px-2 text-xs last:border-b-0 ${
                v.archived ? 'opacity-60' : ''} ${v.key === hovered ? 'bg-accent-wash' : onPath.has(v.key) ? 'bg-raised' : ''}`}
              style={{ height: ROW }}>
            <span className="w-16 shrink-0 font-mono tabular-nums text-ink-subtle">{v.ref}</span>
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className="truncate font-medium text-ink">{v.name}</span>
              <Tags version={v} />
            </span>
            <span className="hidden w-36 shrink-0 truncate text-ink-subtle md:block">
              {v.parentKey ? `from ${nameOf.get(v.parentKey) ?? 'another family'}` : 'root'}
            </span>
            <span data-testid="version-score" title={v.score ? scoreTitle[v.score.kind] : undefined}
                  className="w-28 shrink-0 text-right tabular-nums text-ink-muted">
              {v.state === 'running' ? (v.run?.progress_last?.epoch !== undefined ? `epoch ${v.run.progress_last.epoch}` : v.run?.status)
                : v.state === 'failed' ? 'failed' : formatScore(v.score)}
            </span>
            <span className="hidden w-32 shrink-0 text-right tabular-nums text-ink-subtle sm:block">
              {formatDate(v.createdAt)}
            </span>
            <span className="hidden w-20 shrink-0 truncate text-ink-subtle lg:block">{v.author ?? 'shipped'}</span>
            <span className="w-12 shrink-0 text-right">
              {v.model ? (
                <Link to={`/models/${v.model.id}`} data-testid="version-open" className="text-accent-ink hover:underline">
                  Open
                </Link>
              ) : (
                <Link to={`/models/runs/${v.run!.id}`} data-testid="version-run" className="text-accent-ink hover:underline">
                  Run
                </Link>
              )}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}
