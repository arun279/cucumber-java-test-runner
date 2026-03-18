import * as vscode from 'vscode';
import * as net from 'net';
import { CommandSpec } from '../execution/types';
import { spawnProcess, ProcessResult } from '../util/processRunner';
import { Logger } from '../util/logger';

const DEBUG_TIMEOUT_MS = 120_000; // 2 minutes for Maven compile + fork
const JDWP_READY_PATTERN = /Listening for transport dt_socket at address:\s*(\d+)/;
const DEBUGGER_ATTACH_RETRY_MS = 500;
const DEBUGGER_ATTACH_MAX_RETRIES = 5;

export class DebugManager {
  constructor(private readonly logger: Logger) {}

  /**
   * Finds an available TCP port by binding to port 0 and reading the assigned port.
   */
  async findAvailablePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          const port = address.port;
          server.close(() => resolve(port));
        } else {
          server.close(() => reject(new Error('Failed to get port from server address')));
        }
      });
      server.on('error', reject);
    });
  }

  /**
   * Executes a Maven command with JDWP debugging.
   *
   * Detection strategy: Parse stdout/stderr for the JDWP "Listening for transport"
   * message (Surefire does forward this from the forked JVM's stderr). Then attach
   * the VS Code debugger with retries — no raw TCP port polling that would trigger
   * spurious "handshake failed" errors from the JDWP agent.
   */
  async executeWithDebug(
    commandSpec: CommandSpec,
    debugPort: number,
    workspaceFolder: vscode.WorkspaceFolder,
    testRun: vscode.TestRun,
    cancellation: vscode.CancellationToken,
  ): Promise<ProcessResult> {
    // Check for Java debugger extension
    const javaDebugExt = vscode.extensions.getExtension('vscjava.vscode-java-debug');
    if (!javaDebugExt) {
      const action = await vscode.window.showErrorMessage(
        'Debug requires the "Debugger for Java" extension.',
        'Install',
      );
      if (action === 'Install') {
        await vscode.commands.executeCommand(
          'workbench.extensions.installExtension',
          'vscjava.vscode-java-debug',
        );
      }
      throw new Error('Debugger for Java extension is not installed');
    }

    this.logger.info(`Starting debug session on port ${debugPort}`);

    // State for JDWP detection
    let jdwpReady = false;
    let resolveJdwp: () => void;
    let rejectJdwp: (err: Error) => void;

    const jdwpReadyPromise = new Promise<void>((resolve, reject) => {
      resolveJdwp = resolve;
      rejectJdwp = reject;
    });

    // Timeout for JDWP readiness
    const timeout = setTimeout(() => {
      if (!jdwpReady) {
        rejectJdwp(new Error(
          `Debug session timed out after ${DEBUG_TIMEOUT_MS / 1000}s waiting for Surefire forked JVM. ` +
          'This may indicate a compilation error or missing test class.',
        ));
      }
    }, DEBUG_TIMEOUT_MS);

    const checkForJdwp = (line: string): void => {
      if (jdwpReady) return;
      const match = JDWP_READY_PATTERN.exec(line);
      if (match) {
        jdwpReady = true;
        clearTimeout(timeout);
        this.logger.info(`JDWP ready detected on port ${match[1]}`);
        resolveJdwp();
      }
    };

    // Spawn Maven process
    const processPromise = spawnProcess(
      commandSpec.executable,
      commandSpec.args,
      {
        cwd: commandSpec.cwd,
        env: commandSpec.env,
        onStdout: (line) => {
          testRun.appendOutput(line + '\r\n');
          checkForJdwp(line);
        },
        onStderr: (line) => {
          testRun.appendOutput(line + '\r\n');
          checkForJdwp(line);
        },
        cancellation,
      },
    );

    // If process exits before JDWP is ready, reject
    processPromise.then((result) => {
      if (!jdwpReady) {
        clearTimeout(timeout);
        rejectJdwp(new Error(
          `Maven process exited (code ${result.exitCode}) before JDWP became ready. ` +
          'Check the test output for compilation errors.',
        ));
      }
    }).catch(() => {
      // Spawn error handled by the caller
    });

    // Wait for JDWP "Listening" message in stdout/stderr
    try {
      await jdwpReadyPromise;
    } catch (err) {
      this.logger.error('Failed waiting for JDWP', err);
      throw err;
    }

    // Attach VS Code's Java debugger with retries.
    // The JDWP agent is ready but startDebugging may fail on the first attempt
    // if the agent hasn't fully initialized its protocol handler yet.
    this.logger.info('Attaching Java debugger...');
    const attached = await this.attachDebuggerWithRetry(
      workspaceFolder,
      debugPort,
      DEBUGGER_ATTACH_MAX_RETRIES,
    );

    if (!attached) {
      this.logger.warn('Failed to attach debugger after retries — tests will run without debugging');
    } else {
      this.logger.info('Java debugger attached successfully');
    }

    // Wait for Maven to finish
    return processPromise;
  }

  /**
   * Attempts to attach the VS Code Java debugger with retries.
   * startDebugging may fail if called immediately after the JDWP agent
   * prints "Listening" but before it's fully ready for the handshake.
   */
  private async attachDebuggerWithRetry(
    workspaceFolder: vscode.WorkspaceFolder,
    port: number,
    maxRetries: number,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const started = await vscode.debug.startDebugging(workspaceFolder, {
        type: 'java',
        name: 'Cucumber Debug',
        request: 'attach',
        hostName: 'localhost',
        port,
      });

      if (started) {
        return true;
      }

      this.logger.info(`Debugger attach attempt ${attempt}/${maxRetries} failed, retrying...`);
      await new Promise(resolve => setTimeout(resolve, DEBUGGER_ATTACH_RETRY_MS));
    }

    return false;
  }
}
