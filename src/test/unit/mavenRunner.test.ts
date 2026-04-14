import { strict as assert } from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { MavenRunner } from '../../execution/mavenRunner';

let tmpDir: string;
let runner: MavenRunner;

function makeWorkspaceFolder(fsPath: string) {
  return {
    uri: { fsPath },
    name: path.basename(fsPath),
    index: 0,
  } as any;
}

function mkdirp(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

describe('MavenRunner', () => {

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maven-runner-test-'));
    runner = new MavenRunner();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- getBuildFileNames ---

  describe('getBuildFileNames()', () => {
    it('returns pom.xml', () => {
      assert.deepEqual(runner.getBuildFileNames(), ['pom.xml']);
    });
  });

  // --- detect ---

  describe('detect()', () => {
    it('returns true when pom.xml exists', async () => {
      fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project/>');
      const ws = makeWorkspaceFolder(tmpDir);
      assert.equal(await runner.detect(ws), true);
    });

    it('returns false when pom.xml does not exist', async () => {
      const ws = makeWorkspaceFolder(tmpDir);
      assert.equal(await runner.detect(ws), false);
    });
  });

  // --- detectInSubdirectories ---

  describe('detectInSubdirectories()', () => {
    it('returns true when a subdirectory contains pom.xml', async () => {
      const subdir = path.join(tmpDir, 'module-a');
      mkdirp(subdir);
      fs.writeFileSync(path.join(subdir, 'pom.xml'), '<project/>');
      const ws = makeWorkspaceFolder(tmpDir);
      assert.equal(await runner.detectInSubdirectories(ws), true);
    });

    it('returns false when no subdirectory contains pom.xml', async () => {
      const subdir = path.join(tmpDir, 'module-a');
      mkdirp(subdir);
      // No pom.xml written
      const ws = makeWorkspaceFolder(tmpDir);
      assert.equal(await runner.detectInSubdirectories(ws), false);
    });

    it('ignores files in workspace root (only checks subdirectories)', async () => {
      fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project/>');
      // No subdirectories at all
      const ws = makeWorkspaceFolder(tmpDir);
      assert.equal(await runner.detectInSubdirectories(ws), false);
    });
  });

  // --- resolveExecutable ---

  describe('resolveExecutable()', () => {
    it('returns wrapper path when mvnw exists in project root', async () => {
      const wrapperName = process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw';
      const wrapperPath = path.join(tmpDir, wrapperName);
      fs.writeFileSync(wrapperPath, '');
      assert.equal(await runner.resolveExecutable(tmpDir), wrapperPath);
    });

    it('falls back to workspace root wrapper when not in project root', async () => {
      const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maven-ws-'));
      try {
        const wrapperName = process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw';
        const wrapperPath = path.join(wsRoot, wrapperName);
        fs.writeFileSync(wrapperPath, '');
        assert.equal(await runner.resolveExecutable(tmpDir, wsRoot), wrapperPath);
      } finally {
        fs.rmSync(wsRoot, { recursive: true, force: true });
      }
    });

    it('prefers project root wrapper over workspace root wrapper', async () => {
      const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maven-ws-'));
      try {
        const wrapperName = process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw';
        fs.writeFileSync(path.join(tmpDir, wrapperName), '');
        fs.writeFileSync(path.join(wsRoot, wrapperName), '');
        const result = await runner.resolveExecutable(tmpDir, wsRoot);
        assert.equal(result, path.join(tmpDir, wrapperName));
      } finally {
        fs.rmSync(wsRoot, { recursive: true, force: true });
      }
    });

    it('falls back to configured executable when no wrapper exists', async () => {
      // The mock getConfiguration returns defaultValue, which for getMavenExecutable is 'mvn'
      assert.equal(await runner.resolveExecutable(tmpDir), 'mvn');
    });

    it('does not check workspace root when it equals project root', async () => {
      // No wrapper in tmpDir — should fall back to 'mvn', not loop
      assert.equal(await runner.resolveExecutable(tmpDir, tmpDir), 'mvn');
    });

    if (process.platform === 'win32') {
      it('prefers mvnw.cmd over mvnw on Windows', async () => {
        fs.writeFileSync(path.join(tmpDir, 'mvnw.cmd'), '');
        fs.writeFileSync(path.join(tmpDir, 'mvnw'), '');
        const result = await runner.resolveExecutable(tmpDir);
        assert.equal(path.basename(result), 'mvnw.cmd');
      });
    }
  });

  // --- getResultsFilePath ---

  describe('getResultsFilePath()', () => {
    it('returns target/cucumber-vscode-results.json', () => {
      const expected = path.join(tmpDir, 'target', 'cucumber-vscode-results.json');
      assert.equal(runner.getResultsFilePath(tmpDir), expected);
    });
  });

  // --- readExistingPlugins ---

  describe('readExistingPlugins()', () => {
    it('reads plugins from junit-platform.properties', async () => {
      const propsDir = path.join(tmpDir, 'src', 'test', 'resources');
      mkdirp(propsDir);
      fs.writeFileSync(
        path.join(propsDir, 'junit-platform.properties'),
        'cucumber.plugin = pretty, html:target/cucumber-report.html\n',
      );

      const plugins = await runner.readExistingPlugins(tmpDir);
      assert.deepEqual(plugins, ['pretty', 'html:target/cucumber-report.html']);
    });

    it('returns empty array when properties file does not exist', async () => {
      const plugins = await runner.readExistingPlugins(tmpDir);
      assert.deepEqual(plugins, []);
    });

    it('returns empty array when cucumber.plugin is not defined', async () => {
      const propsDir = path.join(tmpDir, 'src', 'test', 'resources');
      mkdirp(propsDir);
      fs.writeFileSync(
        path.join(propsDir, 'junit-platform.properties'),
        'cucumber.glue = com.example.steps\n',
      );

      const plugins = await runner.readExistingPlugins(tmpDir);
      assert.deepEqual(plugins, []);
    });

    it('handles single plugin without commas', async () => {
      const propsDir = path.join(tmpDir, 'src', 'test', 'resources');
      mkdirp(propsDir);
      fs.writeFileSync(
        path.join(propsDir, 'junit-platform.properties'),
        'cucumber.plugin=pretty\n',
      );

      const plugins = await runner.readExistingPlugins(tmpDir);
      assert.deepEqual(plugins, ['pretty']);
    });
  });

  // --- assembleCommand ---

  describe('assembleCommand()', () => {
    it('includes "test" as the first arg', async () => {
      const cmd = await runner.assembleCommand({
        projectRoot: tmpDir,
        featureTargets: [],
      });
      assert.equal(cmd.args[0], 'test');
    });

    it('includes -Dtest when runnerClass is provided and no feature targets', async () => {
      const cmd = await runner.assembleCommand({
        projectRoot: tmpDir,
        featureTargets: [],
        runnerClass: 'com.example.RunCucumber',
      });
      assert.ok(cmd.args.includes('-Dtest=com.example.RunCucumber'));
    });

    it('omits -Dtest when runnerClass is not provided', async () => {
      const cmd = await runner.assembleCommand({
        projectRoot: tmpDir,
        featureTargets: [],
      });
      assert.ok(!cmd.args.some(a => a.startsWith('-Dtest=')));
    });

    it('includes -Dcucumber.filter.tags when tag expression provided', async () => {
      const cmd = await runner.assembleCommand({
        projectRoot: tmpDir,
        featureTargets: [],
        tagExpression: '@smoke and not @wip',
      });
      assert.ok(cmd.args.includes('-Dcucumber.filter.tags=@smoke and not @wip'));
    });

    it('omits -Dcucumber.filter.tags when no tag expression', async () => {
      const cmd = await runner.assembleCommand({
        projectRoot: tmpDir,
        featureTargets: [],
      });
      assert.ok(!cmd.args.some(a => a.startsWith('-Dcucumber.filter.tags=')));
    });

    it('preserves existing plugins and appends JSON reporter', async () => {
      const propsDir = path.join(tmpDir, 'src', 'test', 'resources');
      mkdirp(propsDir);
      fs.writeFileSync(
        path.join(propsDir, 'junit-platform.properties'),
        'cucumber.plugin = pretty, html:target/report.html\n',
      );

      const cmd = await runner.assembleCommand({
        projectRoot: tmpDir,
        featureTargets: [],
      });

      const pluginArg = cmd.args.find(a => a.startsWith('-Dcucumber.plugin='));
      assert.ok(pluginArg);
      const plugins = pluginArg!.replace('-Dcucumber.plugin=', '');
      assert.ok(plugins.includes('pretty'));
      assert.ok(plugins.includes('html:target/report.html'));
      assert.ok(plugins.includes('json:'));
      assert.ok(plugins.includes('cucumber-vscode-results.json'));
    });

    it('replaces existing json: plugin with ours', async () => {
      const propsDir = path.join(tmpDir, 'src', 'test', 'resources');
      mkdirp(propsDir);
      fs.writeFileSync(
        path.join(propsDir, 'junit-platform.properties'),
        'cucumber.plugin = pretty, json:target/old-results.json\n',
      );

      const cmd = await runner.assembleCommand({
        projectRoot: tmpDir,
        featureTargets: [],
      });

      const pluginArg = cmd.args.find(a => a.startsWith('-Dcucumber.plugin='))!;
      const plugins = pluginArg.replace('-Dcucumber.plugin=', '').split(',');
      const jsonPlugins = plugins.filter(p => p.startsWith('json:'));
      assert.equal(jsonPlugins.length, 1, 'Should have exactly one json: plugin');
      assert.ok(jsonPlugins[0].includes('cucumber-vscode-results.json'));
    });

    it('includes additional args', async () => {
      const cmd = await runner.assembleCommand({
        projectRoot: tmpDir,
        featureTargets: [],
        additionalArgs: ['-Pintegration', '-X'],
      });
      assert.ok(cmd.args.includes('-Pintegration'));
      assert.ok(cmd.args.includes('-X'));
    });

    it('always includes -DfailIfNoTests=false', async () => {
      const cmd = await runner.assembleCommand({
        projectRoot: tmpDir,
        featureTargets: [],
      });
      assert.ok(cmd.args.includes('-DfailIfNoTests=false'));
    });

    it('sets cwd to project root', async () => {
      const cmd = await runner.assembleCommand({
        projectRoot: tmpDir,
        featureTargets: [],
      });
      assert.equal(cmd.cwd, tmpDir);
    });
  });

  // --- assembleDebugCommand ---

  describe('assembleDebugCommand()', () => {
    it('adds maven.surefire.debug with correct port', async () => {
      const cmd = await runner.assembleDebugCommand({
        projectRoot: tmpDir,
        featureTargets: [],
      }, 5005);

      const debugArg = cmd.args.find(a => a.startsWith('-Dmaven.surefire.debug='));
      assert.ok(debugArg, 'Should have maven.surefire.debug arg');
      assert.ok(debugArg!.includes('address=localhost:5005'));
      assert.ok(debugArg!.includes('suspend=y'));
      assert.ok(debugArg!.includes('server=y'));
      assert.ok(debugArg!.includes('dt_socket'));
    });

    it('includes all base command args plus debug arg', async () => {
      const baseCmd = await runner.assembleCommand({
        projectRoot: tmpDir,
        featureTargets: [],
        runnerClass: 'com.example.Run',
      });
      const debugCmd = await runner.assembleDebugCommand({
        projectRoot: tmpDir,
        featureTargets: [],
        runnerClass: 'com.example.Run',
      }, 9999);

      // Debug command should have all base args plus the debug arg
      for (const arg of baseCmd.args) {
        assert.ok(debugCmd.args.includes(arg), `Debug command should include base arg: ${arg}`);
      }
      assert.equal(debugCmd.args.length, baseCmd.args.length + 1);
    });
  });

  // --- assembleCompileCommand ---

  describe('assembleCompileCommand()', () => {
    it('runs test-compile and dependency:build-classpath', async () => {
      const cmd = await runner.assembleCompileCommand({
        projectRoot: tmpDir,
        featureTargets: [],
      });
      assert.equal(cmd.args[0], 'test-compile');
      assert.equal(cmd.args[1], 'dependency:build-classpath');
      assert.ok(cmd.args[2].startsWith('-Dmdep.outputFile='));
      assert.ok(cmd.args[2].includes('cp.txt'));
      assert.equal(cmd.cwd, tmpDir);
    });
  });

  // --- assembleCucumberCliCommand ---

  describe('assembleCucumberCliCommand()', () => {
    it('invokes io.cucumber.core.cli.Main with feature targets', () => {
      // Write a classpath file (simulates compile step output)
      mkdirp(path.join(tmpDir, 'target'));
      fs.writeFileSync(path.join(tmpDir, 'target', 'cp.txt'), '/some/dep.jar');

      const cmd = runner.assembleCucumberCliCommand({
        projectRoot: tmpDir,
        featureTargets: ['src/test/resources/login.feature:10'],
      });
      assert.ok(cmd.args.includes('io.cucumber.core.cli.Main'));
      assert.ok(cmd.args.includes('src/test/resources/login.feature:10'));
      assert.ok(cmd.args.some(a => a.startsWith('json:')),
        'Should include json plugin');
    });

    it('includes --glue from junit-platform.properties', () => {
      mkdirp(path.join(tmpDir, 'target'));
      fs.writeFileSync(path.join(tmpDir, 'target', 'cp.txt'), '/some/dep.jar');
      const propsDir = path.join(tmpDir, 'src', 'test', 'resources');
      mkdirp(propsDir);
      fs.writeFileSync(
        path.join(propsDir, 'junit-platform.properties'),
        'cucumber.glue = com.example.steps\n',
      );

      const cmd = runner.assembleCucumberCliCommand({
        projectRoot: tmpDir,
        featureTargets: ['f.feature:1'],
      });
      const glueIdx = cmd.args.indexOf('--glue');
      assert.ok(glueIdx >= 0, 'Should have --glue flag');
      assert.equal(cmd.args[glueIdx + 1], 'com.example.steps');
    });

    it('includes --tags when tag expression provided', () => {
      mkdirp(path.join(tmpDir, 'target'));
      fs.writeFileSync(path.join(tmpDir, 'target', 'cp.txt'), '/some/dep.jar');

      const cmd = runner.assembleCucumberCliCommand({
        projectRoot: tmpDir,
        featureTargets: ['f.feature:1'],
        tagExpression: 'not @wip',
      });
      const tagsIdx = cmd.args.indexOf('--tags');
      assert.ok(tagsIdx >= 0, 'Should have --tags flag');
      assert.equal(cmd.args[tagsIdx + 1], 'not @wip');
    });

    it('builds classpath from cp.txt + target dirs', () => {
      mkdirp(path.join(tmpDir, 'target'));
      fs.writeFileSync(path.join(tmpDir, 'target', 'cp.txt'), '/dep1.jar:/dep2.jar');

      const cmd = runner.assembleCucumberCliCommand({
        projectRoot: tmpDir,
        featureTargets: ['f.feature:1'],
      });
      const cpIdx = cmd.args.indexOf('-cp');
      const cp = cmd.args[cpIdx + 1];
      assert.ok(cp.includes('test-classes'), 'Classpath should include target/test-classes');
      assert.ok(cp.includes('classes'), 'Classpath should include target/classes');
      assert.ok(cp.includes('dep1.jar'), 'Classpath should include dependencies');
    });
  });

  // --- assembleCucumberCliDebugCommand ---

  describe('assembleCucumberCliDebugCommand()', () => {
    it('inserts JDWP agent before main class', () => {
      mkdirp(path.join(tmpDir, 'target'));
      fs.writeFileSync(path.join(tmpDir, 'target', 'cp.txt'), '/some/dep.jar');

      const cmd = runner.assembleCucumberCliDebugCommand({
        projectRoot: tmpDir,
        featureTargets: ['f.feature:1'],
      }, 5005);

      const mainIdx = cmd.args.indexOf('io.cucumber.core.cli.Main');
      const jdwpIdx = cmd.args.findIndex(a => a.includes('jdwp'));
      assert.ok(jdwpIdx >= 0, 'Should have JDWP arg');
      assert.ok(jdwpIdx < mainIdx, 'JDWP arg should come before main class');
      assert.ok(cmd.args[jdwpIdx].includes('address=localhost:5005'));
    });
  });
});
