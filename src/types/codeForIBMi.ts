import type * as vscode from 'vscode';

export interface IBMiInstance {
  subscribe(
    context: vscode.ExtensionContext,
    event: 'connected' | 'disconnected' | string,
    label: string,
    callback: () => void
  ): void;
}

export interface CodeForIBMi {
  instance: IBMiInstance;
}
