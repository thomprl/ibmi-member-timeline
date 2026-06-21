import type * as vscode from 'vscode';

export interface IBMiConnection {
  currentHost: string;
}

export interface IBMiInstance {
  getConnection(): IBMiConnection | undefined;
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
