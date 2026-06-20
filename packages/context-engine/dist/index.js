"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContextAnalyzer = exports.CacheAligner = exports.CodeCompressor = exports.JsonCrusher = void 0;
const estimators_1 = require("@tokenwall/estimators");
let _magikaInstance = null;
async function getMagika() {
    if (!_magikaInstance) {
        try {
            const magikaModule = require('magika/node');
            const Magika = magikaModule.MagikaNode || magikaModule.Magika;
            if (Magika && typeof Magika.create === 'function') {
                _magikaInstance = await Magika.create();
            }
            else if (Magika) {
                const inst = new Magika();
                if (typeof inst.load === 'function')
                    await inst.load();
                _magikaInstance = inst;
            }
        }
        catch (e) {
            // console.warn('[TokenWall] Magika not available. Falling back to heuristic detection.');
        }
    }
    return _magikaInstance;
}
class JsonCrusher {
    static crush(jsonStr) {
        try {
            const parsed = JSON.parse(jsonStr);
            const walk = (obj) => {
                if (Array.isArray(obj)) {
                    if (obj.length > 3) {
                        return [
                            walk(obj[0]),
                            walk(obj[1]),
                            walk(obj[2]),
                            `... [TokenWall: ${obj.length - 3} more items truncated]`
                        ];
                    }
                    return obj.map(walk);
                }
                else if (obj && typeof obj === 'object') {
                    const newObj = {};
                    for (const key of Object.keys(obj)) {
                        newObj[key] = walk(obj[key]);
                    }
                    return newObj;
                }
                else if (typeof obj === 'string' && obj.length > 200) {
                    // Entropy Preservation: Preserve high-entropy strings like UUIDs/Tokens
                    const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(obj);
                    if (!isUuid) {
                        return obj.substring(0, 100) + '... [TokenWall: Truncated value]';
                    }
                }
                return obj;
            };
            return JSON.stringify(walk(parsed));
        }
        catch {
            // Best effort whitespace compression if invalid JSON
            return jsonStr.replace(/\s+/g, '').trim();
        }
    }
}
exports.JsonCrusher = JsonCrusher;
class CodeCompressor {
    static compress(code) {
        // Strip block comments (/* ... */)
        let compressed = code.replace(/\/\*[\s\S]*?\*\//g, '');
        // Strip single-line comments (// ...) but avoid stripping URL schemes
        compressed = compressed.replace(/(?<!:)\/\/.*$/gm, '');
        // Strip Python/Bash comments (# ...) but avoid stripping string boundaries
        compressed = compressed.replace(/(?<!["'`])#.*$/gm, '');
        // Collapse multiple empty lines
        compressed = compressed.replace(/\n\s*\n/g, '\n');
        return compressed.trim();
    }
}
exports.CodeCompressor = CodeCompressor;
class CacheAligner {
    static normalizeWhitespace(text) {
        return text
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
    }
    static detectVolatileTokens(text) {
        const findings = [];
        const tokens = text.split(/[\s'"\[\](){},;]+/);
        const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
        const hexHashRegex = /^[0-9a-fA-F]{32}$|^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$/;
        const jwtRegex = /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/;
        const iso8601Regex = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
        for (let token of tokens) {
            if (!token)
                continue;
            token = token.replace(/[.,:;?!]+$/, '');
            if (uuidRegex.test(token)) {
                findings.push({ type: 'uuid', value: token });
            }
            else if (iso8601Regex.test(token)) {
                findings.push({ type: 'iso8601', value: token });
            }
            else if (jwtRegex.test(token)) {
                const parts = token.split('.');
                if (parts[0].length >= 4 && parts[1].length >= 4 && parts[2].length >= 4) {
                    findings.push({ type: 'jwt', value: token });
                }
            }
            else if (hexHashRegex.test(token)) {
                findings.push({ type: 'hex_hash', value: token });
            }
        }
        return findings;
    }
}
exports.CacheAligner = CacheAligner;
class ContextAnalyzer {
    async analyze(req, config) {
        const inefficiencies = [];
        let totalWasteTokens = 0;
        const cleanMessages = JSON.parse(JSON.stringify(req.messages));
        const cachedContents = [];
        const isReversible = config?.reversibleCompression !== false;
        for (let i = 0; i < cleanMessages.length; i++) {
            const msg = cleanMessages[i];
            let content = msg.content;
            // 0. Cache alignment detection & normalization
            if ((msg.role === 'system' || i === 0) && config?.cacheAlignment !== false) {
                const normalized = CacheAligner.normalizeWhitespace(content);
                if (normalized !== content) {
                    content = normalized;
                }
                const volatile = CacheAligner.detectVolatileTokens(content);
                if (volatile.length > 0) {
                    for (const finding of volatile) {
                        inefficiencies.push({
                            type: 'volatile_prefix',
                            description: `Volatile content format (${finding.type}) detected in system prompt: '${finding.value.substring(0, 10)}...'. This prevents provider-side prefix caching and increases latency/costs.`,
                            target: finding.value,
                            approximateTokens: (0, estimators_1.countTokens)(finding.value, req.model),
                            potentialSavingsPercent: 50
                        });
                    }
                }
            }
            // 1. Lockfiles detection
            const lockfileMatch = content.match(/(?:File|path|Filename|attachment):\s*([a-zA-Z0-9_\-\.\/]*lock\.[a-z]+|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)/gi);
            const lockfileRegex = /(\`\`\`[a-z]*\s*[\s\S]*?"dependencies"[\s\S]*?\`\`\`)/g;
            if (lockfileMatch && lockfileRegex.test(content)) {
                lockfileRegex.lastIndex = 0;
                const beforeTokens = (0, estimators_1.countTokens)(content, req.model);
                if (isReversible) {
                    const id = `ccr_lk_${Math.random().toString(36).substring(2, 7)}`;
                    cachedContents.push({ id, content });
                    content = content.replace(lockfileRegex, `[TokenWall Reversible Content: ${id} - Truncated Lockfile content. Use tokenwall_retrieve_content tool with content_id='${id}' if you need to read the original content.]`);
                }
                else {
                    content = content.replace(lockfileRegex, '[TokenWall: Truncated Lockfile content. Use package.json for dependencies list]');
                }
                const afterTokens = (0, estimators_1.countTokens)(content, req.model);
                const saved = Math.max(0, beforeTokens - afterTokens);
                if (saved > 0) {
                    inefficiencies.push({
                        type: 'lockfile',
                        description: `Lockfile detected: '${lockfileMatch[0]}'. Standard lockfiles contribute heavily to token bloat.`,
                        target: lockfileMatch[0],
                        approximateTokens: saved,
                        potentialSavingsPercent: 95
                    });
                    totalWasteTokens += saved;
                }
            }
            // 2. node_modules or .git paths
            if (content.includes('node_modules/') || content.includes('.git/')) {
                const approxTokens = (0, estimators_1.countTokens)(content, req.model);
                inefficiencies.push({
                    type: 'node_modules',
                    description: `References to 'node_modules' or '.git' files detected.`,
                    target: content.includes('node_modules/') ? 'node_modules/' : '.git/',
                    approximateTokens: approxTokens,
                    potentialSavingsPercent: 99
                });
                // We don't add to totalWasteTokens because we don't automatically strip it.
            }
            // 3. Repeated stack traces / large logs
            const traceLines = content.match(/at\s+.*:\d+:\d+/g);
            if (traceLines && traceLines.length > 8) {
                const beforeTokens = (0, estimators_1.countTokens)(content, req.model);
                if (isReversible) {
                    const id = `ccr_lg_${Math.random().toString(36).substring(2, 7)}`;
                    cachedContents.push({ id, content });
                    content = `[TokenWall Reversible Content: ${id} - Truncated stack trace frames. Use tokenwall_retrieve_content tool with content_id='${id}' if you need to read the full logs.]\n` + content.substring(0, 500) + '\n... [Remaining frames truncated]';
                }
                else {
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
                const afterTokens = (0, estimators_1.countTokens)(content, req.model);
                const saved = Math.max(0, beforeTokens - afterTokens);
                if (saved > 0) {
                    inefficiencies.push({
                        type: 'logs',
                        description: `Oversized stack trace containing ${traceLines.length} repeat references detected.`,
                        target: 'stack_trace_repeats',
                        approximateTokens: saved,
                        potentialSavingsPercent: 60
                    });
                    totalWasteTokens += saved;
                }
            }
            // 4. Binary/Base64 payloads
            const base64Regex = /([A-Za-z0-9+/]{100,})/g;
            if (base64Regex.test(content)) {
                base64Regex.lastIndex = 0;
                const beforeTokens = (0, estimators_1.countTokens)(content, req.model);
                if (isReversible) {
                    const id = `ccr_bn_${Math.random().toString(36).substring(2, 7)}`;
                    cachedContents.push({ id, content });
                    content = content.replace(base64Regex, `[TokenWall Reversible Content: ${id} - Stripped base64 binary block. Use tokenwall_retrieve_content tool with content_id='${id}' if you need the original binary data.]`);
                }
                else {
                    content = content.replace(base64Regex, '[TokenWall: Stripped base64 binary block]');
                }
                const afterTokens = (0, estimators_1.countTokens)(content, req.model);
                const saved = Math.max(0, beforeTokens - afterTokens);
                if (saved > 0) {
                    inefficiencies.push({
                        type: 'binary',
                        description: `Embedded raw binary/base64 block detected.`,
                        target: 'base64_data',
                        approximateTokens: saved,
                        potentialSavingsPercent: 100
                    });
                    totalWasteTokens += saved;
                }
            }
            // 4.5 Magika Detection for raw unstructured payloads
            if (content.length > 1000 && !content.includes('```')) {
                const magika = await getMagika();
                if (magika) {
                    try {
                        const bytes = new TextEncoder().encode(content.substring(0, 4000));
                        const prediction = await magika.identifyBytes(bytes);
                        const label = prediction?.label || prediction;
                        if (label === 'json' || label === 'jsonl') {
                            const crushed = JsonCrusher.crush(content);
                            const saved = (0, estimators_1.countTokens)(content, req.model) - (0, estimators_1.countTokens)(crushed, req.model);
                            if (saved > 0) {
                                totalWasteTokens += saved;
                                content = `\`\`\`json\n${crushed}\n\`\`\``;
                                inefficiencies.push({
                                    type: 'json',
                                    description: `Magika detected raw JSON. Applied Structural Mask and truncation.`,
                                    target: 'raw_json',
                                    approximateTokens: saved,
                                    potentialSavingsPercent: 80
                                });
                            }
                        }
                        else if (['python', 'javascript', 'typescript', 'go', 'rust', 'cpp', 'java'].includes(label)) {
                            const compressed = CodeCompressor.compress(content);
                            const saved = (0, estimators_1.countTokens)(content, req.model) - (0, estimators_1.countTokens)(compressed, req.model);
                            if (saved > 0) {
                                totalWasteTokens += saved;
                                content = `\`\`\`${label}\n${compressed}\n\`\`\``;
                                inefficiencies.push({
                                    type: 'code',
                                    description: `Magika detected raw ${label} code. Applied Code Compression.`,
                                    target: 'raw_code',
                                    approximateTokens: saved,
                                    potentialSavingsPercent: 50
                                });
                            }
                        }
                    }
                    catch (e) {
                        // Silently ignore Magika errors
                    }
                }
            }
            // 5. JSON Crushing
            if (config?.jsonCrushing !== false) {
                const jsonBlockRegex = /```json\s+([\s\S]*?)\s*```/gi;
                let jsonMatch;
                while ((jsonMatch = jsonBlockRegex.exec(content)) !== null) {
                    const rawJson = jsonMatch[1];
                    if (rawJson.length > 250) {
                        const crushedJson = JsonCrusher.crush(rawJson);
                        const beforeTokens = (0, estimators_1.countTokens)(jsonMatch[0], req.model);
                        const newBlock = `\`\`\`json\n${crushedJson}\n\`\`\``;
                        const afterTokens = (0, estimators_1.countTokens)(newBlock, req.model);
                        const saved = Math.max(0, beforeTokens - afterTokens);
                        if (saved > 10) {
                            inefficiencies.push({
                                type: 'json',
                                description: `Large JSON block minified.`,
                                target: 'json_block',
                                approximateTokens: saved,
                                potentialSavingsPercent: Math.round((saved / beforeTokens) * 100)
                            });
                            totalWasteTokens += saved;
                            content = content.replace(jsonMatch[0], newBlock);
                        }
                    }
                }
            }
            // 6. Code Compression
            if (config?.codeCompression !== false) {
                const codeBlockRegex = /```(javascript|typescript|js|ts|python|py|rust|rs|go|golang|cpp|c\+\+|java|c|shell|sh|bash)\s+([\s\S]*?)\s*```/gi;
                let codeMatch;
                while ((codeMatch = codeBlockRegex.exec(content)) !== null) {
                    const lang = codeMatch[1];
                    const rawCode = codeMatch[2];
                    if (rawCode.length > 300) {
                        const compressedCode = CodeCompressor.compress(rawCode);
                        let newBlock = '';
                        let id = '';
                        if (isReversible) {
                            id = `ccr_cd_${Math.random().toString(36).substring(2, 7)}`;
                            newBlock = `[TokenWall Reversible Content: ${id} - Code comments stripped to save tokens. Use tokenwall_retrieve_content tool with content_id='${id}' if you need the comments/docstrings.]\n\`\`\`${lang}\n${compressedCode}\n\`\`\``;
                        }
                        else {
                            newBlock = `\`\`\`${lang}\n${compressedCode}\n\`\`\``;
                        }
                        const beforeTokens = (0, estimators_1.countTokens)(codeMatch[0], req.model);
                        const afterTokens = (0, estimators_1.countTokens)(newBlock, req.model);
                        const saved = Math.max(0, beforeTokens - afterTokens);
                        if (saved > 10) {
                            inefficiencies.push({
                                type: 'code',
                                description: `Code comments and whitespace compressed in ${lang} block.`,
                                target: `${lang}_code_block`,
                                approximateTokens: saved,
                                potentialSavingsPercent: Math.round((saved / beforeTokens) * 100)
                            });
                            totalWasteTokens += saved;
                            if (isReversible) {
                                cachedContents.push({ id, content: rawCode });
                            }
                            content = content.replace(codeMatch[0], newBlock);
                        }
                    }
                }
            }
            msg.content = content;
        }
        return {
            inefficiencies,
            totalWasteTokens,
            cleanMessages,
            cachedContents
        };
    }
}
exports.ContextAnalyzer = ContextAnalyzer;
