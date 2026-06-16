import { marked } from 'marked';
import { normalizeMarkdownContent } from './markdownNormalize';

const markdownRenderer = new marked.Renderer();

markdownRenderer.html = (html) => escapeHtml(html);

export function renderPiMarkdown(value: string): string {
  const rendered = marked.parse(normalizeMarkdownContent(value), {
    async: false,
    breaks: true,
    gfm: true,
    renderer: markdownRenderer,
  });
  return sanitizeMarkdownHtml(typeof rendered === 'string' ? rendered : '');
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
