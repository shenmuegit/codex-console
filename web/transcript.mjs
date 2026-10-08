import MarkdownIt from 'markdown-it';
import { itemText } from './public/chat.js';

const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });
const escape = markdown.utils.escapeHtml;
markdown.validateLink = value => !/^(javascript:|vbscript:|data:)/i.test(value);
markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  const href = tokens[index].attrGet('href'), ref = env.files?.find(file => file.target === href);
  env.links ??= [];
  if (/^thread:\/\/[A-Za-z0-9_-]{1,64}$/.test(href)) { env.links.push(true); tokens[index].attrSet('href', '/?thread=' + encodeURIComponent(href.slice(9))); return renderer.renderToken(tokens, index, options); }
  if (!/^(https?:\/\/|mailto:)/i.test(href)) {
    env.links.push(Boolean(ref));
    if (!ref) return '<span>';
    tokens[index].attrSet('href', ref.href); return renderer.renderToken(tokens, index, options);
  }
  env.links.push(true);
  tokens[index].attrSet('target', '_blank'); tokens[index].attrSet('rel', 'noopener noreferrer');
  return renderer.renderToken(tokens, index, options);
};
markdown.renderer.rules.link_close = (tokens, index, options, env) => env.links?.pop() ? '</a>' : '</span>';
markdown.renderer.rules.image = (tokens, index, options, env) => {
  const ref = env.files?.find(file => file.target === tokens[index].attrGet('src'));
  return ref?.imageHref ? `<img class="chat-image" loading="lazy" src="${escape(ref.imageHref)}" alt="${escape(tokens[index].content || ref.name)}">` : `<span class="muted">${escape(tokens[index].content || '图片')}</span>`;
};

export function collectTargets(item) {
  const targets = [];
  for (const token of markdown.parse(itemText(item), {})) for (const child of token.children ?? []) {
    if (child.type === 'link_open' || child.type === 'image') {
      const target = child.attrGet(child.type === 'image' ? 'src' : 'href');
      if (!/^(https?:\/\/|mailto:|thread:|app:|plugin:)/i.test(target)) targets.push({ target, encoded: true });
    }
  }
  for (const change of item.changes ?? []) if (typeof change.path === 'string') targets.push({ target: change.path, encoded: false });
  for (const part of item.result?.content ?? []) if (typeof part.uri === 'string' && /^(file:|sandbox:|\/)/.test(part.uri)) targets.push({ target: part.uri, encoded: true });
  return targets;
}

export function renderTranscript(thread, turns, references = new Map()) {
  const items = turns.flatMap(turn => (turn.items ?? []).map(item => {
    const text = itemText(item), role = item.type === 'userMessage' ? 'user' : ['agentMessage', 'plan'].includes(item.type) ? 'assistant' : 'tool';
    const label = role === 'user' ? '你' : role === 'assistant' ? 'Codex' : ({ reasoning: '思考', commandExecution: '命令', fileChange: '文件修改', mcpToolCall: '工具调用' }[item.type] ?? item.type);
    return { id: item.id, turnId: turn.id, type: item.type, role, label, text, status: item.status ?? turn.status,
      cursor: item._cursor, files: references.get(item.id) ?? [], html: role === 'assistant' ? markdown.render(text, { files: references.get(item.id) }) : `<pre>${escape(text)}</pre>` };
  }));
  return { items, html: items.map(item => `<article data-item-id="${escape(item.id)}"><strong>${escape(item.label)}</strong>${item.html}</article>`).join('') };
}
