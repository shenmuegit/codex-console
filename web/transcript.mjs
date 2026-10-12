import MarkdownIt from 'markdown-it';
import { itemText, messageText } from './public/chat.js';

const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });
const escape = markdown.utils.escapeHtml;

export function boundedHistoryItem(item) {
  if (['userMessage', 'agentMessage', 'plan'].includes(item.type)) return structuredClone(item);
  // One tool record can exceed a whole page; bound its preview before cloning or rendering.
  let remaining = 65_536, truncated = false;
  function visit(value, depth = 0) {
    if (remaining <= 0 || depth > 12) {
      truncated = true;
      return Array.isArray(value) ? [] : value && typeof value === 'object' ? {} : typeof value === 'string' ? '…（内容过大，已省略）' : value;
    }
    remaining -= 8;
    if (typeof value === 'string') {
      const text = value.slice(0, Math.max(0, remaining)); remaining -= text.length;
      if (text.length === value.length) return text;
      truncated = true; return text + '…（内容过大，已省略）';
    }
    if (Array.isArray(value)) {
      const result = [];
      for (const child of value) { if (result.length >= 100 || remaining <= 0) { truncated = true; break; } result.push(visit(child, depth + 1)); }
      return result;
    }
    if (value && typeof value === 'object') {
      const result = Object.create(null); let count = 0;
      for (const key in value) if (Object.hasOwn(value, key)) {
        if (++count > 100 || remaining <= 0) { truncated = true; break; }
        const name = key.slice(0, 256); remaining -= name.length; if (name !== key) truncated = true;
        result[name] = visit(value[key], depth + 1);
      }
      return result;
    }
    return value;
  }
  const result = visit(item);
  return { ...result, id: item.id, type: item.type, status: item.status, _incomplete: item._incomplete, ...(truncated ? { _historyTruncated: true } : {}) };
}
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
  return ref?.imageHref ? `<img class="chat-image" loading="lazy" role="button" tabindex="0" aria-haspopup="dialog" aria-label="查看大图 ${escape(tokens[index].content || ref.name)}" src="${escape(ref.imageHref)}" alt="${escape(tokens[index].content || ref.name)}">` : `<span class="muted">${escape(tokens[index].content || '图片')}</span>`;
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
    const text = messageText(item), role = item.type === 'userMessage' ? 'user' : ['agentMessage', 'plan'].includes(item.type) ? 'assistant' : 'tool';
    const label = role === 'user' ? '你' : role === 'assistant' ? 'Codex' : ({ reasoning: '思考', commandExecution: '命令', fileChange: '文件修改', mcpToolCall: '工具调用' }[item.type] ?? item.type);
    return { id: item.id, turnId: turn.id, type: item.type, role, label: label + (item._historyTruncated ? ' · 部分输出' : ''), text, status: item.status ?? turn.status,
      cursor: item._cursor, files: references.get(item.id) ?? [], html: role === 'assistant' ? markdown.render(text, { files: references.get(item.id) }) : `<pre>${escape(text)}</pre>` };
  }));
  return { items, html: items.map(item => `<article data-item-id="${escape(item.id)}"><strong>${escape(item.label)}</strong>${item.html}</article>`).join('') };
}
