"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CodeChunker = void 0;
class CodeChunker {
    static chunk(tree, code, maxChunkSize = 4000) {
        const scopeTree = this.buildScopeTree(tree.rootNode);
        // Phase 1: Split
        const splittableBlocks = this.getSplittableBlocks(tree.rootNode, maxChunkSize);
        // Phase 2: Merge
        const mergedChunks = this.mergeBlocks(splittableBlocks, maxChunkSize, code);
        return { chunks: mergedChunks, scopeTree };
    }
    static buildScopeTree(node) {
        const scope = {
            type: node.type,
            name: this.getNodeName(node),
            startIndex: node.startIndex,
            endIndex: node.endIndex,
            children: []
        };
        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child) {
                if (this.isScopeBoundary(child)) {
                    scope.children.push(this.buildScopeTree(child));
                }
                else {
                    // If not a boundary, we still need to search its children for nested scopes
                    const subScopes = this.findNestedScopes(child);
                    scope.children.push(...subScopes);
                }
            }
        }
        return scope;
    }
    static findNestedScopes(node) {
        const scopes = [];
        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child) {
                if (this.isScopeBoundary(child)) {
                    scopes.push(this.buildScopeTree(child));
                }
                else {
                    scopes.push(...this.findNestedScopes(child));
                }
            }
        }
        return scopes;
    }
    static isScopeBoundary(node) {
        return [
            'class_declaration',
            'function_declaration',
            'method_definition',
            'arrow_function',
            'interface_declaration',
            'type_alias_declaration'
        ].includes(node.type);
    }
    static getNodeName(node) {
        // Attempt to extract the identifier name
        const idNode = node.children.find(c => c.type === 'identifier' || c.type === 'property_identifier');
        if (idNode) {
            return idNode.text;
        }
        return null;
    }
    static getSplittableBlocks(node, maxSize) {
        // If the node itself is small enough, or it cannot be split further, return it as one block.
        // However, for the root node, we always want to split its children.
        const size = node.endIndex - node.startIndex;
        if (node.type !== 'program' && node.type !== 'class_body' && node.type !== 'statement_block') {
            if (size <= maxSize) {
                return [{ startIndex: node.startIndex, endIndex: node.endIndex, node }];
            }
        }
        // Find children to split. Usually, we split on statements or declarations
        const blocks = [];
        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (!child || !child.isNamed)
                continue; // skip unnamed punctuation
            const childSize = child.endIndex - child.startIndex;
            if (childSize > maxSize && this.canSplit(child)) {
                // Recurse into this large node
                blocks.push(...this.getSplittableBlocks(child, maxSize));
            }
            else {
                blocks.push({ startIndex: child.startIndex, endIndex: child.endIndex, node: child });
            }
        }
        // If we couldn't split and no blocks were generated (e.g. leaf node), just return the node
        if (blocks.length === 0) {
            return [{ startIndex: node.startIndex, endIndex: node.endIndex, node }];
        }
        return blocks;
    }
    static canSplit(node) {
        return [
            'program',
            'class_declaration',
            'class_body',
            'function_declaration',
            'statement_block',
            'export_statement',
            'lexical_declaration',
            'method_definition'
        ].includes(node.type);
    }
    static mergeBlocks(blocks, maxSize, code) {
        const chunks = [];
        let currentChunkStart = -1;
        let currentChunkEnd = -1;
        for (const block of blocks) {
            if (currentChunkStart === -1) {
                currentChunkStart = block.startIndex;
                currentChunkEnd = block.endIndex;
            }
            else {
                // Evaluate adding this block
                const prospectiveSize = block.endIndex - currentChunkStart;
                if (prospectiveSize <= maxSize) {
                    // Merge
                    currentChunkEnd = block.endIndex;
                }
                else {
                    // Push current chunk and start a new one
                    chunks.push({
                        text: code.slice(currentChunkStart, currentChunkEnd),
                        startIndex: currentChunkStart,
                        endIndex: currentChunkEnd
                    });
                    currentChunkStart = block.startIndex;
                    currentChunkEnd = block.endIndex;
                }
            }
        }
        if (currentChunkStart !== -1) {
            chunks.push({
                text: code.slice(currentChunkStart, currentChunkEnd),
                startIndex: currentChunkStart,
                endIndex: currentChunkEnd
            });
        }
        // Note: because we slice based on node indices, there might be gaps (whitespace) between chunks.
        // To ensure we cover the entire code (including whitespace/newlines between nodes):
        const continuousChunks = [];
        let lastEnd = 0;
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            let start = lastEnd;
            let end = chunk.endIndex;
            // For the last chunk, extend to the very end of the file
            if (i === chunks.length - 1) {
                end = code.length;
            }
            continuousChunks.push({
                text: code.slice(start, end),
                startIndex: start,
                endIndex: end
            });
            lastEnd = end;
        }
        return continuousChunks;
    }
}
exports.CodeChunker = CodeChunker;
