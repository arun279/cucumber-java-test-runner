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

  // --- resolveExecutable ---

  describe('resolveExecutable()', () => {
    it('returns wrapper path when mvnw exists', async () => {
      const wrapperName = process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw';
      const wrapperPath = path.join(tmpDir, wrapperName);
      fs.writeFileSync(wrapperPath, '');
      const ws = makeWorkspaceFolder(tmpDir);
      assert.equal(await runner.resolveExecutable(ws), wrapperPath);
    });

    it('falls back to configured executable when no wrapper exists', async () => {
      const ws = makeWorkspaceFolder(tmpDir);
      // The mock getConfiguration returns defaultValue, which for getMavenExecutable is 'mvn'
      assert.equal(await runner.resolveExecutable(ws), 'mvn');
    });

    if (process.platform === 'win32') {
      it('prefers mvnw.cmd over mvnw on Windows', async () => {
        fs.writeFileSync(path.join(tmpDir, 'mvnw.cmd'), '');
        fs.writeFileSync(path.join(tmpDir, 'mvnw'), '');
        const ws = makeWorkspaceFolder(tmpDir);
        const result = await runner.resolveExecutable(ws);
        assert.equal(path.basename(result), 'mvnw.cmd');
      });
    }
  });

  // --- getResultsFilePath ---

  describe('getResultsFilePath()', () => {
    it('returns target/cucumber-vscode-results.json', () => {
      const ws = makeWorkspaceFolder(tmpDir);
      const expected = path.join(tmpDir, 'target', 'cucumber-vscode-results.json');
      assert.equal(runner.getResultsFilePath(ws), expected);
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

      const ws = makeWorkspaceFolder(tmpDir);
      const plugins = await runner.readExistingPlugins(ws);
      assert.deepEqual(plugins, ['pretty', 'html:target/cucumber-report.html']);
    });

    it('returns empty array when properties file does not exist', async () => {
      const ws = makeWorkspaceFolder(tmpDir);
      const plugins = await runner.readExistingPlugins(ws);
      assert.deepEqual(plugins, []);
    });

    it('returns empty array when cucumber.plugin is not defined', async () => {
      const propsDir = path.join(tmpDir, 'src', 'test', 'resources');
      mkdirp(propsDir);
      fs.writeFileSync(
        path.join(propsDir, 'junit-platform.properties'),
        'cucumber.glue = com.example.steps\n',
      );

      const ws = makeWorkspaceFolder(tmpDir);
      const plugins = await runner.readExistingPlugins(ws);
      assert.deepEqual(plugins, []);
    });

    it('handles single plugin without commas', async () => {
      const propsDir = path.join(tmpDir, 'src', 'test', 'resources');
      mkdirp(propsDir);
      fs.writeFileSync(
        path.join(propsDir, 'junit-platform.properties'),
        'cucumber.plugin=pretty\n',
      );

      const ws = makeWorkspaceFolder(tmpDir);
      const plugins = await runner.readExistingPlugins(ws);
      assert.deepEqual(plugins, ['pretty']);
    });
  });

  // --- assembleCommand ---

  describe('assembleCommand()', () => {
    it('includes "test" as the first arg', async () => {
      const ws = makeWorkspaceFolder(tmpDir);
      const cmd = await runner.assembleCommand({
        workspaceFolder: ws,
        featureTargets: [],
      });
      assert.equal(cmd.args[0], 'test');
    });

    it('includes -Dtest when runnerClass is provided', async () => {
      const ws = makeWorkspaceFolder(tmpDir);
      const cmd = await runner.assembleCommand({
        workspaceFolder: ws,
        featureTargets: [],
        runnerClass: 'com.example.RunCucumber',
      });
      assert.ok(cmd.args.includes('-Dtest=com.example.RunCucumber'));
    });

    it('omits -Dtest when runnerClass is not provided', async () => {
      const ws = makeWorkspaceFolder(tmpDir);
      const cmd = await runner.assembleCommand({
        workspaceFolder: ws,
        featureTargets: [],
      });
      assert.ok(!cmd.args.some(a => a.startsWith('-Dtest=')));
    });

    it('includes -Dcucumber.features for feature targets', async () => {
      const ws = makeWorkspaceFolder(tmpDir);
      const cmd = await runner.assembleCommand({
        workspaceFolder: ws,
        featureTargets: ['src/test/resources/login.feature:10', 'src/test/resources/login.feature:20'],
      });
      assert.ok(cmd.args.includes(
        '-Dcucumber.features=src/test/resources/login.feature:10,src/test/resources/login.feature:20',
      ));
    });

    it('omits -Dcucumber.features when featureTargets is empty', async () => {
      const ws = makeWorkspaceFolder(tmpDir);
      const cmd = await runner.assembleCommand({
        workspaceFolder: ws,
        featureTargets: [],
      });
      assert.ok(!cmd.args.some(a => a.startsWith('-Dcucumber.features=')));
    });

    it('includes -Dcucumber.filter.tags when tag expression provided', async () => {
      const ws = makeWorkspaceFolder(tmpDir);
      const cmd = await runner.assembleCommand({
        workspaceFolder: ws,
        featureTargets: [],
        tagExpression: '@smoke and not @wip',
      });
      assert.ok(cmd.args.includes('-Dcucumber.filter.tags=@smoke and not @wip'));
    });

    it('omits -Dcucumber.filter.tags when no tag expression', async () => {
      const ws = makeWorkspaceFolder(tmpDir);
      const cmd = await runner.assembleCommand({
        workspaceFolder: ws,
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

      const ws = makeWorkspaceFolder(tmpDir);
      const cmd = await runner.assembleCommand({
        workspaceFolder: ws,
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

      const ws = makeWorkspaceFolder(tmpDir);
      const cmd = await runner.assembleCommand({
        workspaceFolder: ws,
        featureTargets: [],
      });

      const pluginArg = cmd.args.find(a => a.startsWith('-Dcucumber.plugin='))!;
      const plugins = pluginArg.replace('-Dcucumber.plugin=', '').split(',');
      const jsonPlugins = plugins.filter(p => p.startsWith('json:'));
      assert.equal(jsonPlugins.length, 1, 'Should have exactly one json: plugin');
      assert.ok(jsonPlugins[0].includes('cucumber-vscode-results.json'));
    });

    it('includes additional args', async () => {
      const ws = makeWorkspaceFolder(tmpDir);
      const cmd = await runner.assembleCommand({
        workspaceFolder: ws,
        featureTargets: [],
        additionalArgs: ['-Pintegration', '-X'],
      });
      assert.ok(cmd.args.includes('-Pintegration'));
      assert.ok(cmd.args.includes('-X'));
    });

    it('always includes -DfailIfNoTests=false', async () => {
      const ws = makeWorkspaceFolder(tmpDir);
      const cmd = await runner.assembleCommand({
        workspaceFolder: ws,
        featureTargets: [],
      });
      assert.ok(cmd.args.includes('-DfailIfNoTests=false'));
    });

    it('sets cwd to workspace root', async () => {
      const ws = makeWorkspaceFolder(tmpDir);
      const cmd = await runner.assembleCommand({
        workspaceFolder: ws,
        featureTargets: [],
      });
      assert.equal(cmd.cwd, tmpDir);
    });
  });

  // --- assembleDebugCommand ---

  describe('assembleDebugCommand()', () => {
    it('adds maven.surefire.debug with correct port', async () => {
      const ws = makeWorkspaceFolder(tmpDir);
      const cmd = await runner.assembleDebugCommand({
        workspaceFolder: ws,
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
      const ws = makeWorkspaceFolder(tmpDir);
      const baseCmd = await runner.assembleCommand({
        workspaceFolder: ws,
        featureTargets: ['f.feature:1'],
        runnerClass: 'com.example.Run',
      });
      const debugCmd = await runner.assembleDebugCommand({
        workspaceFolder: ws,
        featureTargets: ['f.feature:1'],
        runnerClass: 'com.example.Run',
      }, 9999);

      // Debug command should have all base args plus the debug arg
      for (const arg of baseCmd.args) {
        assert.ok(debugCmd.args.includes(arg), `Debug command should include base arg: ${arg}`);
      }
      assert.equal(debugCmd.args.length, baseCmd.args.length + 1);
    });
  });
});
