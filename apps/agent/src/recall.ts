import { AgentSearchProvider } from 'agents/context';
import { recallKeywords } from './keywords.ts';

/**
 * Searching earlier conversations.
 *
 * Built on the Agents SDK's AgentSearchProvider (SQLite full-text search in the
 * instance's own storage). Its search needs EVERY word of the query to appear
 * in one entry, and the model asks in sentences ('which supplier did I mention
 * before the fresh chat'), so nothing matched (found 2026-09-15). This searches
 * each meaningful word on its own and ranks conversations by how many they hit.
 */
export class RecallSearchProvider extends AgentSearchProvider {
  async search(query: string): Promise<string | null> {
    const keywords = recallKeywords(query);
    if (keywords.length === 0) return super.search(query);
    const hits = new Map<string, { content: string; score: number }>();
    for (const word of keywords) {
      const found = await super.search(word);
      if (!found) continue;
      for (const block of found.split(/\n\n(?=\[exchange-)/)) {
        const match = block.match(/^\[([^\]]+)\]\n([\s\S]*)$/);
        if (!match) continue;
        const entry = hits.get(match[1]) ?? { content: match[2], score: 0 };
        entry.score += 1;
        hits.set(match[1], entry);
      }
    }
    if (hits.size === 0) return null;
    return [...hits.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, 6)
      .map(([key, entry]) => `[${key}]\n${entry.content}`)
      .join('\n\n');
  }
}
