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
  private readonly watcherMap = new Map<string, FeatureWatcher>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger,
  ) {
    // Create the test controller
    this.controller = vscode.tests.createTestController(
      'cucumberTestRunner',
      'Cucumber Tests',
    );
    this.disposables.push(this.controller);

    // Create tree builder
    this.treeBuilder = new TestTreeBuilder(this.controller);

    // Create build tool runner and debug manager
    const mavenRunner = new MavenRunner();
    const debugManager = new DebugManager(this.logger);

    // Create test executor
    this.testExecutor = new TestExecutor(
      this.controller,
      this.treeBuilder,
      mavenRunner,
      debugManager,
      this.logger,
    );

    // Create run profiles
    const runProfile = this.controller.createRunProfile(
      'Run Cucumber Tests',
      vscode.TestRunProfileKind.Run,
      (request, token) => this.testExecutor.executeTests(request, token, false),
      true, // isDefault
    );
    this.disposables.push(runProfile);

    const debugProfile = this.controller.createRunProfile(
      'Debug Cucumber Tests',
      vscode.TestRunProfileKind.Debug,
      (request, token) => this.testExecutor.executeTests(request, token, true),
      false,
    );
    this.disposables.push(debugProfile);

    // Set up the resolve handler for initial discovery
    this.controller.resolveHandler = async (item) => {
      if (!item) {
        // Initial discovery — scan all workspace folders
        await this.discoverAllWorkspaces();
      }
    };

    // Set up refresh handler
    this.controller.refreshHandler = async (_token) => {
      // Clear existing items
      const existingIds: string[] = [];
      this.controller.items.forEach(item => existingIds.push(item.id));
      for (const id of existingIds) {
        this.controller.items.delete(id);
      }

      // Re-discover
      await this.discoverAllWorkspaces();
    };
  }

  /**
   * Activates the controller — sets up file watchers for each workspace folder.
   */
  async activate(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) {
      this.logger.info('No workspace folders found');
      return;
    }

    // Detect build tool
    const mavenRunner = new MavenRunner();
    let hasMaven = false;
    for (const folder of folders) {
      if (await mavenRunner.detect(folder)) {
        hasMaven = true;
        break;
      }
    }

    if (!hasMaven) {
      this.logger.warn('No Maven project detected (pom.xml not found)');
    }

    // Set up file watchers for each workspace folder
    for (const folder of folders) {
      await this.setupWatcherForFolder(folder);
    }

    // Watch for workspace folder changes
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.controller.refreshHandler?.(new vscode.CancellationTokenSource().token);
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

  private async setupWatcherForFolder(folder: vscode.WorkspaceFolder): Promise<void> {
    const key = folder.uri.toString();

    // Don't create duplicate watchers
    if (this.watcherMap.has(key)) return;

    const watcher = new FeatureWatcher(
      folder,
      (uri) => this.handleFeatureChanged(folder, uri),
      (uri) => this.handleFeatureDeleted(uri),
    );
    this.watcherMap.set(key, watcher);

    // Initial discovery
    const featureFiles = await watcher.discoverAll();
    this.logger.info(
      `Discovered ${featureFiles.length} feature file(s) in ${folder.name}`,
    );

    for (const uri of featureFiles) {
      await this.parseAndAddFile(folder, uri);
    }
  }

  private async discoverAllWorkspaces(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return;

    for (const folder of folders) {
      const key = folder.uri.toString();
      const watcher = this.watcherMap.get(key);

      if (watcher) {
        // Use existing watcher for discovery
        const featureFiles = await watcher.discoverAll();
        for (const uri of featureFiles) {
          await this.parseAndAddFile(folder, uri);
        }
      } else {
        // Create new watcher
        await this.setupWatcherForFolder(folder);
      }
    }
  }

  private async parseAndAddFile(
    workspaceFolder: vscode.WorkspaceFolder,
    uri: vscode.Uri,
  ): Promise<void> {
    try {
      const contentBytes = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(contentBytes).toString('utf-8');
      const result = parseFeatureFile(content, uri.toString());

      if (!result.success) {
        this.logger.warn(`Parse error in ${uri.fsPath}: ${result.error.message}`);
        // Create an error item so the user can see the problem
        const errorItem = this.controller.createTestItem(
          uri.toString(),
          uri.path.split('/').pop() || 'Unknown',
          uri,
        );
        errorItem.error = result.error.message;
        this.controller.items.add(errorItem);
        return;
      }

      const fileItem = this.treeBuilder.buildFileItem(
        workspaceFolder,
        result.feature,
        uri,
      );
      this.controller.items.add(fileItem);
    } catch (err) {
      this.logger.error(`Failed to parse ${uri.fsPath}`, err);
    }
  }

  private async handleFeatureChanged(
    workspaceFolder: vscode.WorkspaceFolder,
    uri: vscode.Uri,
  ): Promise<void> {
    try {
      const contentBytes = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(contentBytes).toString('utf-8');
      const result = parseFeatureFile(content, uri.toString());

      if (!result.success) {
        this.logger.warn(`Parse error in ${uri.fsPath}: ${result.error.message}`);
        return;
      }

      // Check if the file already exists in the tree
      const existingItem = this.controller.items.get(uri.toString());
      if (existingItem) {
        this.treeBuilder.syncFileItem(
          workspaceFolder,
          result.feature,
          existingItem,
          uri,
        );
      } else {
        const fileItem = this.treeBuilder.buildFileItem(
          workspaceFolder,
          result.feature,
          uri,
        );
        this.controller.items.add(fileItem);
      }
    } catch (err) {
      this.logger.error(`Failed to handle change for ${uri.fsPath}`, err);
    }
  }

  private handleFeatureDeleted(uri: vscode.Uri): void {
    const fileItemId = uri.toString();
    const fileItem = this.controller.items.get(fileItemId);
    this.treeBuilder.removeFile(fileItemId, fileItem);
    this.controller.items.delete(fileItemId);
    this.logger.info(`Removed feature file: ${uri.fsPath}`);
  }
}
