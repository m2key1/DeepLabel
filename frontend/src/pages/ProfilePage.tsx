import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, Navigate, useLocation, useParams, useSearchParams } from 'react-router-dom'

import { ApiError, getMeta, getPerson, getPersonProfile, logout } from '../api'
import type { AppMeta, Person, PersonProfile, PersonStats } from '../api'
import { useAuth } from '../auth'
import { profilePath } from '../people'
import { useSettings } from '../settings'
import { formatRelative, parseStamp } from '../util'
import { profileSummary } from '../components/users/profileSummary'
import { useCrumb } from '../components/NavBar'
import { ThemeChoice } from '../components/ThemeToggle'
import { useSettingsPanels } from '../components/settings/SettingsPanels'
import { ActivityCalendar } from '../components/users/ActivityCalendar'
import { ProfilePicture } from '../components/users/ProfilePicture'
import { Avatar } from '../components/ui/Avatar'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { Section } from '../components/ui/Section'
import { SectionNav } from '../components/ui/SectionNav'
import { StatRow, StatTile } from '../components/ui/StatTile'
import { pageShell } from '../components/ui/page'
import { NotFoundPage } from './NotFoundPage'

const OVERVIEW = 'overview'
const MEMBER_SINCE = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })

/** The old /settings and /profile addresses: your own profile, on the tab they named. */
export function OwnProfileRedirect() {
  const { user } = useAuth()
  const section = new URLSearchParams(useLocation().search).get('section') ?? undefined
  return <Navigate to={profilePath(user, section)} replace />
}

export function ProfilePage() {
  const { username = '' } = useParams()
  const { user } = useAuth()
  const own = username === user
  const [person, setPerson] = useState<Person | null>(null)
  const [profile, setProfile] = useState<PersonProfile | null>(null)
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useCrumb(own ? 'Your profile' : person?.display_name || username)

  useEffect(() => {
    setPerson(null)
    setProfile(null)
    setMissing(false)
    setError(null)
    const fail = (e: unknown) => {
      if (e instanceof ApiError && e.status === 404) setMissing(true)
      else setError((e as Error).message)
    }
    getPerson(username).then(setPerson).catch(fail)
    getPersonProfile(username).then(setProfile).catch(fail)
  }, [username])

  if (missing) return <NotFoundPage />

  return (
    <div className={pageShell} data-testid="profile" data-username={username}>
      {person ? <Header person={person} own={own} groups={profile?.stats.groups ?? []} /> : (
        <div className="mb-6 h-24" />
      )}
      {error && <p data-testid="profile-error" className="mb-4 text-sm text-danger">{error}</p>}
      {own ? <OwnTabs profile={profile} /> : <Overview profile={profile} />}
    </div>
  )
}

function Header({ person, own, groups }: { person: Person; own: boolean; groups: PersonStats['groups'] }) {
  const name = person.display_name || person.username
  const since = parseStamp(person.created_at)
  return (
    <header className="mb-6 flex flex-wrap items-start gap-5" data-testid="profile-header">
      {own
        ? <ProfilePicture username={person.username} displayName={person.display_name} />
        : <Avatar name={person.username} displayName={person.display_name} size="xl" />}
      <div className="min-w-0 flex-1 space-y-1">
        <h1 data-testid="profile-name" className="font-serif text-xl font-semibold">{name}</h1>
        <div className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
          {person.display_name && <span data-testid="profile-username" className="font-mono text-xs">{person.username}</span>}
          <Badge data-testid="profile-role">{person.role}</Badge>
          {!isNaN(since.getTime()) && (
            <span data-testid="profile-since">Member since {MEMBER_SINCE.format(since)}</span>
          )}
        </div>
        {person.email && (
          <div data-testid="profile-email" className="text-sm text-ink-muted">{person.email}</div>
        )}
        {groups.length > 0 && (
          <div data-testid="profile-groups" className="flex flex-wrap items-center gap-1 text-xs text-ink-subtle">
            Groups:
            {groups.map((g) => <Badge key={g.id} variant="chip" data-testid="profile-group">{g.name}</Badge>)}
          </div>
        )}
      </div>
      {own && <OwnControls />}
    </header>
  )
}

function OwnControls() {
  const { user, canEdit } = useAuth()
  const { shareActivity } = useSettings()
  // Being seen is the default, so say so where the person looks for themselves.
  const visible = shareActivity && canEdit
  const onLogout = async () => {
    await logout().catch(() => undefined)
    window.location.href = '/api/login'
  }
  return (
    <div className="flex flex-col items-end gap-2">
      <ThemeChoice />
      <Link
        to={profilePath(user, 'together')}
        data-testid="visibility-state"
        title={canEdit ? 'Change under Working together' : 'A read-only account is never broadcast'}
        className="flex items-center gap-1.5 text-xs text-ink-muted hover:text-accent-ink"
      >
        <span className={`h-1.5 w-1.5 rounded-full ${visible ? 'bg-ok' : 'bg-warn'}`} />
        {visible ? 'Online' : 'Hidden'}
      </Link>
      <Button size="xs" onClick={() => void onLogout()}>Log out</Button>
    </div>
  )
}

// The settings read in groups by what they are about, under the profile itself.
const SECTION_GROUP: Record<string, string> = {
  [OVERVIEW]: 'You', opening: 'Editing', keys: 'Editing', characters: 'Editing',
  together: 'Together', llm: 'Connections', tokens: 'Connections',
}

function OwnTabs({ profile }: { profile: PersonProfile | null }) {
  const { user } = useAuth()
  const [params, setParams] = useSearchParams()
  const panels = useSettingsPanels()
  const tabs = [{ id: OVERVIEW, label: 'Overview', node: <Overview profile={profile} /> }, ...panels]
  const asked = params.get('section')
  const active = tabs.some((t) => t.id === asked) ? (asked as string) : OVERVIEW
  return (
    <div className="flex gap-6">
      <div className="sticky top-0 self-start">
        <SectionNav
          label={`${user} - profile and settings`}
          items={tabs.map(({ id, label }) => ({ id, label, group: SECTION_GROUP[id] }))}
          active={active}
          onSelect={(id) => setParams(id === OVERVIEW ? {} : { section: id }, { replace: true })}
        />
        <AppVersion />
      </div>
      <div className="min-w-0 flex-1">{tabs.find((t) => t.id === active)?.node}</div>
    </div>
  )
}

/** The release this deployment runs, so a bug report can say which. */
function AppVersion() {
  const [meta, setMeta] = useState<AppMeta | null>(null)
  useEffect(() => {
    getMeta().then(setMeta).catch(() => {})
  }, [])
  if (!meta) return null
  return (
    <p data-testid="app-version" className="mt-4 px-2 font-mono text-xs text-ink-subtle">
      DeepLabel {meta.version}{meta.commit && ` · ${meta.commit}`}
    </p>
  )
}

const count = (n: number) => n.toLocaleString()

function Stat({ id, label, value, title }: { id: string; label: ReactNode; value: ReactNode; title?: string }) {
  return <StatTile data-stat={id} label={label} value={value} title={title} />
}

function Overview({ profile }: { profile: PersonProfile | null }) {
  if (!profile) return <p className="text-sm text-ink-subtle">Loading…</p>
  const { stats } = profile
  const summary = profileSummary(profile)
  return (
    <div data-testid="profile-overview">
      <p data-testid="profile-summary" className="mb-6 max-w-[62ch] text-[15px] leading-relaxed text-ink">
        {summary ? summary.join(' ') : 'Nothing yet - work done here shows up as soon as there is some.'}
      </p>
      <Section title="Annotation">
        <StatRow>
          <Stat id="lines_corrected" label="Lines corrected" value={count(stats.lines_corrected)}
                title="Lines whose correction is theirs" />
          <Stat id="lines_checked" label="Lines checked" value={count(stats.lines_checked)}
                title="Distinct lines they marked checked" />
          <Stat id="pages_signed_off" label="Pages signed off" value={count(stats.pages_signed_off)} />
          <Stat id="regions_drawn" label="Regions drawn" value={count(stats.regions_drawn)} />
        </StatRow>
      </Section>
      <Section title="Training and models">
        <StatRow>
          <Stat id="trainings_started" label="Runs started" value={count(stats.trainings.started)} />
          <Stat id="trainings_done" label="Finished" value={count(stats.trainings.done)} />
          <Stat id="trainings_failed" label="Failed" value={count(stats.trainings.failed)} />
          <Stat id="models_trained" label="Models trained" value={count(stats.models_trained)} />
          <Stat id="evaluations" label="Evaluations" value={count(stats.evaluations)} />
          <Stat id="best_cer" label="Best CER"
                value={stats.best_cer === null ? '-' : `${(stats.best_cer * 100).toFixed(2)}%`} />
        </StatRow>
      </Section>
      <Section title="Datasets">
        <StatRow>
          <Stat id="datasets_owned" label="Owned" value={count(stats.datasets_owned)} />
          <Stat id="datasets_shared" label="Shared with them" value={count(stats.datasets_shared)} />
          <Stat id="groups" label="Groups" value={count(stats.groups.length)} />
        </StatRow>
      </Section>
      <Section
        title="Activity"
        actions={
          <span data-testid="profile-last-active" className="ml-auto text-xs text-ink-subtle">
            {stats.last_active ? `Last active ${formatRelative(stats.last_active)}` : 'Not active yet'}
          </span>
        }
      >
        <ActivityCalendar activity={profile.activity} />
      </Section>
      <Section title="Recently worked on">
        {profile.recent_datasets.length === 0 ? (
          <EmptyState>No dataset you can open has edits of theirs.</EmptyState>
        ) : (
          <ul data-testid="profile-recent" className="divide-y divide-line rounded-md border border-line">
            {profile.recent_datasets.map((d) => (
              <li key={d.id} data-testid="profile-recent-dataset" className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <Link to={`/jobs/${d.id}`} className="min-w-0 truncate font-medium hover:text-accent-ink">{d.name}</Link>
                <span className="shrink-0 text-xs text-ink-subtle">{formatRelative(d.last_edit)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}
