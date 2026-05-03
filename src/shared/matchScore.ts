export function scoreCandidate(query: string, candidate: string): number {
  const q = query.trim().toLowerCase();
  const c = candidate.toLowerCase();
  if (!q) {
    return -1;
  }

  if (c === q) {
    return 400;
  }
  if (c.startsWith(q)) {
    return 250;
  }
  if (c.includes(q)) {
    return 150;
  }

  let queryIndex = 0;
  let firstMatchIndex = -1;
  let previousMatchIndex = -1;
  let gaps = 0;

  for (let candidateIndex = 0; candidateIndex < c.length && queryIndex < q.length; candidateIndex += 1) {
    if (c[candidateIndex] !== q[queryIndex]) {
      continue;
    }

    if (firstMatchIndex < 0) {
      firstMatchIndex = candidateIndex;
    }

    if (previousMatchIndex >= 0) {
      gaps += candidateIndex - previousMatchIndex - 1;
    }

    previousMatchIndex = candidateIndex;
    queryIndex += 1;
  }

  if (queryIndex !== q.length || firstMatchIndex < 0 || previousMatchIndex < 0) {
    return -1;
  }

  const span = previousMatchIndex - firstMatchIndex + 1;
  return Math.max(25, 120 - gaps - (span - q.length));
}
