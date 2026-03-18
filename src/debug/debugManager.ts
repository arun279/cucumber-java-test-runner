import * as vscode from 'vscode';
import * as net from 'net';
import { CommandSpec } from '../execution/types';
import { spawnProcess, ProcessResult } from '../util/processRunner';
import { Logger } from '../util/logger';

const DEBUG_TIMEOUT_MS = 120_000;
const JDWP_READY_PATTERN = /Listening for transport dt_socket at address:\s*(\d+)/;

export class DebugManager {
  constructor(private readonly logger: Logger) {}

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
        this.logger.info(`JDWP ready on port ${match[1]}`);
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

    // If process exits before JDWP is ready, reject the promise
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

    // Wait for JDWP
    try {
      await jdwpReadyPromise;
    } catch (err) {
      this.logger.error('Failed waiting for JDWP', err);
      throw err;
    }

    // Attach debugger
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
}
