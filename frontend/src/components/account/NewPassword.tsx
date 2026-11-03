import { AccountField } from './AccountCard'
import type { Strength } from './strength'
import type { NewPasswordState } from './useNewPassword'

const TONE: Record<Strength['level'], string> = {
  empty: 'bg-line', short: 'bg-danger', weak: 'bg-danger', fair: 'bg-warn', good: 'bg-ok', strong: 'bg-ok',
}

function StrengthMeter({ strength }: { strength: Strength }) {
  return (
    <div data-testid="password-strength" data-level={strength.level} className="space-y-1">
      <div className="h-1.5 overflow-hidden rounded-full bg-line" aria-hidden="true">
        <div className={`h-full rounded-full transition-[width] duration-150 ${TONE[strength.level]}`}
             style={{ width: `${Math.round(strength.fill * 100)}%` }} />
      </div>
      <p data-testid="password-strength-message" aria-live="polite"
         className={`text-xs ${strength.acceptable ? 'text-ok' : 'text-ink-muted'}`}>
        {strength.message}
      </p>
    </div>
  )
}

/** A new password, typed twice, with how strong it is under the first. */
export function NewPassword({ state }: { state: NewPasswordState }) {
  const { value, setValue, strength } = state
  return (
    <>
      <AccountField label="New password" data-testid="new-password" type="password" required
                    autoComplete="new-password" value={value.password}
                    onChange={(e) => setValue({ ...value, password: e.target.value })} />
      <StrengthMeter strength={strength} />
      <AccountField label="Repeat it" data-testid="new-password-repeat" type="password" required
                    autoComplete="new-password" value={value.repeat}
                    onChange={(e) => setValue({ ...value, repeat: e.target.value })} />
    </>
  )
}
