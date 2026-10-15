// Run with Node 24 and open the printed loopback URL. Uses synthetic questions only.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resumeFixture } from './helpers.mjs';

const question = { id: 'click-question', type: 'agentMessage', delivery: 'async', text: '请选择测试选项',
  questions: [{ title: '请选择测试选项', options: ['选项一', '选项二', '选项三'] }] };
const snapshot = resumeFixture('t', [{ id: 'turn', status: 'inProgress', items: [question] }]);
const client = `
import { mountChat } from '/chat.js';
document.querySelector('#login-panel').hidden=true; document.querySelector('#workspace').hidden=false;
const api=async(path,body)=>(await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
const chat=mountChat({api,viewId:'question-fixture',uploadLimitBytes:33554432});chat.connection(true);await chat.open('t');
document.querySelector('#draft').value='保留输入框草稿';document.querySelector('#draft').dispatchEvent(new Event('input'));
const result=document.querySelector('#question-result');
try {
  for(const label of document.querySelectorAll('.async-question-card .request-option')) {
    label.scrollIntoView({block:'nearest'});
    const input=label.querySelector('input'),box=label.getBoundingClientRect();
    for(const fraction of [.05,.5,.95]) {
      if(document.elementFromPoint(box.left+box.width*fraction,box.top+box.height/2)!==input) throw new Error(input.value+': option row does not directly hit its native control');
    }
  }
  result.textContent='PASS: whole option rows hit their native radio controls ('+innerWidth+'px)';
} catch(error) { result.textContent='FAIL: '+error.message; }
let seq=1;const stream=setInterval(()=>{if(seq>=300){clearInterval(stream);return;}chat.onEvent({kind:'notification',cursor:{generation:1,seq:++seq},native:{method:'item/agentMessage/delta',params:{threadId:'t',turnId:'turn',itemId:'stream',delta:'·'}}});},200);
`;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/question-fixture.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(client); return; }
  if (url.pathname === '/favicon.ico') { res.setHeader('Content-Type', 'image/png'); res.end(await readFile(new URL('../../assets/codex-console-icon.png', import.meta.url))); return; }
  if (url.pathname.startsWith('/api/')) {
    let body=''; for await(const chunk of req) body+=chunk;
    if (url.pathname === '/api/thread/send') console.log(body);
    res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(url.pathname === '/api/thread/open' ?
      { snapshot, cursor: { generation: 1, seq: 1 } } : url.pathname === '/api/thread/send' ? { result:{},cursor:{generation:1,seq:10000} } : {result:{data:[],nextCursor:null}})); return;
  }
  if (url.pathname !== '/' && !/^\/[a-z-]+\.(js|css)$/.test(url.pathname)) { res.writeHead(404); res.end(); return; }
  const file = new URL('../../web/public/' + (url.pathname === '/' ? 'index.html' : url.pathname.slice(1)), import.meta.url);
  let source; try { source=await readFile(file,'utf8'); } catch(error) { if(error.code!=='ENOENT') throw error; res.writeHead(404); res.end(); return; }
  if (url.pathname === '/') source=source.replace('src="/app.js"','src="/question-fixture.js"').replace('</body>','<output id="question-result" role="status">Checking option hit areas…</output></body>');
  res.setHeader('Content-Type',url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.css')?'text/css':'text/html;charset=utf-8');res.end(source);
});
server.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+server.address().port));
