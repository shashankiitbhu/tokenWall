import crypto from 'crypto';
import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';

const jsParser = new Parser();
jsParser.setLanguage(JavaScript);

const tsParser = new Parser();
tsParser.setLanguage(TypeScript.typescript);

const tsxParser = new Parser();
tsxParser.setLanguage(TypeScript.tsx);

import type { CoverageMetrics } from './index';

export interface CachedContent {
  id: string;
  content: string;
}

export interface CompressionMapping {
  originalStart: number;
  originalEnd: number;
  replaceWith: string;
}

export interface CompressionMapEntry {
  original: string;
  compressed: string;
  mappings?: CompressionMapping[];
}

export interface Chunk {
  text: string;
  startIndex: number;
  endIndex: number;
}

export interface ScopeNode {
  type: string;
  name: string | null;
  startIndex: number;
  endIndex: number;
  children: ScopeNode[];
}

export interface ChunkedBlock {
  id: string;
  language: string;
  chunks: Chunk[];
  scopeTree: ScopeNode;
}

import { CodeChunker } from './code-chunker';

export class CodeCompressor {
  /**
   * Scans a prompt for JS/TS code blocks and `<file_content>` blocks,
   * parses them into an AST using Tree-sitter, strips only actual comment nodes,
   * and skeletonizes large function bodies by masking them with a CCR token.
   * Also performs AST-aware chunking on the optimized source.
   */
  static compress(
    prompt: string, 
    disableCodeCompression: boolean = false,
    optOutReason: 'system_guard' | 'user_config' | null = null,
    metrics?: CoverageMetrics
  ): { optimizedText: string, cachedContents: CachedContent[], compressionMap: CompressionMapEntry[], chunkedBlocks: ChunkedBlock[] } {
    
    // Count regex total detected
    const mdBlockRegex = /```(javascript|js|typescript|ts|jsx|tsx)\s*([\s\S]*?)\s*```/gi;
    const xmlBlockRegex = /<file_content[^>]*path="[^"]+\.(js|ts|jsx|tsx)"[^>]*>\s*([\s\S]*?)\s*<\/file_content>/gi;
    
    let totalDetected = 0;
    const matchesMd = [...prompt.matchAll(mdBlockRegex)];
    const matchesXml = [...prompt.matchAll(xmlBlockRegex)];
    totalDetected = matchesMd.length + matchesXml.length;
    
    if (metrics) {
      metrics.code.regexTotalDetected += totalDetected;
    }

    if (disableCodeCompression) {
      if (metrics && totalDetected > 0) {
        if (optOutReason === 'system_guard') {
          console.warn(`[TokenWall] ⚠️ Write-Path System Guard active: Skipping AST code compression to preserve write-path integrity.`);
          metrics.code.fallbackOptOutSystemGuard += totalDetected;
        }
        if (optOutReason === 'user_config') metrics.code.fallbackOptOutUserConfig += totalDetected;
      }
      return { optimizedText: prompt, cachedContents: [], compressionMap: [], chunkedBlocks: [] };
    }

    const cachedContents: CachedContent[] = [];
    const compressionMap: CompressionMapEntry[] = [];
    const chunkedBlocks: ChunkedBlock[] = [];

    let optimized = prompt.replace(mdBlockRegex, (match, lang, code) => {
      try {
        const { sparsified, chunks, scopeTree, mappings } = this.sparsifyCode(code, lang, cachedContents);
        if (metrics) metrics.code.successfullyOptimized++;
        if (sparsified !== code) {
          compressionMap.push({ original: code, compressed: sparsified, mappings });
        }
        if (chunks.length > 0 && scopeTree) {
          chunkedBlocks.push({ id: `block_${Math.random().toString(36).substring(2,9)}`, language: lang, chunks, scopeTree });
        }
        return `\`\`\`${lang}\n${sparsified}\n\`\`\``;
      } catch (e: any) {
        console.warn(`[TokenWall] ⚠️ Tree-sitter parse error (${lang}). Falling open to uncompressed code:`, e.message);
        if (metrics) {
          metrics.code.fallbackParseFailure++;
          metrics.sampledFailures.push({ type: 'parse_failure', reason: e.message || 'Tree-sitter error', snippet: code.substring(0, 200) });
        }
        // Fallback to original if parsing fails
        return match;
      }
    });

    optimized = optimized.replace(xmlBlockRegex, (match, ext, code) => {
      try {
        const { sparsified, chunks, scopeTree, mappings } = this.sparsifyCode(code, ext, cachedContents);
        if (metrics) metrics.code.successfullyOptimized++;
        if (sparsified !== code) {
          compressionMap.push({ original: code, compressed: sparsified, mappings });
        }
        if (chunks.length > 0 && scopeTree) {
          chunkedBlocks.push({ id: `block_${Math.random().toString(36).substring(2,9)}`, language: ext, chunks, scopeTree });
        }
        // Replace only the inner code content, keep the XML tags intact
        return match.replace(code, `\n${sparsified}\n`);
      } catch (e: any) {
        console.warn(`[TokenWall] ⚠️ Tree-sitter parse error (${ext}). Falling open to uncompressed xml block code:`, e.message);
        if (metrics) {
          metrics.code.fallbackParseFailure++;
          metrics.sampledFailures.push({ type: 'parse_failure', reason: e.message || 'Tree-sitter error', snippet: code.substring(0, 200) });
        }
        return match;
      }
    });

    return { optimizedText: optimized, cachedContents, compressionMap, chunkedBlocks };
  }

  /**
   * Parses the code with Tree-sitter, splices out comment nodes, and skeletonizes function bodies.
   */
  private static sparsifyCode(code: string, langOrExt: string, cachedContents: CachedContent[]): { sparsified: string, chunks: Chunk[], scopeTree: ScopeNode | null, mappings: CompressionMapping[] } {
    const ext = langOrExt.toLowerCase();
    let parser: Parser;
    if (ext === 'javascript' || ext === 'js') {
      parser = jsParser;
    } else if (ext === 'typescript' || ext === 'ts') {
      parser = tsParser;
    } else if (ext === 'tsx') {
      parser = tsxParser;
    } else {
      parser = tsParser; // Fallback
    }

    try {
      const tree = parser.parse(code);
      const removeNodes: { startIndex: number, endIndex: number, replaceWith?: string }[] = [];
      
      const walk = (node: Parser.SyntaxNode) => {
        if (node.type === 'comment') {
          const newlines = (node.text.match(/\n/g) || []).length;
          removeNodes.push({ startIndex: node.startIndex, endIndex: node.endIndex, replaceWith: '\n'.repeat(newlines) });
        } else if (
          node.type === 'function_declaration' ||
          node.type === 'method_definition' ||
          node.type === 'arrow_function'
        ) {
          const bodyNode = node.children.find(c => c.type === 'statement_block');
          if (bodyNode) {
            const lines = bodyNode.text.split('\n').length;
            if (lines > 10) {
              const hash = crypto.createHash('sha256').update(bodyNode.text).digest('hex').substring(0, 32);
              const id = `ccr_sk_${hash}`;
              cachedContents.push({ id, content: bodyNode.text });
              const newlinesToPad = Math.max(0, lines - 1);
              removeNodes.push({
                startIndex: bodyNode.startIndex,
                endIndex: bodyNode.endIndex,
                replaceWith: `{ /* [TokenWall Reversible Content: ${id}] */ }` + '\n'.repeat(newlinesToPad)
              });
              return; // skip walking inside the skeletonized body
            }
          }
        }
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child) walk(child);
        }
      };
      
      walk(tree.rootNode);

      // Sort descending by startIndex so we can slice from end-to-start without corrupting earlier offsets
      removeNodes.sort((a, b) => b.startIndex - a.startIndex);
      
      let result = code;
      for (const node of removeNodes) {
        result = result.slice(0, node.startIndex) + (node.replaceWith || '') + result.slice(node.endIndex);
      }
      
      const sparsified = result.trim();
      
      // Parse again for chunking so tree offsets align with modified code
      let chunks: Chunk[] = [];
      let scopeTree: ScopeNode | null = null;
      try {
        const sparsifiedTree = parser.parse(sparsified);
        const chunkResult = CodeChunker.chunk(sparsifiedTree, sparsified);
        chunks = chunkResult.chunks;
        scopeTree = chunkResult.scopeTree;
      } catch (ce) {
        console.error("[TokenWall CodeCompressor] CodeChunker failed:", ce);
      }
      
      return { sparsified, chunks, scopeTree, mappings: removeNodes.map(n => ({ originalStart: n.startIndex, originalEnd: n.endIndex, replaceWith: n.replaceWith || '' })) };
    } catch (e: any) {
      // If parsing fails, return original
      return { sparsified: code, chunks: [], scopeTree: null, mappings: [] };
    }
  }
}
