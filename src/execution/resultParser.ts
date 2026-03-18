import * as path from 'path';
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
 * Results are keyed by multiple path variations to maximize matching success,
 * since the path format in Cucumber JSON depends on how features were configured.
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

  const normalizedWsPath = workspaceFolderPath.replace(/\\/g, '/');
  const results: TestResult[] = [];

  for (const feature of features) {
    if (!feature.elements) continue;

    // Normalize the feature URI and generate multiple path keys for robust matching
    const rawUri = feature.uri.replace(/\\/g, '/');

    // Strip workspace folder prefix if present (handles absolute paths from Cucumber)
    let featureUri = rawUri;
    if (featureUri.startsWith(normalizedWsPath)) {
      featureUri = featureUri.substring(normalizedWsPath.length);
      if (featureUri.startsWith('/')) {
        featureUri = featureUri.substring(1);
      }
    }
    // Strip file:// prefix if present
    if (featureUri.startsWith('file://')) {
      featureUri = featureUri.substring(7);
    }
    // Strip classpath: prefix if present
    if (featureUri.startsWith('classpath:')) {
      featureUri = featureUri.substring(10);
    }

    for (const element of feature.elements) {
      const result = processElement(element, featureUri);
      results.push(result);
    }
  }

  return results;
}

/**
 * Extracts the filename from a feature URI for fallback matching.
 */
export function extractFilename(featureUri: string): string {
  const normalized = featureUri.replace(/\\/g, '/');
  return normalized.split('/').pop() ?? '';
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

    if (stepStatus === 'ambiguous') {
      status = 'errored';
      errorMessage = `Ambiguous step: ${step.keyword.trim()} ${step.name} — multiple step definitions match`;
      errorStack = step.result.error_message;
      failedStepLine = step.line;
      break;
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

  return Math.round(totalNanos / 1_000_000);
}
