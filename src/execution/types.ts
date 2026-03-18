import * as vscode from 'vscode';

// === Discovery Types ===

export interface ParsedFeature {
  uri: string;              // workspace-relative path to .feature file
  name: string;             // Feature name
  description: string;
  language: string;
  tags: string[];           // e.g., ["@api", "@smoke"]
  children: ParsedFeatureChild[];
}

export interface ParsedFeatureChild {
  background?: ParsedBackground;
  scenario?: ParsedScenario;
  rule?: ParsedRule;
}

export interface ParsedBackground {
  name: string;
  line: number;
  keyword: string;
  steps: ParsedStep[];
}

export interface ParsedRule {
  name: string;
  line: number;
  tags: string[];
  children: ParsedRuleChild[];
}

export interface ParsedRuleChild {
  background?: ParsedBackground;
  scenario?: ParsedScenario;
}

export interface ParsedScenario {
  name: string;
  line: number;
  keyword: string;         // "Scenario" or "Scenario Outline"
  tags: string[];
  steps: ParsedStep[];
  examples: ParsedExamples[];  // non-empty only for Scenario Outline
}

export interface ParsedStep {
  keyword: string;
  text: string;
  line: number;
}

export interface ParsedExamples {
  name: string;
  line: number;
  tags: string[];
  tableHeader: string[];
  tableRows: ParsedExampleRow[];
}

export interface ParsedExampleRow {
  line: number;
  cells: string[];
}

export interface ParseError {
  message: string;
  line?: number;
  column?: number;
}

export type ParseResult = { success: true; feature: ParsedFeature } | { success: false; error: ParseError };

// === Metadata ===

export interface TestItemData {
  featurePath: string;          // workspace-relative path
  line: number;
  scenarioName: string;
  inheritedTags: string[];
  type: 'feature' | 'rule' | 'scenario' | 'outline' | 'examples' | 'exampleRow' | 'background';
}

// === Execution Types ===

export interface BuildToolRunner {
  detect(workspaceFolder: vscode.WorkspaceFolder): Promise<boolean>;
  resolveExecutable(workspaceFolder: vscode.WorkspaceFolder): Promise<string>;
  assembleCommand(options: RunOptions): Promise<CommandSpec>;
  assembleDebugCommand(options: RunOptions, debugPort: number): Promise<CommandSpec>;
  getResultsFilePath(workspaceFolder: vscode.WorkspaceFolder): string;
  readExistingPlugins(workspaceFolder: vscode.WorkspaceFolder): Promise<string[]>;
}

export interface RunOptions {
  workspaceFolder: vscode.WorkspaceFolder;
  featureTargets: string[];
  tagExpression?: string;
  runnerClass?: string;
  additionalArgs?: string[];
}

export interface CommandSpec {
  executable: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

// === Result Types ===

export interface TestResult {
  testItemId: string;         // featureUri#line
  status: 'passed' | 'failed' | 'errored' | 'skipped';
  duration: number;           // milliseconds
  errorMessage?: string;
  errorStack?: string;
  failedStepLine?: number;
}

// Note: ProcessResult is also defined in util/processRunner.ts
// Import from there for process-related code
export { type ProcessResult } from '../util/processRunner';
