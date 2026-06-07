import assert from 'assert';
import { DBManager } from '../packages/core/dist/db.js';
import { TelemetryLogger } from '../packages/telemetry/dist/index.js';

async function run() {
  console.log('--- Starting Event Sourcing Tests ---');
  
  const db = new DBManager(':memory:');
  const logger = new TelemetryLogger(db);
  
  const sessionId = 'session-events-test';
  const requestId = 'req-123';
  const provider = 'openai';

  logger.startSession(sessionId, null, 100);

  // Simulate a blocked request (runaway loop)
  logger.emitEvent({
    eventType: 'request_received',
    sessionId,
    requestId,
    provider,
    metadata: { url: 'https://api.openai.com' }
  });

  logger.emitEvent({
    eventType: 'runaway_loop_detected',
    sessionId,
    requestId,
    provider,
    model: 'gpt-4',
    metadata: { reason: 'Repeating identical prompt' }
  });

  logger.reconcileRequest(requestId, 0, 'blocked', 'failed');

  // Assert events
  const events = logger.reconstructRequest(requestId);
  
  assert.strictEqual(events.length, 2, 'Should have exactly 2 events for the blocked request');
  assert.strictEqual(events[0].event_type, 'request_received');
  assert.strictEqual(events[1].event_type, 'runaway_loop_detected');

  const metadata = JSON.parse(events[1].metadata);
  assert.strictEqual(metadata.reason, 'Repeating identical prompt');

  console.log('✅ Blocked Request Timeline successfully reconstructed.');

  // Simulate a full successful stream
  const req2 = 'req-456';
  logger.emitEvent({ eventType: 'request_received', sessionId, requestId: req2, provider });
  logger.emitEvent({ eventType: 'reservation_created', sessionId, requestId: req2, provider });
  logger.emitEvent({ eventType: 'approval_requested', sessionId, requestId: req2, provider });
  logger.emitEvent({ eventType: 'approval_granted', sessionId, requestId: req2, provider });
  logger.emitEvent({ eventType: 'provider_request_sent', sessionId, requestId: req2, provider });
  logger.emitEvent({ eventType: 'provider_stream_started', sessionId, requestId: req2, provider });
  logger.emitEvent({ eventType: 'request_stream_completed', sessionId, requestId: req2, provider });
  logger.emitEvent({ eventType: 'provider_usage_received', sessionId, requestId: req2, provider });
  logger.emitEvent({ eventType: 'request_reconciled', sessionId, requestId: req2, provider });

  const streamEvents = logger.reconstructRequest(req2);
  assert.strictEqual(streamEvents.length, 9, 'Should have 9 events for full stream lifecycle');
  assert.strictEqual(streamEvents[0].event_type, 'request_received');
  assert.strictEqual(streamEvents[streamEvents.length - 1].event_type, 'request_reconciled');

  console.log('✅ Full Stream Timeline successfully reconstructed.');

  console.log('🎉 All Event Sourcing Tests PASSED.');
}

run().catch(err => {
  console.error('❌ Event Sourcing Tests FAILED:', err);
  process.exit(1);
});
