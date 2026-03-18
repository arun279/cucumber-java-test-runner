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

export class TestTreeBuilder {
  private readonly testData = new Map<string, TestItemData>();

  constructor(private readonly controller: vscode.TestController) {}

  /**
   * Builds the TestItem hierarchy for a parsed feature file and adds it to the controller.
   * Returns the top-level file TestItem.
   */
  buildFileItem(
    workspaceFolder: vscode.WorkspaceFolder,
    parsedFeature: ParsedFeature,
    fileUri: vscode.Uri,
  ): vscode.TestItem {
    const fileItem = this.controller.createTestItem(
      fileUri.toString(),
      parsedFeature.name || fileUri.path.split('/').pop() || 'Unknown',
      fileUri,
    );

    // Set range to line 1 (the Feature keyword is typically at the top)
    fileItem.canResolveChildren = false;

    // Store metadata for the feature file item
    const featurePath = vscode.workspace.asRelativePath(fileUri, false);
    this.storeData(fileItem.id, {
      featurePath,
      line: 1,
      scenarioName: parsedFeature.name,
      inheritedTags: parsedFeature.tags,
      type: 'feature',
    });

    // Add tags to the TestItem
    fileItem.tags = this.createTestTags(parsedFeature.tags);

    // Build children
    this.buildFeatureChildren(fileItem, parsedFeature, featurePath, fileUri, parsedFeature.tags);

    return fileItem;
  }

  /**
   * Syncs the test tree for a file that has been re-parsed.
   * Removes stale items, adds new ones, updates changed ones.
   */
  syncFileItem(
    workspaceFolder: vscode.WorkspaceFolder,
    parsedFeature: ParsedFeature,
    existingFileItem: vscode.TestItem,
    fileUri: vscode.Uri,
  ): void {
    // Clean up old metadata for this file's children
    this.removeChildData(existingFileItem);

    // Update the file item label
    existingFileItem.label = parsedFeature.name || fileUri.path.split('/').pop() || 'Unknown';
    existingFileItem.tags = this.createTestTags(parsedFeature.tags);

    // Update metadata
    const featurePath = vscode.workspace.asRelativePath(fileUri, false);
    this.storeData(existingFileItem.id, {
      featurePath,
      line: 1,
      scenarioName: parsedFeature.name,
      inheritedTags: parsedFeature.tags,
      type: 'feature',
    });

    // Clear existing children
    const oldChildren: string[] = [];
    existingFileItem.children.forEach(child => oldChildren.push(child.id));
    for (const id of oldChildren) {
      existingFileItem.children.delete(id);
    }

    // Rebuild children
    this.buildFeatureChildren(existingFileItem, parsedFeature, featurePath, fileUri, parsedFeature.tags);
  }

  /**
   * Removes a file and all its children from the metadata map.
   */
  removeFile(fileItemId: string, fileItem?: vscode.TestItem): void {
    this.testData.delete(fileItemId);
    if (fileItem) {
      this.removeChildData(fileItem);
    }
  }

  /**
   * Gets metadata for a TestItem by ID.
   */
  getTestData(itemId: string): TestItemData | undefined {
    return this.testData.get(itemId);
  }

  /**
   * Gets all metadata entries.
   */
  getAllTestData(): Map<string, TestItemData> {
    return this.testData;
  }

  // === Private Methods ===

  private buildFeatureChildren(
    parentItem: vscode.TestItem,
    feature: ParsedFeature,
    featurePath: string,
    fileUri: vscode.Uri,
    parentTags: string[],
  ): void {
    for (const child of feature.children) {
      if (child.background) {
        this.addBackgroundItem(parentItem, child.background, featurePath, fileUri);
      }
      if (child.scenario) {
        this.addScenarioItem(parentItem, child.scenario, featurePath, fileUri, parentTags);
      }
      if (child.rule) {
        this.addRuleItem(parentItem, child.rule, featurePath, fileUri, parentTags);
      }
    }
  }

  private addRuleItem(
    parentItem: vscode.TestItem,
    rule: ParsedRule,
    featurePath: string,
    fileUri: vscode.Uri,
    parentTags: string[],
  ): void {
    const id = `${featurePath}#${rule.line}`;
    const ruleItem = this.controller.createTestItem(id, `Rule: ${rule.name}`, fileUri);
    ruleItem.range = new vscode.Range(rule.line - 1, 0, rule.line - 1, 0);

    const combinedTags = [...parentTags, ...rule.tags];
    ruleItem.tags = this.createTestTags(combinedTags);

    this.storeData(id, {
      featurePath,
      line: rule.line,
      scenarioName: rule.name,
      inheritedTags: combinedTags,
      type: 'rule',
    });

    // Add rule children
    for (const child of rule.children) {
      if (child.background) {
        this.addBackgroundItem(ruleItem, child.background, featurePath, fileUri);
      }
      if (child.scenario) {
        this.addScenarioItem(ruleItem, child.scenario, featurePath, fileUri, combinedTags);
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
  ): void {
    const isOutline = scenario.examples.length > 0;
    const id = `${featurePath}#${scenario.line}`;
    const scenarioItem = this.controller.createTestItem(id, scenario.name, fileUri);
    scenarioItem.range = new vscode.Range(scenario.line - 1, 0, scenario.line - 1, 0);

    const combinedTags = [...parentTags, ...scenario.tags];
    scenarioItem.tags = this.createTestTags(combinedTags);

    this.storeData(id, {
      featurePath,
      line: scenario.line,
      scenarioName: scenario.name,
      inheritedTags: combinedTags,
      type: isOutline ? 'outline' : 'scenario',
    });

    if (isOutline) {
      for (const examples of scenario.examples) {
        this.addExamplesItem(scenarioItem, examples, featurePath, fileUri, combinedTags, scenario.name);
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
  ): void {
    const id = `${featurePath}#${examples.line}`;
    const label = examples.name ? `Examples: ${examples.name}` : 'Examples';
    const examplesItem = this.controller.createTestItem(id, label, fileUri);
    examplesItem.range = new vscode.Range(examples.line - 1, 0, examples.line - 1, 0);

    const combinedTags = [...parentTags, ...examples.tags];
    examplesItem.tags = this.createTestTags(combinedTags);

    this.storeData(id, {
      featurePath,
      line: examples.line,
      scenarioName: examples.name || 'Examples',
      inheritedTags: combinedTags,
      type: 'examples',
    });

    // Add individual example rows
    for (const row of examples.tableRows) {
      this.addExampleRowItem(
        examplesItem,
        row,
        examples.tableHeader,
        featurePath,
        fileUri,
        combinedTags,
        scenarioName,
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
  ): void {
    const id = `${featurePath}#${row.line}`;

    // Build a descriptive label from the row cells
    const paramParts = headers.map((h, i) => `${h}=${row.cells[i] ?? ''}`);
    const label = paramParts.join(', ');

    const rowItem = this.controller.createTestItem(id, label, fileUri);
    rowItem.range = new vscode.Range(row.line - 1, 0, row.line - 1, 0);
    rowItem.tags = this.createTestTags(parentTags);

    this.storeData(id, {
      featurePath,
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
  ): void {
    const id = `${featurePath}#bg-${background.line}`;
    const label = background.name
      ? `Background: ${background.name}`
      : 'Background';
    const bgItem = this.controller.createTestItem(id, label, fileUri);
    bgItem.range = new vscode.Range(background.line - 1, 0, background.line - 1, 0);
    bgItem.description = '(runs before each scenario)';

    this.storeData(id, {
      featurePath,
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
