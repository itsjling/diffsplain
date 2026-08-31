const tokenFields = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
];

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function providerUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const tokens = Object.fromEntries(
    tokenFields.flatMap((field) => {
      const count = tokenCount(value[field]);
      return count === undefined ? [] : [[field, count]];
    }),
  );
  return Object.keys(tokens).length ? tokens : undefined;
}

export function emptyUsageAccumulator() {
  return { calls: 0, reportedCalls: 0, tokens: {} };
}

export function recordUsage(accumulator, usage) {
  const reported = providerUsage(usage);
  const tokens = { ...accumulator.tokens };
  if (reported) {
    for (const [field, count] of Object.entries(reported)) {
      tokens[field] = (tokens[field] || 0) + count;
    }
  }
  return {
    calls: accumulator.calls + 1,
    reportedCalls: accumulator.reportedCalls + (reported ? 1 : 0),
    tokens,
  };
}

export function usageSummary(accumulator) {
  if (accumulator.calls === 0) {
    return {
      status: 'complete',
      calls: 0,
      reportedCalls: 0,
      tokens: { inputTokens: 0, outputTokens: 0 },
    };
  }
  if (accumulator.reportedCalls === 0) {
    return {
      status: 'unavailable',
      calls: accumulator.calls,
      reportedCalls: 0,
    };
  }
  return {
    status: accumulator.reportedCalls === accumulator.calls
      ? 'complete'
      : 'partial',
    calls: accumulator.calls,
    reportedCalls: accumulator.reportedCalls,
    tokens: { ...accumulator.tokens },
  };
}

function accumulatorFromSummary(summary) {
  if (!summary || typeof summary !== 'object') return emptyUsageAccumulator();
  return {
    calls: tokenCount(summary.calls) || 0,
    reportedCalls: tokenCount(summary.reportedCalls) || 0,
    tokens: providerUsage(summary.tokens) || {},
  };
}

export function combineUsage(left, right) {
  const first = accumulatorFromSummary(left);
  const second = accumulatorFromSummary(right);
  const tokens = { ...first.tokens };
  for (const [field, count] of Object.entries(second.tokens)) {
    tokens[field] = (tokens[field] || 0) + count;
  }
  return usageSummary({
    calls: first.calls + second.calls,
    reportedCalls: first.reportedCalls + second.reportedCalls,
    tokens,
  });
}

export function reviewUsage(agentNotes, reviewChat) {
  return {
    agentNotes,
    reviewChat,
    combined: combineUsage(agentNotes, reviewChat),
  };
}

const terminalLabels = {
  inputTokens: 'input',
  outputTokens: 'output',
  cacheReadTokens: 'cache read',
  cacheWriteTokens: 'cache write',
};

export function formatUsage(label, summary) {
  if (summary.status === 'unavailable') return `${label}: Unavailable`;
  const totals = Object.entries(summary.tokens || {})
    .map(([field, count]) => `${terminalLabels[field]} ${count.toLocaleString('en-US')}`)
    .join(', ');
  const prefix = summary.status === 'partial' ? 'Partial, ' : '';
  return `${label}: ${prefix}${totals || '0 tokens'}`;
}

export function formatReviewUsage(usage) {
  return [
    formatUsage('Agent note usage', usage.agentNotes),
    formatUsage('Review chat usage', usage.reviewChat),
    formatUsage('Combined agent usage', usage.combined),
  ].join('\n');
}
