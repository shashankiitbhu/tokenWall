import Parser from 'tree-sitter';
export interface ASTEdit {
    type: 'update' | 'insert' | 'delete';
    startByte: number;
    endByte: number;
    newText?: string;
}
export declare class ASTDiffer {
    static runASTDiff(originalFile: string, compressedFile: string, targetContentInComp: string, replacementContentInComp: string, mappings: CompressionMapping[]): {
        target: string;
        replacement: string;
        verified: boolean;
    };
    /**
     * Compares two ASTs (T_comp and T_edit) and generates an edit script (a list of AST edits).
     * This is a simplified GumTree-lite top-down phase:
     * It looks for isomorphic or modified top-level nodes (functions, classes, variables)
     * and generates granular edit operations for the modified regions.
     */
    static diff(compNode: Parser.SyntaxNode, editNode: Parser.SyntaxNode): ASTEdit[];
    private static getNamedChildren;
    private static areNodesIdentical;
    private static isSameEntity;
    private static getIdentifierName;
}
export interface CompressionMapping {
    originalStart: number;
    originalEnd: number;
    replaceWith: string;
}
export declare class ASTDiffApplier {
    static applyEdits(originalText: string, edits: ASTEdit[], mappings: CompressionMapping[]): string;
    static mapOffset(compOffset: number, ascMappings: CompressionMapping[]): number;
}
