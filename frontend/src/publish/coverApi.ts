import api from '../services/api'

export type CoverProvider = 'openai' | 'seedream' | 'dashscope'

export interface CoverConfigView {
  enabled: boolean
  provider: CoverProvider | string
  model: string
  api_key_masked: string
  base_url: string
  ocr_model: string
  allow_send_frame: boolean
  configured: boolean
  source: string
  key_source?: 'own' | 'env' | 'text_model' | 'connection' | 'none'
  mode?: 'text_model' | 'custom'
  note?: string | null
  verification?: { provider: string; base_url: string; model: string } | null
}

export interface CoverView {
  ok: boolean
  platform: string
  url?: string | null
  path?: string
  method?: string
  title?: string
  subtitle?: string
  badge?: string
  content_type?: string
  warning?: string | null
  frame_time?: number
  image_layout?: 'fit' | 'crop'
  title_position?: 'top' | 'bottom'
  reference_sent?: boolean
  local_template?: 'autoclip' | 'overlay'
  palette?: string
}

export interface CoverJobView {
  job_id: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | string
  error?: string
  result?: CoverView
}

export interface CoverGenerateBody {
  platform?: string
  title?: string
  subtitle?: string
  badge?: string
  content_type?: string
  force_local?: boolean
  require_ai?: boolean
  frame_time?: number | null
  image_layout?: 'fit' | 'crop'
  title_position?: 'top' | 'bottom'
  send_reference?: boolean
  local_template?: 'autoclip' | 'overlay'
  palette?: string
  sync?: boolean
}

export interface ManualCoverKit {
  ok: boolean
  platform: string
  prompt: string
  prompt_url: string
  frame_url: string
  frame_time: number
  revision: number
  width: number
  height: number
}

export const coverApi = {
  preview: (projectId: string, clipId: string, body: CoverGenerateBody, signal?: AbortSignal): Promise<Blob> =>
    api.post(`/publish/covers/${projectId}/clips/${clipId}/preview`, body, { responseType: 'blob', signal }),
  getConfig: (): Promise<CoverConfigView> => api.get('/publish/covers/config'),
  saveConfig: (body: Partial<CoverConfigView> & { api_key?: string }): Promise<CoverConfigView & { ok?: boolean }> =>
    api.put('/publish/covers/config', body),
  clearConfig: (): Promise<CoverConfigView & { ok?: boolean }> => api.delete('/publish/covers/config'),
  get: (projectId: string, clipId: string, platform = 'bilibili'): Promise<CoverView> =>
    api.get(`/publish/covers/${projectId}/clips/${clipId}`, { params: { platform } }),
  start: (projectId: string, clipId: string, body: CoverGenerateBody = {}): Promise<{ ok: boolean; job_id: string; status: string } | CoverView> =>
    api.post(`/publish/covers/${projectId}/clips/${clipId}`, body),
  manual: (projectId: string, clipId: string, body: CoverGenerateBody & { revision: number }): Promise<ManualCoverKit> =>
    api.post(`/publish/covers/${projectId}/clips/${clipId}/manual`, body),
  upload: (projectId: string, clipId: string, image: File, values: { revision: number; platform: string; title: string; subtitle: string; badge: string }): Promise<CoverView> => {
    const form = new FormData(); form.set('image', image)
    for (const [key, value] of Object.entries(values)) form.set(key, String(value))
    return api.post(`/publish/covers/${projectId}/clips/${clipId}/upload`, form, { headers: { 'Content-Type': 'multipart/form-data' } })
  },
  job: (jobId: string): Promise<CoverJobView> => api.get(`/publish/covers/jobs/${jobId}`),
  cancel: (jobId: string): Promise<CoverJobView> => api.post(`/publish/covers/jobs/${jobId}/cancel`),
}
