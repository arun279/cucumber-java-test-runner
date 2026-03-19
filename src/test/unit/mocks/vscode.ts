import * as fs from 'fs';

export const FileType = { File: 1, Directory: 2, SymbolicLink: 64 };

export const workspace = {
  fs: {
    stat: async (uri: any) => {
      if (fs.existsSync(uri.fsPath)) {
        return {};
      }
      throw new Error('File not found');
    },
    readFile: async () => Buffer.from(''),
    readDirectory: async (uri: any): Promise<[string, number][]> => {
      const entries = fs.readdirSync(uri.fsPath, { withFileTypes: true });
      return entries.map(e => [e.name, e.isDirectory() ? FileType.Directory : FileType.File] as [string, number]);
    },
  },
  getConfiguration: () => ({ get: (_k: string, d: any) => d }),
  findFiles: async () => [],
};

export const Uri = {
  file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }),
};

export const window = {
  createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
  showErrorMessage: async () => undefined,
  showWarningMessage: async () => undefined,
};

export class TestTag { constructor(public readonly id: string) {} }
export const RelativePattern = class { constructor(public base: any, public pattern: string) {} };
export const TestRunProfileKind = { Run: 1, Debug: 2, Coverage: 3 };
export const CancellationTokenSource = class { token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) }; cancel() {} dispose() {} };
