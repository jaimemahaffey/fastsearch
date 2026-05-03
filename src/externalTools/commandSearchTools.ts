import { spawn } from 'node:child_process';

export type CommandSearchTool = 'rg' | 'fzf';

export const COMMAND_SEARCH_TOOL_TIMEOUT_MS = 1000;

export type CommandSearchToolAvailability = {
  rg: boolean;
  fzf: boolean;
};

export type ExternalToolRunOptions = {
  enabled: boolean;
  input?: string;
  timeoutMs?: number;
  allowedExitCodes?: number[];
};

export type ExternalToolResult =
  | {
      ok: true;
      tool: CommandSearchTool;
      stdout: string;
      stderr: string;
    }
  | {
      ok: false;
      tool: CommandSearchTool;
      reason: 'disabled' | 'missing' | 'failed';
      stderr?: string;
    };

export type ToolAvailabilityProbe = (tool: CommandSearchTool) => Promise<boolean>;

export type ExternalToolRunner = (
  tool: CommandSearchTool,
  args: string[],
  input?: string
) => Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

export async function detectCommandSearchTools(
  probe: ToolAvailabilityProbe
): Promise<CommandSearchToolAvailability> {
  const [rg, fzf] = await Promise.all([
    probe('rg'),
    probe('fzf')
  ]);

  return { rg, fzf };
}

export async function runExternalTool(
  tool: CommandSearchTool,
  args: string[],
  options: ExternalToolRunOptions,
  runner: ExternalToolRunner
): Promise<ExternalToolResult> {
  if (!options.enabled) {
    return {
      ok: false,
      tool,
      reason: 'disabled'
    };
  }

  try {
    const result = await runner(tool, args, options.input);
    const allowedExitCodes = new Set(options.allowedExitCodes ?? []);
    if (result.exitCode !== 0 && !allowedExitCodes.has(result.exitCode)) {
      return {
        ok: false,
        tool,
        reason: 'failed',
        stderr: result.stderr
      };
    }

    return {
      ok: true,
      tool,
      stdout: result.stdout,
      stderr: result.stderr
    };
  } catch (error) {
    if (isMissingBinaryError(error)) {
      return {
        ok: false,
        tool,
        reason: 'missing'
      };
    }

    return {
      ok: false,
      tool,
      reason: 'failed',
      stderr: error instanceof Error ? error.message : String(error)
    };
  }
}

export const defaultExternalToolRunner: ExternalToolRunner = (tool, args, input) => new Promise((resolve, reject) => {
  const child = spawn(tool, args, {
    stdio: 'pipe',
    windowsHide: true
  });

  let stdout = '';
  let stderr = '';
  let settled = false;
  const timeout = setTimeout(() => {
    if (settled) {
      return;
    }

    settled = true;
    child.kill();
    reject(new Error(`${tool} timed out`));
  }, COMMAND_SEARCH_TOOL_TIMEOUT_MS);

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.on('error', (error) => {
    if (settled) {
      return;
    }

    settled = true;
    clearTimeout(timeout);
    reject(error);
  });
  child.on('close', (exitCode) => {
    if (settled) {
      return;
    }

    settled = true;
    clearTimeout(timeout);
    resolve({
      exitCode: exitCode ?? 1,
      stdout,
      stderr
    });
  });

  if (input) {
    child.stdin.write(input);
  }

  child.stdin.end();
});

function isMissingBinaryError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ENOENT';
}
