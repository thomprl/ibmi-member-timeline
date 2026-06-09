import vscode from 'vscode';
import type { CodeForIBMi } from './types/codeForIBMi';
import { MemberTimelineService } from './memberTimelineService';
import { initializeMemberTimelineView } from './memberTimelineView';

export function activate(context: vscode.ExtensionContext): void {
  const codeForIBMiExt = vscode.extensions.getExtension<CodeForIBMi>(`halcyontechltd.code-for-ibmi`);
  if (!codeForIBMiExt) {
    void vscode.window.showErrorMessage(`IBMi Source Member Timeline requires Code for IBM i to be installed.`);
    return;
  }

  // extensionDependencies guarantees Code for i is active before we are, so exports are available
  const codeForIBMi = codeForIBMiExt.exports;
  if (!codeForIBMi?.instance) {
    void vscode.window.showErrorMessage(`IBMi Source Member Timeline: Code for IBM i did not export its API.`);
    return;
  }

  const service = new MemberTimelineService(context.globalStorageUri);
  context.subscriptions.push(service);
  initializeMemberTimelineView(context, codeForIBMi, service);
}

export function deactivate(): void {}
