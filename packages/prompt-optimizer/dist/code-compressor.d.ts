export declare class CodeCompressor {
    /**
     * Scans a prompt for JS/TS code blocks and `<file_content>` blocks,
     * parses them into an AST, aggressively skeletonizes large function bodies,
     * strips comments, and replaces the block with beautifully formatted sparsified code.
     */
    static compress(prompt: string): string;
    /**
     * Parses the code, skeletonizes it, and prints it out.
     */
    private static sparsifyCode;
}
