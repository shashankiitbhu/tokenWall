"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolPayloadCrusher = exports.ToolSchemaOptimizer = exports.ToolRouter = void 0;
const estimators_1 = require("@tokenwall/estimators");
// --- Tool Router ---
class ToolRouter {
    /**
     * Drops irrelevant tools if the number of tools exceeds a threshold (e.g. 15).
     * It uses lightweight keyword matching against the user's prompt.
     */
    static route(tools, messages) {
        if (!tools || tools.length < 15)
            return tools;
        // Extract recent user context
        const recentContext = messages
            .filter(m => m.role === 'user' || m.role === 'system')
            .slice(-3)
            .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
            .join(' ')
            .toLowerCase();
        return tools.filter(tool => {
            // Always keep very common/fundamental tools that might be implied
            const name = tool.function?.name || tool.name || '';
            if (['search', 'read', 'write', 'execute', 'bash', 'run'].some(k => name.toLowerCase().includes(k))) {
                return true;
            }
            // Keep if the tool name or core keywords appear in the context
            const toolKeywords = name.toLowerCase().split(/[_.-]/);
            return toolKeywords.some((kw) => kw.length > 3 && recentContext.includes(kw));
        });
    }
}
exports.ToolRouter = ToolRouter;
// --- Tool Schema Optimizer ---
class ToolSchemaOptimizer {
    /**
     * Cleans up tautological zero-information descriptions
     */
    static isTautological(name, description) {
        if (!description || !name)
            return false;
        const desc = description.toLowerCase().replace(/[^a-z0-9]/g, '');
        const nm = name.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (desc === nm || desc === `the${nm}`)
            return true;
        return false;
    }
    /**
     * Truncates description to first sentence, preserving constraints.
     */
    static truncateDescription(desc, aggressive) {
        if (!desc)
            return desc;
        // Don't truncate if it has obvious constraint keywords
        if (/must|never|always|only|required|cannot|do not/i.test(desc)) {
            return desc;
        }
        if (aggressive) {
            // Aggressive: keep first sentence
            const match = desc.match(/^.*?[.!?](?:\s|$)/);
            if (match)
                return match[0].trim();
        }
        return desc;
    }
    static optimizeSchemaNode(node, aggressive = false) {
        if (!node || typeof node !== 'object')
            return;
        if (node.properties) {
            for (const [key, prop] of Object.entries(node.properties)) {
                if (prop.description) {
                    if (this.isTautological(key, prop.description)) {
                        delete prop.description;
                    }
                    else {
                        prop.description = this.truncateDescription(prop.description, aggressive);
                    }
                }
                this.optimizeSchemaNode(prop, aggressive);
            }
        }
        if (node.items) {
            this.optimizeSchemaNode(node.items, aggressive);
        }
    }
    static optimize(tools, aggressive = false) {
        if (!tools || !Array.isArray(tools))
            return tools;
        const newTools = JSON.parse(JSON.stringify(tools));
        for (const tool of newTools) {
            // Find the function definition based on schema type
            const func = tool.function || tool;
            if (func.description) {
                func.description = this.truncateDescription(func.description, aggressive);
            }
            if (func.parameters) {
                this.optimizeSchemaNode(func.parameters, aggressive);
            }
            else if (func.input_schema) { // Anthropic format
                this.optimizeSchemaNode(func.input_schema, aggressive);
            }
        }
        return newTools;
    }
}
exports.ToolSchemaOptimizer = ToolSchemaOptimizer;
// --- Tool Payload Crusher ---
class ToolPayloadCrusher {
    /**
     * Detects if an array is homogeneous (objects with identical keys and primitive values)
     */
    static isHomogeneous(arr) {
        if (arr.length < 5)
            return false;
        const keySets = arr.slice(0, Math.min(arr.length, 10)).map(item => {
            if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
                // If any value is a nested object/array, we cannot easily CSV it
                if (Object.values(item).some(v => typeof v === 'object' && v !== null)) {
                    return 'NESTED';
                }
                return Object.keys(item).sort().join(',');
            }
            return 'PRIMITIVE';
        });
        const firstKeys = keySets[0];
        if (firstKeys === 'NESTED' || firstKeys === 'PRIMITIVE')
            return false;
        return keySets.every(keys => keys === firstKeys);
    }
    static convertToCSV(arr) {
        const keys = Object.keys(arr[0]).sort();
        const rows = [keys.join(',')];
        for (const item of arr) {
            const row = keys.map(k => {
                let val = item[k];
                if (val === null || val === undefined)
                    val = '';
                const valStr = String(val);
                if (valStr.includes(',') || valStr.includes('"') || valStr.includes('\n')) {
                    return `"${valStr.replace(/"/g, '""')}"`;
                }
                return valStr;
            });
            rows.push(row.join(','));
        }
        return rows.join('\n');
    }
    static crushArray(arr, maxItems, maxTokens, model) {
        if (arr.length <= maxItems) {
            const tokenCount = (0, estimators_1.countTokens)(JSON.stringify(arr), model);
            if (tokenCount <= maxTokens)
                return arr;
        }
        if (this.isHomogeneous(arr)) {
            const csvStr = this.convertToCSV(arr);
            return [`[TokenWall: SQL/Array converted to CSV for context optimization]`, csvStr];
        }
        // Try keeping head and tail
        const keepCount = Math.min(arr.length, maxItems);
        const headCount = Math.floor(keepCount / 2);
        const tailCount = keepCount - headCount;
        const head = arr.slice(0, headCount);
        const tail = arr.slice(arr.length - tailCount);
        const truncatedCount = arr.length - keepCount;
        const metadataNode = `... [TokenWall: ${truncatedCount} items truncated for context optimization] ...`;
        const candidate = [...head, metadataNode, ...tail];
        const candidateTokens = (0, estimators_1.countTokens)(JSON.stringify(candidate), model);
        if (candidateTokens <= maxTokens) {
            return candidate;
        }
        // If still too large token-wise, fall back to pure head extraction to satisfy token constraints
        let currentTokens = (0, estimators_1.countTokens)(JSON.stringify([metadataNode]), model);
        const aggressiveHead = [];
        for (const item of arr) {
            const itemTokens = (0, estimators_1.countTokens)(JSON.stringify(item), model);
            if (currentTokens + itemTokens > maxTokens)
                break;
            aggressiveHead.push(item);
            currentTokens += itemTokens;
        }
        return [...aggressiveHead, metadataNode];
    }
    static optimizeToolResult(content, model) {
        try {
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed) && parsed.length > 5) {
                const crushed = this.crushArray(parsed, 50, 1500, model);
                return JSON.stringify(crushed);
            }
            else if (typeof parsed === 'object' && parsed !== null) {
                // Find massive arrays inside the object
                let mutated = false;
                for (const [key, val] of Object.entries(parsed)) {
                    if (Array.isArray(val) && val.length > 5) {
                        parsed[key] = this.crushArray(val, 50, 1500, model);
                        mutated = true;
                    }
                }
                if (mutated)
                    return JSON.stringify(parsed);
            }
        }
        catch (e) {
            // Not JSON, return as is
        }
        return content;
    }
}
exports.ToolPayloadCrusher = ToolPayloadCrusher;
