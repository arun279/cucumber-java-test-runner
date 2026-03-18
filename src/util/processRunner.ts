import { spawn, ChildProcess } from 'child_process';
import * as vscode from 'vscode';
import treeKill from 'tree-kill';

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  killed: boolean;
}

export interface SpawnOptions {
  cwd: string;
  env?: Record<string, string>;
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
  cancellation?: vscode.CancellationToken;
}

export function spawnProcess(
  executable: string,
  args: string[],
  options: SpawnOptions,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let killed = false;
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    const env = options.env
      ? { ...process.env, ...options.env }
      : process.env;

    let proc: ChildProcess;
    try {
      proc = spawn(executable, args, {
        cwd: options.cwd,
        env,
        stdio: 'pipe',
        windowsHide: true,
      });
    } catch (err) {
      reject(new Error(
        `Failed to spawn process "${executable}": ${err instanceof Error ? err.message : String(err)}`,
      ));
      return;
    }

    proc.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(
          `Executable not found: "${executable}". Ensure it is installed and on your PATH.`,
        ));
      } else {
        reject(err);
      }
    });

    let stdoutBuffer = '';
    let stderrBuffer = '';

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      stdoutChunks.push(text);

      if (options.onStdout) {
        stdoutBuffer += text;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          options.onStdout(line);
        }
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      stderrChunks.push(text);

      if (options.onStderr) {
        stderrBuffer += text;
        const lines = stderrBuffer.split(/\r?\n/);
        stderrBuffer = lines.pop() ?? '';
        for (const line of lines) {
          options.onStderr(line);
        }
      }
    });

    proc.on('close', (code) => {
      if (options.onStdout && stdoutBuffer) {
        options.onStdout(stdoutBuffer);
      }
      if (options.onStderr && stderrBuffer) {
        options.onStderr(stderrBuffer);
      }

      resolve({
        exitCode: code ?? 1,
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
        killed,
      });
    });

    if (options.cancellation) {
      const disposable = options.cancellation.onCancellationRequested(() => {
        killed = true;
        killProcessTree(proc.pid);
        disposable.dispose();
      });

      proc.on('close', () => {
        disposable.dispose();
      });
    }
  });
}

function killProcessTree(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  treeKill(pid, 'SIGTERM', (err) => {
    if (err) {
      treeKill(pid, 'SIGKILL');
    }
  });
}
