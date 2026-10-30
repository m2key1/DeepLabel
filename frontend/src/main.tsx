import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom'
import './index.css'
import '@fontsource-variable/jetbrains-mono'
// Plex Sans for the chrome, Plex Mono for every figure, Spectral for the names of things;
// only the weights used.
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/spectral/500.css'
import '@fontsource/spectral/600.css'
import { AuthProvider } from './auth'
import { SettingsProvider } from './settings'
import { CommandsProvider } from './commands'
import { PresenceProvider } from './presence'
import { initTheme } from './components/ThemeToggle'
import { Shell } from './components/NavBar'
import { JobsPage } from './pages/JobsPage'
import { QueuePage } from './pages/QueuePage'
import { NewJobPage } from './pages/NewJobPage'
import { JobDetailPage } from './pages/JobDetailPage'
import { LayoutTemplatesPage } from './pages/LayoutTemplatesPage'
import { PageViewerPage } from './pages/PageViewerPage'
import { TileEditorPage } from './pages/TileEditorPage'
import { AdminPage } from './pages/AdminPage'
import { OwnProfileRedirect, ProfilePage } from './pages/ProfilePage'
import { ModelsPage } from './pages/ModelsPage'
import { ModelPage } from './pages/ModelPage'
import { TrainingNewPage } from './pages/TrainingNewPage'
import { TrainingRunPage } from './pages/TrainingRunPage'
import { EvaluationPage } from './pages/EvaluationPage'
import { EvaluationsPage } from './pages/EvaluationsPage'
import { AugmentationsPage } from './pages/AugmentationsPage'
import { ConventionsPage } from './pages/ConventionsPage'
import { DatasetSettingsPage } from './pages/DatasetSettingsPage'
import { TranscriptPage } from './pages/TranscriptPage'
import { CorpusPage } from './pages/CorpusPage'
import { NotFoundPage, RouteError } from './pages/NotFoundPage'

initTheme()

const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      {
        // Pathless, so a page that throws is caught here and drawn inside the shell.
        errorElement: <RouteError />,
        children: [
          { path: '/', element: <JobsPage /> },
          { path: '/queue', element: <QueuePage /> },
          { path: '/new', element: <NewJobPage /> },
          { path: '/admin', element: <AdminPage /> },
          // The page was called Users before it grew the instance-wide settings.
          { path: '/users', element: <Navigate to="/admin" replace /> },
          // Settings became tabs on your own profile; old links land on the matching tab.
          { path: '/settings', element: <OwnProfileRedirect /> },
          { path: '/profile', element: <OwnProfileRedirect /> },
          { path: '/people/:username', element: <ProfilePage /> },
          { path: '/models', element: <ModelsPage /> },
          { path: '/models/train', element: <TrainingNewPage /> },
          { path: '/models/runs/:id', element: <TrainingRunPage /> },
          { path: '/models/evaluations', element: <EvaluationsPage /> },
          { path: '/models/:id', element: <ModelPage /> },
          { path: '/evaluations/:id', element: <EvaluationPage /> },
          { path: '/augmentations', element: <AugmentationsPage /> },
          { path: '/conventions', element: <ConventionsPage /> },
          { path: '/templates', element: <LayoutTemplatesPage /> },
          { path: '/jobs/:id', element: <JobDetailPage /> },
          { path: '/jobs/:id/settings', element: <DatasetSettingsPage /> },
          { path: '/jobs/:id/transcript', element: <TranscriptPage /> },
          { path: '/jobs/:id/corpus', element: <CorpusPage /> },
          { path: '/jobs/:id/pages/:pageId', element: <PageViewerPage /> },
          { path: '/jobs/:id/tiles/:pageId', element: <TileEditorPage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <SettingsProvider>
        <CommandsProvider>
          <PresenceProvider>
            <RouterProvider router={router} />
          </PresenceProvider>
        </CommandsProvider>
      </SettingsProvider>
    </AuthProvider>
  </StrictMode>,
)
