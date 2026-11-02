"""Generated headlines are civil; speech evidence and selected boundaries stay intact."""
from types import SimpleNamespace

import pytest
from backend.pipeline import clip_finder
from backend.services.platform_strategy import platform_strategy
from backend.services.studio import packaging, post_copy
from backend.tests.test_clip_finder import _entries
from backend.services.title_policy import editorial_title


def test_clip_title_uses_neutral_care_term_without_another_request(tmp_path):
    calls = []
    entries = _entries(12)
    entries[10]['text'] = '端屎端尿是原话，字幕应保留。'

    def call(prompt, data):
        calls.append(prompt)
        return {'clips': [{'start': 10, 'end': 40, 'title': '照护不只是端屎端尿', 'reason': '照护工作', 'score': .9}]}

    result = clip_finder.find_clips(entries, call, threshold=.7, metadata_dir=tmp_path)
    assert result[0]['generated_title'] == '照护不只是基础照护'
    assert result[0]['start_time'] == '00:00:50,000' and result[0]['final_score'] == .9
    assert entries[10]['text'] == '端屎端尿是原话，字幕应保留。'
    assert len(calls) == 1 and '文明' in calls[0]


@pytest.mark.parametrize('text', ['专业能力与成长', '尿失禁与排泄护理', '废物利用的方法', 'Care work and career growth'])
def test_civil_terms_medical_vocabulary_and_names_are_not_censored(text):
    assert editorial_title(text) == text


def test_obscene_headings_use_a_clean_topic_without_model_retries():
    assert editorial_title('这是什么狗屁', fallback='职业选择的代价') == '职业选择的代价'
    assert editorial_title('This is bullshit', language='en') == 'Key takeaways'
    assert editorial_title('端 屎\n端 尿与职业选择') == '基础照护与职业选择'
    assert editorial_title(None) == '' and editorial_title('') == ''


@pytest.mark.parametrize('response', ['valid', 'malformed', 'error'])
def test_legacy_generation_and_model_failure_keep_civil_fallback(tmp_path, monkeypatch, response):
    from backend.pipeline.step4_title import TitleGenerator
    monkeypatch.setenv('AUTOCLIP_LLM_CONCURRENCY', '1')
    generator = TitleGenerator.__new__(TitleGenerator)
    generator.llm_raw_output_dir = tmp_path
    from backend.services.title_policy import TITLE_GUIDANCE
    generator.title_prompt = 'Existing category instructions' + TITLE_GUIDANCE
    calls = []

    def call(prompt, data):
        calls.append(prompt)
        if response == 'error':
            raise RuntimeError('offline fixture')
        return 'fixture'

    generator.llm_client = SimpleNamespace(call_with_retry=call,
        parse_json_response=lambda _: {'a': '理解端屎端尿'} if response == 'valid' else [])
    original = {'id': 'a', 'outline': {'title': '理解照护工作的价值'}, 'start_time': '00:00:01,000'}
    result = generator.generate_titles([original.copy()])
    assert result[0]['generated_title'] == ('理解基础照护' if response == 'valid' else original['outline']['title'])
    assert result[0]['outline'] == original['outline'] and result[0]['start_time'] == original['start_time']
    assert len(calls) == 1 and '文明' in calls[0]


def test_generated_post_and_fallback_titles_share_policy():
    calls = []
    result = post_copy.build_posts('护理职业选择', ['讨论基础照护工作。'], ['douyin'],
        call=lambda prompt, data: calls.append(prompt) or {'posts': {'douyin': {'title': '为何去端屎端尿', 'description': '', 'tags': []}}})
    assert result['douyin']['title'] == '为何去基础照护'
    assert post_copy.fallback('护理不是端屎端尿', 'douyin')['title'] == '护理不是基础照护'
    assert len(calls) == 1 and '文明' in calls[0]


def test_cover_titles_split_across_lines_and_raw_caption_are_independent():
    lines = [{'start': 1., 'end': 3., 'text': '护士不是只会端屎端尿，还有专业工作要做。'}]
    calls = []
    result = packaging.build_packaging({'title': '护理职业选择', 'hook': ''}, lines, platform_strategy('douyin'),
        call=lambda prompt, data: calls.append(prompt) or {'title_lines': ['端屎', '端尿之外'], 'segments': []})
    assert ''.join(result['title_lines']) == '基础照护之外'
    assert result['cues'][0]['text'] == lines[0]['text']
    assert len(calls) == 1 and '文明' in calls[0]
