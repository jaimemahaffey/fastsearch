import * as path from 'node:path';
import * as vscode from 'vscode';
import { minimatch } from 'minimatch';
import type { FastIndexerConfig } from '../configuration';
import { WORKSPACE_FILE_EXCLUDE_GLOB } from './workspaceWatcher';

export type ResolvedIgnoreFile = {
  scope: 'workspace-folder' | 'workspace';
  ignoreFilePath: string;
  ruleBasePath: string;
  workspaceFolderPath?: string;
};

export type NormalizedIgnoreRule = {
  sourcePath: string;
  ruleBasePath: string;
  pattern: string;
  negated: boolean;
  directoryOnly: boolean;
};

export type IgnoreMatcher = {
  ignores(filePath: string, relativePath: string): boolean;
};

type IgnoreFileConfig = Pick<FastIndexerConfig, 'ignoreFiles' | 'sharedIgnoreFiles'>;

export type LoadedIgnoreMatcher = {
  matcher: IgnoreMatcher;
  resolvedIgnoreFiles: ResolvedIgnoreFile[];
  diagnostics: string[];
  persistenceInputs: Array<{
    path: string;
    rules?: string[];
    missing?: boolean;
  }>;
};

export function resolveConfiguredIgnoreFiles(
  config: IgnoreFileConfig,
  workspaceFolders: readonly vscode.WorkspaceFolder[],
  workspaceFile?: vscode.Uri
): ResolvedIgnoreFile[] {
  const perFolderEntries = config.ignoreFiles
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const sharedEntries = config.sharedIgnoreFiles
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const resolved: ResolvedIgnoreFile[] = [];

  for (const workspaceFolder of workspaceFolders) {
    for (const entry of perFolderEntries) {
      const ignoreFilePath = path.resolve(workspaceFolder.uri.fsPath, entry);
      resolved.push({
        scope: 'workspace-folder',
        workspaceFolderPath: workspaceFolder.uri.fsPath,
        ignoreFilePath,
        ruleBasePath: path.dirname(ignoreFilePath)
      });
    }
  }

  const sharedBasePath = getSharedWorkspaceBasePath(workspaceFolders, workspaceFile);
  if (!sharedBasePath) {
    return resolved;
  }

  for (const entry of sharedEntries) {
    const ignoreFilePath = path.resolve(sharedBasePath, entry);
    resolved.push({
      scope: 'workspace',
      ignoreFilePath,
      ruleBasePath: sharedBasePath
    });
  }

  return resolved;
}

export function parseIgnoreFileContent(content: string, source: ResolvedIgnoreFile): NormalizedIgnoreRule[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => {
      const negated = line.startsWith('!');
      const rawPattern = negated ? line.slice(1) : line;
      const directoryOnly = rawPattern.endsWith('/');
      const normalizedPattern = normalizeRulePattern(directoryOnly ? rawPattern.slice(0, -1) : rawPattern);

      return {
        sourcePath: source.ignoreFilePath,
        ruleBasePath: source.ruleBasePath,
        pattern: normalizedPattern,
        negated,
        directoryOnly
      };
    })
    .filter((rule) => rule.pattern.length > 0);
}

export function createIgnoreMatcher(options: {
  exclude: string[];
  ignoreRules: NormalizedIgnoreRule[];
}): IgnoreMatcher {
  const excludePatterns = options.exclude
    .map((pattern) => normalizePattern(pattern.trim()))
    .filter((pattern) => pattern.length > 0);

  return {
    ignores(filePath: string, relativePath: string): boolean {
      const normalizedRelativePath = normalizePattern(relativePath);
      if (matchesGlob(normalizedRelativePath, WORKSPACE_FILE_EXCLUDE_GLOB)) {
        return true;
      }

      if (excludePatterns.some((pattern) => matchesGlob(normalizedRelativePath, pattern))) {
        return true;
      }

      let ignored = false;
      for (const rule of options.ignoreRules) {
        if (!matchesIgnoreRule(filePath, rule)) {
          continue;
        }

        ignored = !rule.negated;
      }

      return ignored;
    }
  };
}

export async function loadConfiguredIgnoreMatcher(
  fileSystem: Pick<typeof vscode.workspace.fs, 'readFile'>,
  config: IgnoreFileConfig & Pick<FastIndexerConfig, 'exclude'>,
  workspaceFolders: readonly vscode.WorkspaceFolder[],
  workspaceFile?: vscode.Uri
): Promise<LoadedIgnoreMatcher> {
  const resolvedIgnoreFiles = resolveConfiguredIgnoreFiles(config, workspaceFolders, workspaceFile);
  const diagnostics: string[] = [];
  const ignoreRules: NormalizedIgnoreRule[] = [];
  const persistenceInputs: LoadedIgnoreMatcher['persistenceInputs'] = [];

  for (const source of resolvedIgnoreFiles) {
    try {
      const content = Buffer.from(await fileSystem.readFile(vscode.Uri.file(source.ignoreFilePath))).toString('utf8');
      const parsedRules = parseIgnoreFileContent(content, source);
      ignoreRules.push(...parsedRules);
      persistenceInputs.push({
        path: normalizePersistencePath(source.ignoreFilePath),
        rules: parsedRules.map((rule) => `${rule.negated ? '!' : ''}${rule.pattern}${rule.directoryOnly ? '/' : ''}`)
      });
    } catch (error) {
      diagnostics.push(`Skipping ignore file ${source.ignoreFilePath}: ${error instanceof Error ? error.message : String(error)}`);
      persistenceInputs.push({
        path: normalizePersistencePath(source.ignoreFilePath),
        missing: true
      });
    }
  }

  return {
    matcher: createIgnoreMatcher({
      exclude: config.exclude,
      ignoreRules
    }),
    resolvedIgnoreFiles,
    diagnostics,
    persistenceInputs
  };
}

function getSharedWorkspaceBasePath(
  workspaceFolders: readonly vscode.WorkspaceFolder[],
  workspaceFile?: vscode.Uri
): string | undefined {
  if (workspaceFile) {
    return path.dirname(workspaceFile.fsPath);
  }

  if (workspaceFolders.length > 0) {
    return workspaceFolders[0]!.uri.fsPath;
  }

  return undefined;
}

function matchesIgnoreRule(filePath: string, rule: NormalizedIgnoreRule): boolean {
  const relativeCandidate = path.relative(rule.ruleBasePath, filePath);
  if (!relativeCandidate || relativeCandidate.startsWith('..') || path.isAbsolute(relativeCandidate)) {
    return false;
  }

  const normalizedCandidate = normalizePattern(relativeCandidate);
  if (rule.directoryOnly) {
    const directoryPattern = rule.pattern.includes('/')
      ? `${rule.pattern}/**`
      : `**/${rule.pattern}/**`;
    return normalizedCandidate === rule.pattern || matchesGlob(normalizedCandidate, directoryPattern);
  }

  return matchesGlob(normalizedCandidate, rule.pattern);
}

function matchesGlob(value: string, pattern: string): boolean {
  return minimatch(value, pattern, {
    dot: true,
    matchBase: !pattern.includes('/'),
    nocase: false,
    windowsPathsNoEscape: true
  });
}

function normalizePattern(pattern: string): string {
  return pattern.replace(/\\/g, '/');
}

function normalizeRulePattern(pattern: string): string {
  return normalizePattern(pattern).replace(/^\/+/, '');
}

function normalizePersistencePath(filePath: string): string {
  return path.normalize(filePath).toLowerCase();
}
