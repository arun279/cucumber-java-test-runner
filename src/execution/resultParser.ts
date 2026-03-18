import { TestResult } from './types';

// Cucumber JSON report types (not exported, internal to parser)
interface CucumberFeature {
  uri: string;
  name: string;
  elements?: CucumberElement[];
}

interface CucumberElement {
  name: string;
  line: number;
  keyword: string;
  type: string;
  steps?: CucumberStep[];
  before?: CucumberHookResult[];
  after?: CucumberHookResult[];
}

interface CucumberStep {
  name: string;
  keyword: string;
  line: number;
  result: CucumberStepResult;
}

interface CucumberStepResult {
  status: string;
  duration?: number;      // nanoseconds
  error_message?: string;
}

interface CucumberHookResult {
  result: CucumberStepResult;
}

/**
 * Parses Cucumber JSON report content into TestResult objects.
 *
 * @param jsonContent - Raw JSON string from Cucumber's json reporter
 * @param workspaceFolderPath - Absolute path to the workspace folder (for URI normalization)
 * @returns Array of TestResult, one per scenario/example row
 */
export function parseResults(jsonContent: string, workspaceFolderPath: string): TestResult[] {
  let features: CucumberFeature[];
  try {
    features = JSON.parse(jsonContent);
  } catch {
    return [];
  }

  if (!Array.isArray(features)) {
    return [];
  }

  const results: TestResult[] = [];

  for (const feature of features) {
    if (!feature.elements) continue;

    // Normalize the feature URI to be workspace-relative with forward slashes
    const featureUri = normalizeUri(feature.uri);

    for (const element of feature.elements) {
      results.push(processElement(element, featureUri));
    }
  }

  return results;
}

function processElement(element: CucumberElement, featureUri: string): TestResult {
  const testItemId = `${featureUri}#${element.line}`;

  // Check hook results first (before hooks run before steps)
  const beforeHookFailure = findHookFailure(element.before);
  if (beforeHookFailure) {
    return {
      testItemId,
      status: 'errored',
      duration: computeTotalDuration(element),
      errorMessage: `Before hook failed: ${beforeHookFailure.error_message ?? 'Unknown error'}`,
      errorStack: beforeHookFailure.error_message,
    };
  }

  // Check step results
  const steps = element.steps ?? [];
  let status: TestResult['status'] = 'passed';
  let errorMessage: string | undefined;
  let errorStack: string | undefined;
  let failedStepLine: number | undefined;

  for (const step of steps) {
    const stepStatus = step.result.status;

    if (stepStatus === 'failed') {
      status = 'failed';
      errorMessage = `Step failed: ${step.keyword.trim()} ${step.name}`;
      errorStack = step.result.error_message;
      failedStepLine = step.line;
      break; // First failure wins
    }

    if (stepStatus === 'undefined') {
      status = 'skipped';
      errorMessage = `Undefined step: ${step.keyword.trim()} ${step.name}`;
      failedStepLine = step.line;
      break;
    }

    if (stepStatus === 'pending') {
      status = 'skipped';
      errorMessage = `Pending step: ${step.keyword.trim()} ${step.name}`;
      failedStepLine = step.line;
      break;
    }

    if (stepStatus === 'skipped' && status === 'passed') {
      // Steps after a failure are marked as skipped — don't override failure status
      // But if ALL steps are skipped (e.g., entire scenario skipped), mark as skipped
      status = 'skipped';
    }
  }

  // Check after hooks too
  const afterHookFailure = findHookFailure(element.after);
  if (afterHookFailure && status === 'passed') {
    status = 'errored';
    errorMessage = `After hook failed: ${afterHookFailure.error_message ?? 'Unknown error'}`;
    errorStack = afterHookFailure.error_message;
  }

  return {
    testItemId,
    status,
    duration: computeTotalDuration(element),
    errorMessage,
    errorStack,
    failedStepLine,
  };
}

function findHookFailure(hooks?: CucumberHookResult[]): CucumberStepResult | undefined {
  if (!hooks) return undefined;
  for (const hook of hooks) {
    if (hook.result.status === 'failed') {
      return hook.result;
    }
  }
  return undefined;
}

function computeTotalDuration(element: CucumberElement): number {
  let totalNanos = 0;

  for (const step of element.steps ?? []) {
    totalNanos += step.result.duration ?? 0;
  }

  for (const hook of element.before ?? []) {
    totalNanos += hook.result.duration ?? 0;
  }
  for (const hook of element.after ?? []) {
    totalNanos += hook.result.duration ?? 0;
  }

  // Convert nanoseconds to milliseconds
  return Math.round(totalNanos / 1_000_000);
}

function normalizeUri(uri: string): string {
  return uri.replace(/\\/g, '/');
}
