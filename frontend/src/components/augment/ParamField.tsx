import { useState } from 'react'
import type { AugmentParam } from '../../api'
import { Hint } from '../ui/Hint'
import { formatValue } from './pipeline'
import { controlClass } from '../ui/Field'

const input = controlClass('sm', 'w-full')

const placeholderFor = (param: AugmentParam) =>
  param.default === null || param.default === undefined ? 'required' : formatValue(param.default)

function numbersOf(value: unknown, size: number): string[] {
  return Array.isArray(value)
    ? Array.from({ length: size }, (_, i) => (value[i] === undefined ? '' : String(value[i])))
    : Array(size).fill('')
}

/** One parameter of one step. A blank field is the parameter left out, which is exactly
 *  albumentations' own default - the placeholder names it. */
export function ParamField({ param, value, onChange, readOnly = false }: {
  param: AugmentParam
  value: unknown
  onChange: (value: unknown) => void
  readOnly?: boolean
}) {
  const [raw, setRaw] = useState<string[]>(() =>
    param.kind === 'range' || param.kind === 'tuple'
      ? numbersOf(value, param.kind === 'range' ? 2 : (param.size ?? 2))
      : [value === undefined || value === null ? '' : String(value)])
  const [jsonError, setJsonError] = useState<string | null>(null)
  const id = `param-${param.name}`
  const whole = param.kind === 'integer' || param.items === 'integer'

  const commitNumbers = (next: string[]) => {
    setRaw(next)
    if (next.every((part) => part.trim() === '')) return onChange(undefined)
    if (next.some((part) => part.trim() === '' || Number.isNaN(Number(part)))) return
    onChange(next.length === 1 ? Number(next[0]) : next.map(Number))
  }

  const label = (
    <div className="mb-0.5 flex items-center gap-1">
      <label className="text-xs font-medium text-ink" htmlFor={id}>
        {param.name}
      </label>
      {param.doc && <Hint text={param.doc} about={param.name} />}
    </div>
  )

  if (param.kind === 'boolean' || param.kind === 'enum') {
    const options = param.kind === 'boolean' ? ['true', 'false'] : (param.options ?? []).map(String)
    return (
      <div data-testid="param-field" data-param={param.name}>
        {label}
        <select
          id={id}
          className={`${input} disabled:opacity-60`}
          disabled={readOnly}
          value={value === undefined ? '' : String(value)}
          onChange={(e) => {
            const picked = e.target.value
            if (picked === '') return onChange(undefined)
            if (param.kind === 'boolean') return onChange(picked === 'true')
            const original = (param.options ?? []).find((option) => String(option) === picked)
            onChange(original)
          }}
        >
          <option value="">Default ({placeholderFor(param)})</option>
          {options.map((option) => (
            <option key={option} value={option}>
              {param.kind === 'boolean' ? (option === 'true' ? 'On' : 'Off') : option}
            </option>
          ))}
        </select>
      </div>
    )
  }

  if (param.kind === 'json') {
    return (
      <div data-testid="param-field" data-param={param.name}>
        {label}
        <input
          id={id}
          className={`${input} disabled:opacity-60`}
          disabled={readOnly}
          placeholder={placeholderFor(param)}
          defaultValue={value === undefined ? '' : JSON.stringify(value)}
          onChange={(e) => {
            const text = e.target.value.trim()
            if (text === '') {
              setJsonError(null)
              return onChange(undefined)
            }
            try {
              onChange(JSON.parse(text))
              setJsonError(null)
            } catch {
              setJsonError('not valid JSON')
            }
          }}
        />
        {jsonError && <p className="mt-0.5 text-[11px] text-danger">{jsonError}</p>}
      </div>
    )
  }

  const parts = param.kind === 'range' ? ['from', 'to'] : param.kind === 'tuple'
    ? Array.from({ length: param.size ?? 2 }, (_, i) => `#${i + 1}`) : ['']
  return (
    <div data-testid="param-field" data-param={param.name}>
      {label}
      <div className="flex gap-1">
        {parts.map((part, index) => (
          <input
            key={part}
            id={index === 0 ? id : undefined}
            aria-label={part ? `${param.name} ${part}` : param.name}
            type="number"
            step={whole ? 1 : 'any'}
            min={param.min ?? undefined}
            max={param.max ?? undefined}
            disabled={readOnly}
            className={`${input} disabled:opacity-60`}
            placeholder={Array.isArray(param.default) ? formatValue(param.default[index]) : placeholderFor(param)}
            value={raw[index] ?? ''}
            onChange={(e) => commitNumbers(parts.map((_, i) => (i === index ? e.target.value : raw[i] ?? '')))}
          />
        ))}
      </div>
    </div>
  )
}
