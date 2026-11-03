import { AccountField } from './AccountCard'
import type { NewPasswordValue } from './passwordCheck'

/** A new password, typed twice. */
export function NewPassword({ value, onChange }: { value: NewPasswordValue; onChange: (next: NewPasswordValue) => void }) {
  return (
    <>
      <AccountField label="New password" data-testid="new-password" type="password" required
                    autoComplete="new-password" value={value.password}
                    onChange={(e) => onChange({ ...value, password: e.target.value })} />
      <AccountField label="Repeat it" data-testid="new-password-repeat" type="password" required
                    autoComplete="new-password" value={value.repeat}
                    onChange={(e) => onChange({ ...value, repeat: e.target.value })} />
    </>
  )
}
