// Run with Node 24, then open the printed loopback URL at desktop and mobile sizes.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resumeFixture } from './helpers.mjs';
import { renderTranscript } from '../../web/transcript.mjs';

const cases = [
  ['text', '只发送文字', []], ['landscape', '看这张截图', ['wide']],
  ['portrait', '竖图', ['tall']], ['photos', '两张截图', ['wide', 'wide']],
  ['long', '这是一条需要在窄屏上正常换行的用户消息。'.repeat(12), []],
];
const items = cases.map(([id, text]) => ({ id, type: 'userMessage', content: [{ type: 'text', text, text_elements: [] }] }));
items.push({ id: 'answer', type: 'agentMessage', text: '助手回复仍然从聊天内容区左侧开始。' });
const snapshot = resumeFixture('t', [{ id: 'turn', status: 'completed', items }]);
const references = new Map(cases.map(([id, , images]) => [id, images.map((shape, index) => ({ name: `${shape}-${index}.svg`, href: `/api/files/${shape}`, imageHref: `/api/images/${shape}` }))]));
const presentation = renderTranscript(snapshot.thread, snapshot.initialTurnsPage.data, references);
for (const item of presentation.items) item.cursor = { generation: 1, seq: 1 };
const client = `
import { mountChat } from '/chat.js';
document.querySelector('#login-panel').hidden = true; document.querySelector('#workspace').hidden = false;
const api = async (path, body) => (await fetch(path, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
const chat = mountChat({api,viewId:'layout',uploadLimitBytes:33554432}); chat.connection(true); await chat.open('t');
const reports=[];
async function check(phase) {
  await new Promise(requestAnimationFrame);
  if (phase==='images' && document.querySelectorAll('.chat-image').length!==4) throw new Error('Expected four rendered photos');
  for (const image of document.querySelectorAll('.chat-image')) { image.loading='eager'; await image.decode(); }
  await document.fonts.ready;
  const container=document.querySelector('#messages').getBoundingClientRect(), rows=[];
  for (const row of document.querySelectorAll('.message-user')) {
    const box=row.getBoundingClientRect(), style=getComputedStyle(row), images=[...row.querySelectorAll('img')];
    const padding=parseFloat(style.paddingLeft)+parseFloat(style.paddingRight), text=row.querySelector('pre');
    const range=document.createRange(); range.selectNodeContents(text);
    const limit=row.dataset.itemId==='long' ? container.width*.85 : Math.max(range.getBoundingClientRect().width, images.length*320+Math.max(0,images.length-1)*10)+padding;
    const metric={id:row.dataset.itemId,left:box.left,right:box.right,width:box.width,limit,images:images.map(image=>({width:image.getBoundingClientRect().width,natural:image.naturalWidth}))}; rows.push(metric);
    if(Math.abs(box.right-container.right)>1 || box.width>limit+1 || box.left<container.left-1 || images.some(image=>image.getBoundingClientRect().right>box.right+1)) throw new Error(phase+': '+JSON.stringify(metric));
  }
  if(Math.abs(document.querySelector('.message-assistant').getBoundingClientRect().left-container.left)>1) throw new Error('Assistant alignment changed');
  reports.push({phase,viewport:innerWidth,rows});
}
try {
  await check('plain');
  chat.onEvent({kind:'render',cursor:{generation:1,seq:1},native:{threadId:'t',items:${JSON.stringify(presentation.items)}}});
  await check('images');
  document.querySelector('#layout-result').textContent='PASS: '+innerWidth+'px, text and delayed images stay right aligned';
} catch(error) { document.querySelector('#layout-result').textContent='FAIL: '+error.message; reports.push({error:error.message}); }
await fetch('/qa/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(reports)});
`;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/qa/result') { let body = ''; for await (const chunk of req) body += chunk; console.log(body); res.end(); return; }
  if (url.pathname === '/layout-fixture.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(client); return; }
  if (url.pathname === '/favicon.ico') { res.setHeader('Content-Type', 'image/png'); res.end(await readFile(new URL('../../assets/codex-console-icon.png', import.meta.url))); return; }
  if (url.pathname.startsWith('/api/images/')) { res.setHeader('Content-Type', 'image/svg+xml'); res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="${url.pathname.endsWith('tall') ? 500 : 1800}" height="${url.pathname.endsWith('tall') ? 1500 : 900}"><rect width="100%" height="100%" fill="#ddd"/></svg>`); return; }
  if (url.pathname.startsWith('/api/')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(url.pathname === '/api/thread/open' ? { snapshot, cursor: { generation: 1, seq: 1 } } : { result: { data: [], nextCursor: null } })); return; }
  if (url.pathname !== '/' && !/^\/[a-z-]+\.(js|css)$/.test(url.pathname)) { res.writeHead(404); res.end(); return; }
  const file = new URL('../../web/public/' + (url.pathname === '/' ? 'index.html' : url.pathname.slice(1)), import.meta.url);
  let source;
  try { source = await readFile(file, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; res.writeHead(404); res.end(); return; }
  if (url.pathname === '/') source = source.replace('src="/app.js"', 'src="/layout-fixture.js"').replace('</body>', '<output id="layout-result" role="status">Checking layout…</output></body>');
  res.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8'); res.end(source);
});
server.listen(0, '127.0.0.1', () => console.log('http://127.0.0.1:' + server.address().port));
