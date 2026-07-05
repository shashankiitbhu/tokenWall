import type { Tree } from 'tree-sitter';
export interface ScopeNode {
    type: string;
    name: string | null;
    startIndex: number;
    endIndex: number;
    children: ScopeNode[];
}
export interface Chunk {
    text: string;
    startIndex: number;
    endIndex: number;
}
export declare class CodeChunker {
    static chunk(tree: Tree, code: string, maxChunkSize?: number): {
        chunks: Chunk[];
        scopeTree: ScopeNode;
    };
    private static buildScopeTree;
    private static findNestedScopes;
    private static isScopeBoundary;
    private static getNodeName;
    private static getSplittableBlocks;
    private static canSplit;
    private static mergeBlocks;
}
