import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { LostInMiddleMitigator, MitigationContext } from '../src/lost-in-middle';

describe('LostInMiddleMitigator', () => {
  let context: MitigationContext;

  beforeEach(() => {
    context = {
      currentTurnText: '',
      fileShadowState: new Map(),
      model: 'gpt-4o'
    };
  });

  it('preserves contiguous blocks less than 3', () => {
    const text = `<file_content path="file1.js">\nfile 1\n</file_content>\n\n<file_content path="file2.js">\nfile 2\n</file_content>`;
    const reordered = LostInMiddleMitigator.reorder(text, context);
    assert.strictEqual(reordered, text);
  });

  it('reorders contiguous blocks into a U-shape based on score', () => {
    // Blocks 1 to 5
    const text = `
<file_content path="irrelevant1.js">
file 1
</file_content>

<file_content path="error.js">
Error: Exception thrown here
</file_content>

<file_content path="irrelevant2.js">
file 2
</file_content>

<file_content path="mentioned.js">
file 3
</file_content>

<file_content path="huge.js">
${'A '.repeat(5000)}
</file_content>
`.trim();

    // Context setup
    context.currentTurnText = 'Please check mentioned.js';
    context.fileShadowState.set('error.js', { content: '', hops: 1 });
    
    // Scores should be:
    // mentioned.js: +50 (mention)
    // error.js: +40 (error) + 18 (recency, hops=1) = 58
    // irrelevant1.js: 0
    // irrelevant2.js: 0
    // huge.js: negative (size penalty)
    
    // Sorted descending by score:
    // 1. error.js (58)
    // 2. mentioned.js (50)
    // 3. irrelevant1.js (0)  - order preserved by stable sort (or insertion order if scores match)
    // 4. irrelevant2.js (0)
    // 5. huge.js (-penalty)
    
    // U-shaped placement:
    // index 0 (left 0): error.js
    // index 4 (right 4): mentioned.js
    // index 1 (left 1): irrelevant1.js
    // index 3 (right 3): irrelevant2.js
    // index 2 (left 2): huge.js
    
    // Final order: error.js, irrelevant1.js, huge.js, irrelevant2.js, mentioned.js

    const reordered = LostInMiddleMitigator.reorder(text, context);
    
    const paths = Array.from(reordered.matchAll(/path="([^"]+)"/g)).map(m => m[1]);
    assert.deepStrictEqual(paths, [
      'error.js',
      'irrelevant1.js',
      'huge.js',
      'irrelevant2.js',
      'mentioned.js'
    ]);
  });
  
  it('is purely deterministic across multiple runs', () => {
    const text = `
<file_content path="fileA.js">
A
</file_content>

<file_content path="fileB.js">
Error
</file_content>

<file_content path="fileC.js">
C
</file_content>
`.trim();
    context.currentTurnText = 'fileC';

    const run1 = LostInMiddleMitigator.reorder(text, context);
    const run2 = LostInMiddleMitigator.reorder(text, context);
    
    assert.strictEqual(run1, run2);
  });
});
