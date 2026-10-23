import { Toggle } from '../components/ui/Button'
import { CursorIcon, EraserIcon, HandIcon, PenIcon, WandIcon } from '../components/icons'
import { comboLabel } from '../settings'
import type { Capabilities, Tool } from './types'

const TOOLS: { tool: Tool; label: string; icon: () => React.JSX.Element }[] = [
  { tool: 'select', label: 'Select', icon: CursorIcon },
  { tool: 'hand', label: 'Hand', icon: HandIcon },
  { tool: 'draw', label: 'Draw', icon: PenIcon },
  { tool: 'erase', label: 'Erase', icon: EraserIcon },
  { tool: 'detect', label: 'Detect', icon: WandIcon },
]

/** The tools, one row, the same on both editors: an icon each, named in the tooltip and
 *  by the footer's sentence. A tool the editor cannot offer is not shown, so nothing is
 *  greyed out for a reason the page cannot explain. */
export function ToolPalette({ tool, onTool, capabilities, bindings, detectDisabled = false, readOnly = false }: {
  tool: Tool
  onTool: (tool: Tool) => void
  capabilities: Capabilities
  /** The live key for each tool, for the tooltip. */
  bindings: Partial<Record<Tool, string>>
  /** No detector on this server: the tool stays, disabled, so the tooltip can say why. */
  detectDisabled?: boolean
  readOnly?: boolean
}) {
  const shown = TOOLS.filter(({ tool: t }) =>
    (t !== 'erase' || (capabilities.erase && !readOnly)) &&
    (t !== 'detect' || (capabilities.detect && !readOnly)) &&
    (t !== 'draw' || !readOnly))
  return (
    <div className="flex gap-1">
      {shown.map(({ tool: t, label, icon: Icon }) => {
        const key = bindings[t]
        const disabled = t === 'detect' && detectDisabled
        return (
          <Toggle
            key={t}
            on={tool === t}
            size="icon"
            data-testid={`tool-${t}`}
            aria-label={label}
            onClick={() => onTool(t)}
            disabled={disabled}
            title={disabled
              ? 'Edge detection is not configured on this server'
              : key ? `${label} (${comboLabel(key)})`
              // Unbound, the hand is still in reach: both editors take a held Space or Alt.
              : t === 'hand' ? `${label} (hold Space or Alt)` : label}
            className="flex-1"
          >
            <Icon />
          </Toggle>
        )
      })}
    </div>
  )
}
