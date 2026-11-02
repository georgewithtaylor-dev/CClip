import { message } from 'antd'
import { ct } from './messages'
import { restoreCClipPreferences } from './preferences'

window.addEventListener('cclip-file-saved', event => message.success(ct('fileSavedAt').replace('{path}', String((event as CustomEvent).detail))))

void restoreCClipPreferences().then(() => import('../main'))
