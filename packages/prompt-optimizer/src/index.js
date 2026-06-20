"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PromptOptimizer = void 0;
const estimators_1 = require("@tokenwall/estimators");
const CONVERSATIONAL_FILLERS = [
    { pattern: /could you please go ahead and/gi, replacement: '' },
    { pattern: /please take a look at/gi, replacement: 'check' },
    { pattern: /can you write a highly detailed, clean, and production-grade/gi, replacement: 'write' },
    { pattern: /write a very clean and thoroughly documented function that/gi, replacement: 'write function to' },
    { pattern: /i want you to analyze the codebase and tell me/gi, replacement: 'analyze' },
    { pattern: /please make sure to write tests and handle error cases/gi, replacement: 'include tests and error handling' },
    { pattern: /please edit this file and change/gi, replacement: 'edit file to' },
    { pattern: /here is the content of the file/gi, replacement: 'file content' },
    { pattern: /please explain how this works/gi, replacement: 'explain' },
    { pattern: /thank you so much/gi, replacement: '' },
    { pattern: /kindly help me with/gi, replacement: 'resolve' }
];
class PromptOptimizer {
    optimize(prompt, model) {
        const originalTokens = (0, estimators_1.countTokens)(prompt, model);
        let optimized = prompt;
        // Apply filler regexes
        for (const item of CONVERSATIONAL_FILLERS) {
            optimized = optimized.replace(item.pattern, item.replacement);
        }
        // Clean up double spaces or trailing newlines left over from replacements
        optimized = optimized.replace(/\s\s+/g, ' ').trim();
        const optimizedTokens = (0, estimators_1.countTokens)(optimized, model);
        const tokensSaved = Math.max(0, originalTokens - optimizedTokens);
        const savingsPercent = originalTokens > 0 ? Math.round((tokensSaved / originalTokens) * 100) : 0;
        return {
            originalText: prompt,
            optimizedText: optimized,
            tokensSaved,
            savingsPercent
        };
    }
}
exports.PromptOptimizer = PromptOptimizer;
