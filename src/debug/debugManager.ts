import * as vscode from 'vscode';
import * as net from 'net';
import { CommandSpec } from '../execution/types';
import { spawnProcess, ProcessResult } from '../util/processRunner';
import { Logger } from '../util/logger';

const DEBUG_TIMEOUT_MS = 120_000; // 2 minutes for Maven compile + fork
const PORT_POLL_INTERVAL_MS = 1000; // Check port every 1s
const DEBUGGER_ATTACH_MAX_RETRIES = 5;
const DEBUGGER_ATTACH_RETRY_MS = 1000;

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
   * Detection strategy: We know the debug port (we chose it), so we poll it
   * with TCP connection attempts until it accepts connections. This is necessary
   * because Surefire 3.x hijacks the forked JVM's stdout for its binary protocol,
   * so the JDWP "Listening for transport" message is NOT reliably forwarded
   * to Maven's stdout/stderr.
   *
   * The TCP probe triggers a brief "handshake failed" log from the JDWP agent
   * (because we connect and immediately disconnect without completing the JDWP
   * handshake). This is harmless — the agent recovers and continues listening.
   * We then attach the real VS Code debugger with retries.
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

    // Spawn Maven process
    let processExited = false;
    let processExitCode = 1;

    const processPromise = spawnProcess(
      commandSpec.executable,
      commandSpec.args,
      {
        cwd: commandSpec.cwd,
        env: commandSpec.env,
        onStdout: (line) => testRun.appendOutput(line + '\r\n'),
        onStderr: (line) => testRun.appendOutput(line + '\r\n'),
        cancellation,
      },
    );

    processPromise.then((result) => {
      processExited = true;
      processExitCode = result.exitCode;
    }).catch(() => {
      processExited = true;
    });

    // Poll the debug port until it accepts connections
    this.logger.info(`Waiting for JDWP on port ${debugPort}...`);
    try {
      await this.waitForPort(debugPort, DEBUG_TIMEOUT_MS, () => processExited, cancellation);
    } catch (err) {
      this.logger.error('Failed waiting for JDWP', err);
      if (processExited) {
        throw new Error(
          `Maven process exited (code ${processExitCode}) before the debug port became ready. ` +
          'Check the test output for compilation errors.',
        );
      }
      throw err;
    }

    this.logger.info(`JDWP port ${debugPort} is accepting connections`);

    // Attach VS Code's Java debugger with retries.
    // The JDWP agent needs a moment to reset after our probe connection
    // triggered a partial handshake. Retrying handles this deterministically.
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
   * Polls a TCP port until it accepts connections.
   *
   * We use this because Surefire 3.x does not reliably forward the JDWP agent's
   * "Listening for transport" message from the forked JVM to Maven's stdout.
   * Since we control the port (we chose it), direct polling is reliable.
   */
  private waitForPort(
    port: number,
    timeoutMs: number,
    hasProcessExited: () => boolean,
    cancellation?: vscode.CancellationToken,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      let done = false;

      let cancelDisposable: vscode.Disposable | undefined;
      if (cancellation) {
        cancelDisposable = cancellation.onCancellationRequested(() => {
          done = true;
          cancelDisposable?.dispose();
          reject(new Error('Debug session cancelled'));
        });
      }

      const tryConnect = (): void => {
        if (done) return;

        if (Date.now() - startTime > timeoutMs) {
          done = true;
          cancelDisposable?.dispose();
          reject(new Error(
            `Debug session timed out after ${timeoutMs / 1000}s waiting for Surefire forked JVM. ` +
            'This may indicate a compilation error or missing test class.',
          ));
          return;
        }

        if (hasProcessExited()) {
          done = true;
          cancelDisposable?.dispose();
          reject(new Error('Maven process exited before debug port became ready'));
          return;
        }

        const socket = new net.Socket();
        socket.setTimeout(PORT_POLL_INTERVAL_MS);

        socket.on('connect', () => {
          socket.destroy();
          if (!done) {
            done = true;
            cancelDisposable?.dispose();
            resolve();
          }
        });

        socket.on('error', () => {
          socket.destroy();
          if (!done) {
            setTimeout(tryConnect, PORT_POLL_INTERVAL_MS);
          }
        });

        socket.on('timeout', () => {
          socket.destroy();
          if (!done) {
            setTimeout(tryConnect, PORT_POLL_INTERVAL_MS);
          }
        });

        socket.connect(port, '127.0.0.1');
      };

      tryConnect();
    });
  }

  /**
   * Attempts to attach the VS Code Java debugger with retries.
   *
   * After our port probe, the JDWP agent logs a "handshake failed" and resets.
   * The retry loop gives it time to become ready for the real debugger connection.
   * This is deterministic — we retry until success or max attempts.
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

      if (attempt < maxRetries) {
        this.logger.info(`Debugger attach attempt ${attempt}/${maxRetries} — retrying...`);
        await new Promise(resolve => setTimeout(resolve, DEBUGGER_ATTACH_RETRY_MS));
      }
    }

    return false;
  }
}
