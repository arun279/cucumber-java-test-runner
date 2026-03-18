import * as vscode from 'vscode';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
  debug(message: string): void;
  show(): void;
  dispose(): void;
}

export function createLogger(name: string): Logger {
  const channel = vscode.window.createOutputChannel(name);

  function timestamp(): string {
    return new Date().toISOString();
  }

  function formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.stack ?? error.message;
    }
    return String(error);
  }

  return {
    info(message: string) {
      channel.appendLine(`[${timestamp()}] [INFO] ${message}`);
    },
    warn(message: string) {
      channel.appendLine(`[${timestamp()}] [WARN] ${message}`);
    },
    error(message: string, error?: unknown) {
      channel.appendLine(`[${timestamp()}] [ERROR] ${message}`);
      if (error !== undefined) {
        channel.appendLine(formatError(error));
      }
    },
    debug(message: string) {
      channel.appendLine(`[${timestamp()}] [DEBUG] ${message}`);
    },
    show() {
      channel.show(true);
    },
    dispose() {
      channel.dispose();
    },
  };
}
