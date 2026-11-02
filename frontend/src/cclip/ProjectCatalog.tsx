import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Select, message } from 'antd'
import { t } from '../i18n'
import { cclipRequest } from './runtime'
import { ct } from './messages'

interface SavedProject { id: string; title: string; route: string; status: string; updated: string; thumbnail?: string }
export default function ProjectCatalog() {
  const navigate = useNavigate()
  const [items, setItems] = useState<SavedProject[]>([])
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')
  const load = useCallback(async () => {
    try { setItems(await cclipRequest<SavedProject[]>('/api/cclip/projects')); setError(false) }
    catch { setError(true) } finally { setLoading(false) }
  }, [])
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 5000); return () => window.clearInterval(timer) }, [load])
  const remove = async (id: string) => {
    if (!window.confirm(ct('deleteProjectConfirm'))) return
    try { await cclipRequest(`/api/cclip/projects/${id.replace(':', '/')}`, 'DELETE'); await load() } catch { message.error(t('删除项目失败')) }
  }
  const statuses: Record<string, string> = { saved: ct('projectSaved'), completed: t('已完成'), pending: t('等待处理'), processing: t('处理中'), failed: t('处理失败'), error: t('处理失败') }
  const shown = items.filter(item => filter === 'all' || (filter === 'failed' ? ['error', 'failed'].includes(item.status) : item.status === filter))
  return <section className="cclip-projects" aria-label={t('我的项目')}>
    <header><h2>{t('我的项目')} <span>{shown.length}</span></h2><Select aria-label={t('全部状态')} value={filter} onChange={setFilter} options={['all', 'saved', 'completed', 'processing', 'failed'].map(value => ({ value, label: value === 'all' ? t('全部状态') : statuses[value] }))} /></header>
    {error && <p role="alert">{t('加载项目失败')} <button className="studio-link" onClick={() => void load()}>{t('重试')}</button></p>}
    {loading ? <p role="status">{t('正在加载项目列表…')}</p> : <div className="cclip-saved-grid">{shown.map(item => <article className="cclip-saved-card" key={item.id}>
      <button className="cclip-open-project" onClick={() => navigate(item.route)} aria-label={`${ct('open')} ${item.title}`}><span className="cclip-project-image">{item.thumbnail ? <img src={item.thumbnail} alt="" onError={event => { event.currentTarget.hidden = true }} /> : <img className="cclip-project-mark" src="./cclip-mark.svg" alt="" />}</span><b>{item.title}</b><span>{statuses[item.status] || item.status}</span><span className="cclip-open-label">{ct('open')} →</span></button>
      <footer><time>{new Date(item.updated).toLocaleString()}</time><button className="studio-link" aria-label={`${t('删除')} ${item.title}`} onClick={() => void remove(item.id)}>{t('删除')}</button></footer>
    </article>)}</div>}
    {!loading && !shown.length && <p className="cclip-empty">{t('还没有项目')}</p>}
  </section>
}
