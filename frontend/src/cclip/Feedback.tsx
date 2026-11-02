import { Btn, Dialog } from '../ui'
import { t } from '../i18n'
import { openExternalLink } from '../utils/externalLinks'
import { ct } from './messages'

export const CCLIP_ISSUES = 'https://github.com/georgewithtaylor-dev/CClip/issues'

export default function CClipFeedback({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <Dialog open={open} onClose={onClose} title={t('反馈')} description={ct('feedbackHint')}
    footer={<><Btn onClick={onClose}>{t('关闭')}</Btn><Btn variant="cta" onClick={() => void openExternalLink(`${CCLIP_ISSUES}/new`)}>{ct('openFeedback')}</Btn></>}>
    <p>{ct('feedbackHint')}</p>
  </Dialog>
}
