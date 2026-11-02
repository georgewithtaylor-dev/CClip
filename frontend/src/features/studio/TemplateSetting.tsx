import { t } from '../../i18n'
import { ct } from '../../cclip/messages'
import { Row } from '../../ui'
import type { Draft, Packaging, SubtitleCue, Workspace } from './types'

export function changeTemplate(draft: Draft, template: Packaging['template'] | 'standard', sourceCues: SubtitleCue[] = []): Partial<Draft> {
  const previous = draft.packaging
  const cues = (draft.subtitle_cues ?? previous?.cues ?? sourceCues).map(cue => ({ original: '', ...cue }))
  if (template === 'standard') return { template_override: 'classic', packaging: null, subtitle_cues: cues, hook: previous?.title_lines.join('\n').slice(0, 120) || draft.hook, layout: draft.layout === 'window' ? 'fit' : draft.layout }
  const html = template === 'editorial' || template === 'street'
  const packaging: Packaging = { version: html ? 2 : previous?.version || 1, audience_language: 'zh', source_language: 'other', title_lines: draft.hook ? draft.hook.split('\n').slice(0, 2).map(line => line.slice(0, 40)) : [], title_accent_line: 1, speakers: [], tags: [], highlights: [], tags_enabled: true, burned_captions: false, fallback: false, ...previous,
    template, cues: cues.slice(0, 600), style: html ? null : template === 'interview_zh' ? 'classic' : 'pop' }
  packaging.version = html ? 2 : packaging.version
  return { template_override: html ? template : 'classic', packaging, subtitle_cues: cues, aspect: 'portrait', layout: template === 'interview_zh' ? 'window' : 'crop' }
}

/** Old automatic exports stored their effective HTML template on the platform version. */
export function resolveDraftTemplate(draft: Draft, workspace: Workspace): Draft {
  if (draft.template_override) return draft
  const template = workspace.output_variants?.find(item => item.draft_id === draft.id)?.html_template
  return template ? { ...draft, ...changeTemplate(draft, template), aspect: draft.aspect, layout: draft.layout } : draft
}

export default function TemplateSetting({ draft, patch, sourceCues }: { draft: Draft; patch: (value: Partial<Draft>) => void; sourceCues?: SubtitleCue[] }) {
  return <Row stack label={t('模板')} hint={ct('templateChoiceHint')}><select className="ac-input" aria-label={t('模板')} value={draft.packaging?.template || 'standard'} onChange={event => patch(changeTemplate(draft, event.target.value as Packaging['template'] | 'standard', sourceCues))}>
    <option value="standard">{ct('templateStandard')}</option><option value="interview_zh">{t('访谈式')}</option><option value="podcast_en">{t('播客式')}</option><option value="editorial">{t('杂志风')}</option><option value="street">{t('街头快剪')}</option>
  </select></Row>
}
