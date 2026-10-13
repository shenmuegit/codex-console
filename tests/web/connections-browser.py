"""Opt-in navigation QA with fixture hosts; never accesses an owner session."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright, expect


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='/tmp/codex-console-navigation-qa')
    parser.add_argument('--chromium')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    output = Path(args.output); output.mkdir(parents=True, exist_ok=True)

    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(root / 'web/public')))
    Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    failing = False

    def route_api(route):
        path = urlsplit(route.request.url).path
        if path == '/api/controller/status':
            route.fulfill(json=dict(available=True, enrolled=True, phase='ready'))
        elif path == '/api/controller/hosts' and failing:
            route.fulfill(status=500, json=dict(error=dict(code='REMOTE_REQUEST_FAILED', message='设备清单暂不可用')))
        elif path == '/api/rpc':
            route.fulfill(json=dict(result=dict(rateLimits=dict(secondary=dict(windowDurationMins=10080, usedPercent=25)))))
        else:
            route.fulfill(json=dict(hosts=[dict(id='host-a', name='办公电脑', online=True), dict(id='host-b', name='工作笔记本', online=True)]))

    boot = """import {mountConnections} from '/connections.js';import {mountUsage} from '/usage.js';
document.querySelector('#workspace').hidden=false;document.querySelector('#login-panel').hidden=true;
document.querySelector('.work-layout').dataset.level='projects';
const api=async (path,body)=>{const response=await fetch(path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const value=await response.json();if(!response.ok)throw new Error(value.error.message);return value;};
window.qaConnections=mountConnections({api,selectedHost:new URL(location.href).searchParams.get('host')??'local',selectHost:host=>location.assign('/?host='+encodeURIComponent(host))});
window.qaUsage=mountUsage({api,viewId:'view',getState:()=>null,onChange(){},onError(){}});
qaConnections.refresh();"""
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=args.chromium, args=['--no-sandbox'])
            for width, height, scheme in [(1280, 850, 'light'), (1280, 850, 'dark'), (375, 812, 'light'), (375, 812, 'dark')]:
                failing = False
                context = browser.new_context(viewport=dict(width=width, height=height), color_scheme=scheme, has_touch=width <= 760)
                page = context.new_page()
                page.route('**/app.js', lambda route: route.fulfill(content_type='text/javascript', body=boot))
                page.route('**/api/**', route_api)
                page.route('**/favicon.ico', lambda route: route.fulfill(status=204))
                page.goto(origin)
                expect(page.locator('#host-picker option[value="host-a"]')).to_have_text('办公电脑 · 已连接')
                failing = True
                page.locator('#host-picker').select_option('host-a')
                page.wait_for_url('**/?host=host-a')
                expect(page.locator('#host-picker option:checked')).to_have_text('办公电脑')
                prefix = f'{width}x{height}-{scheme}'
                page.screenshot(path=str(output / f'{prefix}-host-switch.png'))
                failing = False
                expect(page.locator('.sidebar-footer #show-connections')).to_have_count(0)
                expect(page.locator('.sidebar-footer #show-usage')).to_have_count(0)
                page.locator('#show-settings').click()
                expect(page.get_by_role('dialog', name='系统设置')).to_be_visible()
                expect(page.locator('#settings-dialog #show-connections')).to_be_visible()
                expect(page.locator('#settings-dialog #show-usage')).to_be_visible()
                bounds = page.locator('#settings-dialog').bounding_box()
                assert bounds['x'] >= 0 and bounds['x'] + bounds['width'] <= width, bounds
                assert bounds['y'] >= 0 and bounds['y'] + bounds['height'] <= height, bounds
                page.screenshot(path=str(output / f'{prefix}-settings.png'))
                page.locator('#show-connections').click()
                expect(page.locator('#settings-dialog')).not_to_be_visible()
                expect(page.locator('#connections-dialog')).to_be_visible()
                expect(page.locator('#host-picker option:checked')).to_have_text('办公电脑 · 已连接')
                expect(page.locator('#connections-error')).to_have_text('')
                page.keyboard.press('Escape')
                expect(page.locator('#settings-dialog')).to_be_visible()
                expect(page.locator('#show-connections')).to_be_focused()
                page.locator('#show-usage').click()
                expect(page.locator('#settings-dialog')).not_to_be_visible()
                expect(page.locator('#usage-dialog')).to_be_visible()
                expect(page.locator('#weekly-usage')).to_contain_text('已用 25%')
                page.screenshot(path=str(output / f'{prefix}-usage.png'))
                page.keyboard.press('Escape')
                expect(page.locator('#settings-dialog')).to_be_visible()
                expect(page.locator('#show-usage')).to_be_focused()
                page.keyboard.press('Escape')
                expect(page.locator('#settings-dialog')).not_to_be_visible()
                expect(page.locator('#show-settings')).to_be_focused()
                context.close()
            for width, height, scheme in [(1280, 850, 'light'), (375, 812, 'dark')]:
                for code, status, reason, expected in [
                    ('NATIVE_DISCONNECTED', 503, 'The native backend is offline.', '未能建立到所选设备的 Codex 连接。'),
                    ('REMOTE_REQUEST_FAILED', 502, 'Official remote-control request failed (403).', 'Official remote-control request failed (403).'),
                    ('REMOTE_HOST_NOT_PAIRED', 404, '设备尚未配对或已经移除。', '设备尚未配对或已经移除。'),
                ]:
                    context = browser.new_context(viewport=dict(width=width, height=height), color_scheme=scheme)
                    page = context.new_page()

                    def fail_selected_host(route):
                        url = urlsplit(route.request.url)
                        if url.path == '/api/status' and url.query:
                            route.fulfill(status=status, json=dict(error=dict(code=code, message=reason)))
                        elif url.path == '/api/status':
                            route.fulfill(json=dict(online=True, uploadLimitBytes=32000000, generation=1))
                        else:
                            route_api(route)

                    page.route('**/api/**', fail_selected_host)
                    page.route('**/favicon.ico', lambda route: route.fulfill(status=204))
                    page.goto(origin + '/?host=host-a')
                    expect(page.locator('#workspace-error-message')).to_have_text(expected + f'（{code}）')
                    expect(page.locator('#workspace-error button, #workspace-error select, #workspace-error label')).to_have_count(0)
                    expect(page.locator('#workspace-error > *')).to_have_count(1)
                    expect(page.locator('#login-panel')).not_to_be_visible()
                    assert page.locator('#workspace-error').bounding_box()['height'] < 100
                    page.screenshot(path=str(output / f'{width}x{height}-{scheme}-{code}.png'))
                    context.close()
            browser.close()
    finally:
        server.shutdown(); server.server_close()
    print('Navigation, settings, focus return and compact connection failure reasons passed in Chromium.')


if __name__ == '__main__':
    main()
