"""Opt-in native-task UI QA against in-memory fixtures; no account or scheduler is used."""
import argparse
import json
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright, expect


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='/home/desktop/.local/state/codex-console-web/native-schedules/automation-ui-qa')
    parser.add_argument('--chromium', help='Existing Chromium executable; otherwise use Playwright Chromium')
    args = parser.parse_args()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    root = Path(__file__).resolve().parents[2]

    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(root / 'web/public')))
    Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    calls, errors, captures, tasks, pending = [], [], [], {}, {}
    flags = dict(conflict=False, hold_read=False)

    def fixtures():
        base = dict(kind='heartbeat', name='原会话巡检', prompt='完整的原生提示词，包含不会出现在列表摘要中的细节。', promptPreview='原生提示词摘要…', status='ACTIVE', rrule='FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0', targetThreadId='original-thread', updatedAt=10, nextRunAt=None, lastRunAt=1791936000000)
        tasks.clear()
        tasks['heartbeat'] = dict(base, id='heartbeat')
        tasks['cron'] = dict(base, id='cron', kind='cron', name='项目独立任务', targetThreadId=None, projectId='project', executionEnvironment='worktree', model='advanced-model', reasoningEffort='high')
        for index in range(18):
            tasks[f'item-{index}'] = dict(base, id=f'item-{index}', name=('长任务名称，完整换行而不遮挡右侧菜单' * 4) if index == 0 else f'定时检查 {index + 1}')
        flags.update(conflict=False, hold_read=False)

    def route_api(route):
        path = urlsplit(route.request.url).path
        body = route.request.post_data_json or {}
        calls.append(dict(path=path, body=body))
        if path == '/api/automations/list':
            result = dict(items=[{key: value for key, value in item.items() if key != 'prompt'} for item in tasks.values()], unavailable=[], timeZone='Asia/Shanghai', now=1791936000000)
        elif path == '/api/automations/read':
            if flags['hold_read']:
                pending['read'] = route
                return
            result = dict(item=tasks[body['id']])
        elif path == '/api/automations/create':
            item = dict(body['item'], id=f'created-{len(tasks)}', updatedAt=11, promptPreview=body['item']['prompt'][:16], nextRunAt=None, lastRunAt=None)
            tasks[item['id']] = item
            result = dict(item=item)
        elif path == '/api/automations/update':
            if flags['conflict']:
                route.fulfill(status=409, json=dict(error=dict(message='The native task changed.')))
                return
            item = tasks[body['id']]
            assert body['expectedUpdatedAt'] == item['updatedAt'], body
            item.update(body['patch'])
            item['updatedAt'] += 1
            result = dict(item=item)
        elif path == '/api/automations/delete':
            assert body['confirmed'] is True and body['expectedUpdatedAt'] == tasks[body['id']]['updatedAt'], body
            del tasks[body['id']]
            result = dict(deleted=True, id=body['id'])
        elif path == '/api/rpc':
            method = body['method']
            assert method in ['thread/list', 'project/list', 'model/list'] and body['params']['limit'] <= 100, body
            data = [dict(id='catalog-thread', name='其他已有会话')] if method == 'thread/list' else [dict(id='project', name='已登记项目', roots=[dict(path='/fixture/private/project')])] if method == 'project/list' else [dict(model='default-model', displayName='默认模型', isDefault=True, supportedReasoningEfforts=[dict(reasoningEffort='low')]), dict(model='advanced-model', displayName='高级模型', supportedReasoningEfforts=[dict(reasoningEffort='high'), dict(reasoningEffort='xhigh')])]
            result = dict(result=dict(data=data, nextCursor=None))
        else:
            raise AssertionError(f'Unexpected API request: {path}')
        route.fulfill(json=result)

    def setup(page, host='local'):
        fixtures()
        page.goto(origin)
        expect(page.locator('#show-automations')).to_be_hidden()
        page.evaluate("""async ({host}) => {
          document.querySelector('#workspace').hidden=false;
          document.querySelector('#login-panel').hidden=true;
          document.querySelector('.work-layout').dataset.level='threads';
          window.qaState={threadId:'current-empty',ready:true,thread:{name:'当前空会话'},draft:'保留当前聊天草稿',settings:{model:'chat-model',effort:'high'}};
          window.qaOpened=[];
          const {mountAutomations}=await import('/automations.js');
          const api=async (path,body)=>{const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.error.message),{status:response.status});return data;};
          window.qaPanel=mountAutomations({api,viewId:'fixture-view',selectedHost:host,getState:()=>qaState,onOpenThread:id=>qaOpened.push(id)});
        }""", dict(host=host))

    def bounds(page):
        metrics = page.evaluate("""() => {
          const d=document.querySelector('#automations-dialog').getBoundingClientRect();
          const form=!document.querySelector('#automation-form').hidden;
          const footer=document.querySelector(form?'.automation-form-footer':'.automation-toolbar').getBoundingClientRect();
          const scroll=document.querySelector(form?'#automation-form-scroll':'#automation-list-scroll');
          return {left:d.left,right:d.right,top:d.top,bottom:d.bottom,width:innerWidth,height:innerHeight,footerTop:footer.top,footerBottom:footer.bottom,scrollWidth:document.documentElement.scrollWidth,scrollHeight:scroll.scrollHeight,clientHeight:scroll.clientHeight,bar:getComputedStyle(scroll).scrollbarWidth,webkit:getComputedStyle(scroll,'::-webkit-scrollbar').display};
        }""")
        assert metrics['left'] >= -1 and metrics['right'] <= metrics['width'] + 1, metrics
        assert metrics['top'] >= -1 and metrics['bottom'] <= metrics['height'] + 1, metrics
        assert metrics['footerTop'] >= metrics['top'] and metrics['footerBottom'] <= metrics['bottom'], metrics
        assert metrics['scrollWidth'] <= metrics['width'] and metrics['clientHeight'] > 50, metrics
        assert metrics['bar'] == 'none' and metrics['webkit'] == 'none', metrics
        return metrics

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=args.chromium, args=['--no-sandbox'])
            for width, height, scheme in [(1280, 850, 'light'), (1280, 850, 'dark'), (375, 812, 'light'), (375, 812, 'dark'), (667, 375, 'dark'), (1024, 500, 'light'), (320, 568, 'light'), (375, 480, 'dark')]:
                context = browser.new_context(viewport=dict(width=width, height=height), color_scheme=scheme, has_touch=width <= 760, timezone_id='America/Los_Angeles', reduced_motion='reduce')
                page = context.new_page()
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.on('console', lambda message: errors.append(message.text) if message.type == 'error' and '409' not in message.text else None)
                page.route('**/app.js', lambda route: route.fulfill(content_type='text/javascript', body=''))
                page.route('**/favicon.ico', lambda route: route.fulfill(status=204))
                page.route('**/api/**', route_api)
                setup(page)
                page.locator('#show-automations').click()
                expect(page.locator('#automation-list > li')).to_have_count(20)
                metrics = bounds(page)
                scroll = page.locator('#automation-list-scroll')
                assert metrics['scrollHeight'] > metrics['clientHeight'], metrics
                scroll.hover()
                page.mouse.wheel(0, 220)
                page.wait_for_function("document.querySelector('#automation-list-scroll').scrollTop>0")
                scroll.evaluate('(node)=>node.scrollTop=0')
                scroll.focus()
                scroll.press('ArrowDown')
                page.wait_for_function("document.querySelector('#automation-list-scroll').scrollTop>0")
                scroll.evaluate('(node)=>node.scrollTop=0')
                if width <= 760:
                    box = scroll.bounding_box()
                    touch = context.new_cdp_session(page)
                    touch.send('Input.synthesizeScrollGesture', dict(x=box['x'] + box['width'] / 2, y=box['y'] + box['height'] / 2, yDistance=-180, gestureSourceType='touch', speed=800))
                    page.wait_for_function("document.querySelector('#automation-list-scroll').scrollTop>0")
                    scroll.evaluate('(node)=>node.scrollTop=0')
                    touch.detach()
                prefix = f'{width}x{height}-{scheme}'
                page.screenshot(path=str(output / f'{prefix}-list.png'))

                page.get_by_role('button', name='编辑 原会话巡检', exact=True).click()
                expect(page.locator('#automation-prompt')).to_have_value(tasks['heartbeat']['prompt'])
                expect(page.locator('#automation-thread')).to_have_value('original-thread')
                expect(page.locator('#automation-kind')).to_be_disabled()
                page.locator('#cancel-automation').click()
                page.get_by_role('button', name='编辑 项目独立任务', exact=True).click()
                expect(page.locator('#automation-project')).to_have_value('project')
                expect(page.locator('#automation-model')).to_have_value('advanced-model')
                expect(page.locator('#automation-effort')).to_have_value('high')
                expect(page.locator('#automation-environment')).to_contain_text('原生工作树')
                page.locator('#automation-name').fill('仅改任务名称')
                page.locator('#save-automation').click()
                expect(page.locator('#automation-form')).to_be_hidden()
                update = [call for call in calls if call['path'].endswith('/update')][-1]['body']
                assert update['patch'] == dict(name='仅改任务名称'), update

                page.locator('#new-automation').click()
                expect(page.locator('#automation-kind')).to_have_value('cron')
                expect(page.locator('#automation-heartbeat-fields')).to_be_hidden()
                expect(page.locator('#automation-cron-fields')).to_be_visible()
                page.locator('#automation-kind').select_option('heartbeat')
                expect(page.locator('#automation-thread-hint')).to_contain_text('Codex 桌面打开该会话')
                expect(page.locator('#automation-thread-hint')).to_contain_text('保持客户端运行')
                expect(page.locator('#automation-thread')).to_have_value('current-empty')
                page.locator('#automation-name').fill('每半小时检查当前会话')
                page.locator('#automation-prompt').fill('按上下文继续检查。保留这段完整输入。')
                page.locator('#automation-schedule').select_option('minutes')
                page.locator('#automation-interval').fill('30')
                metrics = bounds(page)
                page.locator('#automation-interval').focus()
                page.locator('#automation-interval').press('Tab')
                expect(page.locator('#cancel-automation')).to_be_focused()
                page.screenshot(path=str(output / f'{prefix}-form.png'))
                page.locator('#save-automation').click()
                expect(page.locator('#automation-form')).to_be_hidden()
                created = [call for call in calls if call['path'].endswith('/create')][-1]['body']['item']
                assert created['kind'] == 'heartbeat' and created['targetThreadId'] == 'current-empty', created
                assert created['rrule'] == 'FREQ=MINUTELY;INTERVAL=30' and 'model' not in created, created

                page.locator('#new-automation').click()
                expect(page.locator('#automation-kind')).to_have_value('cron')
                page.locator('#automation-name').fill('电脑时区的一次任务')
                page.locator('#automation-prompt').fill('检查项目并创建独立会话。')
                expect(page.locator('#automation-project')).to_be_visible()
                page.locator('#automation-project').select_option('project')
                page.locator('#automation-model').select_option('advanced-model')
                page.locator('#automation-effort').select_option('xhigh')
                page.locator('#automation-schedule').select_option('once')
                page.locator('#automation-once').fill('2026-10-15T10:00')
                page.locator('#save-automation').click()
                expect(page.locator('#automation-form')).to_be_hidden()
                cron = [call for call in calls if call['path'].endswith('/create')][-1]['body']['item']
                assert cron['rrule'] == 'DTSTART;TZID=Asia/Shanghai:20261015T100000\nRRULE:FREQ=DAILY;COUNT=1', cron
                assert cron['projectId'] == 'project' and cron['executionEnvironment'] == 'local' and cron['model'] == 'advanced-model' and cron['reasoningEffort'] == 'xhigh', cron
                assert 'cwds' not in cron and 'targetThreadId' not in cron, cron
                assert page.evaluate('qaState.draft') == '保留当前聊天草稿'

                page.get_by_role('button', name='编辑 原会话巡检', exact=True).click()
                page.locator('#automation-prompt').fill('正在编辑的完整输入 😀')
                page.locator('#automation-prompt').evaluate("node=>{node.focus();node.setSelectionRange(4,4);node.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));}")
                page.evaluate("qaPanel.onEvent({native:{method:'automation/changed'}})")
                expect(page.locator('#automation-prompt')).to_have_value('正在编辑的完整输入 😀')
                expect(page.locator('#automation-prompt')).to_be_focused()
                assert page.locator('#automation-prompt').evaluate('node=>node.selectionStart') == 4
                count = len([call for call in calls if call['path'].endswith('/update')])
                page.locator('#automation-form').evaluate('node=>node.requestSubmit()')
                assert len([call for call in calls if call['path'].endswith('/update')]) == count
                page.locator('#automation-prompt').evaluate("node=>node.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))")
                flags['conflict'] = True
                page.locator('#save-automation').click()
                expect(page.locator('#automation-form-error')).to_contain_text('重新打开')
                expect(page.locator('#save-automation')).to_be_disabled()
                expect(page.locator('#automation-prompt')).to_have_value('正在编辑的完整输入 😀')
                bounds(page)
                flags['conflict'] = False
                page.locator('#cancel-automation').click()

                page.get_by_role('button', name='原会话巡检 的选项', exact=True).click()
                expect(page.locator('#automation-menu')).to_be_visible()
                page.locator('#automation-menu-edit').press('ArrowDown')
                expect(page.locator('#automation-menu-toggle')).to_be_focused()
                page.locator('#automation-menu-toggle').press('Escape')
                expect(page.locator('#automation-menu')).to_be_hidden()
                expect(page.locator('#automations-dialog')).to_be_visible()
                page.get_by_role('button', name='原会话巡检 的选项', exact=True).click()
                page.locator('#automation-menu-toggle').click()
                expect(page.locator('#automation-list > li').first).to_contain_text('已暂停')
                expect(page.get_by_role('button', name='原会话巡检 的选项', exact=True)).to_be_focused()
                page.get_by_role('button', name='原会话巡检 的选项', exact=True).click()
                page.once('dialog', lambda dialog: dialog.dismiss())
                page.locator('#automation-menu-delete').click()
                assert 'heartbeat' in tasks
                page.get_by_role('button', name='原会话巡检 的选项', exact=True).click()
                page.once('dialog', lambda dialog: dialog.accept())
                page.locator('#automation-menu-delete').click()
                expect(page.get_by_role('button', name='编辑 原会话巡检', exact=True)).to_have_count(0)

                flags['hold_read'] = True
                page.get_by_role('button', name='编辑 仅改任务名称', exact=True).click()
                page.locator('#close-automations').click()
                page.locator('#show-automations').click()
                page.locator('#new-automation').click()
                page.locator('#automation-name').fill('新的表单不接受迟到回复')
                assert 'read' in pending
                pending.pop('read').fulfill(json=dict(item=tasks['cron']))
                flags['hold_read'] = False
                expect(page.locator('#automation-name')).to_have_value('新的表单不接受迟到回复')
                page.evaluate("document.querySelector('#close-automations').click();document.querySelector('#show-automations').click();document.querySelector('#new-automation').click();")
                page.locator('#automation-name').fill('同步重开后仍可创建')
                page.locator('#automation-prompt').fill('迟到的原生 close 事件不能关闭新页面。')
                page.locator('#save-automation').click()
                expect(page.locator('#automation-form')).to_be_hidden()
                page.locator('#new-automation').click()
                page.locator('#automation-name').press('Escape')
                expect(page.locator('#automations-dialog')).not_to_be_visible()
                expect(page.locator('#show-automations')).to_be_focused()
                captures.append(dict(viewport=prefix, **metrics))
                page.evaluate('qaPanel.dispose()')
                expect(page.locator('#show-automations')).to_be_hidden()
                context.close()

            context = browser.new_context(viewport=dict(width=1280, height=850))
            page = context.new_page()
            page.route('**/app.js', lambda route: route.fulfill(content_type='text/javascript', body=''))
            page.route('**/api/**', route_api)
            before = len(calls)
            setup(page, 'remote-device')
            expect(page.locator('#show-automations')).to_be_hidden()
            page.evaluate("qaPanel.onEvent({native:{method:'automation/changed'}})")
            assert len(calls) == before, calls[before:]
            context.close()
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
        (output / 'report.json').write_text(json.dumps(dict(captures=captures, apiCalls=calls, errors=errors), ensure_ascii=False, indent=2))
    assert not errors, errors
    print(f'PASS: {len(captures)} viewport/theme combinations; native CRUD, focus, host timezone, conflicts and late responses; {output}')


if __name__ == '__main__':
    main()
