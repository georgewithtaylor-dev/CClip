import type { Project, TimeRange } from './model'

export interface LocalRecord { id: string; project: Project; revision: number; updated: string }
export interface Suggestion extends TimeRange { id: string; kind: 'silence' | 'repeat' | 'filler'; text?: string }
export interface LocalJob {
  id: string; kind: 'export' | 'transcribe' | 'analyze' | 'cleanup'; status: string; progress: number; error: string | null
  result?: { record?: LocalRecord; candidate?: Project; conflict?: boolean; download?: string; subtitles?: string; suggestions?: Suggestion[] }
}
export interface AnalysisPreview { revision: number; baseUrl: string; model: string; sentences: number; characters: number }
export interface Readiness { mediaReady: boolean; asrReady: boolean }
export const mediaUrl = (project: Project) => project.source.assetId ? `/api/workbench/assets/${encodeURIComponent(project.source.assetId)}/video` : ''

export class LocalClient {
  private session = ''
  private bindings = new Map<string, { id: string; revision: number }>()
  private writes: Promise<unknown> = Promise.resolve()

  async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    if (!path.startsWith('/api/workbench/')) throw new Error('invalid_endpoint')
    const form = body instanceof FormData
    const response = await fetch(path, { method, credentials: 'same-origin', headers: {
      ...(this.session ? { 'x-workbench-session': this.session } : {}),
      ...(body && !form ? { 'Content-Type': 'application/json' } : {}),
    }, body: body ? form ? body : JSON.stringify(body) : undefined })
    if (!response.ok) throw new Error(response.status === 409 ? 'revision_conflict_or_busy' : response.status === 403 ? 'consent_required' : 'local_request_failed')
    return response.json() as Promise<T>
  }

  async connect(): Promise<Readiness> {
    const result = await this.request<Readiness & { session: string }>('/api/workbench/session')
    this.session = result.session
    return result
  }

  bind(record: LocalRecord) {
    this.bindings.set(record.project.source.assetId || record.id, { id: record.id, revision: record.revision })
    this.bindings.set(record.id, { id: record.id, revision: record.revision })
    return record.project
  }

  save(project: Project): Promise<LocalRecord> {
    const action = this.writes.catch(() => {}).then(() => this.saveNow(project))
    this.writes = action
    return action
  }

  private async saveNow(project: Project): Promise<LocalRecord> {
    const key = project.localId || project.source.assetId || ''
    const binding = this.bindings.get(key) || (project.localId && project.localRevision ? { id: project.localId, revision: project.localRevision } : null)
    const record = binding ? await this.request<LocalRecord>(`/api/workbench/projects/${binding.id}`, 'PUT', { project, revision: binding.revision })
      : await this.request<LocalRecord>('/api/workbench/projects', 'POST', project)
    this.bind(record)
    return record
  }

  async open(id: string) { const record = await this.request<LocalRecord>(`/api/workbench/projects/${encodeURIComponent(id)}`); this.bind(record); return record.project }

  async import(file: File, previous?: Project) {
    const form = new FormData(); form.append('video', file)
    const asset = await this.request<Project['source'] & { hasAudio: boolean; codec: string }>('/api/workbench/assets', 'POST', form)
    const source: Project['source'] = { name: asset.name, kind: 'local', duration: asset.duration, bytes: asset.bytes, width: asset.width, height: asset.height, assetId: asset.assetId }
    let project: Project = { schemaVersion: 1, title: file.name.replace(/\.[^.]+$/, '').slice(0, 200), source,
      clips: [], cues: [], bookmarks: [], highlights: [] }
    if (previous) {
      if (previous.source.name !== file.name || previous.source.bytes !== file.size || Math.abs(previous.source.duration - source.duration) >= .2) throw new Error('source_mismatch')
      project = { ...previous, source }
      delete project.localId; delete project.localRevision
    }
    return (await this.save(project)).project
  }
}
