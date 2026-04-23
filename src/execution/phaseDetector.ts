import * as fs from 'fs';
import * as path from 'path';

export type MavenPhase = 'test' | 'verify';

interface CachedResult {
  phase: MavenPhase;
  mtimeMs: number;
  timestamp: number;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CachedResult>();

/**
 * Decides whether a project should be driven by `mvn test` (Surefire) or
 * `mvn verify` (Failsafe).
 *
 * Returns 'verify' when pom.xml declares an active `maven-failsafe-plugin`
 * entry — i.e. inside `<build><plugins>` or a `<profiles>/<profile>/<build><plugins>`
 * block. Entries that appear only in `<pluginManagement>` are ignored: they
 * don't activate the plugin, which is exactly the shape spring-boot-starter-parent
 * ships with.
 *
 * Results are cached for 60s keyed by pom.xml mtime so edits invalidate promptly.
 */
export function detectMavenPhase(projectRoot: string): MavenPhase {
  const pomPath = path.join(projectRoot, 'pom.xml');

  let stat: fs.Stats;
  try {
    stat = fs.statSync(pomPath);
  } catch {
    return 'test';
  }

  const cached = cache.get(projectRoot);
  if (
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    Date.now() - cached.timestamp < CACHE_TTL_MS
  ) {
    return cached.phase;
  }

  let content: string;
  try {
    content = fs.readFileSync(pomPath, 'utf-8');
  } catch {
    return 'test';
  }

  const phase = hasActiveFailsafePlugin(content) ? 'verify' : 'test';
  cache.set(projectRoot, { phase, mtimeMs: stat.mtimeMs, timestamp: Date.now() });
  return phase;
}

export function clearPhaseCache(projectRoot?: string): void {
  if (projectRoot) {
    cache.delete(projectRoot);
  } else {
    cache.clear();
  }
}

/**
 * Returns true if any `<plugins>` block outside `<pluginManagement>` declares
 * `maven-failsafe-plugin`. Includes profile-scoped plugin blocks, since those
 * are a common way to gate integration tests.
 */
export function hasActiveFailsafePlugin(pomXml: string): boolean {
  const stripped = stripXmlComments(pomXml);
  const activeBlocks = extractActivePluginBlocks(stripped);
  for (const block of activeBlocks) {
    if (/<artifactId>\s*maven-failsafe-plugin\s*<\/artifactId>/.test(block)) {
      return true;
    }
  }
  return false;
}

function stripXmlComments(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Extracts the contents of every `<plugins>...</plugins>` block that is NOT
 * nested inside a `<pluginManagement>` element. Profile-scoped plugin blocks
 * are included.
 */
function extractActivePluginBlocks(xml: string): string[] {
  const blocks: string[] = [];
  const re = /<plugins\b[^>]*>([\s\S]*?)<\/plugins>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    if (!isInsidePluginManagement(xml, match.index)) {
      blocks.push(match[1]);
    }
  }
  return blocks;
}

function isInsidePluginManagement(xml: string, offset: number): boolean {
  const before = xml.slice(0, offset);
  const lastOpen = before.lastIndexOf('<pluginManagement');
  if (lastOpen === -1) return false;
  const lastClose = before.lastIndexOf('</pluginManagement>');
  return lastClose < lastOpen;
}
