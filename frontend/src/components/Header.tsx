import { t } from '../i18n'
import { useTranslation } from 'react-i18next'
import React from 'react'
import LanguageSelect from './LanguageSelect'
import { Layout, Button } from 'antd'
import { SettingOutlined, BulbOutlined, MoonOutlined } from '@ant-design/icons'
import { useNavigate, useLocation } from 'react-router-dom'
import { useTheme } from '../context/ThemeContext'
import { UpdateToast, useAppUpdate } from '../desktop/UpdatePrompt'
import { Icon } from '../ui'
import { isCClip, navigateCClip } from '../cclip/runtime'
import { ct } from '../cclip/messages'

const { Header: AntHeader } = Layout

// Calm Premium header — see DESIGN.md
const Header: React.FC<{ settingsOpen?: boolean }> = ({ settingsOpen = false }) => {
  useTranslation()
  const routerNavigate = useNavigate()
  const navigate = (path: string) => isCClip ? navigateCClip(routerNavigate, path) : routerNavigate(path)
  const location = useLocation()
  const isSettings = settingsOpen || location.pathname === '/settings'
  const { theme, toggleTheme } = useTheme()
  const appUpdate = useAppUpdate()
  const updatePending = appUpdate.phase === 'downloading' || appUpdate.phase === 'ready' || appUpdate.phase === 'failed' || appUpdate.phase === 'restarting'

  return (
    <AntHeader
      style={{
        padding: '0 clamp(12px, 4vw, 56px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: '64px',
        lineHeight: 'normal',
        overflow: 'visible',
        position: 'sticky',
        top: 0,
        zIndex: 1000,
        backdropFilter: 'blur(10px)',
        background: 'color-mix(in srgb, var(--ac-bg) 78%, transparent)',
        borderBottom: '1px solid var(--ac-line-2)',
      }}
    >
      {/* Wordmark — serif, italic "Clip" */}
      <div
        style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}
        onClick={() => navigate('/')}
      >
        {isCClip ? <span className="cclip-wordmark"><img src="./cclip-mark.svg" alt="" />CClip</span> : <span
          style={{
            fontFamily: 'var(--ac-font-serif)',
            fontSize: '26px',
            color: 'var(--ac-ink)',
            letterSpacing: '0.3px',
          }}
        >
          Auto<em style={{ fontStyle: 'italic' }}>Clip</em>
        </span>}
      </div>

      {isCClip && <nav className="cclip-nav" aria-label="CClip"><button onClick={() => navigate('/')} aria-current={location.pathname === '/' ? 'page' : undefined}>{ct('home')}</button><button onClick={() => navigate('/workbench')} aria-current={location.pathname.includes('workbench') || location.pathname.includes('timeline') ? 'page' : undefined}>{ct('editor')}</button></nav>}

      {/* Right side */}
      <div className="ac-header-actions">
        {updatePending && (
          <div className="ac-update-anchor">
            <button
              type="button"
              className="ac-update-icon"
              aria-expanded={appUpdate.toastVisible}
              aria-label={t('有新版本可用')}
              onClick={() => appUpdate.toastVisible ? appUpdate.snooze() : appUpdate.openUpdate()}
            >
              <Icon.Up size={16} />
            </button>
            <UpdateToast />
          </div>
        )}
        <div className="ac-header-permanent">
        <LanguageSelect />
        {/* 返回入口由各页面页头承担（见 DESIGN.md App Layer），顶栏只留全局动作 */}
        <Button
          type="text"
          icon={theme === 'dark' ? <BulbOutlined /> : <MoonOutlined />}
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? t("切换到亮色模式") : t("切换到暗色模式")}
          title={theme === 'dark' ? t("切换到亮色模式") : t("切换到暗色模式")}
          style={{
            color: 'var(--ac-sub)',
            border: '1px solid var(--ac-line)',
            borderRadius: '999px',
            width: '36px',
            height: '36px',
            padding: 0,
            background: 'var(--ac-card)',
          }}
        />
        <Button
          type="text"
          icon={<SettingOutlined />}
          onClick={() => navigate('/settings')}
          aria-label={t('设置')}
          aria-haspopup={isCClip ? 'dialog' : undefined}
          aria-expanded={isCClip ? settingsOpen : undefined}
          aria-current={isSettings ? 'page' : undefined}
          style={{
            color: isSettings ? 'var(--ac-ink)' : 'var(--ac-sub)',
            border: '1px solid var(--ac-line)',
            borderRadius: '999px',
            height: '36px',
            padding: '0 16px',
            background: isSettings ? 'var(--ac-line-2)' : 'var(--ac-card)',
          }}
        >{t("设置")}</Button>
        </div>
      </div>
    </AntHeader>
  )
}

export default Header
