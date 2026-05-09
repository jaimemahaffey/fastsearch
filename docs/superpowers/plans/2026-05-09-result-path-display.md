# Result Path Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the `file:///` prefix from user-facing FastSearch result details while keeping raw URIs unchanged for navigation.

**Architecture:** Keep the change inside `src/shared/commandSearch.ts`, where shared candidate builders already shape file, text, symbol, usage, and implementation results. Add one display-path helper for file URIs, reuse it when composing `detail` strings, and prove the behavior with focused command-search tests before running the full suite.

**Tech Stack:** TypeScript, VS Code extension APIs, Mocha test suite

---

## File Map

- Modify: `src/shared/commandSearch.ts` — add the shared file-URI display formatter and wire it into candidate builders and semantic detail formatting.
- Modify: `src/test/suite/commandSearch.test.ts` — update shared candidate-builder expectations to assert plain displayed paths instead of `file:///...` strings.

### Task 1: Normalize displayed file paths in shared command-search candidates

**Files:**
- Modify: `src/test/suite/commandSearch.test.ts`
- Modify: `src/shared/commandSearch.ts`
- Test: `src/test/suite/commandSearch.test.ts`

- [ ] **Step 1: Write the failing test expectations**

Update the shared candidate-builder test and semantic detail assertions so they expect a plain displayed path derived from the URI instead of the raw `file:///...` string.

```ts
test('normalizes built-in result shapes into shared command search candidates', () => {
  const fileRecord: FileRecord = {
    relativePath: 'src/app/main.ts',
    uri: 'file:///workspace/src/app/main.ts',
    basename: 'main.ts',
    extension: '.ts',
    tokens: ['src', 'app', 'main', 'ts']
  };
  const displayPath = vscode.Uri.parse(fileRecord.uri).fsPath;
  const textMatch: TextMatch = {
    relativePath: 'src/app/main.ts',
    uri: fileRecord.uri,
    line: 7,
    column: 3,
    preview: 'const alpha = beta;'
  };
  const symbolRecord: SymbolRecord = {
    name: 'AlphaService',
    kind: 5,
    containerName: 'services',
    uri: fileRecord.uri,
    startLine: 10,
    startColumn: 2,
    approximate: false
  };
  const discoveryResult: DiscoveryResult = {
    uri: fileRecord.uri,
    line: 14,
    approximate: true
  };

  assert.deepEqual(toFileSearchCandidate(fileRecord), {
    source: 'file',
    label: 'main.ts',
    description: 'src/app/main.ts',
    detail: displayPath,
    filterText: 'main.ts src/app/main.ts',
    uri: fileRecord.uri,
    approximate: false
  });
  assert.equal(toTextSearchCandidate(textMatch).detail, displayPath);
  assert.equal(toSymbolSearchCandidate(symbolRecord).detail, displayPath);
  assert.equal(toDiscoverySearchCandidate('usage', discoveryResult).detail, displayPath);
});

test('formats semantic symbol detail with references, implementations, and provider', () => {
  const semanticMetadata: SemanticMetadata = {
    definition: { uri: 'file:///workspace/src/app/main.ts', line: 10, column: 2 },
    implementationCount: 3,
    referenceCount: 7,
    provider: 'vscode',
    status: 'enriched',
    confidence: 1,
    enrichedAt: 123
  };

  const detail = getSemanticSymbolDetail('file:///workspace/src/app/main.ts', semanticMetadata);

  assert.equal(detail, `${vscode.Uri.parse('file:///workspace/src/app/main.ts').fsPath} • 7 refs • 3 impls • vscode`);
});

test('preserves semanticConfidence from non-enriched metadata while falling back detail to the display path', () => {
  const symbolRecord: SymbolRecord = {
    name: 'BetaService',
    kind: 5,
    containerName: 'services',
    uri: 'file:///workspace/src/app/service.ts',
    startLine: 20,
    startColumn: 4,
    approximate: false
  };
  const semanticMetadata: SemanticMetadata = {
    definition: { uri: 'file:///workspace/src/app/service.ts', line: 20, column: 4 },
    implementationCount: undefined,
    referenceCount: undefined,
    provider: 'vscode',
    status: 'pending',
    confidence: 0.8,
    enrichedAt: 456
  };

  const candidate = toSymbolSearchCandidate(symbolRecord, semanticMetadata);

  assert.equal(candidate.detail, vscode.Uri.parse(symbolRecord.uri).fsPath);
  assert.equal(candidate.semanticConfidence, 0.8);
});
```

- [ ] **Step 2: Run the focused command-search test to verify it fails**

Run:

```powershell
$env:MOCHA_GREP='commandSearch'; npm test
```

Expected: FAIL because `src/shared/commandSearch.ts` still returns raw URI strings for `detail`.

- [ ] **Step 3: Implement the shared display-path formatter**

Add one helper in `src/shared/commandSearch.ts` and reuse it in every shared candidate builder that currently surfaces the raw URI as display detail.

```ts
export function getCommandSearchDisplayPath(uri: string): string {
  const parsed = vscode.Uri.parse(uri);
  return parsed.scheme === 'file' ? parsed.fsPath : uri;
}

export function toFileSearchCandidate(record: FileRecord): CommandSearchCandidate {
  return {
    source: 'file',
    label: record.basename,
    description: record.relativePath,
    detail: getCommandSearchDisplayPath(record.uri),
    filterText: `${record.basename} ${record.relativePath}`,
    uri: record.uri,
    approximate: false
  };
}

export function getSemanticSymbolDetail(uri: string, semanticMetadata?: SemanticMetadata): string {
  const displayPath = getCommandSearchDisplayPath(uri);
  if (!semanticMetadata || semanticMetadata.status !== 'enriched') {
    return displayPath;
  }

  const parts: string[] = [displayPath];
  if (semanticMetadata.referenceCount !== undefined) {
    parts.push(`${semanticMetadata.referenceCount} refs`);
  }
  if (semanticMetadata.implementationCount !== undefined) {
    parts.push(`${semanticMetadata.implementationCount} impls`);
  }
  parts.push(semanticMetadata.provider);
  return parts.join(' • ');
}
```

Apply the same helper to:

```ts
detail: getCommandSearchDisplayPath(match.uri)
detail: getCommandSearchDisplayPath(result.uri)
```

- [ ] **Step 4: Run the focused command-search test to verify it passes**

Run:

```powershell
$env:MOCHA_GREP='commandSearch'; npm test
```

Expected: PASS.

- [ ] **Step 5: Commit the shared path-display change**

Run:

```powershell
git add src\shared\commandSearch.ts src\test\suite\commandSearch.test.ts
git commit -m "fix: remove file URI prefixes from displayed result paths" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Re-run the full suite on the finished behavior

**Files:**
- Modify: `src/shared/commandSearch.ts` (already updated in Task 1)
- Modify: `src/test/suite/commandSearch.test.ts` (already updated in Task 1)
- Test: `src/test/suite/commandSearch.test.ts`

- [ ] **Step 1: Run the full test suite**

Run:

```powershell
npm test
```

Expected: PASS with the existing suite count and no new failures in discovery or activation behavior.

- [ ] **Step 2: Inspect the working tree**

Run:

```powershell
git --no-pager status --short
git --no-pager diff --check
```

Expected: only the intended shared command-search files are changed and there is no whitespace damage.

- [ ] **Step 3: Commit any follow-up fix if the full suite required one**

If Task 2 required no code changes, do not add another commit.

If a follow-up edit was needed in the shared formatter or its tests, run:

```powershell
git add src\shared\commandSearch.ts src\test\suite\commandSearch.test.ts
git commit -m "test: stabilize result path display coverage" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```
