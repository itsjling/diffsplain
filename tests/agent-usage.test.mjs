import assert from 'node:assert/strict';
import test from 'node:test';
import {
  combineUsage,
  emptyUsageAccumulator,
  formatReviewUsage,
  formatUsage,
  recordUsage,
  usageSummary,
} from '../scripts/agent-usage.mjs';

test('distinguishes zero, unavailable, partial, and complete usage', () => {
  const zero = usageSummary(emptyUsageAccumulator());
  assert.deepEqual(zero, {
    status: 'complete',
    calls: 0,
    reportedCalls: 0,
    tokens: { inputTokens: 0, outputTokens: 0 },
  });

  const unavailable = usageSummary(recordUsage(emptyUsageAccumulator()));
  assert.deepEqual(unavailable, {
    status: 'unavailable',
    calls: 1,
    reportedCalls: 0,
  });

  const one = recordUsage(emptyUsageAccumulator(), {
    inputTokens: 12,
    outputTokens: 3,
    cacheReadTokens: 8,
  });
  const partial = usageSummary(recordUsage(one));
  assert.deepEqual(partial, {
    status: 'partial',
    calls: 2,
    reportedCalls: 1,
    tokens: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 8 },
  });

  assert.equal(formatUsage('Agent usage', partial),
    'Agent usage: Partial, input 12, output 3, cache read 8');
  assert.equal(formatReviewUsage({
    agentNotes: partial,
    reviewChat: zero,
    combined: combineUsage(partial, zero),
  }), [
    'Agent note usage: Partial, input 12, output 3, cache read 8',
    'Review chat usage: input 0, output 0',
    'Combined agent usage: Partial, input 12, output 3, cache read 8',
  ].join('\n'));
});

test('combines note and chat calls without inventing missing token fields', () => {
  const notes = usageSummary(recordUsage(emptyUsageAccumulator(), {
    inputTokens: 20,
    outputTokens: 5,
    cacheWriteTokens: 4,
  }));
  const chat = usageSummary(recordUsage(emptyUsageAccumulator(), {
    inputTokens: 7,
    outputTokens: 2,
  }));
  assert.deepEqual(combineUsage(notes, chat), {
    status: 'complete',
    calls: 2,
    reportedCalls: 2,
    tokens: {
      inputTokens: 27,
      outputTokens: 7,
      cacheWriteTokens: 4,
    },
  });
});
