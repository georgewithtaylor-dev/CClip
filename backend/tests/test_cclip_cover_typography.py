"""A local cover keeps a readable headline instead of shrinking a Chinese sentence."""
from io import BytesIO

from PIL import Image, ImageDraw

from backend.services import cover_local
from backend.services.studio import cover_design
from backend.tests.test_cclip import full, video  # noqa: F401
from backend.tests.test_cclip_manual_cover import setup_cover


def frame():
    data = BytesIO()
    Image.new('RGB', (640, 360), (80, 80, 80)).save(data, 'JPEG')
    return data.getvalue()


def test_chinese_preview_has_two_large_title_rows_and_an_accent():
    image = Image.open(BytesIO(cover_local.render(
        frame(), width=1080, height=1920, title='工具怎么选，关键看实际使用价值', palette='amber')))
    rows, accented = [], 0
    for y in range(110, 700):
        ink = 0
        for x in range(65, 1015):
            red, green, blue = image.getpixel((x, y))
            white = min(red, green, blue) > 180 and max(red, green, blue) - min(red, green, blue) < 35
            accent = red > 170 and 95 < green < 220 and blue < 135 and red - blue > 70
            ink += white or accent
            accented += accent
        if ink > 12:
            if not rows or y > rows[-1][-1] + 1:
                rows.append([])
            rows[-1].append(y)
    headline_rows = [row for row in rows if len(row) > 20]
    assert len(headline_rows) == 2
    assert min(map(len, headline_rows)) >= 70
    assert accented > 5000


def test_preview_and_existing_two_line_platform_design_agree():
    lines = ['把握核心观点', '清晰表达方法']
    source = frame()
    expected = cover_design.design(source, width=1080, height=1920, title_lines=lines, palette='mint')
    assert cover_local.render(source, width=1080, height=1920, title=' '.join(lines), palette='mint') == expected


def test_very_long_mixed_title_is_complete_and_stays_inside_cover(monkeypatch):
    title = '专业表达与清晰思考ABC2026' * 8
    painted = []
    original = ImageDraw.ImageDraw.text

    def capture(draw, xy, text, *args, **kwargs):
        box = draw.textbbox(xy, text, font=kwargs.get('font'))
        painted.append((text, box))
        return original(draw, xy, text, *args, **kwargs)

    monkeypatch.setattr(ImageDraw.ImageDraw, 'text', capture)
    data = cover_local.render(frame(), width=1080, height=1440, title=title, palette='amber')
    assert Image.open(BytesIO(data)).size == (1080, 1440)
    assert ''.join(text for text, _ in painted).replace(' ', '') == title
    assert all(left >= 65 and right <= 1015 and top >= 0 and bottom < 1440
               for _, (left, top, right, bottom) in painted)


def test_preview_and_apply_keep_the_draft_heading_and_accent(full, video, monkeypatch):
    client, pid, did, endpoint = setup_cover(full, video, monkeypatch)
    from backend.services import cover
    from backend.services.studio import store
    lines = ['理解复杂问题的方法', '先理清目标']
    title = ' '.join(lines)
    def prepare(state):
        draft = next(d for d in state['drafts'] if d['id'] == did)
        draft['packaging'] = {'title_lines': lines, 'title_accent_line': 0}
    store.change(pid, prepare)
    source = frame()
    monkeypatch.setattr(cover, 'extract_frame_jpeg', lambda *_a, **_k: source)
    body = {'platform': 'douyin', 'title': title, 'local_template': 'autoclip', 'palette': 'amber'}
    preview = client.post(endpoint + '/preview', json=body)
    expected = cover_design.design(source, width=1080, height=1920, title_lines=lines, accent_line=0, palette='amber')
    assert preview.status_code == 200 and preview.content == expected
    monkeypatch.setattr(cover, 'load_config', lambda: cover.CoverConfig())
    applied = client.post(endpoint, json={**body, 'force_local': True, 'sync': True})
    assert applied.status_code == 200
    assert cover.cover_path(pid, f'draft-{did}', 'douyin').read_bytes() == expected
    assert client.get(endpoint + '?platform=douyin').json()['title'] == title
    assert next(d for d in store.read(pid)['drafts'] if d['id'] == did)['packaging']['title_lines'] == lines
