import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BuildToolRunner, RunOptions, TestResult } from './types';
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
      const items = this.collectRunnableItems(request);
      if (items.length === 0) {
        run.end();
        return;
      }

      // Group items by project root
      const byProject = this.groupByProject(items);

      // Debug restriction: only one project at a time
      if (debug && byProject.size > 1) {
        const firstProject = [...byProject.keys()][0];
        vscode.window.showWarningMessage(
          `Debug mode supports one project at a time. Running tests from "${path.basename(firstProject)}" only.`,
        );
        for (const [key, projectItems] of byProject) {
          if (key !== firstProject) {
            for (const item of projectItems) { run.skipped(item); }
            byProject.delete(key);
          }
        }
      }

      // Mark all remaining items as enqueued
      for (const item of items) {
        const data = this.treeBuilder.getTestData(item.id);
        if (data && byProject.has(data.projectRoot)) {
          run.enqueued(item);
        }
      }

      // Resolve workspace root for shared mvnw fallback
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

      // Track reported items to avoid double-marking on cancellation
      const reportedItems = new Set<string>();

      // Execute per project
      for (const [projectRoot, projectItems] of byProject) {
        if (cancellation.isCancellationRequested) break;

        for (const item of projectItems) { run.started(item); }

        const featureTargets = this.buildFeatureTargets(projectItems);
        const runnerClass = config.getRunnerClass()
          ?? await detectRunnerClass(projectRoot);

        if (!runnerClass) {
          this.logger.warn(
            `No Cucumber runner class found in ${path.basename(projectRoot)}. ` +
            'Configure cucumberTestRunner.runnerClass in settings.',
          );
        }

        const runOptions: RunOptions = {
          projectRoot,
          workspaceRoot,
          featureTargets,
          tagExpression: config.getDefaultTags() || undefined,
          runnerClass,
          additionalArgs: config.getAdditionalMavenArgs(),
        };

        const resultsPath = this.buildToolRunner.getResultsFilePath(projectRoot);
        this.deleteFileIfExists(resultsPath);

        if (debug) {
          await this.executeDebug(runOptions, projectRoot, run, cancellation);
        } else {
          await this.executeRun(runOptions, run, cancellation);
        }

        if (!cancellation.isCancellationRequested) {
          await this.reportResults(projectItems, resultsPath, projectRoot, run);
          for (const item of projectItems) { reportedItems.add(item.id); }
        }
      }

      if (cancellation.isCancellationRequested) {
        // Only skip items that haven't already been reported
        for (const item of items) {
          if (!reportedItems.has(item.id)) {
            run.skipped(item);
          }
        }
      }

    } catch (err) {
      this.logger.error('Test execution failed', err);
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Cucumber Test Runner: ${message}`);
    } finally {
      run.end();
    }
  }

  /**
   * Groups test items by their Maven project root.
   */
  private groupByProject(items: vscode.TestItem[]): Map<string, vscode.TestItem[]> {
    const groups = new Map<string, vscode.TestItem[]>();
    for (const item of items) {
      const data = this.treeBuilder.getTestData(item.id);
      if (!data) continue;
      const key = data.projectRoot;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(item);
    }
    return groups;
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
   * Uses project-relative featurePath directly from TestItemData.
   */
  private buildFeatureTargets(items: vscode.TestItem[]): string[] {
    const targets = new Set<string>();
    for (const item of items) {
      const data = this.treeBuilder.getTestData(item.id);
      if (!data) continue;
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
    projectRoot: string,
    run: vscode.TestRun,
    cancellation: vscode.CancellationToken,
  ): Promise<number> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(projectRoot))
      ?? vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error('No workspace folder found for debug session');
    }
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
    projectRoot: string,
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

    const results = parseResults(jsonContent, projectRoot);
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
