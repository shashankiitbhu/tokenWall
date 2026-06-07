import { ProviderRegistry } from '../packages/providers/dist/index.js';
import { createParser } from 'eventsource-parser';

function testSSE() {
  const provider = 'openai';
  let inputTokens = 0;
  let outputTokens = 0;

  const parser = createParser({
    onEvent: (event) => {
      const parsedChunk = ProviderRegistry.parseStreamChunk(provider, event.data);
      if (parsedChunk && parsedChunk.usage) {
        if (parsedChunk.usage.inputTokens > 0) inputTokens = parsedChunk.usage.inputTokens;
        if (parsedChunk.usage.outputTokens > 0) outputTokens = parsedChunk.usage.outputTokens;
      }
    }
  });

  // Simulate fragmented stream
  parser.feed('data: {"id":"chatcmpl-123","choices":[{"index":0,"delta":{"content":"Hel"}}]}');
  parser.feed('\n\n');
  parser.feed('data: {"id":"chatcmpl-123","choices":[{"index":0,"delta":{"content":"lo!"}}]}');
  parser.feed('\n\n');
  parser.feed('data: {"id":"chatcmpl-123","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}');
  parser.feed('\n\n');
  parser.feed('data: [DONE]\n\n');

  if (inputTokens === 10 && outputTokens === 2) {
    console.log('✅ Streaming test PASSED. Fragmented SSE parsed successfully.');
  } else {
    console.error(`❌ Streaming test FAILED. Expected 10/2 tokens, got ${inputTokens}/${outputTokens}`);
    process.exit(1);
  }
}

testSSE();
