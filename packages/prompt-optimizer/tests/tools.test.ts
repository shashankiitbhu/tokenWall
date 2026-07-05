import { describe, it, expect } from 'vitest';
import { ToolPayloadCrusher } from '../src/tools';
import { CachedContent } from '../src/code-compressor';

describe('ToolPayloadCrusher', () => {
  it('leaves short text untouched', () => {
    const text = 'Hello world\nThis is short';
    const out: CachedContent[] = [];
    const res = ToolPayloadCrusher.optimizeToolResult(text, 'gpt-4o', out);
    expect(res).toBe(text);
    expect(out.length).toBe(0);
  });

  it('performs inline excerpt redaction and caches redacted text', () => {
    const lines = Array.from({ length: 150 }, (_, i) => `Line ${i}`);
    lines[50] = 'My AWS key is AKIA1234567890ABCDEF !'; // Should be redacted
    lines[51] = 'Error: something went wrong'; // Signal to ensure it is kept
    
    const text = lines.join('\n');
    const out: CachedContent[] = [];
    const res = ToolPayloadCrusher.optimizeToolResult(text, 'gpt-4o', out);
    
    expect(res).toContain('[REDACTED_AWS_KEY]');
    expect(res).not.toContain('AKIA1234567890ABCDEF');
    expect(out.length).toBe(1);
    expect(out[0].content).toContain('[REDACTED_AWS_KEY]');
    expect(out[0].content).not.toContain('AKIA1234567890ABCDEF');
  });

  it('strips ANSI escape codes before processing', () => {
    const lines = Array.from({ length: 150 }, (_, i) => `\x1B[31mLine ${i}\x1B[0m`);
    const text = lines.join('\n');
    const out: CachedContent[] = [];
    const res = ToolPayloadCrusher.optimizeToolResult(text, 'gpt-4o', out);
    
    expect(res).not.toContain('\x1B[31m');
    expect(res).not.toContain('\x1B[0m');
  });

  it('parses JSONL correctly', () => {
    const lines = Array.from({ length: 100 }, (_, i) => JSON.stringify({ id: i, name: `Name${i}` }));
    const text = lines.join('\n');
    const out: CachedContent[] = [];
    const res = ToolPayloadCrusher.optimizeToolResult(text, 'gpt-4o', out);
    
    // Should be crushed as an array
    expect(res).toContain('[TokenWall: SQL/Array converted to CSV for context optimization]');
    expect(res).toContain('id,name'); // CSV header
    expect(res).toContain('99,Name99');
  });

  it('applies fallback positional pruning with no-signal marker', () => {
    const lines = Array.from({ length: 150 }, (_, i) => `Line ${i}`);
    const text = lines.join('\n');
    const out: CachedContent[] = [];
    const res = ToolPayloadCrusher.optimizeToolResult(text, 'gpt-4o', out);
    
    expect(res).toContain('Line 0');
    expect(res).toContain('Line 29');
    expect(res).toContain('Line 120');
    expect(res).toContain('Line 149');
    expect(res).not.toContain('Line 50');
    expect(res).toContain('no error/warning markers detected');
  });

  it('enforces blowup cap for relevance matches', () => {
    // 150 lines, all of them are warnings
    const lines = Array.from({ length: 150 }, (_, i) => `Warning: Line ${i}`);
    const text = lines.join('\n');
    const out: CachedContent[] = [];
    const res = ToolPayloadCrusher.optimizeToolResult(text, 'gpt-4o', out);
    
    // Should cap at 5 matches (which gives some tail/head bias, max 50 lines-ish + head/tail)
    const resLines = res.split('\n');
    expect(resLines.length).toBeLessThan(120); // Not 150, should be heavily pruned
    expect(res).toContain('lines truncated');
  });

  it('correctly merges overlapping ranges', () => {
    const lines = Array.from({ length: 150 }, (_, i) => `Line ${i}`);
    lines[50] = 'Error: first error';
    lines[55] = 'Error: second error'; // context windows (45-55) and (50-60) overlap
    const text = lines.join('\n');
    const out: CachedContent[] = [];
    const res = ToolPayloadCrusher.optimizeToolResult(text, 'gpt-4o', out);
    
    // Check that we only see one truncation marker between head and the error block
    const matches = res.match(/\.\.\. \[TokenWall/g);
    expect(matches?.length).toBe(2); // One before error block, one after error block
    expect(res).toContain('Line 45');
    expect(res).toContain('Line 60');
  });

  it('adversarial test: 500-line build log with error in the middle', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `Compile output line ${i}`);
    lines[250] = 'fatal error: missing semicolon';
    const text = lines.join('\n');
    const out: CachedContent[] = [];
    const res = ToolPayloadCrusher.optimizeToolResult(text, 'gpt-4o', out);
    
    expect(res).toContain('Compile output line 0'); // head
    expect(res).toContain('Compile output line 499'); // tail
    expect(res).toContain('fatal error: missing semicolon'); // The crucial middle line
    expect(res).toContain('Compile output line 245'); // context before
    expect(res).toContain('Compile output line 255'); // context after
    expect(res).not.toContain('no error/warning markers'); // Should use relevance marker
  });
});
