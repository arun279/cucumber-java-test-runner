import * as vscode from 'vscode';

const SECTION = 'cucumberTestRunner';

export function getMavenExecutable(): string {
  return vscode.workspace.getConfiguration(SECTION).get<string>('maven.executable', 'mvn');
}

export function getAdditionalMavenArgs(): string[] {
  return vscode.workspace.getConfiguration(SECTION).get<string[]>('maven.additionalArgs', []);
}

export function getRunnerClass(): string | undefined {
  const value = vscode.workspace.getConfiguration(SECTION).get<string>('runnerClass', '');
  return value || undefined;
}

export function getFeaturesPath(): string | undefined {
  const value = vscode.workspace.getConfiguration(SECTION).get<string>('featuresPath', '');
  return value || undefined;
}

export function getDefaultTags(): string | undefined {
  const value = vscode.workspace.getConfiguration(SECTION).get<string>('defaultTags', '');
  return value || undefined;
}
