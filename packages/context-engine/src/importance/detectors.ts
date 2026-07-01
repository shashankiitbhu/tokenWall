import { ImportanceDetector, ImportanceSignal, ImportanceContext } from './types';

export class KeywordDetector implements ImportanceDetector {
  private highSignalRegex = /\b(error|exception|fail|failed|failure|panic|fatal|warn|warning|critical)\b/i;
  private lowSignalRegex = /\b(debug|info|trace|verbose)\b/i;

  score(line: string, ctx: ImportanceContext): ImportanceSignal | null {
    // We only rely on keyword detection for unstructured logs or conversational context.
    if (!ctx.isLog && !ctx.isCodeBlock && !ctx.isStructuredData) {
      if (this.highSignalRegex.test(line)) {
        return { score: 0.9, reason: 'High-signal keyword detected' };
      }
      if (this.lowSignalRegex.test(line)) {
        return { score: 0.2, reason: 'Low-signal keyword detected' };
      }
    } else if (ctx.isLog) {
      if (this.highSignalRegex.test(line)) {
        return { score: 0.95, reason: 'Error trace in log' };
      }
      if (this.lowSignalRegex.test(line)) {
        return { score: 0.1, reason: 'Debug/Info trace in log' };
      }
    }
    return null; // Abstain
  }
}

export class StructureDetector implements ImportanceDetector {
  score(line: string, ctx: ImportanceContext): ImportanceSignal | null {
    const trimmed = line.trim();
    // Empty lines or purely structural lines (bracket closing) have low semantic importance
    if (trimmed === '' || trimmed === '}' || trimmed === ']' || trimmed === '{' || trimmed === '[') {
      return { score: 0.1, reason: 'Structural/Empty line' };
    }
    return null; // Abstain
  }
}

export class TieredDetector implements ImportanceDetector {
  constructor(private detectors: ImportanceDetector[]) {}

  score(line: string, ctx: ImportanceContext): ImportanceSignal | null {
    for (const detector of this.detectors) {
      const signal = detector.score(line, ctx);
      if (signal !== null) {
        return signal;
      }
    }
    return { score: 0.5, reason: 'Default fallback' };
  }
}
