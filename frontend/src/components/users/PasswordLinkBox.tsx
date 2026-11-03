import type { PasswordLink } from '../../api'

/** A one-time password link for the admin to send on, with the address they reached
 *  DeepLabel on in front of it, since that is the one the person can reach too. */
export function PasswordLinkBox({ link, note, onDismiss }: { link: PasswordLink; note: string; onDismiss: () => void }) {
  const url = `${window.location.origin}${link.link}`
  return (
    <div data-testid="password-link" className="rounded border border-ok/40 bg-ok/10 p-3">
      <p className="mb-1 text-xs text-ok">
        {note} Send them this link - it works once, within {link.valid_days} days.
      </p>
      <div className="flex items-center gap-2">
        <code data-testid="password-link-url" className="flex-1 break-all text-xs">{url}</code>
        <button onClick={() => navigator.clipboard?.writeText(url)}
                className="rounded border border-ok/50 px-2 py-1 text-xs text-ok">
          Copy
        </button>
        <button onClick={onDismiss} className="text-xs text-ink-muted hover:text-ink">Dismiss</button>
      </div>
    </div>
  )
}
