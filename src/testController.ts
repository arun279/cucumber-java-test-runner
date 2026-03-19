import * as vscode from 'vscode';
import { parseFeatureFile } from './discovery/featureParser';
import { TestTreeBuilder } from './discovery/testTreeBuilder';
import { FeatureWatcher } from './discovery/featureWatcher';
import { MavenRunner } from './execution/mavenRunner';
import { TestExecutor } from './execution/testExecutor';
import { DebugManager } from './debug/debugManager';
import { Logger } from './util/logger';

export class CucumberTestController implements vscode.Disposable {
  private readonly controller: vscode.TestController;
  private readonly treeBuilder: TestTreeBuilder;
  private readonly testExecutor: TestExecutor;
  private readonly buildToolRunner: MavenRunner;
  private readonly watcherMap = new Map<string, FeatureWatcher>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger,
  ) {
    this.controller = vscode.tests.createTestController(
      'cucumberTestRunner',
      'Cucumber Tests',
    );
    this.disposables.push(this.controller);

    this.buildToolRunner = new MavenRunner();
    this.treeBuilder = new TestTreeBuilder(this.controller, this.buildToolRunner.getBuildFileNames());
    const debugManager = new DebugManager(this.logger);

    this.testExecutor = new TestExecutor(
      this.controller,
      this.treeBuilder,
      this.buildToolRunner,
      debugManager,
      this.logger,
    );

    const runProfile = this.controller.createRunProfile(
      'Run Cucumber Tests',
      vscode.TestRunProfileKind.Run,
      (request, token) => this.testExecutor.executeTests(request, token, false),
      true,
    );
    this.disposables.push(runProfile);

    const debugProfile = this.controller.createRunProfile(
      'Debug Cucumber Tests',
      vscode.TestRunProfileKind.Debug,
      (request, token) => this.testExecutor.executeTests(request, token, true),
      false,
    );
    this.disposables.push(debugProfile);

    this.controller.resolveHandler = async (item) => {
      if (!item) {
        await this.discoverAllWorkspaces();
      }
    };

    this.controller.refreshHandler = async (_token) => {
      // Clear all items and metadata
      const existingIds: string[] = [];
      this.controller.items.forEach(item => existingIds.push(item.id));
      for (const id of existingIds) {
        this.controller.items.delete(id);
      }
      this.treeBuilder.clear();
      await this.discoverAllWorkspaces();
    };
  }

  async activate(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) {
      this.logger.info('No workspace folders found');
      return;
    }

    let hasMaven = false;
    for (const folder of folders) {
      if (await this.buildToolRunner.detect(folder)
          || await this.buildToolRunner.detectInSubdirectories(folder)) {
        hasMaven = true;
        break;
      }
    }

    if (!hasMaven) {
      this.logger.warn('No Maven project detected (pom.xml not found)');
    }

    for (const folder of folders) {
      await this.setupWatcherForFolder(folder);
    }

    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.syncWatchers();
      }),
    );
  }

  dispose(): void {
    for (const watcher of this.watcherMap.values()) {
      watcher.dispose();
    }
    this.watcherMap.clear();

    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }

  private syncWatchers(): void {
    const currentFolderKeys = new Set(
      (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.toString()),
    );

    for (const [key, watcher] of this.watcherMap) {
      if (!currentFolderKeys.has(key)) {
        watcher.dispose();
        this.watcherMap.delete(key);
        this.logger.info('Removed watcher for closed folder');
      }
    }

    const existingIds: string[] = [];
    this.controller.items.forEach(item => existingIds.push(item.id));
    for (const id of existingIds) {
      this.controller.items.delete(id);
    }
    this.treeBuilder.clear();
    this.discoverAllWorkspaces();
  }

  private async setupWatcherForFolder(folder: vscode.WorkspaceFolder): Promise<void> {
    const key = folder.uri.toString();
    if (this.watcherMap.has(key)) return;

    const watcher = new FeatureWatcher(
      folder,
      (uri) => this.handleFeatureChanged(uri),
      (uri) => this.handleFeatureDeleted(uri),
    );
    this.watcherMap.set(key, watcher);

    const featureFiles = await watcher.discoverAll();
    this.logger.info(
      `Discovered ${featureFiles.length} feature file(s) in ${folder.name}`,
    );

    for (const uri of featureFiles) {
      await this.parseAndAddFile(uri);
    }
  }

  private async discoverAllWorkspaces(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return;

    for (const folder of folders) {
      const key = folder.uri.toString();
      const watcher = this.watcherMap.get(key);

      if (watcher) {
        const featureFiles = await watcher.discoverAll();
        for (const uri of featureFiles) {
          await this.parseAndAddFile(uri);
        }
      } else {
        await this.setupWatcherForFolder(folder);
      }
    }
  }

  private async parseAndAddFile(uri: vscode.Uri): Promise<void> {
    try {
      const contentBytes = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(contentBytes).toString('utf-8');
      const result = parseFeatureFile(content, uri.toString());

      if (!result.success) {
        this.logger.warn(`Parse error in ${uri.fsPath}: ${result.error.message}`);
        return;
      }

      // Tree builder handles placement under the project grouping node
      this.treeBuilder.buildFileItem(result.feature, uri);
    } catch (err) {
      this.logger.error(`Failed to parse ${uri.fsPath}`, err);
    }
  }

  private async handleFeatureChanged(uri: vscode.Uri): Promise<void> {
    try {
      const contentBytes = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(contentBytes).toString('utf-8');
      const result = parseFeatureFile(content, uri.toString());

      if (!result.success) {
        this.logger.warn(`Parse error in ${uri.fsPath}: ${result.error.message}`);
        return;
      }

      // Find existing file item through project grouping nodes
      const existingItem = this.treeBuilder.findFileItem(uri);
      if (existingItem) {
        this.treeBuilder.syncFileItem(result.feature, existingItem, uri);
      } else {
        this.treeBuilder.buildFileItem(result.feature, uri);
      }
    } catch (err) {
      this.logger.error(`Failed to handle change for ${uri.fsPath}`, err);
    }
  }

  private handleFeatureDeleted(uri: vscode.Uri): void {
    const fileItemId = uri.toString();
    const fileItem = this.treeBuilder.findFileItem(uri);
    this.treeBuilder.removeFile(fileItemId, fileItem);
    this.logger.info(`Removed feature file: ${uri.fsPath}`);
  }
}
