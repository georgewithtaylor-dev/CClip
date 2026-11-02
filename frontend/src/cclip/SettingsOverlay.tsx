import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate, type Location } from 'react-router-dom'
import SettingsPage from '../pages/SettingsPage'
import { Btn, Dialog } from '../ui'
import { t } from '../i18n'
import { CCLIP_SETTINGS_CLOSED } from './runtime'

/** Keep the route, video and unsaved editor state mounted while settings are open. */
export function useSettingsOverlay(enabled: boolean) {
  const location = useLocation(), navigate = useNavigate()
  const direct = enabled && location.pathname === '/settings'
  const background = useRef<Location>(direct ? { ...location, pathname: '/', search: '' } : location)
  if (!direct) background.current = location
  const [section, setSection] = useState<string | null>(direct ? new URLSearchParams(location.search).get('section') || 'ai' : null)
  useEffect(() => {
    if (!enabled) return
    const open = (event: Event) => setSection(String((event as CustomEvent).detail || 'ai'))
    window.addEventListener('cclip-open-settings', open)
    return () => window.removeEventListener('cclip-open-settings', open)
  }, [enabled])
  useEffect(() => {
    if (direct) setSection(new URLSearchParams(location.search).get('section') || 'ai')
  }, [direct, location.search])
  const close = useCallback(() => {
    setSection(null)
    if (direct) navigate(background.current.pathname + background.current.search, { replace: true })
  }, [direct, navigate])
  return { location: direct ? background.current : location, section, setSection, close }
}

export default function SettingsOverlay({ section, onSectionChange, onClose, children }: {
  section: string | null; onSectionChange: (section: string) => void; onClose: () => void; children: ReactNode
}) {
  const background = useRef<HTMLDivElement>(null)
  const opened = section !== null
  useEffect(() => {
    const element = background.current
    if (!element) return
    element.inert = opened
    return () => { element.inert = false }
  }, [opened])
  const close = () => { if (background.current) background.current.inert = false; onClose(); window.dispatchEvent(new Event(CCLIP_SETTINGS_CLOSED)) }
  return <>
    <div ref={background} aria-hidden={opened || undefined}>{children}</div>
    <Dialog open={opened} onClose={close} title={t('设置')} className="cclip-settings-dialog" footer={<Btn onClick={close}>{t('关闭')}</Btn>}>
      <button type="button" className="cclip-settings-close ac-btn ac-btn--text" aria-label={t('关闭')} onClick={close}>×</button>
      {opened && <SettingsPage section={section} onSectionChange={onSectionChange} embedded />}
    </Dialog>
  </>
}
