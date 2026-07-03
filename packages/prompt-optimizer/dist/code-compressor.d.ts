export declare class CodeCompressor {
    /**
     * Scans a prompt for JS/TS code blocks and `<file_content>` blocks,
     * parses them into an AST using Tree-sitter, strips only actual comment nodes
     * by byte-range slicing to preserve original whitespace, empty lines, and non-comment structure perfectly.
     */
    static compress(prompt: string): string;
    /**
     * Parses the code with Tree-sitter and splices out comment nodes.
     */
    private static sparsifyCode;
}
