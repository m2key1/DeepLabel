import type { AugmentCatalog, AugmentSpec, AugmentTransform, Training } from '../../api'

/** A step in the tree the builder edits. Groups carry children; leaves carry parameters.
 *  `id` is local to the editing session - the saved spec is plain albumentations JSON. */
export interface PipelineNode {
  id: string
  name: string
  p: number
  /** How many children a SomeOf applies. */
  n?: number
  params: Record<string, unknown>
  children?: PipelineNode[]
  /** Left out of the preview only, so a step's effect can be isolated without losing it. */
  muted?: boolean
}

export const ROOT = 'Compose'

let counter = 0
const nextId = () => `n${++counter}`

export const isGroup = (node: PipelineNode) => node.children !== undefined

export function groupNames(catalog: AugmentCatalog | null): string[] {
  return (catalog?.groups ?? []).map((g) => g.name)
}

export function newStep(transform: AugmentTransform): PipelineNode {
  return { id: nextId(), name: transform.name, p: transform.default_p, params: {} }
}

export function newGroup(name: string): PipelineNode {
  return { id: nextId(), name, p: 0.5, params: {}, children: [], ...(name === 'SomeOf' ? { n: 1 } : {}) }
}

const RESERVED = new Set(['__class_fullname__', 'p', 'n', 'transforms'])

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function fromNode(raw: Record<string, unknown>, groups: string[],
                  byName: Map<string, AugmentTransform>): PipelineNode {
  const name = String(raw.__class_fullname__ ?? '')
  // A serialised stack spells out every parameter, defaults included. Those are dropped
  // on the way in, so a step shows only what someone actually chose - and a saved
  // pipeline follows the library's defaults wherever it was left alone.
  const defaults = new Map((byName.get(name)?.params ?? []).map((param) => [param.name, param.default]))
  const params: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (RESERVED.has(key)) continue
    if (defaults.has(key) && same(defaults.get(key), value)) continue
    params[key] = value
  }
  const node: PipelineNode = { id: nextId(), name, p: typeof raw.p === 'number' ? raw.p : 1, params }
  if (groups.includes(name) || name === ROOT) {
    node.children = ((raw.transforms as Record<string, unknown>[]) ?? [])
      .map((child) => fromNode(child, groups, byName))
  }
  if (typeof raw.n === 'number') node.n = raw.n
  return node
}

/** The steps of an albumentations spec, as the builder's tree. */
export function fromSpec(spec: AugmentSpec | null, groups: string[],
                         byName: Map<string, AugmentTransform> = new Map()): PipelineNode[] {
  if (!spec?.transform) return []
  return fromNode(spec.transform as Record<string, unknown>, groups, byName).children ?? []
}

function toNode(node: PipelineNode, skipMuted: boolean): Record<string, unknown> {
  const raw: Record<string, unknown> = { __class_fullname__: node.name, p: node.p, ...node.params }
  if (node.n !== undefined && node.name === 'SomeOf') raw.n = node.n
  if (node.children) raw.transforms = toNodes(node.children, skipMuted)
  return raw
}

function toNodes(nodes: PipelineNode[], skipMuted: boolean): Record<string, unknown>[] {
  return nodes.filter((node) => !(skipMuted && node.muted)).map((node) => toNode(node, skipMuted))
}

/** The tree as albumentations reads it. Muting only ever hides a step from the preview,
 *  so a saved pipeline still holds everything the builder shows. */
export function toSpec(nodes: PipelineNode[], { skipMuted = false } = {}): AugmentSpec {
  return { transform: { __class_fullname__: ROOT, p: 1.0, transforms: toNodes(nodes, skipMuted) } }
}

/** A stack with no steps: the crops go to the model as scanned. */
export const EMPTY_STACK: AugmentSpec = { transform: { __class_fullname__: ROOT, p: 1.0, transforms: [] } }

export const isEmptyStack = (spec: AugmentSpec) =>
  ((spec.transform.transforms as unknown[] | undefined)?.length ?? 0) === 0

/** What a run trained with, in the words the training form uses for the same choice. */
export function trainedAugmentationLabel(run: Pick<Training, 'augmentation' | 'augmentation_name'>): string {
  if (run.augmentation === null) return "the model's own"
  if (run.augmentation_name) return run.augmentation_name
  return isEmptyStack(run.augmentation) ? 'none' : 'custom'
}

export function countSteps(nodes: PipelineNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + (node.children ? countSteps(node.children) : 0), 0)
}

function mapTree(nodes: PipelineNode[], fn: (list: PipelineNode[]) => PipelineNode[]): PipelineNode[] {
  return fn(nodes).map((node) => (node.children ? { ...node, children: mapTree(node.children, fn) } : node))
}

export function updateNode(nodes: PipelineNode[], id: string, patch: Partial<PipelineNode>): PipelineNode[] {
  return mapTree(nodes, (list) => list.map((node) => (node.id === id ? { ...node, ...patch } : node)))
}

export function removeNode(nodes: PipelineNode[], id: string): PipelineNode[] {
  return mapTree(nodes, (list) => list.filter((node) => node.id !== id))
}

/** Moves a step within the list that holds it; it never changes nesting level. */
export function moveNode(nodes: PipelineNode[], id: string, delta: number): PipelineNode[] {
  return mapTree(nodes, (list) => {
    const index = list.findIndex((node) => node.id === id)
    const target = index + delta
    if (index < 0 || target < 0 || target >= list.length) return list
    const next = [...list]
    ;[next[index], next[target]] = [next[target], next[index]]
    return next
  })
}

function clone(node: PipelineNode): PipelineNode {
  return {
    ...node,
    id: nextId(),
    params: { ...node.params },
    ...(node.children ? { children: node.children.map(clone) } : {}),
  }
}

export function duplicateNode(nodes: PipelineNode[], id: string): PipelineNode[] {
  return mapTree(nodes, (list) => {
    const index = list.findIndex((node) => node.id === id)
    if (index < 0) return list
    return [...list.slice(0, index + 1), clone(list[index]), ...list.slice(index + 1)]
  })
}

export function findNode(nodes: PipelineNode[], id: string | null): PipelineNode | null {
  if (!id) return null
  for (const node of nodes) {
    if (node.id === id) return node
    const found = node.children ? findNode(node.children, id) : null
    if (found) return found
  }
  return null
}

/** Appends a step to the end of a named group, or of the pipeline itself when the target
 *  is null. Every add button names its own target, so nothing lands by inference. */
export function addInto(nodes: PipelineNode[], groupId: string | null, added: PipelineNode): PipelineNode[] {
  if (groupId === null) return [...nodes, added]
  const group = findNode(nodes, groupId)
  if (!group || !isGroup(group)) return [...nodes, added]
  return updateNode(nodes, groupId, { children: [...group.children!, added] })
}

export function transformsByCategory(catalog: AugmentCatalog | null) {
  const groups = new Map<string, AugmentTransform[]>()
  for (const transform of catalog?.transforms ?? []) {
    groups.set(transform.category, [...(groups.get(transform.category) ?? []), transform])
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
}

/** How a parameter's value reads in a step summary and in a field placeholder. Objects
 *  keep their shape but lose the quoting, which is noise at a glance. */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'none'
  if (Array.isArray(value)) return value.map(formatValue).join(', ')
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  if (typeof value === 'object') return JSON.stringify(value).replace(/"(\w+)":/g, '$1 ')
  return String(value)
}

const SUMMARY_LIMIT = 3

/** What this step was changed from, short enough to sit on one line. */
export function summarise(node: PipelineNode): string {
  const tuned = Object.entries(node.params).map(([key, value]) => `${key} ${formatValue(value)}`)
  if (tuned.length <= SUMMARY_LIMIT) return tuned.join(' · ')
  return `${tuned.slice(0, SUMMARY_LIMIT).join(' · ')} · +${tuned.length - SUMMARY_LIMIT} more`
}
