import type { LocalJob } from './localApi'
import type { MessageKey } from './strings'

export interface LocalTaskActivity {
  kind: LocalJob['kind']
  phase: 'preparing' | 'running' | 'cancelling' | 'saving'
  progress: number | null
  cancellable: boolean
}

export const taskLabels: Record<LocalJob['kind'], MessageKey> = {
  transcribe: 'localTranscribe', analyze: 'findHighlights', cleanup: 'cleanSpeech', export: 'exportVideo',
}

interface Props {
  activity: LocalTaskActivity
  ui: (key: MessageKey, values?: Record<string, string | number>) => string
  onCancel: () => void
}

export default function LocalTaskProgress({ activity, ui, onCancel }: Props) {
  const progress = activity.progress === null || !Number.isFinite(activity.progress) || ['preparing', 'saving'].includes(activity.phase)
    ? null : Math.min(100, Math.max(0, Math.round(activity.progress)))
  const label = ui(activity.phase === 'preparing' ? 'preparingTask' : activity.phase === 'cancelling' ? 'cancellingTask' : activity.phase === 'saving' ? 'savingFile' : 'taskProgress', { count: progress ?? 0 })
  return <div className="wb-task-progress" role="status" aria-label={ui(taskLabels[activity.kind])}>
    <span>{ui(taskLabels[activity.kind])} · {label}</span>
    <progress max={100} value={progress ?? undefined} aria-label={`${ui(taskLabels[activity.kind])} · ${ui('taskProgressLabel')}`} />
    {activity.cancellable && <button type="button" className="wb-task-cancel" disabled={activity.phase === 'cancelling'} onClick={onCancel}>{ui(activity.phase === 'cancelling' ? 'cancellingTask' : 'cancelTask')}</button>}
  </div>
}
