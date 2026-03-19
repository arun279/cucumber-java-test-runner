import * as fs from 'fs';
import * as path from 'path';

/**
 * Finds the build project root for a given file by walking up directories
 * until finding a build file (e.g., pom.xml, build.gradle) with a sibling
 * src/ directory (indicating a buildable module, not just an aggregator).
 *
 * Build-tool-agnostic: accepts an array of build file names to look for.
 * Each BuildToolRunner provides its own patterns via getBuildFileNames().
 *
 * Returns undefined if no matching project root is found.
 *
 * @param filePath - absolute path to a file (e.g., a .feature file)
 * @param buildFileNames - build file names to look for (e.g., ['pom.xml'] or ['build.gradle', 'build.gradle.kts'])
 */
export function findProjectRoot(filePath: string, buildFileNames: string[]): string | undefined {
  let dir = path.dirname(filePath);
  const root = path.parse(dir).root;

  while (dir !== root) {
    if (hasBuildFile(dir, buildFileNames) && fs.existsSync(path.join(dir, 'src'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Check root itself
  if (hasBuildFile(dir, buildFileNames) && fs.existsSync(path.join(dir, 'src'))) {
    return dir;
  }

  return undefined;
}

function hasBuildFile(dir: string, buildFileNames: string[]): boolean {
  return buildFileNames.some(name => fs.existsSync(path.join(dir, name)));
}
