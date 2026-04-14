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

    if (options.runnerClass) {
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

  async assembleCompileCommand(options: RunOptions): Promise<CommandSpec> {
    const executable = await this.resolveExecutable(options.projectRoot, options.workspaceRoot);
    const cpFile = path.join(options.projectRoot, 'target', 'cp.txt');
    return {
      executable,
      args: ['test-compile', 'dependency:build-classpath', `-Dmdep.outputFile=${cpFile}`],
      cwd: options.projectRoot,
    };
  }

  assembleCucumberCliCommand(options: RunOptions): CommandSpec {
    const java = this.resolveJavaExecutable();
    const classpath = this.resolveTestClasspath(options.projectRoot);
    const resultsPath = this.getResultsFilePath(options.projectRoot);

    const args: string[] = ['-cp', classpath, 'io.cucumber.core.cli.Main'];

    args.push('--plugin', `json:${resultsPath.replace(/\\/g, '/')}`);

    const glue = config.getGlue()
      ?? this.readJunitPlatformProperty(options.projectRoot, 'cucumber.glue');
    if (glue) {
      args.push('--glue', glue);
    }

    if (options.tagExpression) {
      args.push('--tags', options.tagExpression);
    }

    args.push(...options.featureTargets);

    return { executable: java, args, cwd: options.projectRoot };
  }

  assembleCucumberCliDebugCommand(options: RunOptions, debugPort: number): CommandSpec {
    const cmd = this.assembleCucumberCliCommand(options);
    const mainClassIdx = cmd.args.indexOf('io.cucumber.core.cli.Main');
    cmd.args.splice(mainClassIdx, 0,
      `-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=localhost:${debugPort}`,
    );
    return cmd;
  }

  getResultsFilePath(projectRoot: string): string {
    return path.join(projectRoot, 'target', RESULTS_FILENAME);
  }

  async readExistingPlugins(projectRoot: string): Promise<string[]> {
    const value = this.readJunitPlatformProperty(projectRoot, 'cucumber.plugin');
    return value ? value.split(/\s*,\s*/).filter(p => p.length > 0) : [];
  }

  private readJunitPlatformProperty(projectRoot: string, key: string): string | undefined {
    const propsPath = path.join(
      projectRoot,
      'src', 'test', 'resources',
      JUNIT_PLATFORM_PROPERTIES,
    );

    try {
      const content = fs.readFileSync(propsPath, 'utf-8');
      const escapedKey = key.replace(/\./g, '\\.');
      const regex = new RegExp(`^${escapedKey}\\s*=\\s*(.+)$`, 'm');
      const match = content.match(regex);
      return match ? match[1].trim() : undefined;
    } catch {
      // File doesn't exist or can't be read
    }

    return undefined;
  }

  private resolveJavaExecutable(): string {
    const javaHome = process.env.JAVA_HOME;
    if (javaHome) {
      const javaBin = path.join(javaHome, 'bin', 'java');
      if (fs.existsSync(javaBin) || fs.existsSync(javaBin + '.exe')) {
        return javaBin;
      }
    }
    return 'java';
  }

  private resolveTestClasspath(projectRoot: string): string {
    const cpFile = path.join(projectRoot, 'target', 'cp.txt');
    const deps = fs.readFileSync(cpFile, 'utf-8').trim();
    const sep = process.platform === 'win32' ? ';' : ':';
    const testClasses = path.join(projectRoot, 'target', 'test-classes');
    const classes = path.join(projectRoot, 'target', 'classes');
    return [testClasses, classes, deps].filter(Boolean).join(sep);
  }
}
