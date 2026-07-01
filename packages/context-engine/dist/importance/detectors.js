"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TieredDetector = exports.StructureDetector = exports.KeywordDetector = void 0;
class KeywordDetector {
    highSignalRegex = /\b(error|exception|fail|failed|failure|panic|fatal|warn|warning|critical)\b/i;
    lowSignalRegex = /\b(debug|info|trace|verbose)\b/i;
    score(line, ctx) {
        // We only rely on keyword detection for unstructured logs or conversational context.
        if (!ctx.isLog && !ctx.isCodeBlock && !ctx.isStructuredData) {
            if (this.highSignalRegex.test(line)) {
                return { score: 0.9, reason: 'High-signal keyword detected' };
            }
            if (this.lowSignalRegex.test(line)) {
                return { score: 0.2, reason: 'Low-signal keyword detected' };
            }
        }
        else if (ctx.isLog) {
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
exports.KeywordDetector = KeywordDetector;
class StructureDetector {
    score(line, ctx) {
        const trimmed = line.trim();
        // Empty lines or purely structural lines (bracket closing) have low semantic importance
        if (trimmed === '' || trimmed === '}' || trimmed === ']' || trimmed === '{' || trimmed === '[') {
            return { score: 0.1, reason: 'Structural/Empty line' };
        }
        return null; // Abstain
    }
}
exports.StructureDetector = StructureDetector;
class TieredDetector {
    detectors;
    constructor(detectors) {
        this.detectors = detectors;
    }
    score(line, ctx) {
        for (const detector of this.detectors) {
            const signal = detector.score(line, ctx);
            if (signal !== null) {
                return signal;
            }
        }
        return { score: 0.5, reason: 'Default fallback' };
    }
}
exports.TieredDetector = TieredDetector;
