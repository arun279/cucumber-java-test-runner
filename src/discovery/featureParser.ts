import { Parser, AstBuilder, GherkinClassicTokenMatcher } from '@cucumber/gherkin';
import { IdGenerator } from '@cucumber/messages';
import type * as messages from '@cucumber/messages';
import type {
  ParseResult,
  ParsedFeature,
  ParsedFeatureChild,
  ParsedRuleChild,
  ParsedBackground,
  ParsedScenario,
  ParsedStep,
  ParsedExamples,
  ParsedExampleRow,
} from '../execution/types';

export function parseFeatureFile(content: string, uri: string): ParseResult {
  try {
    const builder = new AstBuilder(IdGenerator.uuid());
    const matcher = new GherkinClassicTokenMatcher();
    const parser = new Parser(builder, matcher);
    const doc: messages.GherkinDocument = parser.parse(content);

    if (!doc.feature) {
      return { success: false, error: { message: 'No feature found in file' } };
    }

    return { success: true, feature: convertFeature(doc.feature, uri) };
  } catch (e: unknown) {
    return { success: false, error: extractParseError(e) };
  }
}

function convertFeature(feature: messages.Feature, uri: string): ParsedFeature {
  return {
    uri,
    name: feature.name,
    description: feature.description.trim(),
    language: feature.language,
    tags: feature.tags.map(t => t.name),
    children: feature.children.map(convertFeatureChild),
  };
}

function convertFeatureChild(child: messages.FeatureChild): ParsedFeatureChild {
  if (child.background) {
    return { background: convertBackground(child.background) };
  }
  if (child.scenario) {
    return { scenario: convertScenario(child.scenario) };
  }
  if (child.rule) {
    return { rule: convertRule(child.rule) };
  }
  return {};
}

function convertRule(rule: messages.Rule): import('../execution/types').ParsedRule {
  return {
    name: rule.name,
    line: rule.location.line,
    tags: rule.tags.map(t => t.name),
    children: rule.children.map(convertRuleChild),
  };
}

function convertRuleChild(child: messages.RuleChild): ParsedRuleChild {
  if (child.background) {
    return { background: convertBackground(child.background) };
  }
  if (child.scenario) {
    return { scenario: convertScenario(child.scenario) };
  }
  return {};
}

function convertBackground(bg: messages.Background): ParsedBackground {
  return {
    name: bg.name,
    line: bg.location.line,
    keyword: bg.keyword.trim(),
    steps: bg.steps.map(convertStep),
  };
}

function convertScenario(scenario: messages.Scenario): ParsedScenario {
  return {
    name: scenario.name,
    line: scenario.location.line,
    keyword: scenario.keyword.trim(),
    tags: scenario.tags.map(t => t.name),
    steps: scenario.steps.map(convertStep),
    examples: scenario.examples.map(convertExamples),
  };
}

function convertStep(step: messages.Step): ParsedStep {
  return {
    keyword: step.keyword.trim(),
    text: step.text,
    line: step.location.line,
  };
}

function convertExamples(examples: messages.Examples): ParsedExamples {
  return {
    name: examples.name,
    line: examples.location.line,
    tags: examples.tags.map(t => t.name),
    tableHeader: examples.tableHeader
      ? examples.tableHeader.cells.map(c => c.value)
      : [],
    tableRows: examples.tableBody.map(convertExampleRow),
  };
}

function convertExampleRow(row: messages.TableRow): ParsedExampleRow {
  return {
    line: row.location.line,
    cells: row.cells.map(c => c.value),
  };
}

function extractParseError(e: unknown): import('../execution/types').ParseError {
  if (e instanceof Error) {
    const withLocation = e as Error & { errors?: Array<{ location?: { line?: number; column?: number } }> };
    const firstError = withLocation.errors?.[0];
    return {
      message: e.message,
      line: firstError?.location?.line,
      column: firstError?.location?.column,
    };
  }
  return { message: String(e) };
}
