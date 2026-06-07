import { ProviderRegistry } from '../packages/providers/dist/index.js';
import { createParser } from 'eventsource-parser';

function testOpenAISSE() {
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

  parser.feed('data: {"id":"chatcmpl-123","choices":[{"index":0,"delta":{"content":"Hel"}}]}');
  parser.feed('\n\n');
  parser.feed('data: {"id":"chatcmpl-123","choices":[{"index":0,"delta":{"content":"lo!"}}]}');
  parser.feed('\n\n');
  parser.feed('data: {"id":"chatcmpl-123","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}');
  parser.feed('\n\n');
  parser.feed('data: [DONE]\n\n');

  if (inputTokens === 10 && outputTokens === 2) {
    console.log('✅ OpenAI Streaming test PASSED.');
  } else {
    console.error(`❌ OpenAI Streaming test FAILED. Expected 10/2 tokens, got ${inputTokens}/${outputTokens}`);
    process.exit(1);
  }
}

function testAnthropicSSE() {
  const provider = 'anthropic';
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

  parser.feed('data: {"type": "message_start", "message": {"usage": {"input_tokens": 25}}}');
  parser.feed('\n\n');
  parser.feed('data: {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hel"}}');
  parser.feed('\n\n');
  parser.feed('data: {"type": "message_delta", "usage": {"output_tokens": 15}}');
  parser.feed('\n\n');

  if (inputTokens === 25 && outputTokens === 15) {
    console.log('✅ Anthropic Streaming test PASSED.');
  } else {
    console.error(`❌ Anthropic Streaming test FAILED. Expected 25/15 tokens, got ${inputTokens}/${outputTokens}`);
    process.exit(1);
  }
}

function testGeminiSSE() {
  const provider = 'gemini';
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

  parser.feed('data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]}}], "usageMetadata": {"promptTokenCount": 5, "candidatesTokenCount": 2}}');
  parser.feed('\n\n');

  if (inputTokens === 5 && outputTokens === 2) {
    console.log('✅ Gemini Streaming test PASSED.');
  } else {
    console.error(`❌ Gemini Streaming test FAILED. Expected 5/2 tokens, got ${inputTokens}/${outputTokens}`);
    process.exit(1);
  }
}

console.log('--- Testing Streaming Parsers ---');
testOpenAISSE();
testAnthropicSSE();
testGeminiSSE();
console.log('All streaming tests passed successfully.\n');
