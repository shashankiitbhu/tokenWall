import { test, expect } from 'vitest';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import { CodeChunker } from '../src/code-chunker';

test('CodeChunker correctly splits and merges at semantic boundaries', () => {
  const parser = new Parser();
  parser.setLanguage(TypeScript.typescript);

  const code = `
class User {
  constructor(public name: string) {
    console.log("User created");
  }

  getName() {
    return this.name;
  }
}

function helperFunction() {
  let count = 0;
  for(let i=0; i<100; i++) {
    count += i;
  }
  return count;
}

export const x = 10;
`;

  const tree = parser.parse(code);
  
  // With a very small max chunk size, it should split the class and function separately
  const result = CodeChunker.chunk(tree, code, 100);
  
  expect(result.chunks.length).toBeGreaterThan(1);
  expect(result.scopeTree).toBeDefined();
  expect(result.scopeTree.children.length).toBeGreaterThan(0);
  
  // Verify ScopeTree contents
  const classScope = result.scopeTree.children.find(c => c.type === 'class_declaration');
  expect(classScope).toBeDefined();
  expect(classScope?.name).toBe('User');
  
  const funcScope = result.scopeTree.children.find(c => c.type === 'function_declaration');
  expect(funcScope).toBeDefined();
  expect(funcScope?.name).toBe('helperFunction');

  // Verify that chunks do not fragment the structural blocks if possible
  const mergedChunks = result.chunks.map(c => c.text.trim()).filter(t => t.length > 0);
  expect(mergedChunks[0].includes('class User')).toBe(true);
});

test('CodeChunker merges small blocks into single chunks', () => {
  const parser = new Parser();
  parser.setLanguage(TypeScript.typescript);

  const code = `
const a = 1;
const b = 2;
const c = 3;
const d = 4;
`;

  const tree = parser.parse(code);
  
  // With a large max chunk size, it should merge all variable declarations into a single chunk
  const result = CodeChunker.chunk(tree, code, 1000);
  
  expect(result.chunks.length).toBe(1);
  expect(result.chunks[0].text.trim()).toBe('const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;');
});
