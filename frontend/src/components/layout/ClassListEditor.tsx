import type { LayoutClassDraft, LayoutReads, LayoutRole } from '../../api'
import { classHex } from '../../util'
import { Button } from '../ui/Button'
import { Input, Select } from '../ui/Field'

export const ROLE_LABEL: Record<LayoutRole, string> = { content: 'Content', container: 'Container' }
export const READS_LABEL: Record<LayoutReads, string> = { down: 'reads top to bottom', across: 'reads left to right' }

/** One class's role and, for a container, its direction, as one choice. */
export function RoleSelect({ role, reads, disabled, onChange, label }: {
  role: LayoutRole
  reads: LayoutReads | null
  disabled?: boolean
  onChange: (role: LayoutRole, reads: LayoutReads | null) => void
  label: string
}) {
  const value = role === 'container' ? `container-${reads ?? 'down'}` : 'content'
  return (
    <Select size="xs" aria-label={label} value={value} disabled={disabled} className="w-48"
            onChange={(e) => {
              const [nextRole, nextReads] = e.target.value.split('-') as [LayoutRole, LayoutReads | undefined]
              onChange(nextRole, nextReads ?? null)
            }}>
      <option value="content">Content</option>
      <option value="container-down">Container, reads top to bottom</option>
      <option value="container-across">Container, reads left to right</option>
    </Select>
  )
}

/** A template's classes as an editable list: colour, name, role, order. */
export function ClassListEditor({ classes, onChange, disabled }: {
  classes: LayoutClassDraft[]
  onChange: (classes: LayoutClassDraft[]) => void
  disabled?: boolean
}) {
  const update = (index: number, change: Partial<LayoutClassDraft>) =>
    onChange(classes.map((c, i) => (i === index ? { ...c, ...change } : c)))
  const move = (index: number, by: number) => {
    const next = [...classes]
    const [taken] = next.splice(index, 1)
    next.splice(index + by, 0, taken)
    onChange(next)
  }
  return (
    <div className="space-y-1" data-testid="class-list-editor">
      {classes.map((c, i) => (
        <div key={c.id ?? `new-${i}`} className="flex flex-wrap items-center gap-2" data-testid="class-row">
          <input
            type="color"
            aria-label={`Colour of ${c.name || 'new class'}`}
            value={classHex(c.name, c.color)}
            disabled={disabled}
            onChange={(e) => update(i, { color: e.target.value })}
            className="h-7 w-8 cursor-pointer rounded border border-line-strong disabled:cursor-default"
          />
          <Input size="xs" className="w-48" aria-label="Class name" value={c.name} disabled={disabled}
                 placeholder="Class name" onChange={(e) => update(i, { name: e.target.value })} />
          <RoleSelect role={c.role} reads={c.reads} disabled={disabled} label={`Role of ${c.name || 'new class'}`}
                      onChange={(role, reads) => update(i, { role, reads })} />
          {!disabled && (
            <span className="flex gap-0.5">
              <Button variant="ghost" size="xs" aria-label={`Move ${c.name} up`} disabled={i === 0}
                      onClick={() => move(i, -1)}>↑</Button>
              <Button variant="ghost" size="xs" aria-label={`Move ${c.name} down`} disabled={i === classes.length - 1}
                      onClick={() => move(i, 1)}>↓</Button>
              <Button variant="ghost" size="xs" aria-label={`Remove ${c.name}`}
                      onClick={() => onChange(classes.filter((_, k) => k !== i))}>Remove</Button>
            </span>
          )}
        </div>
      ))}
      {!disabled && (
        <Button variant="ghost" size="xs" data-testid="add-class"
                onClick={() => onChange([...classes, { name: '', role: 'content', reads: null, color: null }])}>
          + Add class
        </Button>
      )}
    </div>
  )
}
