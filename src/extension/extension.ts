import type * as vscode from 'vscode';
import type { SchemaModel } from '../core/model';
import type { MapStatus } from '../core/protocol';
import { registry } from '../parsers';
import { Controller } from './controller';

/** Read-only view of the extension state, returned from `activate` (used by integration tests). */
export interface DbNextApi {
  readonly model: SchemaModel | undefined;
  readonly status: MapStatus;
}

/**
 * Activated on startup (`onStartupFinished`) so every workspace is mapped automatically, and when
 * VS Code restores a DB Map tab (`onWebviewPanel:dbnext.map`).
 */
export function activate(context: vscode.ExtensionContext): DbNextApi {
  const controller = new Controller(context, registry);
  context.subscriptions.push(controller);
  controller.start();
  return {
    get model() {
      return controller.model;
    },
    get status() {
      return controller.status;
    },
  };
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
