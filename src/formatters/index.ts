import type { Format } from '../schemas/common';

type LlmResponse = { briefing: string; content_type: string };

export function formatResponse<T>(
  data: T,
  format: Format,
  formatter: (d: T) => string,
): T | LlmResponse | (T & { llm_summary: string }) {
  switch (format) {
    case 'json':
      return data;
    case 'llm':
      return { briefing: formatter(data), content_type: 'text/markdown' };
    case 'both':
      return { ...data, llm_summary: formatter(data) };
  }
}
