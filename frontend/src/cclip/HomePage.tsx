import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import CreativeImport from '../features/studio/CreativeImport'
import FirstRunSetup from '../features/settings/FirstRunSetup'
import ProjectCatalog from './ProjectCatalog'
export default function CClipHomePage({ settingsOpen = false }: { settingsOpen?: boolean }) {
  useTranslation()
  const [needed, setNeeded] = useState<boolean | null>(null)
  const [setup, setSetup] = useState(0)
  return <main className="cclip-home cclip-home-dashboard"><FirstRunSetup onStatus={setNeeded} openRequest={setup} suspended={settingsOpen} /><CreativeImport onImported={async () => undefined} blocked={needed === true} onBlocked={() => setSetup(value => value + 1)} readinessKey={settingsOpen} /><ProjectCatalog /></main>
}
