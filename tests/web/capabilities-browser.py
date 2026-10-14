"""Opt-in browser QA with fixture catalogs; never connects to an owner session."""
import argparse
import json
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
from threading import Thread
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright, expect


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='/tmp/codex-console-capability-qa')
    parser.add_argument('--chromium', help='Existing Chromium executable; otherwise use Playwright Chromium')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    snapshot = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', "import {resumeFixture} from './tests/web/helpers.mjs'; console.log(JSON.stringify(resumeFixture('t', [{id:'sample',status:'completed',items:[{id:'question',type:'userMessage',content:[{type:'text',text:'帮我检查这次改动。',text_elements:[]}]},{id:'answer',type:'agentMessage',text:'可以在输入框旁选择技能或插件，结合用途说明查看适合的能力。'}]}])));"], cwd=root))
    snapshot['cwd'] = snapshot['thread']['cwd'] = '/work'
    snapshot['thread']['name'] = '代码审查 · 浏览器验证'
    review = dict(kind='skill', name='review', path='/work/review/SKILL.md', label='$review', displayName='代码审查', description='检查代码改动，识别回归风险，给出可验证的修复建议。', source='Ponytail 插件', status='可用', disabled=False, keywords=['审查'], pluginId='pony@market')
    plugin = dict(kind='plugin', id='pony@market', name='pony', label='@pony', displayName='Ponytail', description='代码质量与最小实现工作流。', source='已安装插件', status='可用', disabled=False, keywords=['代码'], skills=[review])
    catalog = dict(items=[review, dict(review, name='documents', path='/work/documents/SKILL.md', label='$documents', displayName='Word 文档', description='创建、编辑并检查文档的页面布局。', source='内置技能', pluginId=None), dict(review, name='long-skill', path='/work/long/SKILL.md', label='$long-skill', displayName='跨平台远程工作区与持续集成配置审查' * 4, description='长名称应完整换行，选择与收藏仍然可以操作。', source='个人技能', pluginId=None), dict(review, name='deploy', path='/work/deploy/SKILL.md', label='$deploy', displayName='部署检查', description='检查部署配置与运行环境。', source='当前项目', disabled=True, status='未启用'), plugin, dict(kind='app', id='github', name='GitHub', label='@GitHub', displayName='GitHub', description='读取仓库、议题和拉取请求。', source='应用 / 连接器', status='可用', disabled=False, keywords=[]), dict(kind='app', id='offline', name='Offline app', label='@Offline app', displayName='待连接的应用', description='不可调用时明确显示原因。', source='应用 / 连接器', status='未连接或不可访问', disabled=True, keywords=[])], unavailable=[])

    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(root / 'web/public')))
    Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    calls, errors, captures = [], [], []

    def route_api(route):
        path = urlsplit(route.request.url).path
        body = route.request.post_data_json or {}
        calls.append((path, body))
        if path == '/api/thread/open':
            result = dict(snapshot=snapshot, cursor=dict(generation=1, seq=1))
        elif path == '/api/capabilities':
            result = dict(catalog, items=[item for item in catalog['items'] if
                body.get('section') is None or (item['kind'] == 'app') == (body['section'] == 'apps')])
        elif path == '/api/thread/goal':
            result = dict(result=dict(goal=None), cursor=dict(generation=1, seq=1))
        else:
            result = dict(result=dict(data=[], nextCursor=None))
        route.fulfill(json=result)

    def setup(page, host='local'):
        page.goto(origin)
        page.evaluate("""async ({host}) => {
          sessionStorage.clear(); // Each setup starts a fresh fixture draft; favorites stay in localStorage.
          document.querySelector('#workspace').hidden = false;
          document.querySelector('#login-panel').hidden = true;
          const {mountChat} = await import('/chat.js');
          const api = async (path, body) => (await fetch(path, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
          window.qaChat = mountChat({api,viewId:'qa-view',selectedHost:host,uploadLimitBytes:33554432});
          qaChat.connection(true); await qaChat.open('t');
        }""", dict(host=host))
        expect(page.locator('#show-capabilities')).to_be_enabled()
        expect(page.locator('#selected-capabilities')).to_be_hidden()

    def bounds(page):
        metrics = page.evaluate("""() => {
          const d=document.querySelector('#capabilities-dialog').getBoundingClientRect();
          const f=document.querySelector('.capability-footer').getBoundingClientRect();
          const panel=document.querySelector('#capability-panel').getBoundingClientRect();
          const composer=document.querySelector('#composer').getBoundingClientRect();
          const scrollbars=[...document.querySelectorAll('#capabilities-dialog, #capability-panel, #capability-status, #selected-capabilities')].map(n=>({width:getComputedStyle(n).scrollbarWidth,display:getComputedStyle(n,'::-webkit-scrollbar').display}));
          return {left:d.left,right:d.right,top:d.top,bottom:d.bottom,dialogWidth:d.width,dialogHeight:d.height,width:innerWidth,height:innerHeight,footer:f.bottom,panel:panel.height,scrollWidth:document.documentElement.scrollWidth,composerTop:composer.top,scrollbars};
        }""")
        assert metrics['left'] >= -1 and metrics['right'] <= metrics['width'] + 1, metrics
        assert metrics['top'] >= -1 and metrics['bottom'] <= metrics['height'] + 1, metrics
        assert metrics['footer'] <= metrics['bottom'] and metrics['panel'] >= 50, metrics
        assert metrics['scrollWidth'] <= metrics['width'], metrics
        assert all(bar['width'] == 'none' and bar['display'] == 'none' for bar in metrics['scrollbars']), metrics
        if metrics['width'] > 760:
            assert abs(metrics['dialogWidth'] - min(720, metrics['width'] - 24)) <= 1, metrics
            assert abs(metrics['dialogHeight'] - min(720, metrics['height'] - 24)) <= 1, metrics
        else:
            assert abs(metrics['right'] - metrics['width']) <= 1, metrics
            assert metrics['dialogHeight'] >= metrics['height'] * .9, metrics
        return metrics

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=args.chromium, args=['--no-sandbox'])
            for width, height, scheme in [(1280, 850, 'light'), (1280, 850, 'dark'), (375, 812, 'light'), (375, 812, 'dark'), (667, 375, 'dark'), (1024, 500, 'light'), (820, 420, 'dark'), (320, 568, 'light'), (375, 480, 'dark')]:
                context = browser.new_context(viewport=dict(width=width, height=height), color_scheme=scheme, has_touch=width <= 760, reduced_motion='reduce')
                page = context.new_page()
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)
                page.route('**/app.js', lambda route: route.fulfill(content_type='text/javascript', body=''))
                page.route('**/favicon.ico', lambda route: route.fulfill(status=204))
                page.route('**/api/**', route_api)
                setup(page)
                for offset in [-4, 4]:
                    surface = page.locator('.composer-surface').bounding_box()
                    page.locator('#thread-title').focus()
                    page.evaluate('getSelection().removeAllRanges()')
                    page.mouse.move(surface['x'] + 24, surface['y'] + offset)
                    page.mouse.down()
                    assert page.evaluate('!document.querySelector("#composer").contains(getSelection().anchorNode)'), 'Padding must not create a document caret, even before releasing the mouse'
                    expect(page.locator('#draft')).not_to_be_focused()
                    page.mouse.up()
                    expect(page.locator('#draft')).not_to_be_focused()
                page.locator('#draft').fill('请检查这次改动 😀，保留这段说明。')
                page.locator('#draft').press('Control+A')
                assert page.locator('#draft').evaluate('(n) => n.value.slice(n.selectionStart, n.selectionEnd) === n.value'), 'Text selection still works inside the editor'
                page.locator('#draft').evaluate('(n) => n.setSelectionRange(2, 2)')
                page.locator('#thread-title').focus()
                surface = page.locator('.composer-surface').bounding_box()
                page.mouse.click(surface['x'] + 24, surface['y'] + 4)
                expect(page.locator('#draft')).not_to_be_focused()
                assert page.locator('#draft').evaluate('(n) => n.selectionStart === 2 && n.selectionEnd === 2'), 'Blank clicks preserve the editing position'
                page.locator('#draft').evaluate('(n) => n.setSelectionRange(n.value.length, n.value.length)')
                page.locator('#show-capabilities').click()
                expect(page.locator('#capability-search')).to_be_focused()
                expect(page.get_by_role('button', name='选择 代码审查', exact=True)).to_be_enabled()
                prefix = f'{width}x{height}-{scheme}'
                page.screenshot(path=str(output / f'{prefix}-skills.png'))
                metrics = bounds(page)
                scroll_selector = '#capability-panel' if height > 560 else '#capabilities-dialog'
                scroll = page.locator(scroll_selector)
                assert scroll.evaluate('(n) => n.scrollHeight > n.clientHeight'), metrics
                scroll.hover()
                page.mouse.wheel(0, 180)
                page.wait_for_function('(selector) => document.querySelector(selector).scrollTop > 0', arg=scroll_selector)
                scroll.evaluate('(n) => n.scrollTop = 0')
                page.locator('#capability-search').fill('回归')
                expect(page.locator('#capability-results > li')).to_have_count(1)
                page.get_by_role('button', name='收藏 代码审查', exact=True).click()
                expect(page.get_by_role('button', name='取消收藏 代码审查', exact=True)).to_be_focused()
                page.locator('#capability-search').focus()
                page.locator('#capability-search').press('Enter')
                page.locator('#capability-search').fill('')
                page.locator('#capability-filter-favorites').click()
                expect(page.locator('#capability-results > li')).to_have_count(1)
                page.locator('#capability-filter-recent').click()
                expect(page.locator('#capability-results')).to_contain_text('代码审查')
                page.locator('#capability-filter-all').click()
                page.locator('#capability-tab-plugins').click()
                page.get_by_role('button', name='查看 Ponytail 详情', exact=True).click()
                expect(page.locator('#capability-details')).to_contain_text('包含的技能（1）')
                expect(page.locator('#capability-details')).to_contain_text('代码审查')
                page.screenshot(path=str(output / f'{prefix}-plugin.png'))
                page.get_by_role('button', name='选择 Ponytail', exact=True).click()
                page.locator('#done-capabilities').click()
                expect(page.locator('#draft')).to_be_focused()
                expect(page.locator('#selected-capabilities')).to_contain_text('代码审查')
                expect(page.locator('#selected-capabilities')).to_contain_text('Ponytail')
                page.get_by_role('button', name='移除 代码审查', exact=True).click()
                assert '$review' not in page.locator('#draft').input_value()
                assert '😀，保留这段说明。' in page.locator('#draft').input_value()
                encoded = page.evaluate("""async () => {const {encodeComposer}=await import('/composer.js'); const s=qaChat.getState(); return encodeComposer({text:s.draft,selections:s.selections,uploads:[],threadId:'t',mode:'start'}).input;}""")
                assert encoded[-1]['type'] == 'mention' and encoded[-1]['path'] == 'plugin://pony@market', encoded
                page.screenshot(path=str(output / f'{prefix}-selected.png'))
                page.locator('#show-capabilities').click()
                page.locator('#capability-search').press('Escape')
                expect(page.locator('#capabilities-dialog')).not_to_be_visible()
                expect(page.locator('#show-capabilities')).to_be_focused()
                setup(page)
                page.locator('#show-capabilities').click()
                expect(page.get_by_role('button', name='取消收藏 代码审查', exact=True)).to_be_visible()
                page.locator('#capability-filter-recent').click()
                expect(page.locator('#capability-results')).to_contain_text('代码审查')
                setup(page, 'other-host')
                page.locator('#show-capabilities').click()
                expect(page.get_by_role('button', name='收藏 代码审查', exact=True)).to_be_visible()
                page.locator('#capability-filter-favorites').click()
                expect(page.locator('#capability-results')).not_to_contain_text('代码审查')
                original = catalog['items']
                long = next(item for item in original if item['name'] == 'long-skill')
                catalog['items'] = [dict(long, name=f'long-{i}', label=f'$long-{i}', path=f'/work/long-{i}/SKILL.md') for i in range(4)]
                setup(page)
                page.locator('#show-capabilities').click()
                expect(page.locator('#capability-results .capability-choice:enabled')).to_have_count(4)
                for _i in range(4):
                    page.locator('#capability-results .capability-choice:enabled').first.click()
                page.locator('#done-capabilities').click()
                assert page.locator('.composer-footer').bounding_box()['y'] + page.locator('.composer-footer').bounding_box()['height'] <= height, 'Selected labels must not hide send controls'
                page.screenshot(path=str(output / f'{prefix}-multi-long.png'))
                catalog['items'] = original
                captures.append(dict(viewport=prefix, metrics=metrics, screenshots=[str(output / f'{prefix}-{state}.png') for state in ['skills', 'plugin', 'selected', 'multi-long']]))
                page.evaluate('qaChat.connection(false)')
                expect(page.locator('#draft')).to_be_disabled()
                surface = page.locator('.composer-surface').bounding_box()
                page.mouse.click(surface['x'] + 24, surface['y'] + 4)
                expect(page.locator('#draft')).not_to_be_focused()
                context.close()
            browser.close()
        assert not errors, errors
        assert not any(path == '/api/thread/send' for path, _body in calls), 'Selecting must never send a message'
        report = dict(result='passed', fixture_catalog=True, captures=captures, console_errors=errors, capability_requests=sum(path == '/api/capabilities' for path, _body in calls))
        (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps(dict(result='passed', viewports=len(captures), screenshots=sum(len(capture['screenshots']) for capture in captures), output=str(output)), ensure_ascii=False))
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
