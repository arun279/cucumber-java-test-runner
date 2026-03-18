import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { BuildToolRunner, RunOptions, CommandSpec } from './types';
import * as config from '../config/configuration';

const RESULTS_FILENAME = 'cucumber-vscode-results.json';
const JUNIT_PLATFORM_PROPERTIES = 'junit-platform.properties';

export class MavenRunner implements BuildToolRunner {

  async detect(workspaceFolder: vscode.WorkspaceFolder): Promise<boolean> {
    const pomPath = path.join(workspaceFolder.uri.fsPath, 'pom.xml');
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(pomPath));
      return true;
    } catch {
      return false;
    }
  }

  async resolveExecutable(workspaceFolder: vscode.WorkspaceFolder): Promise<string> {
    const wsRoot = workspaceFolder.uri.fsPath;

    const wrapperNames = process.platform === 'win32'
      ? ['mvnw.cmd', 'mvnw']
      : ['mvnw'];

    for (const wrapper of wrapperNames) {
      const wrapperPath = path.join(wsRoot, wrapper);
      if (fs.existsSync(wrapperPath)) {
        return wrapperPath;
      }
    }

    return config.getMavenExecutable();
  }

  async assembleCommand(options: RunOptions): Promise<CommandSpec> {
    const executable = await this.resolveExecutable(options.workspaceFolder);
    const wsRoot = options.workspaceFolder.uri.fsPath;
    const resultsPath = this.getResultsFilePath(options.workspaceFolder);

    const args: string[] = ['test'];

    if (options.runnerClass) {
      args.push(`-Dtest=${options.runnerClass}`);
    }

    if (options.featureTargets.length > 0) {
      args.push(`-Dcucumber.features=${options.featureTargets.join(',')}`);
    }

    if (options.tagExpression) {
      args.push(`-Dcucumber.filter.tags=${options.tagExpression}`);
    }

    const existingPlugins = await this.readExistingPlugins(options.workspaceFolder);
    // Use forward slashes for the JSON plugin path (Cucumber/Java expects forward slashes)
    const jsonPlugin = `json:${resultsPath.replace(/\\/g, '/')}`;
    const allPlugins = [...existingPlugins.filter(p => !p.startsWith('json:')), jsonPlugin];
    args.push(`-Dcucumber.plugin=${allPlugins.join(',')}`);

    args.push('-DfailIfNoTests=false');

    if (options.additionalArgs && options.additionalArgs.length > 0) {
      args.push(...options.additionalArgs);
    }

    return {
      executable,
      args,
      cwd: wsRoot,
    };
  }

  async assembleDebugCommand(options: RunOptions, debugPort: number): Promise<CommandSpec> {
    const cmd = await this.assembleCommand(options);

    const debugArg = `-Dmaven.surefire.debug=-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=localhost:${debugPort}`;
    cmd.args.push(debugArg);

    return cmd;
  }

  getResultsFilePath(workspaceFolder: vscode.WorkspaceFolder): string {
    return path.join(workspaceFolder.uri.fsPath, 'target', RESULTS_FILENAME);
  }

  async readExistingPlugins(workspaceFolder: vscode.WorkspaceFolder): Promise<string[]> {
    const propsPath = path.join(
      workspaceFolder.uri.fsPath,
      'src', 'test', 'resources',
      JUNIT_PLATFORM_PROPERTIES,
    );

    try {
      const content = fs.readFileSync(propsPath, 'utf-8');
      const match = content.match(/^cucumber\.plugin\s*=\s*(.+)$/m);
      if (match) {
        return match[1].trim().split(/\s*,\s*/).filter(p => p.length > 0);
      }
    } catch {
      // File doesn't exist or can't be read
    }

    return [];
  }
}
