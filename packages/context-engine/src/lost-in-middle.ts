import { countTokens } from '@tokenwall/estimators';

export interface MitigationContext {
  currentTurnText: string;
  fileShadowState: Map<string, { content: string; hops: number }>;
  model: string;
}

interface FileBlock {
  startIndex: number;
  endIndex: number;
  matchText: string;
  filePath: string;
  fileContent: string;
  type: 'md' | 'xml';
}

export class LostInMiddleMitigator {
  private static mdRegex = /(?:File|Path|Filename):\s*([/\\]?[^\s"']+)\n(?:```[a-zA-Z0-9_-]*\n)?([\s\S]*?)(?:\n```|$)/gi;
  private static xmlRegex = /<file_content[^>]*path="([^"]+)"[^>]*>\n?([\s\S]*?)\n?<\/file_content>/gi;
  private static diagnosticRegex = /Exception|Error|Traceback|at\s+.*:\d+:\d+/i;

  public static reorder(content: string, context: MitigationContext): string {
    const blocks: FileBlock[] = [];
    let match;

    // Reset regexes
    this.mdRegex.lastIndex = 0;
    this.xmlRegex.lastIndex = 0;

    // Find Markdown blocks
    while ((match = this.mdRegex.exec(content)) !== null) {
      blocks.push({
        startIndex: match.index,
        endIndex: match.index + match[0].length,
        matchText: match[0],
        filePath: match[1],
        fileContent: match[2],
        type: 'md'
      });
    }

    // Find XML blocks
    while ((match = this.xmlRegex.exec(content)) !== null) {
      blocks.push({
        startIndex: match.index,
        endIndex: match.index + match[0].length,
        matchText: match[0],
        filePath: match[1],
        fileContent: match[2],
        type: 'xml'
      });
    }

    if (blocks.length < 3) return content;

    // Sort blocks by order of appearance
    blocks.sort((a, b) => a.startIndex - b.startIndex);

    // Group into contiguous sequences
    const sequences: FileBlock[][] = [];
    let currentSequence: FileBlock[] = [blocks[0]];

    for (let i = 1; i < blocks.length; i++) {
      const prev = blocks[i - 1];
      const curr = blocks[i];
      
      // Check if they are contiguous (ignoring whitespace)
      const gap = content.substring(prev.endIndex, curr.startIndex);
      if (gap.trim() === '') {
        currentSequence.push(curr);
      } else {
        sequences.push(currentSequence);
        currentSequence = [curr];
      }
    }
    sequences.push(currentSequence);

    let result = content;
    // Process sequences from end to start to avoid index shifting issues during string replacement
    for (let i = sequences.length - 1; i >= 0; i--) {
      const seq = sequences[i];
      if (seq.length < 3) continue;

      const scoredBlocks = seq.map(block => ({
        block,
        score: this.scoreBlock(block, context)
      }));

      // Sort descending by score
      scoredBlocks.sort((a, b) => b.score - a.score);

      // U-Shaped placement
      const uShape = new Array(seq.length);
      let left = 0;
      let right = seq.length - 1;
      
      for (let j = 0; j < seq.length; j++) {
        if (j % 2 === 0) {
          uShape[left] = scoredBlocks[j].block.matchText;
          left++;
        } else {
          uShape[right] = scoredBlocks[j].block.matchText;
          right--;
        }
      }

      // Replace in the original string
      const start = seq[0].startIndex;
      const end = seq[seq.length - 1].endIndex;
      // Re-join with a generic double newline or just the exact whitespace between them?
      // Since they were contiguous (only whitespace between), joining with standard double newline is safe and clean.
      const reorderedString = uShape.join('\n\n');
      
      result = result.substring(0, start) + reorderedString + result.substring(end);
    }

    return result;
  }

  private static scoreBlock(block: FileBlock, context: MitigationContext): number {
    let score = 0;

    // 1. Explicit mention in current turn (+50)
    // Extract base name for looser matching
    const baseName = block.filePath.split(/[/\\]/).pop() || block.filePath;
    if (context.currentTurnText.includes(block.filePath) || context.currentTurnText.includes(baseName)) {
      score += 50;
    }

    // 2. Recency of edit (+20 max)
    const state = context.fileShadowState.get(block.filePath);
    if (state) {
      const hops = state.hops;
      // Closer to 0 hops = more recent. +20 for 0 hops, +0 for >=10 hops
      const recencyScore = Math.max(0, (10 - Math.min(hops, 10)) * 2);
      score += recencyScore;
    }

    // 3. Error/Diagnostic content (+40)
    if (this.diagnosticRegex.test(block.fileContent)) {
      score += 40;
    }

    // 4. Size penalty (-X)
    const approxTokens = countTokens(block.matchText, context.model);
    const sizePenalty = (approxTokens / 1000) * 2;
    score -= sizePenalty;

    return score;
  }
}
