import { NormalizedRequest } from '@tokenwall/providers';
import { countTokens } from './index';

export interface TokenAttribution {
  sourceCodeTokens: number;
  logsTokens: number;
  toolSchemasTokens: number;
  jsonPayloadsTokens: number;
  systemPromptTokens: number;
  conversationTokens: number;
  totalTokens: number;
}

export class TokenAttributionAnalyzer {
  static analyze(req: NormalizedRequest): TokenAttribution {
    let sourceCodeTokens = 0;
    let logsTokens = 0;
    let toolSchemasTokens = 0;
    let jsonPayloadsTokens = 0;
    let systemPromptTokens = 0;
    let conversationTokens = 0;

    // 1. Tool Schemas
    if (req.toolsSchemaText) {
      toolSchemasTokens += countTokens(req.toolsSchemaText, req.model);
    }

    // 2. Messages
    for (const msg of req.messages) {
      if (msg.role === 'system') {
        systemPromptTokens += countTokens(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content), req.model);
        continue;
      }

      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      let remainingContent = content;

      const extract = (regex: RegExp, categoryFn: (match: string, group1?: string) => void) => {
        remainingContent = remainingContent.replace(regex, (fullMatch, group1) => {
          categoryFn(fullMatch, group1);
          return '';
        });
      };

      // A. Extract JSON blocks
      extract(/```(?:json|jsonl)\s+([\s\S]*?)\s*```/gi, (match) => {
        jsonPayloadsTokens += countTokens(match, req.model);
      });

      // B. Extract XML File blocks (<file_content>)
      extract(/<file_content path="([^"]+)">\n?([\s\S]*?)\n?<\/file_content>/gi, (match, path) => {
        const filePath = (path || '').toLowerCase();
        const tokens = countTokens(match, req.model);
        if (filePath.endsWith('.log')) logsTokens += tokens;
        else if (filePath.endsWith('.json') || filePath.includes('lock')) jsonPayloadsTokens += tokens;
        else sourceCodeTokens += tokens;
      });

      // C. Extract Markdown File blocks (File: foo.ts)
      extract(/(?:File|Path|Filename):\s*([/\\]?[^\s"']+)\n([\s\S]*?)(?=\n(?:File|Path|Filename):|$)/gi, (match, path) => {
        const filePath = (path || '').toLowerCase();
        const tokens = countTokens(match, req.model);
        if (filePath.endsWith('.log')) logsTokens += tokens;
        else if (filePath.endsWith('.json') || filePath.includes('lock')) jsonPayloadsTokens += tokens;
        else sourceCodeTokens += tokens;
      });

      // D. Extract remaining Code blocks (Markdown)
      extract(/```(?:javascript|typescript|js|ts|python|py|rust|rs|go|golang|cpp|c\+\+|java|c|shell|sh|bash)\s+([\s\S]*?)\s*```/gi, (match) => {
        sourceCodeTokens += countTokens(match, req.model);
      });

      // E. Extract Logs (Stack traces or Error dumps)
      extract(/(?:.*?(?:Error|Exception|Failed).*?\n)?(?:(?:\s+at\s+.*?\n)+)/gi, (match) => {
         logsTokens += countTokens(match, req.model);
      });

      // F. Conversation is what's left
      if (remainingContent.trim().length > 0) {
        conversationTokens += countTokens(remainingContent, req.model);
      }
    }

    const totalTokens = sourceCodeTokens + logsTokens + toolSchemasTokens + jsonPayloadsTokens + systemPromptTokens + conversationTokens;

    return {
      sourceCodeTokens,
      logsTokens,
      toolSchemasTokens,
      jsonPayloadsTokens,
      systemPromptTokens,
      conversationTokens,
      totalTokens
    };
  }
}
