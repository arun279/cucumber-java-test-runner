import * as vscode from 'vscode';

interface CachedResult {
  className: string | undefined;
  timestamp: number;
}

const CACHE_TTL_MS = 60_000; // 1 minute
const cache = new Map<string, CachedResult>();

/**
 * Detects the Cucumber runner class in the workspace.
 * Scans src/test/java/**\/*.java for @IncludeEngines("cucumber") or @Cucumber annotations.
 * Results are cached for 60 seconds per workspace folder.
 */
export async function detectRunnerClass(
  workspaceFolder: vscode.WorkspaceFolder,
): Promise<string | undefined> {
  const cacheKey = workspaceFolder.uri.toString();
  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.className;
  }

  const className = await scanForRunnerClass(workspaceFolder);
  cache.set(cacheKey, { className, timestamp: Date.now() });
  return className;
}

/**
 * Clears the cached runner class for a workspace folder.
 */
export function clearRunnerCache(workspaceFolder?: vscode.WorkspaceFolder): void {
  if (workspaceFolder) {
    cache.delete(workspaceFolder.uri.toString());
  } else {
    cache.clear();
  }
}

async function scanForRunnerClass(
  workspaceFolder: vscode.WorkspaceFolder,
): Promise<string | undefined> {
  // Search in src/test/java only (Cucumber runners are test classes)
  const pattern = new vscode.RelativePattern(workspaceFolder, 'src/test/java/**/*.java');
  const files = await vscode.workspace.findFiles(pattern, '**/target/**', 100);

  for (const fileUri of files) {
    const contentBytes = await vscode.workspace.fs.readFile(fileUri);
    const content = Buffer.from(contentBytes).toString('utf-8');

    const className = extractRunnerClassName(content);
    if (className) {
      return className;
    }
  }

  return undefined;
}

/**
 * Extracts the runner class name from Java source if it contains
 * Cucumber runner annotations.
 */
export function extractRunnerClassName(javaContent: string): string | undefined {
  // Check for modern JUnit Platform approach: @IncludeEngines("cucumber")
  // Supports both @IncludeEngines("cucumber") and @IncludeEngines({"cucumber"})
  const hasIncludeEngines = /\@IncludeEngines\s*\(\s*\{?\s*"cucumber"\s*\}?\s*\)/.test(javaContent);

  // Check for deprecated @Cucumber annotation
  const hasCucumberAnnotation = /\@Cucumber\b/.test(javaContent);

  if (!hasIncludeEngines && !hasCucumberAnnotation) {
    return undefined;
  }

  // Extract class name from "public class ClassName" or just "class ClassName"
  const classMatch = javaContent.match(/(?:public\s+)?class\s+(\w+)/);
  return classMatch ? classMatch[1] : undefined;
}
