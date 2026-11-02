import type { Workspace } from '../features/studio/types'
import { ct } from './messages'

export interface WorkspaceTask { id: string; label: string; progress?: number | null; cancel?: () => void }

export function workspaceTasks(workspace: Workspace): WorkspaceTask[] {
  const tasks: WorkspaceTask[] = workspace.jobs.filter(job => ['queued', 'running'].includes(job.status))
    .map(job => ({ id: job.job_id, label: `${ct('renderTask')} · ${job.title}`, progress: job.percent }))
  if (workspace.analysis?.status === 'running') tasks.push({ id: 'analysis', label: ct('analyzeTask'), progress: workspace.analysis.percent })
  if (['queued', 'running'].includes(workspace.source_preview?.status || '')) tasks.push({ id: 'source-preview', label: ct('previewTask') })
  for (const job of Object.values(workspace.cclip_cover_jobs || {})) {
    if (['queued', 'running'].includes(job.status)) tasks.push({ id: job.job_id, label: ct('coverTask') })
  }
  for (const variant of workspace.output_variants || []) {
    if (['queued', 'running'].includes(variant.cover_job?.status || '')) tasks.push({ id: variant.cover_job!.job_id, label: ct('coverTask') })
    if (variant.status === 'preparing') tasks.push({ id: variant.id, label: ct('prepareOutputTask') })
  }
  if (!tasks.length && ['screening', 'production', 'rendering'].includes(workspace.generation?.status || '')) tasks.push({ id: 'generation', label: ct('prepareOutputTask') })
  return tasks
}

export default function WorkspaceTasks({ tasks }: { tasks: WorkspaceTask[] }) {
  return <>{tasks.map(task => {
    const percent = typeof task.progress === 'number' && Number.isFinite(task.progress) ? Math.max(0, Math.min(100, Math.round(task.progress))) : undefined
    return <div className="wb-task-progress" role="status" key={task.id} data-task-id={task.id} title={task.label}><span className="cclip-task-label">{task.label}</span><progress aria-label={task.label} max={100} value={percent} /><span>{percent !== undefined ? `${percent}%` : '…'}</span>{task.cancel && <button className="wb-task-cancel" onClick={task.cancel}>{ct('cancelTask')}</button>}</div>
  })}</>
}
