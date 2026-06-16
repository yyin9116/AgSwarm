export function normalizeMarkdownContent(value: string): string {
  return transformOutsideFences(value, restoreMarkdownSpacing)
    .replace(/&lt;u&gt;([\s\S]*?)&lt;\/u&gt;/gi, '$1')
    .replace(/<u>([\s\S]*?)<\/u>/gi, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi, (_match, label: string, url: string) => {
      const trimmedLabel = label.trim();
      const trimmedUrl = url.trim();
      return `[${trimmedLabel || trimmedUrl}](${trimmedUrl})`;
    })
    .replace(/\]\((arxiv\.org\/[^)\s]+)\)/gi, '](https://$1)')
    .replace(/\]\((www\.[^)\s]+)\)/gi, '](https://$1)')
    .replace(/```([a-zA-Z][\w+-]*)?<br>([\s\S]*?)```/g, (_match, language: string = '', body: string) => {
      const code = decodeBasicEntities(body).replace(/<br\s*\/?>/gi, '\n').trim();
      return `\`\`\`${language.trim()}\n${code}\n\`\`\``;
    })
    .replace(/`([^`]*<br\s*\/?>[\s\S]*?)`/gi, (_match, body: string) => {
      const normalized = decodeBasicEntities(body)
        .replace(/<br\s*\/?>/gi, '\n')
        .trim();
      const firstLineEnd = normalized.indexOf('\n');
      const language = firstLineEnd > 0 ? normalized.slice(0, firstLineEnd).trim() : '';
      const code = firstLineEnd > 0 ? normalized.slice(firstLineEnd + 1).trim() : normalized;
      if (language && /^[a-zA-Z][\w+-]*$/.test(language) && code) {
        return `\`\`\`${language}\n${code}\n\`\`\``;
      }
      return `\`\`\`text\n${normalized}\n\`\`\``;
    })
    .replace(/(^|[^`])`([a-zA-Z][\w+-]*)\n([\s\S]*?\n)`(?!`)/g, (_match, prefix: string, language: string, code: string) => {
      const normalized = code.trim();
      return normalized ? `${prefix}\`\`\`${language}\n${normalized}\n\`\`\`` : _match;
    })
    .replace(/<br\s*\/?>/gi, '\n');
}

function transformOutsideFences(value: string, transform: (chunk: string) => string): string {
  return value
    .split(/(```[\s\S]*?```)/g)
    .map(part => part.startsWith('```') ? part : transform(part))
    .join('');
}

function restoreMarkdownSpacing(value: string): string {
  return value
    .replace(/([A-Za-z])([\u4e00-\u9fff])/g, '$1 $2')
    .replace(/([\u4e00-\u9fff])([A-Za-z])/g, '$1 $2')
    .replace(/([a-z])([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])(\*\*)/g, '$1 $2')
    .replace(/(\*\*)([A-Za-z])/g, '$1 $2')
    .replace(/([。！？!?：:])(?=[^\s\n*-])/g, '$1\n')
    .replace(/(为什么值得看|核心点|出门建议|气温|体感|降雨|风)([：:])/g, '\n$1$2')
    .replace(/(?<!\n)-(?=[\u4e00-\u9fffA-Za-z])/g, '\n- ')
    .replace(/\n{3,}/g, '\n\n');
}

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
