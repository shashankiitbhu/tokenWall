import { NormalizedRequest } from '@tokenwall/providers';

export interface InefficiencyItem {
  type: 'lockfile' | 'node_modules' | 'binary' | 'minified' | 'logs' | 'duplicate';
  description: string;
  target: string;
  approximateTokens: number;
  potentialSavingsPercent: number; // e.g. 95 for lockfiles, 50 for logs
}

export interface ContextReport {
  inefficiencies: InefficiencyItem[];
  totalWasteTokens: number;
  cleanMessages: NormalizedRequest['messages'];
}

export class ContextAnalyzer {
  analyze(req: NormalizedRequest): ContextReport {
    const inefficiencies: InefficiencyItem[] = [];
    let totalWasteTokens = 0;
    const cleanMessages = JSON.parse(JSON.stringify(req.messages)) as NormalizedRequest['messages'];

    for (let i = 0; i < cleanMessages.length; i++) {
      const msg = cleanMessages[i];
      let content = msg.content;

      // 1. Lockfiles detection
      const lockfileMatch = content.match(/(?:File|path|Filename|attachment):\s*([a-zA-Z0-9_\-\.\/]*lock\.[a-z]+|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)/gi);
      if (lockfileMatch) {
        for (const match of lockfileMatch) {
          const approxTokens = Math.ceil(content.length / 4); // Lockfile block token size
          inefficiencies.push({
            type: 'lockfile',
            description: `Lockfile detected: '${match}'. Standard lockfiles contribute heavily to token bloat.`,
            target: match,
            approximateTokens: approxTokens,
            potentialSavingsPercent: 95
          });
          totalWasteTokens += Math.ceil(approxTokens * 0.95);
          
          // Optionally strip or replace lockfile with small representation
          content = content.replace(
            /(\`\`\`[a-z]*\s*[\s\S]*?"dependencies"[\s\S]*?\`\`\`)/g,
            '[TokenWall: Truncated Lockfile content. Use package.json for dependencies list]'
          );
        }
      }

      // 2. node_modules or .git paths
      if (content.includes('node_modules/') || content.includes('.git/')) {
        const approxTokens = Math.ceil(content.length / 4);
        inefficiencies.push({
          type: 'node_modules',
          description: `References to 'node_modules' or '.git' files detected.`,
          target: content.includes('node_modules/') ? 'node_modules/' : '.git/',
          approximateTokens: approxTokens,
          potentialSavingsPercent: 99
        });
        totalWasteTokens += Math.ceil(approxTokens * 0.99);
      }

      // 3. Repeated stack traces / large logs
      const traceLines = content.match(/at\s+.*:\d+:\d+/g);
      if (traceLines && traceLines.length > 8) {
        const approxTokens = Math.ceil(content.length / 4);
        inefficiencies.push({
          type: 'logs',
          description: `Oversized stack trace containing ${traceLines.length} repeat references detected.`,
          target: 'stack_trace_repeats',
          approximateTokens: approxTokens,
          potentialSavingsPercent: 60
        });
        totalWasteTokens += Math.ceil(approxTokens * 0.60);

        // Keep only top 3 trace frames, replace rest with message
        const lines = content.split('\n');
        let keptLines = 0;
        const filteredLines = lines.filter((line) => {
          if (line.trim().startsWith('at ')) {
            keptLines++;
            return keptLines <= 3;
          }
          return true;
        });
        if (keptLines > 3) {
          filteredLines.push('... [TokenWall: Truncated remaining stack trace frames]');
        }
        content = filteredLines.join('\n');
      }

      // 4. Binary/Base64 payloads
      const base64Regex = /([A-Za-z0-9+/]{100,})/g;
      const base64Matches = content.match(base64Regex);
      if (base64Matches) {
        const approxTokens = Math.ceil(content.length / 4);
        inefficiencies.push({
          type: 'binary',
          description: `Embedded raw binary/base64 block detected.`,
          target: 'base64_data',
          approximateTokens: approxTokens,
          potentialSavingsPercent: 100
        });
        totalWasteTokens += approxTokens;
        content = content.replace(base64Regex, '[TokenWall: Stripped base64 binary block]');
      }

      msg.content = content;
    }

    return {
      inefficiencies,
      totalWasteTokens,
      cleanMessages
    };
  }
}
