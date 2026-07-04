"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CodeCompressor = void 0;
const tree_sitter_1 = __importDefault(require("tree-sitter"));
const tree_sitter_javascript_1 = __importDefault(require("tree-sitter-javascript"));
const tree_sitter_typescript_1 = __importDefault(require("tree-sitter-typescript"));
const jsParser = new tree_sitter_1.default();
jsParser.setLanguage(tree_sitter_javascript_1.default);
const tsParser = new tree_sitter_1.default();
tsParser.setLanguage(tree_sitter_typescript_1.default.typescript);
const tsxParser = new tree_sitter_1.default();
tsxParser.setLanguage(tree_sitter_typescript_1.default.tsx);
class CodeCompressor {
    /**
     * Scans a prompt for JS/TS code blocks and `<file_content>` blocks,
     * parses them into an AST using Tree-sitter, strips only actual comment nodes,
     * and skeletonizes large function bodies by masking them with a CCR token.
     */
    static compress(prompt, disableCodeCompression = false) {
        if (disableCodeCompression) {
            return { optimizedText: prompt, cachedContents: [] };
        }
        const cachedContents = [];
        // Match Markdown code blocks (```javascript, ```js, ```typescript, ```ts)
        const mdBlockRegex = /```(javascript|js|typescript|ts|jsx|tsx)\s*([\s\S]*?)\s*```/gi;
        // Match XML file_content blocks with .js, .ts, .jsx, .tsx extensions
        const xmlBlockRegex = /<file_content[^>]*path="[^"]+\.(js|ts|jsx|tsx)"[^>]*>\s*([\s\S]*?)\s*<\/file_content>/gi;
        let optimized = prompt.replace(mdBlockRegex, (match, lang, code) => {
            try {
                const sparsified = this.sparsifyCode(code, lang, cachedContents);
                return `\`\`\`${lang}\n${sparsified}\n\`\`\``;
            }
            catch (e) {
                // Fallback to original if parsing fails
                return match;
            }
        });
        optimized = optimized.replace(xmlBlockRegex, (match, ext, code) => {
            try {
                const sparsified = this.sparsifyCode(code, ext, cachedContents);
                // Replace only the inner code content, keep the XML tags intact
                return match.replace(code, `\n${sparsified}\n`);
            }
            catch (e) {
                return match;
            }
        });
        return { optimizedText: optimized, cachedContents };
    }
    /**
     * Parses the code with Tree-sitter, splices out comment nodes, and skeletonizes function bodies.
     */
    static sparsifyCode(code, langOrExt, cachedContents) {
        const ext = langOrExt.toLowerCase();
        let parser;
        if (ext === 'javascript' || ext === 'js') {
            parser = jsParser;
        }
        else if (ext === 'typescript' || ext === 'ts') {
            parser = tsParser;
        }
        else if (ext === 'tsx') {
            parser = tsxParser;
        }
        else {
            parser = tsParser; // Fallback
        }
        try {
            const tree = parser.parse(code);
            const removeNodes = [];
            const walk = (node) => {
                if (node.type === 'comment') {
                    removeNodes.push({ startIndex: node.startIndex, endIndex: node.endIndex });
                }
                else if (node.type === 'function_declaration' ||
                    node.type === 'method_definition' ||
                    node.type === 'arrow_function') {
                    const bodyNode = node.children.find(c => c.type === 'statement_block');
                    if (bodyNode) {
                        const lines = bodyNode.text.split('\n').length;
                        if (lines > 10) {
                            const id = `ccr_sk_${Math.random().toString(36).substring(2, 9)}`;
                            cachedContents.push({ id, content: bodyNode.text });
                            removeNodes.push({
                                startIndex: bodyNode.startIndex,
                                endIndex: bodyNode.endIndex,
                                replaceWith: `{ /* [TokenWall Reversible Content: ${id}] */ }`
                            });
                            return; // skip walking inside the skeletonized body
                        }
                    }
                }
                for (let i = 0; i < node.childCount; i++) {
                    const child = node.child(i);
                    if (child)
                        walk(child);
                }
            };
            walk(tree.rootNode);
            // Sort descending by startIndex so we can slice from end-to-start without corrupting earlier offsets
            removeNodes.sort((a, b) => b.startIndex - a.startIndex);
            let result = code;
            for (const node of removeNodes) {
                result = result.slice(0, node.startIndex) + (node.replaceWith || '') + result.slice(node.endIndex);
            }
            return result.trim();
        }
        catch (e) {
            console.error("[TokenWall CodeCompressor] Tree-sitter parsing failed:", e);
            return code;
        }
    }
}
exports.CodeCompressor = CodeCompressor;
