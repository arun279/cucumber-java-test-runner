import * as path from 'path';
import * as vscode from 'vscode';
import {
  ParsedFeature,
  ParsedScenario,
  ParsedRule,
  ParsedBackground,
  ParsedExamples,
  ParsedExampleRow,
  TestItemData,
} from '../execution/types';
import { findProjectRoot } from '../util/projectDetector';

export class TestTreeBuilder {
  private readonly testData = new Map<string, TestItemData>();
  private readonly projectItems = new Map<string, vscode.TestItem>();

  constructor(
    private readonly controller: vscode.TestController,
    private readonly buildFileNames: string[],
  ) {}

  /**
   * Builds the TestItem hierarchy for a parsed feature file and adds it
   * under the appropriate project grouping node in the controller.
   */
  buildFileItem(
    parsedFeature: ParsedFeature,
    fileUri: vscode.Uri,
  ): void {
    const projectRoot = findProjectRoot(fileUri.fsPath, this.buildFileNames) ?? path.dirname(fileUri.fsPath);
    const projectName = path.basename(projectRoot);
    const featurePath = path.relative(projectRoot, fileUri.fsPath).replace(/\\/g, '/');

    // Get or create the project-level grouping item
    const projectItem = this.getOrCreateProjectItem(projectRoot, projectName);

    const fileItem = this.controller.createTestItem(
      fileUri.toString(),
      parsedFeature.name || fileUri.path.split('/').pop() || 'Unknown',
      fileUri,
    );

    fileItem.canResolveChildren = false;

    this.storeData(fileItem.id, {
      featurePath,
      projectRoot,
      line: 1,
      scenarioName: parsedFeature.name,
      inheritedTags: parsedFeature.tags,
      type: 'feature',
    });

    fileItem.tags = this.createTestTags(parsedFeature.tags);
    this.buildFeatureChildren(fileItem, parsedFeature, featurePath, fileUri, parsedFeature.tags, projectRoot, projectName);

    projectItem.children.add(fileItem);
  }

  /**
   * Syncs the test tree for a file that has been re-parsed.
   */
  syncFileItem(
    parsedFeature: ParsedFeature,
    existingFileItem: vscode.TestItem,
    fileUri: vscode.Uri,
  ): void {
    const projectRoot = findProjectRoot(fileUri.fsPath, this.buildFileNames) ?? path.dirname(fileUri.fsPath);
    const projectName = path.basename(projectRoot);
    const featurePath = path.relative(projectRoot, fileUri.fsPath).replace(/\\/g, '/');

    this.removeChildData(existingFileItem);

    existingFileItem.label = parsedFeature.name || fileUri.path.split('/').pop() || 'Unknown';
    existingFileItem.tags = this.createTestTags(parsedFeature.tags);

    this.storeData(existingFileItem.id, {
      featurePath,
      projectRoot,
      line: 1,
      scenarioName: parsedFeature.name,
      inheritedTags: parsedFeature.tags,
      type: 'feature',
    });

    const oldChildren: string[] = [];
    existingFileItem.children.forEach(child => oldChildren.push(child.id));
    for (const id of oldChildren) {
      existingFileItem.children.delete(id);
    }

    this.buildFeatureChildren(existingFileItem, parsedFeature, featurePath, fileUri, parsedFeature.tags, projectRoot, projectName);
  }

  /**
   * Removes a file and all its children from the metadata map.
   * Also removes the project grouping item if it becomes empty.
   */
  removeFile(fileItemId: string, fileItem?: vscode.TestItem): void {
    // Get project root from metadata before deleting it
    const data = this.testData.get(fileItemId);
    this.testData.delete(fileItemId);
    if (fileItem) {
      this.removeChildData(fileItem);
    }

    // Remove from the correct project node and clean up if empty
    if (data) {
      const projectItem = this.projectItems.get(data.projectRoot);
      if (projectItem) {
        projectItem.children.delete(fileItemId);
        if (projectItem.children.size === 0) {
          this.controller.items.delete(projectItem.id);
          this.projectItems.delete(data.projectRoot);
        }
      }
    }
  }

  /**
   * Finds a file item by URI, searching within project grouping items.
   */
  findFileItem(fileUri: vscode.Uri): vscode.TestItem | undefined {
    const fileItemId = fileUri.toString();
    for (const projectItem of this.projectItems.values()) {
      const item = projectItem.children.get(fileItemId);
      if (item) return item;
    }
    return undefined;
  }

  getTestData(itemId: string): TestItemData | undefined {
    return this.testData.get(itemId);
  }

  getAllTestData(): Map<string, TestItemData> {
    return this.testData;
  }

  /**
   * Clears all project items and metadata. Used during refresh.
   */
  clear(): void {
    this.testData.clear();
    this.projectItems.clear();
  }

  // === Private Methods ===

  /**
   * Gets or creates a project-level grouping TestItem.
   * These appear as top-level nodes in the Test Explorer (e.g., "task-manager", "my-api").
   */
  private getOrCreateProjectItem(projectRoot: string, projectName: string): vscode.TestItem {
    let projectItem = this.projectItems.get(projectRoot);
    if (projectItem) return projectItem;

    const id = `project:${projectRoot}`;
    projectItem = this.controller.createTestItem(id, projectName);
    projectItem.canResolveChildren = false;
    this.controller.items.add(projectItem);
    this.projectItems.set(projectRoot, projectItem);
    return projectItem;
  }

  private buildFeatureChildren(
    parentItem: vscode.TestItem,
    feature: ParsedFeature,
    featurePath: string,
    fileUri: vscode.Uri,
    parentTags: string[],
    projectRoot: string,
    projectName: string,
  ): void {
    for (const child of feature.children) {
      if (child.background) {
        this.addBackgroundItem(parentItem, child.background, featurePath, fileUri, projectRoot, projectName);
      }
      if (child.scenario) {
        this.addScenarioItem(parentItem, child.scenario, featurePath, fileUri, parentTags, projectRoot, projectName);
      }
      if (child.rule) {
        this.addRuleItem(parentItem, child.rule, featurePath, fileUri, parentTags, projectRoot, projectName);
      }
    }
  }

  private addRuleItem(
    parentItem: vscode.TestItem,
    rule: ParsedRule,
    featurePath: string,
    fileUri: vscode.Uri,
    parentTags: string[],
    projectRoot: string,
    projectName: string,
  ): void {
    const id = `${projectName}/${featurePath}#${rule.line}`;
    const ruleItem = this.controller.createTestItem(id, `Rule: ${rule.name}`, fileUri);
    ruleItem.range = new vscode.Range(rule.line - 1, 0, rule.line - 1, 0);

    const combinedTags = [...parentTags, ...rule.tags];
    ruleItem.tags = this.createTestTags(combinedTags);

    this.storeData(id, {
      featurePath,
      projectRoot,
      line: rule.line,
      scenarioName: rule.name,
      inheritedTags: combinedTags,
      type: 'rule',
    });

    for (const child of rule.children) {
      if (child.background) {
        this.addBackgroundItem(ruleItem, child.background, featurePath, fileUri, projectRoot, projectName);
      }
      if (child.scenario) {
        this.addScenarioItem(ruleItem, child.scenario, featurePath, fileUri, combinedTags, projectRoot, projectName);
      }
    }

    parentItem.children.add(ruleItem);
  }

  private addScenarioItem(
    parentItem: vscode.TestItem,
    scenario: ParsedScenario,
    featurePath: string,
    fileUri: vscode.Uri,
    parentTags: string[],
    projectRoot: string,
    projectName: string,
  ): void {
    const isOutline = scenario.examples.length > 0;
    const id = `${projectName}/${featurePath}#${scenario.line}`;
    const scenarioItem = this.controller.createTestItem(id, scenario.name, fileUri);
    scenarioItem.range = new vscode.Range(scenario.line - 1, 0, scenario.line - 1, 0);

    const combinedTags = [...parentTags, ...scenario.tags];
    scenarioItem.tags = this.createTestTags(combinedTags);

    this.storeData(id, {
      featurePath,
      projectRoot,
      line: scenario.line,
      scenarioName: scenario.name,
      inheritedTags: combinedTags,
      type: isOutline ? 'outline' : 'scenario',
    });

    if (isOutline) {
      for (const examples of scenario.examples) {
        this.addExamplesItem(scenarioItem, examples, featurePath, fileUri, combinedTags, scenario.name, projectRoot, projectName);
      }
    }

    parentItem.children.add(scenarioItem);
  }

  private addExamplesItem(
    parentItem: vscode.TestItem,
    examples: ParsedExamples,
    featurePath: string,
    fileUri: vscode.Uri,
    parentTags: string[],
    scenarioName: string,
    projectRoot: string,
    projectName: string,
  ): void {
    const id = `${projectName}/${featurePath}#${examples.line}`;
    const label = examples.name ? `Examples: ${examples.name}` : 'Examples';
    const examplesItem = this.controller.createTestItem(id, label, fileUri);
    examplesItem.range = new vscode.Range(examples.line - 1, 0, examples.line - 1, 0);

    const combinedTags = [...parentTags, ...examples.tags];
    examplesItem.tags = this.createTestTags(combinedTags);

    this.storeData(id, {
      featurePath,
      projectRoot,
      line: examples.line,
      scenarioName: examples.name || 'Examples',
      inheritedTags: combinedTags,
      type: 'examples',
    });

    for (const row of examples.tableRows) {
      this.addExampleRowItem(
        examplesItem,
        row,
        examples.tableHeader,
        featurePath,
        fileUri,
        combinedTags,
        scenarioName,
        projectRoot,
        projectName,
      );
    }

    parentItem.children.add(examplesItem);
  }

  private addExampleRowItem(
    parentItem: vscode.TestItem,
    row: ParsedExampleRow,
    headers: string[],
    featurePath: string,
    fileUri: vscode.Uri,
    parentTags: string[],
    scenarioName: string,
    projectRoot: string,
    projectName: string,
  ): void {
    const id = `${projectName}/${featurePath}#${row.line}`;

    const paramParts = headers.map((h, i) => `${h}=${row.cells[i] ?? ''}`);
    const label = paramParts.join(', ');

    const rowItem = this.controller.createTestItem(id, label, fileUri);
    rowItem.range = new vscode.Range(row.line - 1, 0, row.line - 1, 0);
    rowItem.tags = this.createTestTags(parentTags);

    this.storeData(id, {
      featurePath,
      projectRoot,
      line: row.line,
      scenarioName: `${scenarioName} [${label}]`,
      inheritedTags: parentTags,
      type: 'exampleRow',
    });

    parentItem.children.add(rowItem);
  }

  private addBackgroundItem(
    parentItem: vscode.TestItem,
    background: ParsedBackground,
    featurePath: string,
    fileUri: vscode.Uri,
    projectRoot: string,
    projectName: string,
  ): void {
    const id = `${projectName}/${featurePath}#bg-${background.line}`;
    const label = background.name
      ? `Background: ${background.name}`
      : 'Background';
    const bgItem = this.controller.createTestItem(id, label, fileUri);
    bgItem.range = new vscode.Range(background.line - 1, 0, background.line - 1, 0);
    bgItem.description = '(runs before each scenario)';

    this.storeData(id, {
      featurePath,
      projectRoot,
      line: background.line,
      scenarioName: background.name || 'Background',
      inheritedTags: [],
      type: 'background',
    });

    parentItem.children.add(bgItem);
  }

  private createTestTags(tags: string[]): vscode.TestTag[] {
    return tags.map(tag => new vscode.TestTag(tag));
  }

  private storeData(id: string, data: TestItemData): void {
    this.testData.set(id, data);
  }

  private removeChildData(item: vscode.TestItem): void {
    item.children.forEach(child => {
      this.testData.delete(child.id);
      this.removeChildData(child);
    });
  }
}
