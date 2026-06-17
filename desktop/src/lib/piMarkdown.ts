import { marked } from 'marked';

const markdownRenderer = new marked.Renderer();
const MAX_CACHE_SIZE = 300;
const markdownCache = new Map<string, string>();

markdownRenderer.html = (html) => escapeHtml(String(html));

export function renderPiMarkdown(value: string): string {
  const cached = markdownCache.get(value);
  if (cached !== undefined) return cached;

  const rendered = marked.parse(value, {
    async: false,
    breaks: true,
    gfm: true,
    renderer: markdownRenderer,
  });
  const html = sanitizeMarkdownHtml(typeof rendered === 'string' ? rendered : '');
  markdownCache.set(value, html);
  if (markdownCache.size > MAX_CACHE_SIZE) {
    const oldestKey = markdownCache.keys().next().value;
    if (oldestKey !== undefined) markdownCache.delete(oldestKey);
  }
  return html;
}

function sanitizeMarkdownHtml(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  template.content.querySelectorAll('script, style, iframe, object, embed').forEach(element => element.remove());
  template.content.querySelectorAll('*').forEach(element => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on')) {
        element.removeAttribute(attribute.name);
      }
      if ((name === 'href' || name === 'src') && !isSafeUrl(attribute.value)) {
        element.removeAttribute(attribute.name);
      }
    }
    if (element.tagName === 'A') {
      element.setAttribute('target', '_blank');
      element.setAttribute('rel', 'noreferrer noopener');
    }
  });
  return template.innerHTML;
}

function isSafeUrl(value: string): boolean {
  if (value.startsWith('#') || value.startsWith('/')) return true;
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
