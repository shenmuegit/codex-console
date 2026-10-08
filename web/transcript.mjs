import MarkdownIt from 'markdown-it';
import { itemText } from './public/chat.js';

const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });
const escape = markdown.utils.escapeHtml;
markdown.validateLink = value => /^(https?:\/\/|mailto:)/i.test(value);
markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  tokens[index].attrSet('target', '_blank'); tokens[index].attrSet('rel', 'noopener noreferrer');
  return renderer.renderToken(tokens, index, options);
};
markdown.renderer.rules.image = (tokens, index) => `<span class="muted">${escape(tokens[index].content || '图片')}</span>`;

export function renderTranscript(thread, turns) {
  const items = turns.flatMap(turn => (turn.items ?? []).map(item => {
    const text = itemText(item), role = item.type === 'userMessage' ? 'user' : ['agentMessage', 'plan'].includes(item.type) ? 'assistant' : 'tool';
    const label = role === 'user' ? '你' : role === 'assistant' ? 'Codex' : ({ reasoning: '思考', commandExecution: '命令', fileChange: '文件修改', mcpToolCall: '工具调用' }[item.type] ?? item.type);
    return { id: item.id, turnId: turn.id, type: item.type, role, label, text, status: item.status ?? turn.status,
      cursor: item._cursor, html: role === 'assistant' ? markdown.render(text) : `<pre>${escape(text)}</pre>` };
  }));
  return { items, html: items.map(item => `<article data-item-id="${escape(item.id)}"><strong>${escape(item.label)}</strong>${item.html}</article>`).join('') };
}
