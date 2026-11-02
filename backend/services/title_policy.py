"""Editorial rules for generated headlines, never for transcript or manual edits."""
import re


TITLE_GUIDANCE = (
    '\n标题与开头文字规范：提炼片段最有价值的问题、观点、结论或方法，简洁吸睛，同时文明、专业、克制、有质感。'
    '忠于片段事实，不编造、不夸大，不靠粗俗、羞辱、贬低职业或人群制造冲突。'
    '原话即使粗俗，也应概括其核心含义，不直接搬到标题、封面标题或发布标题；'
    '例如护理话题中的“端屎端尿”应概括为“基础照护”，结合片段提炼职业选择或专业价值。'
    '英文及其他语言遵循同样要求，专名、数据与医学等专业术语仍应准确。\n'
)

# A narrow last-line check for explicit coarse wording. Do not censor medical
# vocabulary (排泄护理/尿失禁), ordinary metaphors, subtitles or stored user titles.
_CARE = re.compile(r'端\s*屎\s*(?:[、，,和与及]\s*)?(?:端\s*)?尿')
_COARSE = re.compile(
    r'傻\s*[逼屄]|煞\s*笔|他\s*妈\s*的|你\s*妈\s*的|狗\s*屁|'
    r'\b(?:fuck(?:ing|ed|er|ers)?|bullshit|shit|asshole|bitch(?:es)?)\b', re.IGNORECASE,
)


def editorial_title(value: object, *, fallback: object = '', language: str = 'zh') -> str:
    """Keep a usable generated title; replace coarse care wording without a call.

    If abuse remains, use a clean supplied topic or a neutral heading. Empty or
    malformed model responses remain empty so their original validation applies.
    """
    if not isinstance(value, str) or not value.strip():
        return ''
    text = _CARE.sub('基础照护', value.strip())
    if not _COARSE.search(text):
        return text
    safe = _CARE.sub('基础照护', fallback.strip()) if isinstance(fallback, str) else ''
    return safe if safe and not _COARSE.search(safe) else ('Key takeaways' if language == 'en' else '片段要点')
