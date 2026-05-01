export interface ParsedPromptGroup {
  index: number;
  order?: number; // user-supplied order number parsed from a leading "N\n" header line
  prompt: string;
}

export function parsePromptGroups(input: string): ParsedPromptGroup[] {
  const normalized = input.replace(/\r\n/g, '\n').trim();

  if (!normalized) {
    return [];
  }

  return normalized
    .split(/\n\s*\n+/)
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw, index) => {
      // Detect a leading bare integer header line: "1\nPrompt text..." or "42\ntext"
      const headerMatch = raw.match(/^(\d+)\n([\s\S]+)$/);
      if (headerMatch) {
        const order = parseInt(headerMatch[1], 10);
        const prompt = headerMatch[2].trim();
        return { index, order, prompt };
      }
      return { index, prompt: raw };
    });
}