import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findProjectRoot } from '../../util/projectDetector';

describe('projectDetector', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-detect-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Helper to create nested directories and optionally write files. */
  function mkStructure(layout: Record<string, null>): void {
    for (const p of Object.keys(layout)) {
      const full = path.join(tmpDir, p);
      if (p.endsWith('/')) {
        fs.mkdirSync(full, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, '');
      }
    }
  }

  describe('findProjectRoot', () => {

    it('finds pom.xml with src/ sibling in the project directory', () => {
      mkStructure({
        'project/pom.xml': null,
        'project/src/': null,
        'project/src/test/resources/features/login.feature': null,
      });
      const feature = path.join(tmpDir, 'project/src/test/resources/features/login.feature');
      assert.equal(findProjectRoot(feature, ['pom.xml']), path.join(tmpDir, 'project'));
    });

    it('finds project root when workspace root has no build file', () => {
      mkStructure({
        'workspace/proj1/pom.xml': null,
        'workspace/proj1/src/test/resources/features/login.feature': null,
      });
      const feature = path.join(tmpDir, 'workspace/proj1/src/test/resources/features/login.feature');
      assert.equal(findProjectRoot(feature, ['pom.xml']), path.join(tmpDir, 'workspace/proj1'));
    });

    it('skips parent aggregator (pom.xml but no src/) and finds nearest buildable module', () => {
      mkStructure({
        'root/pom.xml': null,
        'root/module-a/pom.xml': null,
        'root/module-a/src/test/resources/features/checkout.feature': null,
      });
      // root/ has pom.xml but no src/ — aggregator
      const feature = path.join(tmpDir, 'root/module-a/src/test/resources/features/checkout.feature');
      assert.equal(findProjectRoot(feature, ['pom.xml']), path.join(tmpDir, 'root/module-a'));
    });

    it('finds parent POM when it IS the buildable project (has both pom.xml and src/)', () => {
      mkStructure({
        'root/pom.xml': null,
        'root/src/test/resources/features/checkout.feature': null,
      });
      const feature = path.join(tmpDir, 'root/src/test/resources/features/checkout.feature');
      assert.equal(findProjectRoot(feature, ['pom.xml']), path.join(tmpDir, 'root'));
    });

    it('returns undefined when no build file found anywhere', () => {
      mkStructure({
        'project/src/test/resources/features/login.feature': null,
      });
      const feature = path.join(tmpDir, 'project/src/test/resources/features/login.feature');
      assert.equal(findProjectRoot(feature, ['pom.xml']), undefined);
    });

    it('terminates without error for nonexistent paths', () => {
      const feature = path.join(tmpDir, 'does/not/exist/login.feature');
      assert.equal(findProjectRoot(feature, ['pom.xml']), undefined);
    });

    it('returns undefined when feature file is outside any project', () => {
      mkStructure({
        'stray/login.feature': null,
      });
      const feature = path.join(tmpDir, 'stray/login.feature');
      assert.equal(findProjectRoot(feature, ['pom.xml']), undefined);
    });

    it('works with build.gradle as build file name (tool-agnostic)', () => {
      mkStructure({
        'gradle-proj/build.gradle': null,
        'gradle-proj/src/test/resources/features/login.feature': null,
      });
      const feature = path.join(tmpDir, 'gradle-proj/src/test/resources/features/login.feature');
      assert.equal(findProjectRoot(feature, ['build.gradle']), path.join(tmpDir, 'gradle-proj'));
    });

    it('works with multiple build file names — matches either', () => {
      mkStructure({
        'kotlin-proj/build.gradle.kts': null,
        'kotlin-proj/src/test/resources/features/login.feature': null,
      });
      const feature = path.join(tmpDir, 'kotlin-proj/src/test/resources/features/login.feature');
      assert.equal(
        findProjectRoot(feature, ['build.gradle', 'build.gradle.kts']),
        path.join(tmpDir, 'kotlin-proj'),
      );
    });

  });
});
