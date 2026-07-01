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
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.CacheAlignerPipeline = exports.PromptFingerprintPlugin = exports.VolatileRelocationPlugin = exports.ToolSchemaSortPlugin = exports.DeterministicJsonPlugin = exports.WhitespaceNormalizationPlugin = void 0;
const crypto = __importStar(require("crypto"));
class WhitespaceNormalizationPlugin {
    name = 'WhitespaceNormalizationPlugin';
    apply(context, options) {
        // We want to normalize whitespace outside of code blocks and JSON.
        // A simple approach is to find ``` blocks, temporarily replace them, normalize the rest, and restore them.
        const codeBlocks = [];
        let tempText = context.prompt.replace(/```[\s\S]*?```/g, match => {
            codeBlocks.push(match);
            return `__TOKENWALL_CODEBLOCK_${codeBlocks.length - 1}__`;
        });
        // Normalize whitespace
        tempText = tempText
            .split(/\r?\n/)
            .map(line => line.replace(/[ \t]+/g, ' ').trim())
            .filter((line, i, arr) => {
            if (line === '') {
                return i > 0 && arr[i - 1].trim() !== '';
            }
            return true;
        })
            .join('\n')
            .trim();
        // Restore code blocks
        let finalPrompt = tempText.replace(/__TOKENWALL_CODEBLOCK_(\d+)__/g, (match, index) => {
            return codeBlocks[parseInt(index, 10)];
        });
        context.prompt = finalPrompt;
        return context;
    }
}
exports.WhitespaceNormalizationPlugin = WhitespaceNormalizationPlugin;
class DeterministicJsonPlugin {
    name = 'DeterministicJsonPlugin';
    apply(context, options) {
        const jsonRegex = /```json\s*([\s\S]*?)\s*```/ig;
        let finalPrompt = context.prompt.replace(jsonRegex, (match, jsonString) => {
            try {
                const parsed = JSON.parse(jsonString);
                const sortKeys = (obj) => {
                    if (Array.isArray(obj)) {
                        return obj.map(sortKeys);
                    }
                    else if (obj !== null && typeof obj === 'object') {
                        const sortedObj = {};
                        Object.keys(obj).sort().forEach(key => {
                            sortedObj[key] = sortKeys(obj[key]);
                        });
                        return sortedObj;
                    }
                    return obj;
                };
                return `\`\`\`json\n${JSON.stringify(sortKeys(parsed), null, 2)}\n\`\`\``;
            }
            catch (e) {
                return match; // If it's invalid JSON, leave it alone
            }
        });
        context.prompt = finalPrompt;
        return context;
    }
}
exports.DeterministicJsonPlugin = DeterministicJsonPlugin;
class ToolSchemaSortPlugin {
    name = 'ToolSchemaSortPlugin';
    apply(context, options) {
        // This plugin doesn't touch the prompt directly.
        // It provides a static method to sort the tools array elsewhere.
        return context;
    }
    static sortTools(tools) {
        if (!tools || !Array.isArray(tools))
            return tools;
        const sortObjectKeys = (obj) => {
            if (Array.isArray(obj))
                return obj.map(sortObjectKeys);
            if (obj !== null && typeof obj === 'object') {
                const sorted = {};
                Object.keys(obj).sort().forEach(k => {
                    sorted[k] = sortObjectKeys(obj[k]);
                });
                return sorted;
            }
            return obj;
        };
        const sortedTools = tools.map(sortObjectKeys);
        // Sort the tool array by tool name
        sortedTools.sort((a, b) => {
            const nameA = a.function?.name || a.name || '';
            const nameB = b.function?.name || b.name || '';
            return nameA.localeCompare(nameB);
        });
        return sortedTools;
    }
}
exports.ToolSchemaSortPlugin = ToolSchemaSortPlugin;
class VolatileRelocationPlugin {
    name = 'VolatileRelocationPlugin';
    apply(context, options) {
        const isAggressive = options?.aggressiveCacheOptimization === true;
        const uuidRegex = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
        const iso8601Regex = /\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;
        const jwtRegex = /\b[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g;
        let totalVolatileTokens = 0;
        const relocatedValues = [];
        const relocate = (match, type) => {
            totalVolatileTokens += Math.ceil(match.length / 4); // rough approximation
            context.findings.push({ type, value: match });
            if (isAggressive) {
                relocatedValues.push(match);
                return `{{VOLATILE_${relocatedValues.length}}}`;
            }
            return match;
        };
        let p = context.prompt;
        p = p.replace(uuidRegex, (m) => relocate(m, 'uuid'));
        p = p.replace(iso8601Regex, (m) => relocate(m, 'iso8601'));
        // JWT has a high chance of false positive on filenames, so we do a quick length check
        p = p.replace(jwtRegex, (m) => {
            const parts = m.split('.');
            if (parts[0].length >= 4 && parts[1].length >= 4 && parts[2].length >= 4) {
                return relocate(m, 'jwt');
            }
            return m;
        });
        if (totalVolatileTokens > 0) {
            // Base score is 100. Lower it based on volatility.
            context.cacheabilityScore = Math.max(0, context.cacheabilityScore - (totalVolatileTokens * 2));
        }
        if (isAggressive && relocatedValues.length > 0) {
            // Append the map to the end
            p += '\n\n[TokenWall Relocated Variables]\n' + relocatedValues.map((v, i) => `{{VOLATILE_${i + 1}}}: ${v}`).join('\n');
        }
        context.prompt = p;
        return context;
    }
}
exports.VolatileRelocationPlugin = VolatileRelocationPlugin;
class PromptFingerprintPlugin {
    name = 'PromptFingerprintPlugin';
    apply(context, options) {
        const hash = crypto.createHash('sha256').update(context.prompt).digest('hex');
        context.findings.push({ type: 'fingerprint', value: hash });
        return context;
    }
}
exports.PromptFingerprintPlugin = PromptFingerprintPlugin;
class CacheAlignerPipeline {
    plugins = [];
    constructor() {
        this.plugins.push(new WhitespaceNormalizationPlugin());
        this.plugins.push(new DeterministicJsonPlugin());
        this.plugins.push(new ToolSchemaSortPlugin());
        this.plugins.push(new VolatileRelocationPlugin());
        this.plugins.push(new PromptFingerprintPlugin());
    }
    align(prompt, role, isSystem, options) {
        let context = {
            prompt,
            role,
            isSystem,
            findings: [],
            cacheabilityScore: 100
        };
        for (const plugin of this.plugins) {
            context = plugin.apply(context, options);
        }
        return context;
    }
}
exports.CacheAlignerPipeline = CacheAlignerPipeline;
