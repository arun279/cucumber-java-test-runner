import * as vscode from 'vscode';
import * as net from 'net';
import { CommandSpec } from '../execution/types';
import { spawnProcess, ProcessResult } from '../util/processRunner';
import { Logger } from '../util/logger';

const DEBUG_TIMEOUT_MS = 120_000; // 2 minutes for Maven compile + fork
const PORT_POLL_INTERVAL_MS = 500; // Check port every 500ms

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
   * Instead of parsing stdout for the "Listening for transport" message (which
   * Surefire 3.x may not forward from the forked JVM), we poll the debug port
   * with TCP connection attempts until it accepts connections.
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
        onStdout: (line) => {
          testRun.appendOutput(line + '\r\n');
        },
        onStderr: (line) => {
          testRun.appendOutput(line + '\r\n');
        },
        cancellation,
      },
    );

    processPromise.then((result) => {
      processExited = true;
      processExitCode = result.exitCode;
    }).catch(() => {
      processExited = true;
    });

    // Poll the debug port until it accepts connections or we timeout
    this.logger.info(`Polling port ${debugPort} for JDWP readiness...`);
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

    this.logger.info(`JDWP ready on port ${debugPort}`);

    // Attach VS Code's Java debugger
    this.logger.info('Attaching Java debugger...');
    const started = await vscode.debug.startDebugging(workspaceFolder, {
      type: 'java',
      name: 'Cucumber Debug',
      request: 'attach',
      hostName: 'localhost',
      port: debugPort,
    });

    if (!started) {
      this.logger.warn('Failed to start debug session — continuing without debugger');
    } else {
      this.logger.info('Java debugger attached successfully');
    }

    // Wait for Maven to finish
    return processPromise;
  }

  /**
   * Polls a TCP port until it accepts connections.
   * This is more robust than parsing stdout for the JDWP "Listening" message,
   * because Surefire 3.x may not forward the forked JVM's stderr output.
   */
  private waitForPort(
    port: number,
    timeoutMs: number,
    hasProcessExited: () => boolean,
    cancellation?: vscode.CancellationToken,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      let disposed = false;

      const cleanup = (): void => {
        disposed = true;
      };

      // Set up cancellation
      let cancelDisposable: vscode.Disposable | undefined;
      if (cancellation) {
        cancelDisposable = cancellation.onCancellationRequested(() => {
          cleanup();
          reject(new Error('Debug session cancelled'));
        });
      }

      const tryConnect = (): void => {
        if (disposed) return;

        // Check timeout
        if (Date.now() - startTime > timeoutMs) {
          cleanup();
          cancelDisposable?.dispose();
          reject(new Error(
            `Debug session timed out after ${timeoutMs / 1000}s waiting for Surefire forked JVM. ` +
            'This may indicate a compilation error or missing test class.',
          ));
          return;
        }

        // Check if process exited
        if (hasProcessExited()) {
          cleanup();
          cancelDisposable?.dispose();
          reject(new Error('Maven process exited before debug port became ready'));
          return;
        }

        // Try to connect to the port
        const socket = new net.Socket();
        socket.setTimeout(PORT_POLL_INTERVAL_MS);

        socket.on('connect', () => {
          // Port is open — JDWP is ready
          socket.destroy();
          cleanup();
          cancelDisposable?.dispose();
          resolve();
        });

        socket.on('error', () => {
          // Port not yet open — retry after interval
          socket.destroy();
          if (!disposed) {
            setTimeout(tryConnect, PORT_POLL_INTERVAL_MS);
          }
        });

        socket.on('timeout', () => {
          socket.destroy();
          if (!disposed) {
            setTimeout(tryConnect, PORT_POLL_INTERVAL_MS);
          }
        });

        socket.connect(port, '127.0.0.1');
      };

      // Start polling
      tryConnect();
    });
  }
}
