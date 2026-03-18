import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BuildToolRunner, RunOptions, TestItemData, TestResult } from './types';
import { parseResults } from './resultParser';
import { detectRunnerClass } from './runnerDetector';
import { spawnProcess } from '../util/processRunner';
import { TestTreeBuilder } from '../discovery/testTreeBuilder';
import { DebugManager } from '../debug/debugManager';
import { Logger } from '../util/logger';
import * as config from '../config/configuration';

export class TestExecutor {
  constructor(
    private readonly controller: vscode.TestController,
    private readonly treeBuilder: TestTreeBuilder,
    private readonly buildToolRunner: BuildToolRunner,
    private readonly debugManager: DebugManager,
    private readonly logger: Logger,
  ) {}

  /**
   * Main entry point for running or debugging tests.
   * Called by the TestRunProfile handler.
   */
  async executeTests(
    request: vscode.TestRunRequest,
    cancellation: vscode.CancellationToken,
    debug: boolean,
  ): Promise<void> {
    const run = this.controller.createTestRun(request);

    try {
      // 1. Determine workspace folder
      const workspaceFolder = this.resolveWorkspaceFolder(request);
      if (!workspaceFolder) {
        this.logger.error('No workspace folder found');
        run.end();
        return;
      }

      // 2. Collect runnable test items (leaf-level: scenarios, example rows)
      const items = this.collectRunnableItems(request);
      if (items.length === 0) {
        this.logger.warn('No runnable test items found');
        run.end();
        return;
      }

      // 3. Validate and build feature targets
      const featureTargets = this.buildFeatureTargets(items, workspaceFolder);

      // 4. Mark all items as enqueued, then started
      for (const item of items) {
        run.enqueued(item);
      }
      for (const item of items) {
        run.started(item);
      }

      // 5. Detect or use configured runner class
      const runnerClass = config.getRunnerClass()
        ?? await detectRunnerClass(workspaceFolder);

      if (!runnerClass) {
        this.logger.warn(
          'No Cucumber runner class found. Tests may include unrelated unit tests. ' +
          'Configure cucumberTestRunner.runnerClass in settings.',
        );
      }

      // 6. Build run options
      const defaultTags = config.getDefaultTags();
      const runOptions: RunOptions = {
        workspaceFolder,
        featureTargets,
        tagExpression: defaultTags || undefined,
        runnerClass,
        additionalArgs: config.getAdditionalMavenArgs(),
      };

      // 7. Delete old results file
      const resultsPath = this.buildToolRunner.getResultsFilePath(workspaceFolder);
      this.deleteFileIfExists(resultsPath);

      // 8. Execute
      let exitCode: number;
      if (debug) {
        exitCode = await this.executeDebug(runOptions, workspaceFolder, run, cancellation);
      } else {
        exitCode = await this.executeRun(runOptions, run, cancellation);
      }

      // 9. Check for cancellation
      if (cancellation.isCancellationRequested) {
        this.markRemainingAsSkipped(items, run);
        return;
      }

      // 10. Parse results and report
      await this.reportResults(items, resultsPath, workspaceFolder, run);

    } catch (err) {
      this.logger.error('Test execution failed', err);
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Cucumber Test Runner: ${message}`);
    } finally {
      run.end();
    }
  }

  private resolveWorkspaceFolder(
    request: vscode.TestRunRequest,
  ): vscode.WorkspaceFolder | undefined {
    // Try to get workspace folder from the first included item
    if (request.include && request.include.length > 0) {
      const uri = request.include[0].uri;
      if (uri) {
        return vscode.workspace.getWorkspaceFolder(uri);
      }
    }

    // Fall back to first workspace folder
    return vscode.workspace.workspaceFolders?.[0];
  }

  /**
   * Collects all runnable (leaf-level) test items from the request.
   * Expands parent items (features, rules, outlines) down to scenarios and example rows.
   */
  private collectRunnableItems(request: vscode.TestRunRequest): vscode.TestItem[] {
    const items: vscode.TestItem[] = [];
    const excluded = new Set(request.exclude?.map(item => item.id) ?? []);

    const collect = (item: vscode.TestItem): void => {
      if (excluded.has(item.id)) return;

      const data = this.treeBuilder.getTestData(item.id);
      if (!data) return;

      // Leaf-level runnable items: scenarios, example rows
      // Non-runnable: features, rules, outlines (they have children), examples (container), backgrounds
      if (data.type === 'scenario' || data.type === 'exampleRow') {
        items.push(item);
      } else {
        // Expand children
        item.children.forEach(child => collect(child));
      }
    };

    if (request.include) {
      for (const item of request.include) {
        collect(item);
      }
    } else {
      // Run all
      this.controller.items.forEach(item => collect(item));
    }

    return items;
  }

  /**
   * Builds feature targets (path:line pairs) from runnable items.
   * Validates that all paths are within the workspace folder.
   */
  private buildFeatureTargets(
    items: vscode.TestItem[],
    workspaceFolder: vscode.WorkspaceFolder,
  ): string[] {
    const targets = new Set<string>();
    const wsRoot = workspaceFolder.uri.fsPath;

    for (const item of items) {
      const data = this.treeBuilder.getTestData(item.id);
      if (!data) continue;

      // Validate path is within workspace
      const absolutePath = path.resolve(wsRoot, data.featurePath);
      if (!absolutePath.startsWith(wsRoot)) {
        this.logger.warn(`Skipping path outside workspace: ${data.featurePath}`);
        continue;
      }

      // Use workspace-relative path with forward slashes
      const relativePath = data.featurePath.replace(/\\/g, '/');
      targets.add(`${relativePath}:${data.line}`);
    }

    return Array.from(targets);
  }

  private async executeRun(
    options: RunOptions,
    run: vscode.TestRun,
    cancellation: vscode.CancellationToken,
  ): Promise<number> {
    const cmd = await this.buildToolRunner.assembleCommand(options);
    this.logger.info(`Running: ${cmd.executable} ${cmd.args.join(' ')}`);
    run.appendOutput(`> ${cmd.executable} ${cmd.args.join(' ')}\r\n\r\n`);

    const result = await spawnProcess(cmd.executable, cmd.args, {
      cwd: cmd.cwd,
      env: cmd.env,
      onStdout: (line) => run.appendOutput(line + '\r\n'),
      onStderr: (line) => run.appendOutput(line + '\r\n'),
      cancellation,
    });

    if (result.killed) {
      this.logger.info('Test execution was cancelled');
    } else {
      this.logger.info(`Maven exited with code ${result.exitCode}`);
    }

    return result.exitCode;
  }

  private async executeDebug(
    options: RunOptions,
    workspaceFolder: vscode.WorkspaceFolder,
    run: vscode.TestRun,
    cancellation: vscode.CancellationToken,
  ): Promise<number> {
    const port = await this.debugManager.findAvailablePort();
    const cmd = await this.buildToolRunner.assembleDebugCommand(options, port);
    this.logger.info(`Debug: ${cmd.executable} ${cmd.args.join(' ')}`);
    run.appendOutput(`> [DEBUG] ${cmd.executable} ${cmd.args.join(' ')}\r\n\r\n`);

    const result = await this.debugManager.executeWithDebug(
      cmd,
      port,
      workspaceFolder,
      run,
      cancellation,
    );

    return result.exitCode;
  }

  /**
   * Parses the Cucumber JSON results file and reports results to the TestRun.
   */
  private async reportResults(
    items: vscode.TestItem[],
    resultsPath: string,
    workspaceFolder: vscode.WorkspaceFolder,
    run: vscode.TestRun,
  ): Promise<void> {
    // Check if results file exists
    if (!fs.existsSync(resultsPath)) {
      this.logger.warn('Results file not found: ' + resultsPath);
      for (const item of items) {
        run.errored(
          item,
          new vscode.TestMessage('Test results not found. Check Maven output for errors.'),
        );
      }
      return;
    }

    // Read and parse results
    let jsonContent: string;
    try {
      jsonContent = fs.readFileSync(resultsPath, 'utf-8');
    } catch (err) {
      this.logger.error('Failed to read results file', err);
      for (const item of items) {
        run.errored(
          item,
          new vscode.TestMessage('Failed to read test results file.'),
        );
      }
      return;
    }

    const results = parseResults(jsonContent, workspaceFolder.uri.fsPath);
    const resultMap = new Map<string, TestResult>();

    for (const result of results) {
      resultMap.set(result.testItemId, result);
    }

    // Build additional lookup indexes for robust matching
    // Index by filename#line for fallback matching
    const byFilenameLine = new Map<string, TestResult>();
    for (const result of results) {
      const parts = result.testItemId.split('#');
      if (parts.length === 2) {
        const filename = parts[0].split('/').pop() ?? '';
        byFilenameLine.set(`${filename}#${parts[1]}`, result);
      }
    }

    // Map results to test items
    for (const item of items) {
      const data = this.treeBuilder.getTestData(item.id);
      if (!data) continue;

      // Primary match: by feature path + line number (exact path match)
      const featurePath = data.featurePath.replace(/\\/g, '/');
      const primaryKey = `${featurePath}#${data.line}`;
      let result = resultMap.get(primaryKey);

      // Fallback 1: match by just the features/ relative path (handles src/test/resources prefix differences)
      if (!result) {
        const featuresIdx = featurePath.indexOf('features/');
        if (featuresIdx >= 0) {
          const shortPath = featurePath.substring(featuresIdx);
          for (const [key, r] of resultMap) {
            if (key.endsWith(`#${data.line}`) && key.includes(shortPath)) {
              result = r;
              break;
            }
          }
        }
      }

      // Fallback 2: match by filename + line number
      if (!result) {
        const filename = featurePath.split('/').pop() ?? '';
        result = byFilenameLine.get(`${filename}#${data.line}`);
      }

      if (!result) {
        // No result found — scenario may not have been executed
        run.errored(
          item,
          new vscode.TestMessage(
            'No result found for this scenario. It may not have been executed.',
          ),
        );
        continue;
      }

      this.reportSingleResult(item, result, run);
    }
  }

  private reportSingleResult(
    item: vscode.TestItem,
    result: TestResult,
    run: vscode.TestRun,
  ): void {
    switch (result.status) {
      case 'passed':
        run.passed(item, result.duration);
        break;

      case 'failed': {
        const message = new vscode.TestMessage(
          result.errorMessage ?? 'Test failed',
        );
        if (result.failedStepLine && item.uri) {
          message.location = new vscode.Location(
            item.uri,
            new vscode.Position(result.failedStepLine - 1, 0),
          );
        }
        // Add stack trace as expected/actual for better display
        if (result.errorStack) {
          message.message = `${result.errorMessage}\n\n${result.errorStack}`;
        }
        run.failed(item, message, result.duration);
        break;
      }

      case 'errored': {
        const message = new vscode.TestMessage(
          result.errorMessage ?? 'Test errored',
        );
        if (result.errorStack) {
          message.message = `${result.errorMessage}\n\n${result.errorStack}`;
        }
        run.errored(item, message, result.duration);
        break;
      }

      case 'skipped':
        run.skipped(item);
        break;
    }
  }

  private markRemainingAsSkipped(items: vscode.TestItem[], run: vscode.TestRun): void {
    for (const item of items) {
      run.skipped(item);
    }
  }

  private deleteFileIfExists(filePath: string): void {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Ignore — file may be locked, old results will be overwritten anyway
    }
  }
}
