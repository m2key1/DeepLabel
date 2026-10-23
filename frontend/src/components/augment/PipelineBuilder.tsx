import { useMemo, useState } from 'react'
import type { AugmentCatalog, AugmentTransform } from '../../api'
import { Button } from '../ui/Button'
import { Hint } from '../ui/Hint'
import { ParamField } from './ParamField'
import {
  addInto, duplicateNode, findNode, groupNames, isGroup, moveNode, newGroup, newStep, removeNode,
  summarise, transformsByCategory, updateNode,
} from './pipeline'
import type { PipelineNode } from './pipeline'
import { controlClass } from '../ui/Field'

const smallInput = controlClass('sm', 'w-24 disabled:opacity-60')

function TransformPalette({ catalog, targetName, onClearTarget, onPick }: {
  catalog: AugmentCatalog | null
  /** The group new steps land in, or null for the end of the pipeline. */
  targetName: string | null
  onClearTarget: () => void
  onPick: (name: string) => void
}) {
  const [query, setQuery] = useState('')
  const categories = useMemo(() => transformsByCategory(catalog), [catalog])
  const matches = (transform: AugmentTransform) =>
    `${transform.name} ${transform.doc}`.toLowerCase().includes(query.trim().toLowerCase())

  const entry = (name: string, doc: string) => (
    <button
      key={name}
      type="button"
      data-testid="picker-option"
      onClick={() => onPick(name)}
      title={doc}
      className="block w-full truncate rounded px-1 py-0.5 text-left text-sm hover:bg-accent-wash"
    >
      <span className="font-medium">{name}</span>{' '}
      <span className="text-xs text-ink-muted">{doc}</span>
    </button>
  )

  return (
    <div data-testid="transform-picker"
         className="rounded border border-line p-2">
      <div className="mb-1 text-sm font-medium text-ink">Available transforms</div>
      <p className="mb-2 text-[11px] text-ink-muted">
        {targetName ? (
          <>
            Clicking one adds it inside <span className="font-medium">{targetName}</span>.{' '}
            <button type="button" onClick={onClearTarget}
                    className="text-accent-ink hover:underline">
              Add at the end instead
            </button>
          </>
        ) : (
          'Clicking one adds it to the end of the pipeline.'
        )}
      </p>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={`Search ${catalog?.transforms.length ?? 0} transforms`}
        aria-label="Search transforms"
        className="mb-2 w-full rounded border border-line-strong bg-surface px-2 py-1 text-sm focus-visible:border-accent focus:outline-none"
      />
      <div className="max-h-[32rem] overflow-auto">
        <div className="mb-1 text-[11px] font-semibold uppercase text-ink-muted">
          Groups
        </div>
        {(catalog?.groups ?? []).filter((g) => g.name.toLowerCase().includes(query.trim().toLowerCase()))
          .map((group) => entry(group.name, group.doc))}
        {categories.map(([category, transforms]) => {
          const shown = transforms.filter(matches)
          if (shown.length === 0) return null
          return (
            <div key={category}>
              <div className="mb-1 mt-2 text-[11px] font-semibold uppercase text-ink-muted">
                {category}
              </div>
              {shown.map((transform) => entry(transform.name, transform.doc))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

interface CardProps {
  node: PipelineNode
  transform: AugmentTransform | undefined
  byName: Map<string, AugmentTransform>
  open: string | null
  onOpen: (id: string | null) => void
  nodes: PipelineNode[]
  onChange: (nodes: PipelineNode[]) => void
  readOnly: boolean
  /** The group new steps land in, or null for the end of the pipeline. */
  target: string | null
  onTarget: (target: string | null) => void
  catalog: AugmentCatalog | null
}

/** One step, open or shut. Shut it is a line; open it shows what it does, its parameters
 *  and the things you can do to it - all where you clicked, never in another panel. */
function StepCard(props: CardProps) {
  const { node, transform, byName, open, onOpen, nodes, onChange, readOnly, target, onTarget, catalog } = props
  const expanded = open === node.id
  const group = isGroup(node)
  const tuned = summarise(node)
  const doc = group ? catalog?.groups.find((g) => g.name === node.name)?.doc : transform?.doc

  const action = (label: string, run: () => void, danger = false) => (
    <button
      type="button"
      onClick={run}
      className={`rounded border px-1.5 py-0.5 text-xs ${
        danger
          ? 'border-danger/40 text-danger hover:bg-danger/10'
          : 'border-line text-ink-muted hover:bg-raised'
      }`}
    >
      {label}
    </button>
  )

  return (
    <div
      data-testid="pipeline-step"
      data-step={node.name}
      data-muted={node.muted || undefined}
      className={`rounded border ${
        expanded ? 'border-accent' : 'border-line'
      } ${node.muted ? 'opacity-60' : ''}`}
    >
      <div className="flex items-center gap-1 px-1.5 py-1">
        <button
          type="button"
          onClick={() => onOpen(expanded ? null : node.id)}
          aria-expanded={expanded}
          aria-label={node.name}
          className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left"
        >
          <span className="text-[10px] text-ink-subtle">{expanded ? '▾' : '▸'}</span>
          <span className={`text-sm ${group ? 'font-semibold' : 'font-medium'} ${node.muted ? 'line-through' : ''}`}>
            {node.name}
          </span>
          <span className="truncate text-xs text-ink-muted">
            p {node.p}
            {node.name === 'SomeOf' && node.n !== undefined ? ` · n ${node.n}` : ''}
            {tuned ? ` · ${tuned}` : ''}
            {node.muted ? ' · skipped in preview' : ''}
          </span>
        </button>
        {doc && <Hint text={doc} about={node.name} />}
        {!readOnly && (
          <>
            <button type="button" aria-label={`Move ${node.name} up`} title="Move up"
                    onClick={() => onChange(moveNode(nodes, node.id, -1))}
                    className="rounded px-1 text-xs text-ink-subtle hover:bg-raised hover:text-ink">
              ↑
            </button>
            <button type="button" aria-label={`Move ${node.name} down`} title="Move down"
                    onClick={() => onChange(moveNode(nodes, node.id, 1))}
                    className="rounded px-1 text-xs text-ink-subtle hover:bg-raised hover:text-ink">
              ↓
            </button>
          </>
        )}
      </div>

      {expanded && (
        <div className="space-y-2 border-t border-line px-2 py-2">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <div className="mb-0.5 flex items-center gap-1">
                <label className="text-xs font-medium text-ink"
                       htmlFor={`p-${node.id}`}>
                  Probability
                </label>
                <Hint text="How often this step applies, 0 to 1." about="probability" />
              </div>
              <input
                id={`p-${node.id}`}
                aria-label="Probability"
                type="number"
                min={0}
                max={1}
                step={0.05}
                disabled={readOnly}
                value={node.p}
                onChange={(e) => onChange(updateNode(nodes, node.id, { p: Number(e.target.value) }))}
                className={smallInput}
              />
            </div>
            {node.name === 'SomeOf' && (
              <div>
                <div className="mb-0.5 flex items-center gap-1">
                  <label className="text-xs font-medium text-ink"
                         htmlFor={`n-${node.id}`}>
                    n
                  </label>
                  <Hint text="How many of this group's steps apply." about="n" />
                </div>
                <input
                  id={`n-${node.id}`}
                  aria-label="n"
                  type="number"
                  min={1}
                  step={1}
                  disabled={readOnly}
                  value={node.n ?? 1}
                  onChange={(e) => onChange(updateNode(nodes, node.id, { n: Number(e.target.value) }))}
                  className={smallInput}
                />
              </div>
            )}
          </div>

          {transform && transform.params.length > 0 && (
            // More columns as the window grows, rather than ever-wider fields.
            <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {transform.params.map((param) => (
                <ParamField
                  key={`${node.id}:${param.name}`}
                  param={param}
                  value={node.params[param.name]}
                  readOnly={readOnly}
                  onChange={(value) => {
                    const params = { ...node.params }
                    if (value === undefined) delete params[param.name]
                    else params[param.name] = value
                    onChange(updateNode(nodes, node.id, { params }))
                  }}
                />
              ))}
            </div>
          )}
          {transform && transform.params.length === 0 && (
            <p className="text-xs text-ink-muted">This transform takes no parameters.</p>
          )}
          {!transform && !group && (
            <p className="text-xs text-warn">
              This step is not in the catalog the training backends offer, so its parameters cannot be shown.
            </p>
          )}

          {!readOnly && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {action('Move up', () => onChange(moveNode(nodes, node.id, -1)))}
              {action('Move down', () => onChange(moveNode(nodes, node.id, 1)))}
              {action('Duplicate', () => onChange(duplicateNode(nodes, node.id)))}
              <button
                type="button"
                data-testid="mute-step"
                aria-label={`${node.muted ? 'Keep' : 'Skip'} ${node.name} in preview`}
                title="Leave this step out of the preview - it stays in the pipeline"
                onClick={() => onChange(updateNode(nodes, node.id, { muted: !node.muted }))}
                className="rounded border border-line px-1.5 py-0.5 text-xs text-ink-muted hover:bg-raised"
              >
                {node.muted ? 'Keep in preview' : 'Skip in preview'}
              </button>
              {action('Remove', () => {
                onChange(removeNode(nodes, node.id))
                if (expanded) onOpen(null)
              }, true)}
            </div>
          )}
        </div>
      )}

      {group && (
        <div className="space-y-1 border-t border-line py-1 pl-4 pr-1.5">
          {node.children?.length === 0 && (
            <p className="py-0.5 text-xs text-ink-subtle">
              Nothing in this group yet.
            </p>
          )}
          {node.children?.map((child) => (
            <StepCard {...props} key={child.id} node={child} transform={byName.get(child.name)} />
          ))}
          {!readOnly && (
            <Button
              variant="ghost"
              size="xs"
              data-testid="add-into-group"
              onClick={() => onTarget(target === node.id ? null : node.id)}
            >
              {target === node.id ? `✓ Adding into ${node.name}` : `+ Add into ${node.name}`}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

/** The pipeline as a column of cards. Nesting is shown by nesting, and a group carries its
 *  own add button, so where a new step lands is never a guess. */
export function PipelineBuilder({ catalog, nodes, onChange, readOnly = false }: {
  catalog: AugmentCatalog | null
  nodes: PipelineNode[]
  onChange: (nodes: PipelineNode[]) => void
  readOnly?: boolean
}) {
  const [open, setOpen] = useState<string | null>(null)
  const [target, setTarget] = useState<string | null>(null)
  const groups = groupNames(catalog)
  const byName = useMemo(() => new Map((catalog?.transforms ?? []).map((t) => [t.name, t])), [catalog])
  const targetNode = findNode(nodes, target)

  const pick = (name: string) => {
    const added = groups.includes(name) ? newGroup(name) : newStep(byName.get(name)!)
    onChange(addInto(nodes, targetNode ? targetNode.id : null, added))
    setOpen(added.id)
  }

  const shared = { byName, open, onOpen: setOpen, nodes, onChange, readOnly, target, onTarget: setTarget, catalog }

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="space-y-1">
        {nodes.length === 0 && (
          <p className="rounded border border-dashed border-line-strong p-3 text-sm text-ink-muted">
            No steps. The crops train exactly as they were scanned.
          </p>
        )}
        {nodes.map((node) => (
          <StepCard {...shared} key={node.id} node={node} transform={byName.get(node.name)} />
        ))}
      </div>
      {!readOnly && (
        <TransformPalette
          catalog={catalog}
          targetName={targetNode ? targetNode.name : null}
          onClearTarget={() => setTarget(null)}
          onPick={pick}
        />
      )}
    </div>
  )
}
