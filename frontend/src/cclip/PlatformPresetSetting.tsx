import { useEffect, useRef, useState } from 'react'
import { Select } from 'antd'
import { studioApi } from '../features/studio/api'
import { platformLabel } from '../features/studio/platformLabel'
import type { Draft, PlatformStrategySummary } from '../features/studio/types'
import { Row } from '../ui'
import { ct } from './messages'
import { cclipSession } from './runtime'

export default function PlatformPresetSetting({ draft, patch }: { draft: Draft; patch: (changes: Partial<Draft>) => void }) {
  const [strategies, setStrategies] = useState<PlatformStrategySummary[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    void studioApi.platformStrategies().then(data => { if (mounted.current) setStrategies(data.strategies) }).catch(() => { if (mounted.current) setError(true) })
    return () => { mounted.current = false }
  }, [])
  const apply = async (strategyId: string) => {
    setBusy(true); setError(false)
    try {
      const response = await fetch('/api/cclip/platform-preset', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-workbench-session': await cclipSession() }, body: JSON.stringify({ draft, strategyId }) })
      if (!response.ok) throw new Error('preset_failed')
      const data: { changes: Partial<Draft> } = await response.json()
      if (mounted.current) patch(data.changes)
    } catch { if (mounted.current) setError(true) }
    finally { if (mounted.current) setBusy(false) }
  }
  return <Row stack label={ct('platformPreset')} hint={error ? ct('presetFailed') : ct('presetHint')}>
    <Select aria-label={ct('platformPreset')} style={{ width: '100%' }} value={draft.platform_preset || undefined}
      placeholder={ct('choosePreset')} loading={busy} disabled={busy || !strategies.length}
      options={strategies.map(strategy => ({ value: strategy.id, label: `${platformLabel(strategy.id)} · ${strategy.aspect === 'portrait' ? '9:16' : strategy.aspect === 'landscape' ? '16:9' : ct('sourceAspect')}` }))}
      onChange={value => void apply(value)} />
  </Row>
}
