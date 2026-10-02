import * as vscode from 'vscode';

/** Thin wrapper around the "DBNext" log output channel (View → Output → DBNext). */
export class Log implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel('DBNext', { log: true });

  info(message: string): void {
    this.channel.info(message);
  }

  warn(message: string): void {
    this.channel.warn(message);
  }

  error(message: string, error?: unknown): void {
    if (error === undefined) {
      this.channel.error(message);
      return;
    }
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    this.channel.error(`${message}: ${detail}`);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
