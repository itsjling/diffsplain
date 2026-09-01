const tokenFields = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
];

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function usageObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : undefined;
}

function usageEntries(value) {
  return tokenFields.reduce((entries, field) => {
    const count = tokenCount(value[field]);
    return count === undefined ? entries : [...entries, [field, count]];
  }, []);
}

function providerUsage(value) {
  const usage = usageObject(value);
  if (!usage) return undefined;
  const tokens = Object.fromEntries(usageEntries(usage));
  return Object.keys(tokens).length > 0 ? tokens : undefined;
}

function countOrZero(value) {
  return tokenCount(value) || 0;
}

function summaryTokens(value) {
  return providerUsage(value) || {};
}

export function emptyUsageAccumulator() {
  return { calls: 0, reportedCalls: 0, tokens: {} };
}

function mergedTokens(left, right) {
  const tokens = { ...left };
  for (const [field, count] of Object.entries(right || {})) {
    tokens[field] = (tokens[field] || 0) + count;
  }
  return tokens;
}

export function recordUsage(accumulator, usage) {
  const reported = providerUsage(usage);
  return {
    calls: accumulator.calls + 1,
    reportedCalls: accumulator.reportedCalls + Number(Boolean(reported)),
    tokens: mergedTokens(accumulator.tokens, reported),
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
  const usage = usageObject(summary);
  if (!usage) return emptyUsageAccumulator();
  return {
    calls: countOrZero(usage.calls),
    reportedCalls: countOrZero(usage.reportedCalls),
    tokens: summaryTokens(usage.tokens),
  };
}

export function combineUsage(left, right) {
  const first = accumulatorFromSummary(left);
  const second = accumulatorFromSummary(right);
  return usageSummary({
    calls: first.calls + second.calls,
    reportedCalls: first.reportedCalls + second.reportedCalls,
    tokens: mergedTokens(first.tokens, second.tokens),
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

function formatUsageTokens(tokens) {
  return Object.entries(tokens || {})
    .map(([field, count]) => `${terminalLabels[field]} ${count.toLocaleString('en-US')}`)
    .join(', ');
}

export function formatUsage(label, summary) {
  if (summary.status === 'unavailable') return `${label}: Unavailable`;
  const totals = formatUsageTokens(summary.tokens);
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
