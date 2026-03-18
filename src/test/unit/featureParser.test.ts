import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parseFeatureFile } from '../../discovery/featureParser';

const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf-8');
}

function parseFixture(name: string) {
  const content = readFixture(name);
  const result = parseFeatureFile(content, name);
  assert.equal(result.success, true, `Expected parse to succeed for ${name}`);
  return (result as { success: true; feature: import('../../execution/types').ParsedFeature }).feature;
}

describe('featureParser', () => {
  describe('simple.feature', () => {
    it('parses feature name and tags', () => {
      const feature = parseFixture('simple.feature');
      assert.equal(feature.name, 'Task Management');
      assert.deepEqual(feature.tags, ['@api']);
      assert.equal(feature.language, 'en');
    });

    it('parses scenarios with names, lines, and tags', () => {
      const feature = parseFixture('simple.feature');
      const scenarios = feature.children.filter(c => c.scenario).map(c => c.scenario!);
      assert.equal(scenarios.length, 2);

      assert.equal(scenarios[0].name, 'Create a new task');
      assert.equal(scenarios[0].line, 6);
      assert.deepEqual(scenarios[0].tags, ['@smoke', '@create']);

      assert.equal(scenarios[1].name, 'Update an existing task');
      assert.equal(scenarios[1].line, 12);
      assert.deepEqual(scenarios[1].tags, ['@update']);
    });

    it('parses steps correctly', () => {
      const feature = parseFixture('simple.feature');
      const scenario = feature.children[0].scenario!;
      assert.equal(scenario.steps.length, 3);

      assert.equal(scenario.steps[0].keyword, 'Given');
      assert.equal(scenario.steps[0].text, 'the task repository is empty');
      assert.equal(scenario.steps[0].line, 7);

      assert.equal(scenario.steps[1].keyword, 'When');
      assert.equal(scenario.steps[1].text, 'I create a task with title "Test Task"');
      assert.equal(scenario.steps[1].line, 8);

      assert.equal(scenario.steps[2].keyword, 'Then');
      assert.equal(scenario.steps[2].text, 'the response status code should be 201');
      assert.equal(scenario.steps[2].line, 9);
    });
  });

  describe('complex.feature', () => {
    it('parses Background', () => {
      const feature = parseFixture('complex.feature');
      const bg = feature.children[0].background;
      assert.ok(bg, 'First child should be a background');
      assert.equal(bg.name, '');
      assert.equal(bg.line, 5);
      assert.equal(bg.keyword, 'Background');
      assert.equal(bg.steps.length, 2);
      assert.equal(bg.steps[0].keyword, 'Given');
      assert.equal(bg.steps[0].text, 'the system is initialized');
      assert.equal(bg.steps[1].keyword, 'And');
      assert.equal(bg.steps[1].text, 'the database is clean');
    });

    it('parses Scenario Outline with multiple Examples blocks', () => {
      const feature = parseFixture('complex.feature');
      const outline = feature.children[1].scenario;
      assert.ok(outline, 'Second child should be a scenario outline');
      assert.ok(outline.keyword.includes('Outline'), `Keyword should contain "Outline", got "${outline.keyword}"`);
      assert.equal(outline.name, 'Create items with priorities');
      assert.equal(outline.line, 10);
      assert.deepEqual(outline.tags, ['@parameterized', '@create']);

      assert.equal(outline.examples.length, 2);

      const ex1 = outline.examples[0];
      assert.equal(ex1.name, 'Common priorities');
      assert.equal(ex1.line, 16);
      assert.deepEqual(ex1.tags, ['@smoke']);
      assert.deepEqual(ex1.tableHeader, ['priority']);
      assert.equal(ex1.tableRows.length, 2);
      assert.deepEqual(ex1.tableRows[0].cells, ['HIGH']);
      assert.equal(ex1.tableRows[0].line, 18);
      assert.deepEqual(ex1.tableRows[1].cells, ['MEDIUM']);
      assert.equal(ex1.tableRows[1].line, 19);

      const ex2 = outline.examples[1];
      assert.equal(ex2.name, 'Edge case priorities');
      assert.equal(ex2.line, 22);
      assert.deepEqual(ex2.tags, ['@edge-case']);
      assert.deepEqual(ex2.tableHeader, ['priority']);
      assert.equal(ex2.tableRows.length, 1);
      assert.deepEqual(ex2.tableRows[0].cells, ['LOW']);
      assert.equal(ex2.tableRows[0].line, 24);
    });

    it('parses data table scenario', () => {
      const feature = parseFixture('complex.feature');
      const scenario = feature.children[2].scenario;
      assert.ok(scenario, 'Third child should be the data table scenario');
      assert.equal(scenario.name, 'Search with data table');
      assert.equal(scenario.line, 27);
      assert.deepEqual(scenario.tags, ['@search']);
    });

    it('parses doc string scenario', () => {
      const feature = parseFixture('complex.feature');
      const scenario = feature.children[3].scenario;
      assert.ok(scenario, 'Fourth child should be the doc string scenario');
      assert.equal(scenario.name, 'Create with description');
      assert.equal(scenario.line, 36);
      assert.deepEqual(scenario.tags, ['@docstring']);
    });
  });

  describe('with-rules.feature', () => {
    it('parses Rules with nested scenarios', () => {
      const feature = parseFixture('with-rules.feature');

      // First child is feature-level background
      assert.ok(feature.children[0].background, 'First child should be a background');

      // Second child is first rule
      const rule1 = feature.children[1].rule;
      assert.ok(rule1, 'Second child should be a rule');
      assert.equal(rule1.name, 'Free tier limits');
      assert.equal(rule1.line, 8);
      assert.deepEqual(rule1.tags, []);

      // Rule 1 has a background + 2 scenarios
      const rule1Scenarios = rule1.children.filter(c => c.scenario).map(c => c.scenario!);
      assert.equal(rule1Scenarios.length, 2);
      assert.equal(rule1Scenarios[0].name, 'Enforce storage limit');
      assert.deepEqual(rule1Scenarios[0].tags, ['@limit']);
      assert.equal(rule1Scenarios[1].name, 'Allow within limit');
      assert.deepEqual(rule1Scenarios[1].tags, ['@limit']);

      // Third child is second rule
      const rule2 = feature.children[2].rule;
      assert.ok(rule2, 'Third child should be a rule');
      assert.equal(rule2.name, 'Premium tier benefits');
      assert.equal(rule2.line, 24);

      const rule2Scenarios = rule2.children.filter(c => c.scenario).map(c => c.scenario!);
      assert.equal(rule2Scenarios.length, 1);
      assert.equal(rule2Scenarios[0].name, 'Unlimited storage');
      assert.deepEqual(rule2Scenarios[0].tags, ['@premium']);
    });

    it('parses Rule-level Background', () => {
      const feature = parseFixture('with-rules.feature');
      const rule1 = feature.children[1].rule!;
      const bg = rule1.children[0].background;
      assert.ok(bg, 'First rule child should be a background');
      assert.equal(bg.line, 11);
      assert.equal(bg.steps.length, 1);
      assert.equal(bg.steps[0].text, 'the customer is on the free tier');
    });
  });

  describe('i18n.feature', () => {
    it('parses non-English features', () => {
      const feature = parseFixture('i18n.feature');
      assert.equal(feature.name, 'Gestion des t\u00e2ches');
      assert.equal(feature.language, 'fr');
      assert.deepEqual(feature.tags, ['@international']);

      const scenarios = feature.children.filter(c => c.scenario).map(c => c.scenario!);
      assert.equal(scenarios.length, 1);
      assert.equal(scenarios[0].name, 'Cr\u00e9er une t\u00e2che');
      assert.equal(scenarios[0].line, 6);
    });
  });

  describe('empty.feature', () => {
    it('returns feature with empty children', () => {
      const result = parseFeatureFile(readFixture('empty.feature'), 'empty.feature');
      assert.equal(result.success, true);
      const feature = (result as { success: true; feature: import('../../execution/types').ParsedFeature }).feature;
      assert.equal(feature.name, 'Empty Feature');
      assert.deepEqual(feature.children, []);
    });
  });

  describe('outline-no-examples.feature', () => {
    it('returns outline with empty example rows', () => {
      const feature = parseFixture('outline-no-examples.feature');
      const outline = feature.children[0].scenario;
      assert.ok(outline, 'Should have a scenario outline');
      assert.ok(outline.keyword.includes('Outline'));
      assert.equal(outline.examples.length, 1);
      assert.deepEqual(outline.examples[0].tableHeader, ['count']);
      assert.equal(outline.examples[0].tableRows.length, 0);
    });
  });

  describe('error handling', () => {
    it('returns parse error for invalid content', () => {
      const result = parseFeatureFile('not valid gherkin', 'test.feature');
      assert.equal(result.success, false);
      const error = (result as { success: false; error: import('../../execution/types').ParseError }).error;
      assert.ok(error.message.length > 0, 'Error message should be non-empty');
    });

    it('returns parse error for empty string', () => {
      const result = parseFeatureFile('', 'test.feature');
      assert.equal(result.success, false);
      const error = (result as { success: false; error: import('../../execution/types').ParseError }).error;
      assert.ok(error.message.length > 0, 'Error message should be non-empty');
    });
  });
});
