import * as vscode from 'vscode';

export class FeatureWatcher implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher | undefined;
  private disposables: vscode.Disposable[] = [];
  private debounceTimers = new Map<string, NodeJS.Timeout>();

  private static readonly DEBOUNCE_MS = 300;
  private static readonly FEATURE_GLOB = '**/*.feature';
  private static readonly EXCLUDE_PATTERN = '{**/node_modules/**,**/target/**,**/build/**,.git/**}';

  constructor(
    private readonly workspaceFolder: vscode.WorkspaceFolder,
    private readonly onFeatureChanged: (uri: vscode.Uri) => void,
    private readonly onFeatureDeleted: (uri: vscode.Uri) => void,
  ) {
    this.setupWatcher();
  }

  /**
   * Performs initial discovery of all .feature files in the workspace.
   */
  async discoverAll(): Promise<vscode.Uri[]> {
    const pattern = new vscode.RelativePattern(
      this.workspaceFolder,
      FeatureWatcher.FEATURE_GLOB,
    );
    const files = await vscode.workspace.findFiles(
      pattern,
      FeatureWatcher.EXCLUDE_PATTERN,
    );
    return files;
  }

  dispose(): void {
    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // Dispose all VS Code disposables
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    this.watcher = undefined;
  }

  private setupWatcher(): void {
    const pattern = new vscode.RelativePattern(
      this.workspaceFolder,
      FeatureWatcher.FEATURE_GLOB,
    );

    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

    this.disposables.push(
      this.watcher.onDidCreate(uri => this.handleChange(uri)),
      this.watcher.onDidChange(uri => this.handleChange(uri)),
      this.watcher.onDidDelete(uri => this.handleDelete(uri)),
      this.watcher,
    );
  }

  private handleChange(uri: vscode.Uri): void {
    const key = uri.toString();

    // Clear existing timer for this URI
    const existing = this.debounceTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    // Set new debounced timer
    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      this.onFeatureChanged(uri);
    }, FeatureWatcher.DEBOUNCE_MS);

    this.debounceTimers.set(key, timer);
  }

  private handleDelete(uri: vscode.Uri): void {
    const key = uri.toString();

    // Clear any pending debounce timer
    const existing = this.debounceTimers.get(key);
    if (existing) {
      clearTimeout(existing);
      this.debounceTimers.delete(key);
    }

    // Deletions are not debounced — notify immediately
    this.onFeatureDeleted(uri);
  }
}
