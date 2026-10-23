import { Badge } from '../ui/Badge'

const PUBLIC_TITLE = 'Published by an admin: everyone on this deployment can read with it, billed to its owner\'s key'
const PRIVATE_TITLE = 'Only its owner can see this endpoint or read with it'

export function VisibilityBadge({ shared, className }: { shared: boolean; className?: string }) {
  return (
    <Badge
      tone={shared ? 'accent' : 'neutral'}
      data-testid="llm-visibility"
      title={shared ? PUBLIC_TITLE : PRIVATE_TITLE}
      className={className}
    >
      {shared ? 'Public' : 'Private'}
    </Badge>
  )
}
