import { describe, it, expect } from 'vitest';
import { ASTDiffer, ASTDiffApplier } from '../src/ast-differ';
import { CodeCompressor } from '../src/code-compressor';

describe('Structural AST Diffing', () => {
  it('correctly maps compressed edits back to original space without corrupting comments', () => {
    const original = `
function calculateTotal(items) {
  // Initialize total
  let total = 0;
  
  // Loop through all items to sum them up
  for (const item of items) {
    total += item.price;
  }
  
  // Apply final discount
  return total * 0.9;
}
`;
    // We sparsify the original code
    // CodeCompressor.compress returns { optimizedText, compressionMap }
    const { optimizedText, compressionMap } = CodeCompressor.compress(original, false);
    
    // We know the first entry is our code block
    const mappings = compressionMap[0]?.mappings || [];
    const sparsified = compressionMap[0]?.compressed || '';
    
    // sparsified will have the comments stripped
    const targetContentInComp = `  let total = 0;`;
    const replacementContentInComp = `  let total = 0;\n  let discount = 0.8;`;

    const { target, replacement, verified } = ASTDiffer.runASTDiff(
      original,
      sparsified,
      targetContentInComp,
      replacementContentInComp,
      mappings
    );

    // Verified must be true
    expect(verified).toBe(true);

    const newOriginal = original.replace(target, replacement);

    // The new original MUST still contain all the comments
    expect(newOriginal).toContain('// Initialize total');
    expect(newOriginal).toContain('// Loop through all items');
    expect(newOriginal).toContain('let discount = 0.8;');
  });

  it('fails closed when verification fails (e.g. malformed replacement)', () => {
    const original = `const x = 1;`;
    const sparsified = `const x = 1;`;
    const mappings = [];
    
    const { verified } = ASTDiffer.runASTDiff(
      original,
      sparsified,
      `const y = 2;`, // not found
      `const y = 3;`,
      mappings
    );
    
    expect(verified).toBe(false);
  });
});
