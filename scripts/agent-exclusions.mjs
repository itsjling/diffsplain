import ignore from 'ignore';

export function createAgentExclusionMatcher(
  rules = [],
  { ignoreCase = false } = {},
) {
  if (!rules.length) return () => false;
  const matcher = ignore({ ignorecase: ignoreCase }).add(rules);
  return (path) => matcher.ignores(path);
}
