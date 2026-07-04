import type { CoverageMetrics } from './index';
export interface CachedContent {
    id: string;
    content: string;
}
export interface CompressionMapEntry {
    original: string;
    compressed: string;
}
export declare class CodeCompressor {
    /**
     * Scans a prompt for JS/TS code blocks and `<file_content>` blocks,
     * parses them into an AST using Tree-sitter, strips only actual comment nodes,
     * and skeletonizes large function bodies by masking them with a CCR token.
     */
    static compress(prompt: string, disableCodeCompression?: boolean, optOutReason?: 'system_guard' | 'user_config' | null, metrics?: CoverageMetrics): {
        optimizedText: string;
        cachedContents: CachedContent[];
        compressionMap: CompressionMapEntry[];
    };
    /**
     * Parses the code with Tree-sitter, splices out comment nodes, and skeletonizes function bodies.
     */
    private static sparsifyCode;
}
