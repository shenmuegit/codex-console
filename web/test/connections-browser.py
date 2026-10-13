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
        else:
            route.fulfill(json=dict(hosts=[dict(id='host-a', name='办公电脑', online=True), dict(id='host-b', name='工作笔记本', online=True)]))

    boot = """import {mountConnections} from '/connections.js';
document.querySelector('#workspace').hidden=false;document.querySelector('#login-panel').hidden=true;
const api=async path=>{const response=await fetch(path);const value=await response.json();if(!response.ok)throw new Error(value.error.message);return value;};
window.qaConnections=mountConnections({api,selectedHost:new URL(location.href).searchParams.get('host')??'local',selectHost:host=>location.assign('/?host='+encodeURIComponent(host))});
qaConnections.refresh();"""
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=args.chromium, args=['--no-sandbox'])
            for scheme in ('light', 'dark'):
                failing = False
                context = browser.new_context(viewport=dict(width=1280, height=850), color_scheme=scheme)
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
                expect(page.locator('#recovery-host-picker option:checked')).to_have_text('办公电脑')
                page.screenshot(path=str(output / f'host-switch-{scheme}.png'))
                failing = False
                page.locator('#show-connections').click()
                expect(page.locator('#host-picker option:checked')).to_have_text('办公电脑 · 已连接')
                expect(page.locator('#connections-error')).to_have_text('')
                context.close()
            browser.close()
    finally:
        server.shutdown(); server.server_close()
    print('Device switching and inventory recovery passed in light and dark Chromium.')


if __name__ == '__main__':
    main()
