export function collapseRepeatedText(value: string): string {
  let text = value.trim();
  if (!text) return '';

  let previous = '';
  while (text && text !== previous) {
    previous = text;
    text = collapseWholeRepeat(text);
    text = collapseRepeatedParagraphs(text);
    text = collapseRepeatedSentences(text);
    text = collapseRepeatedSegments(text);
  }
  return text.trim();
}

function collapseWholeRepeat(value: string): string {
  const text = value.trim();
  for (let parts = 6; parts >= 2; parts -= 1) {
    if (text.length % parts !== 0) continue;
    const size = text.length / parts;
    const chunk = text.slice(0, size);
    if (chunk.trim().length >= 4 && chunk.repeat(parts) === text) {
      return chunk.trim();
    }
  }
  return text;
}

function collapseRepeatedParagraphs(value: string): string {
  const paragraphs = value.split(/\n{2,}/).map(part => part.trim()).filter(Boolean);
  if (paragraphs.length < 2) return value;

  const deduped: string[] = [];
  for (const paragraph of paragraphs) {
    if (deduped.at(-1) !== paragraph) deduped.push(paragraph);
  }
  return deduped.join('\n\n');
}

function collapseRepeatedSentences(value: string): string {
  const parts = value.match(/[^。！？!?]+[。！？!?]?|\s+/g);
  if (!parts || parts.length < 2) return value;

  const result: string[] = [];
  for (const part of parts) {
    if (!part.trim()) {
      result.push(part);
      continue;
    }
    const normalized = normalizeForRepeat(part);
    const previous = result.length ? normalizeForRepeat(result[result.length - 1]) : '';
    if (normalized && normalized === previous) continue;
    result.push(part);
  }
  return result.join('').trim();
}

function collapseRepeatedSegments(value: string): string {
  const segments = value
    .split(/(?<=[。！？!?])\s*|\n+/)
    .map(part => part.trim())
    .filter(Boolean);
  if (segments.length < 4) return value;

  for (let size = Math.floor(segments.length / 2); size >= 2; size -= 1) {
    const tail = segments.slice(-size);
    const beforeTail = segments.slice(-size * 2, -size);
    if (beforeTail.length === size && sameSegments(beforeTail, tail)) {
      return segments.slice(0, -size).join('\n');
    }
  }
  return value;
}

function sameSegments(left: string[], right: string[]): boolean {
  return left.every((segment, index) => normalizeForRepeat(segment) === normalizeForRepeat(right[index] || ''));
}

export function normalizeForRepeat(value: string): string {
  return value
    .replace(/\s+/g, '')
    .replace(/[，,、；;：:]+$/g, '')
    .trim();
}
