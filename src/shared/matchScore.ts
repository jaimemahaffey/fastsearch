export function scoreCandidate(query: string, candidate: string): number {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  if (c === q) {
    return 400;
  }
  if (c.startsWith(q)) {
    return 250;
  }
  if (c.includes(q)) {
    return 150;
  }
  return -1;
}
