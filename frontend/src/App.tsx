import { useEffect } from 'react'
import { Routes, Route, useLocation } from 'react-router-dom'
import { Layout } from 'antd'
import HomePage from './pages/HomePage'
import ProjectDetailPage from './pages/ProjectDetailPage'
import PublishClipPage from './pages/PublishClipPage'
import PublishListPage from './pages/PublishListPage'
import PublishWeekPage from './pages/PublishWeekPage'
import ImportReview from './features/studio/ImportReview'
import StudioEditor from './features/studio/StudioEditor'
import SettingsPage from './pages/SettingsPage'
import Header from './components/Header'
import { UpdateProvider } from './desktop/UpdatePrompt'
import { trackPageview } from './analytics/posthog'
import { startWorkflowObserver } from './analytics/observer'
import WorkbenchPage from './cclip/WorkbenchPage'
import CClipHomePage from './cclip/HomePage'
import { isCClip } from './cclip/runtime'
import SettingsOverlay, { useSettingsOverlay } from './cclip/SettingsOverlay'

const { Content } = Layout

// HashRouter 下手动上报 pageview（init 时已关闭自动 pageview）
function usePageviewTracking() {
  const location = useLocation()
  useEffect(() => {
    trackPageview(location.pathname + location.search)
  }, [location.pathname, location.search])
}

function App() {
  const settings = useSettingsOverlay(isCClip)
  console.log('🎬 App组件已加载');
  usePageviewTracking()
  useEffect(() => startWorkflowObserver(), [])

  return (
    <UpdateProvider>
      <SettingsOverlay section={isCClip ? settings.section : null} onSectionChange={settings.setSection} onClose={settings.close}><Layout>
        <Header settingsOpen={isCClip && settings.section !== null} />
        <Content>
          <Routes location={settings.location}>
            <Route path="/" element={isCClip ? <CClipHomePage settingsOpen={settings.section !== null} /> : <HomePage />} />
            <Route path="/import/:id" element={<ImportReview />} />
            <Route path="/project/:id/studio/:draftId" element={isCClip ? <WorkbenchPage initialView="edit" /> : <StudioEditor />} />
            <Route path="/project/:id/publish/week" element={isCClip ? <WorkbenchPage initialView="edit" /> : <PublishWeekPage />} />
            <Route path="/project/:id/publish/:clipId" element={isCClip ? <WorkbenchPage initialView="edit" /> : <PublishClipPage />} />
            <Route path="/project/:id/publish" element={isCClip ? <WorkbenchPage initialView="edit" /> : <PublishListPage />} />
            <Route path="/project/:id" element={isCClip ? <WorkbenchPage /> : <ProjectDetailPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/workbench" element={<WorkbenchPage />} />
            <Route path="/workbench/:id" element={<WorkbenchPage />} />
            <Route path="/project/:id/timeline/:draftId" element={<WorkbenchPage />} />
          </Routes>
        </Content>
      </Layout></SettingsOverlay>
    </UpdateProvider>
  )
}

export default App
