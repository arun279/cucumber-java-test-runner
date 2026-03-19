import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { BuildToolRunner, RunOptions, CommandSpec } from './types';
import * as config from '../config/configuration';

const RESULTS_FILENAME = 'cucumber-vscode-results.json';
const JUNIT_PLATFORM_PROPERTIES = 'junit-platform.properties';

export class MavenRunner implements BuildToolRunner {

  getBuildFileNames(): string[] {
    return ['pom.xml'];
  }

  async detect(workspaceFolder: vscode.WorkspaceFolder): Promise<boolean> {
    const pomPath = path.join(workspaceFolder.uri.fsPath, 'pom.xml');
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(pomPath));
      return true;
    } catch {
      return false;
    }
  }

  async detectInSubdirectories(workspaceFolder: vscode.WorkspaceFolder): Promise<boolean> {
    const wsRoot = workspaceFolder.uri.fsPath;
    try {
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(wsRoot));
      for (const [name, type] of entries) {
        if (type === vscode.FileType.Directory) {
          const subdir = path.join(wsRoot, name);
          for (const buildFile of this.getBuildFileNames()) {
            try {
              await vscode.workspace.fs.stat(vscode.Uri.file(path.join(subdir, buildFile)));
              return true;
            } catch {
              // Not found, continue
            }
          }
        }
      }
    } catch {
      // Can't read directory
    }
    return false;
  }

  async resolveExecutable(projectRoot: string, workspaceRoot?: string): Promise<string> {
    const wrapperNames = process.platform === 'win32'
      ? ['mvnw.cmd', 'mvnw']
      : ['mvnw'];

    // Check project root first
    for (const wrapper of wrapperNames) {
      const wrapperPath = path.join(projectRoot, wrapper);
      if (fs.existsSync(wrapperPath)) {
        return wrapperPath;
      }
    }

    // Check workspace root as fallback (shared wrapper)
    if (workspaceRoot && workspaceRoot !== projectRoot) {
      for (const wrapper of wrapperNames) {
        const wrapperPath = path.join(workspaceRoot, wrapper);
        if (fs.existsSync(wrapperPath)) {
          return wrapperPath;
        }
      }
    }

    return config.getMavenExecutable();
  }

  async assembleCommand(options: RunOptions): Promise<CommandSpec> {
    const executable = await this.resolveExecutable(options.projectRoot, options.workspaceRoot);
    const resultsPath = this.getResultsFilePath(options.projectRoot);

    const args: string[] = ['test'];

    if (options.featureTargets.length > 0) {
      // Target specific features. The Cucumber JUnit Platform Engine discovers
      // these directly via ServiceLoader using the cucumber.features property.
      args.push(`-Dcucumber.features=${options.featureTargets.join(',')}`);

      // Exclude the @Suite runner class (e.g., CucumberTest) from Surefire's
      // class scanning to prevent double execution. Without this, Surefire
      // discovers the engine via ServiceLoader AND discovers the Suite class
      // via classpath scanning, causing the same scenarios to run twice.
      if (options.runnerClass) {
        args.push(`-Dtest=!${options.runnerClass}`);
      }
    } else if (options.runnerClass) {
      // Running ALL tests — use the runner class to scope to Cucumber only.
      args.push(`-Dtest=${options.runnerClass}`);
    }

    if (options.tagExpression) {
      args.push(`-Dcucumber.filter.tags=${options.tagExpression}`);
    }

    const existingPlugins = await this.readExistingPlugins(options.projectRoot);
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
      cwd: options.projectRoot,
    };
  }

  async assembleDebugCommand(options: RunOptions, debugPort: number): Promise<CommandSpec> {
    const cmd = await this.assembleCommand(options);

    const debugArg = `-Dmaven.surefire.debug=-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=localhost:${debugPort}`;
    cmd.args.push(debugArg);

    return cmd;
  }

  getResultsFilePath(projectRoot: string): string {
    return path.join(projectRoot, 'target', RESULTS_FILENAME);
  }

  async readExistingPlugins(projectRoot: string): Promise<string[]> {
    const propsPath = path.join(
      projectRoot,
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
