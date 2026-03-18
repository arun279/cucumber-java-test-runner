import * as vscode from 'vscode';
import { CucumberTestController } from './testController';
import { createLogger } from './util/logger';

let controller: CucumberTestController | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = createLogger('Cucumber Test Runner');
  logger.info('Activating Cucumber Test Runner');

  try {
    controller = new CucumberTestController(context, logger);
    await controller.activate();
    context.subscriptions.push(controller);
    context.subscriptions.push({ dispose: () => logger.dispose() });
    logger.info('Cucumber Test Runner activated successfully');
  } catch (err) {
    logger.error('Failed to activate Cucumber Test Runner', err);
    throw err;
  }
}

export function deactivate(): void {
  controller?.dispose();
  controller = undefined;
}
