/**
 * Thin typed wrapper around the VS Code webview API. `acquireVsCodeApi` may only be called once per
 * document, so it is called here and shared.
 */

import type { WebviewMessage } from '../core/protocol';

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode: VsCodeApi = acquireVsCodeApi();

export function post(message: WebviewMessage): void {
  vscode.postMessage(message);
}
