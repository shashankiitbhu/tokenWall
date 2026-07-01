"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ImportanceEngine = void 0;
__exportStar(require("./types"), exports);
__exportStar(require("./detectors"), exports);
const detectors_1 = require("./detectors");
class ImportanceEngine {
    detector;
    constructor() {
        this.detector = new detectors_1.TieredDetector([
            new detectors_1.KeywordDetector(),
            new detectors_1.StructureDetector()
        ]);
    }
    scoreLine(line, ctx) {
        const signal = this.detector.score(line, ctx);
        return signal ? signal.score : 0.5;
    }
    static getThresholdForPolicy(policy) {
        switch (policy) {
            case 'aggressive': return 0.5;
            case 'balanced': return 0.3;
            case 'conservative': return 0.15;
            default: return 0.0; // Don't prune by default unless specified
        }
    }
    pruneLogBlock(text, policy = 'balanced') {
        const threshold = ImportanceEngine.getThresholdForPolicy(policy);
        if (threshold <= 0.0)
            return text;
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
exports.ImportanceEngine = ImportanceEngine;
