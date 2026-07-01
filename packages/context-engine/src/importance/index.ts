export * from './types';
export * from './detectors';

import { ImportanceContext, ImportancePolicy } from './types';
import { KeywordDetector, StructureDetector, TieredDetector } from './detectors';

export class ImportanceEngine {
  private detector: TieredDetector;

  constructor() {
    this.detector = new TieredDetector([
      new KeywordDetector(),
      new StructureDetector()
    ]);
  }

  scoreLine(line: string, ctx: ImportanceContext): number {
    const signal = this.detector.score(line, ctx);
    return signal ? signal.score : 0.5;
  }

  static getThresholdForPolicy(policy?: ImportancePolicy): number {
    switch (policy) {
      case 'aggressive': return 0.5;
      case 'balanced': return 0.3;
      case 'conservative': return 0.15;
      default: return 0.0; // Don't prune by default unless specified
    }
  }

  pruneLogBlock(text: string, policy: ImportancePolicy = 'balanced'): string {
    const threshold = ImportanceEngine.getThresholdForPolicy(policy);
    if (threshold <= 0.0) return text;

    const lines = text.split('\n');
    let prunedCount = 0;
    
    const output = lines.filter(line => {
      const score = this.scoreLine(line, { isLog: true, isCodeBlock: false, isStructuredData: false });
      if (score < threshold) {
        prunedCount++;
        return false;
      }
      return true;
    });

    if (prunedCount > 0) {
      output.push(`\n... [TokenWall: Pruned ${prunedCount} low-importance log lines (Policy: ${policy})]`);
    }

    return output.join('\n');
  }
}
