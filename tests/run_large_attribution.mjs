import { TokenAttributionAnalyzer } from '../packages/estimators/dist/attribution.js';
import { endToEndMockReq } from './evaluate_optimizations.mjs';

const attribution = TokenAttributionAnalyzer.analyze(endToEndMockReq);

console.log('\n--- TOKEN ATTRIBUTION REPORT ---');
console.log('Incoming prompt');
console.log(`Total: ${attribution.totalTokens.toLocaleString()} tokens`);
console.log('\nBreakdown');

const pct = (val) => ((val / (attribution.totalTokens || 1)) * 100).toFixed(0).padStart(2, ' ');
console.log(`Source code               ${pct(attribution.sourceCodeTokens)}%`);
console.log(`Logs                      ${pct(attribution.logsTokens)}%`);
console.log(`Tool schemas              ${pct(attribution.toolSchemasTokens)}%`);
console.log(`JSON payloads             ${pct(attribution.jsonPayloadsTokens)}%`);
console.log(`Conversation              ${pct(attribution.conversationTokens)}%`);
console.log(`System prompt             ${pct(attribution.systemPromptTokens)}%`);
