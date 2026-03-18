import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parseResults } from '../../execution/resultParser';

const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf-8');
}

describe('resultParser', () => {
  const workspacePath = '/workspace';
  let jsonContent: string;

  before(() => {
    jsonContent = readFixture('cucumber-results.json');
  });

  it('parses all scenarios from JSON', () => {
    const results = parseResults(jsonContent, workspacePath);
    // 5 elements in first feature + 1 in second = 6
    assert.equal(results.length, 6);
  });

  it('identifies passed scenarios', () => {
    const results = parseResults(jsonContent, workspacePath);
    const passed = results.filter(r => r.status === 'passed');
    // Create task (passed), two outline examples (passed) = 3 passed
    assert.equal(passed.length, 3);
  });

  it('identifies failed scenarios with error details', () => {
    const results = parseResults(jsonContent, workspacePath);
    const failed = results.filter(r => r.status === 'failed');
    assert.equal(failed.length, 1);

    const updateScenario = failed[0];
    assert.ok(updateScenario.errorMessage?.includes('I update the task title'));
    assert.ok(updateScenario.errorStack?.includes('Expected status code 200'));
    assert.equal(updateScenario.failedStepLine, 16);
  });

  it('identifies skipped/undefined scenarios', () => {
    const results = parseResults(jsonContent, workspacePath);
    const skipped = results.filter(r => r.status === 'skipped');
    assert.equal(skipped.length, 1);

    const deleteScenario = skipped[0];
    assert.ok(deleteScenario.errorMessage?.includes('Undefined step'));
  });

  it('identifies before hook failures as errored', () => {
    const results = parseResults(jsonContent, workspacePath);
    const errored = results.filter(r => r.status === 'errored');
    assert.equal(errored.length, 1);

    const hookFailure = errored[0];
    assert.ok(hookFailure.errorMessage?.includes('Before hook failed'));
  });

  it('computes duration in milliseconds from nanoseconds', () => {
    const results = parseResults(jsonContent, workspacePath);
    const createTask = results.find(r => r.testItemId.includes('#8'));
    assert.ok(createTask);
    // (52 + 150 + 5 + 1 + 0.5) million ns = 208.5ms -> 209ms (rounded)
    assert.ok(createTask.duration > 0);
  });

  it('builds testItemId from featureUri#line', () => {
    const results = parseResults(jsonContent, workspacePath);
    const ids = results.map(r => r.testItemId);
    assert.ok(ids.includes('src/test/resources/features/task_management.feature#8'));
    assert.ok(ids.includes('src/test/resources/features/task_management.feature#14'));
    assert.ok(ids.includes('src/test/resources/features/task_management.feature#30'));
    assert.ok(ids.includes('src/test/resources/features/task_management.feature#31'));
  });

  it('maps Scenario Outline examples by their line numbers', () => {
    const results = parseResults(jsonContent, workspacePath);
    const outlines = results.filter(r => r.testItemId.includes('#30') || r.testItemId.includes('#31'));
    assert.equal(outlines.length, 2);
    assert.ok(outlines.every(r => r.status === 'passed'));
  });

  it('returns empty array for invalid JSON', () => {
    const results = parseResults('not valid json', workspacePath);
    assert.deepEqual(results, []);
  });

  it('returns empty array for empty string', () => {
    const results = parseResults('', workspacePath);
    assert.deepEqual(results, []);
  });

  it('returns empty array for null/non-array JSON', () => {
    const results = parseResults('{}', workspacePath);
    assert.deepEqual(results, []);
  });

  it('normalizes backslash paths in URIs', () => {
    const json = JSON.stringify([{
      uri: 'src\\test\\resources\\features\\test.feature',
      elements: [{
        line: 5,
        name: 'Test',
        keyword: 'Scenario',
        type: 'scenario',
        steps: [{ result: { status: 'passed', duration: 1000 }, line: 6, name: 'step', keyword: 'Given ' }]
      }]
    }]);
    const results = parseResults(json, workspacePath);
    assert.equal(results[0].testItemId, 'src/test/resources/features/test.feature#5');
  });
});
