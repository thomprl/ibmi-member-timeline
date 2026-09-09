import vscode from 'vscode';
import type { CodeForIBMi } from './types/codeForIBMi';
import { getMemberUri } from './memberTimelineUtils';
import { MemberTimelineService } from './memberTimelineService';

type TimelineEntry = Awaited<ReturnType<MemberTimelineService['getSnapshotsForMember']>>[number];
type MemberTimelineItem = MemberTimelineTreeItem | MemberTimelineDisabledItem;
type RecentMemberEntry = Awaited<ReturnType<MemberTimelineService['getRecentMembers']>>[number];

function resolveTrackedMemberUri(): vscode.Uri | undefined {
  const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
  if (activeEditorUri?.scheme === `member`) {
    return activeEditorUri;
  }
  const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (activeTab?.input instanceof vscode.TabInputText && activeTab.input.uri.scheme === `member`) {
    return activeTab.input.uri;
  }
  return undefined;
}

async function resolveSnapshotUri(snapshotPath: string): Promise<vscode.Uri | undefined> {
  const uri = vscode.Uri.file(snapshotPath);
  try {
    await vscode.workspace.fs.stat(uri);
    return uri;
  } catch {
    void vscode.window.showErrorMessage(
      vscode.l10n.t(`Snapshot file not found. It may have been deleted manually.\n{0}`, snapshotPath)
    );
    return undefined;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function initializeMemberTimelineView(
  context: vscode.ExtensionContext,
  codeForIBMi: CodeForIBMi,
  service: MemberTimelineService
): void {
  const provider = new MemberTimelineViewProvider(service);
  const treeView = vscode.window.createTreeView(`memberTimelineView`, {
    treeDataProvider: provider,
    showCollapseAll: true,
    canSelectMany: true
  });

  const recentProvider = new RecentMembersViewProvider(service);
  const recentTreeView = vscode.window.createTreeView(`memberTimelineRecentView`, {
    treeDataProvider: recentProvider,
    showCollapseAll: false,
    canSelectMany: false
  });

  void vscode.commands.executeCommand(`setContext`, `memberTimeline:recentMembersEnabled`, service.isRecentMembersEnabled());

  context.subscriptions.push(
    treeView,
    recentTreeView,
    service.onDidUpdate(() => {
      void provider.refreshForActiveEditor(treeView);
      void recentProvider.refresh();
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration(`memberTimeline`)) {
        service.resetStorage();
        void vscode.commands.executeCommand(`setContext`, `memberTimeline:recentMembersEnabled`, service.isRecentMembersEnabled());
        void provider.refreshForActiveEditor(treeView);
        void recentProvider.refresh();
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(() => { void provider.refreshForActiveEditor(treeView); }),
    vscode.window.tabGroups.onDidChangeTabs(async event => {
      void provider.refreshForActiveEditor(treeView);
      // Only tabs actually opened in the editor count as "opened" — this excludes
      // background member reads (e.g. the RPGLE language server resolving /COPY
      // and /INCLUDE targets via workspace.openTextDocument), which never surface as a tab.
      for (const tab of event.opened) {
        if (tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === `member` && service.isEnabled()) {
          const member = service.parseMemberFromUri(tab.input.uri);
          if (member) {
            await service.recordRecentMemberOpen(member);
          }
        }
      }
    }),
    vscode.workspace.onDidOpenTextDocument(async document => {
      if (document.uri.scheme === `member` && service.isEnabled()) {
        const member = service.parseMemberFromUri(document.uri);
        try {
          const stat = await vscode.workspace.fs.stat(document.uri);
          if ((stat.permissions ?? 0) & vscode.FilePermission.Readonly) {
            return; // browse mode — skip snapshot
          }
        } catch {
          // stat unavailable, fall through and capture
        }
        if (member) {
          await service.captureMemberSnapshot(member, `opened`, document.getText());
        }
        await provider.refreshForActiveEditor(treeView);
      }
    }),
    vscode.workspace.onDidSaveTextDocument(async document => {
      if (document.uri.scheme === `member` && service.isEnabled()) {
        const member = service.parseMemberFromUri(document.uri);
        if (member) {
          await service.captureMemberSnapshot(member, `saved`, document.getText());
        }
        await provider.refreshForActiveEditor(treeView);
      }
    }),
    vscode.commands.registerCommand(`memberTimeline.refresh`, () => {
      void provider.refreshForActiveEditor(treeView);
      void recentProvider.refresh();
    }),
    vscode.commands.registerCommand(`memberTimeline.openRecentMember`, async (item?: RecentMemberTreeItem) => {
      const recent = item?.recent;
      if (!recent) {
        return;
      }
      const memberUri = getMemberUri(recent.member);
      await vscode.commands.executeCommand(`vscode.open`, memberUri, { preview: false });
    }),
    vscode.commands.registerCommand(`memberTimeline.clearRecentMembers`, async () => {
      await service.clearRecentMembers();
      await recentProvider.refresh();
    }),
    vscode.commands.registerCommand(`memberTimeline.openDiff`, async (item?: MemberTimelineTreeItem | TimelineEntry) => {
      const entry = item instanceof MemberTimelineTreeItem ? item.entry : item;
      if (!entry) {
        return;
      }
      const snapshotUri = await resolveSnapshotUri(entry.snapshotPath);
      if (!snapshotUri) {
        return;
      }
      const rightUri = vscode.window.activeTextEditor?.document.uri?.scheme === `member`
        ? vscode.window.activeTextEditor.document.uri
        : getMemberUri(entry.member);
      const title = vscode.l10n.t(`History: {0} ({1})`, `${entry.member.name}.${entry.member.extension}`, new Date(entry.timestamp).toLocaleString());
      await vscode.commands.executeCommand(`vscode.diff`, snapshotUri, rightUri, title);
    }),
    vscode.commands.registerCommand(`memberTimeline.openSnapshot`, async (item?: MemberTimelineTreeItem) => {
      const entry = item?.entry;
      if (!entry) {
        return;
      }
      const snapshotUri = await resolveSnapshotUri(entry.snapshotPath);
      if (!snapshotUri) {
        return;
      }
      await vscode.commands.executeCommand(`vscode.open`, snapshotUri, { preview: false });
    }),
    vscode.commands.registerCommand(`memberTimeline.revealSnapshot`, async (item?: MemberTimelineTreeItem) => {
      const entry = item?.entry;
      if (!entry) {
        return;
      }
      const snapshotUri = await resolveSnapshotUri(entry.snapshotPath);
      if (!snapshotUri) {
        return;
      }
      await vscode.commands.executeCommand(`revealFileInOS`, snapshotUri);
    }),
    vscode.commands.registerCommand(`memberTimeline.addComment`, async (item?: MemberTimelineTreeItem) => {
      const entry = item?.entry;
      if (!entry) {
        return;
      }
      const comment = await vscode.window.showInputBox({
        prompt: vscode.l10n.t(`Add a note to this snapshot (leave blank to remove)`),
        placeHolder: vscode.l10n.t(`e.g. Before refactor, Working version...`),
        value: entry.comment ?? ``
      });
      if (comment === undefined) {
        return;
      }
      await service.addComment(entry.id, entry.member, comment);
    }),
    vscode.commands.registerCommand(`memberTimeline.pinSnapshot`, async (item?: MemberTimelineTreeItem) => {
      const entry = item?.entry;
      if (!entry) { return; }
      await service.pinSnapshot(entry.id, entry.member, true);
    }),
    vscode.commands.registerCommand(`memberTimeline.unpinSnapshot`, async (item?: MemberTimelineTreeItem) => {
      const entry = item?.entry;
      if (!entry) { return; }
      await service.pinSnapshot(entry.id, entry.member, false);
    }),
    vscode.commands.registerCommand(`memberTimeline.deleteSnapshot`, async (item?: MemberTimelineTreeItem, allItems?: MemberTimelineTreeItem[]) => {
      const targets = allItems?.length ? allItems : (item ? [item] : []);
      if (!targets.length) {
        return;
      }
      const entries = targets.map(t => t.entry);
      const pinnedCount = entries.filter(e => e.pinned).length;
      const rows = entries
        .map(e => `${e.pinned ? `$(pinned) ` : ``}${e.member.name}.${e.member.extension}  —  ${new Date(e.timestamp).toLocaleString()}`)
        .join(`\n`);
      const pinnedNote = pinnedCount > 0
        ? `\n\n${vscode.l10n.t(`{0} pinned snapshot(s) will also be deleted.`, String(pinnedCount))}`
        : ``;
      const detail = rows + pinnedNote;
      const label = entries.length === 1
        ? vscode.l10n.t(`Delete this snapshot?`)
        : vscode.l10n.t(`Delete these {0} snapshots?`, String(entries.length));
      const confirm = await vscode.window.showWarningMessage(label, { modal: true, detail }, vscode.l10n.t(`Delete`));
      if (confirm !== vscode.l10n.t(`Delete`)) {
        return;
      }
      const deletedIds = new Set(entries.map(e => e.id));
      if (provider.selectedForCompare && deletedIds.has(provider.selectedForCompare.id)) {
        provider.selectedForCompare = undefined;
        await vscode.commands.executeCommand(`setContext`, `memberTimeline:hasCompareSelection`, false);
      }
      await service.deleteSnapshots(entries);
      await provider.refreshForActiveEditor(treeView);
    }),
    vscode.commands.registerCommand(`memberTimeline.clearMemberHistory`, async () => {
      const activeUri = resolveTrackedMemberUri();
      if (!activeUri) {
        return;
      }
      const member = service.parseMemberFromUri(activeUri);
      if (!member) {
        return;
      }
      const snapshots = await service.getSnapshotsForMember(member);
      const memberName = `${member.name}.${member.extension}`;
      const pinnedCount = snapshots.filter(s => s.pinned).length;
      const unpinnedCount = snapshots.length - pinnedCount;
      if (unpinnedCount === 0) {
        void vscode.window.showInformationMessage(
          pinnedCount > 0
            ? vscode.l10n.t(`All {0} snapshot(s) for {1} are pinned — nothing to clear.`, String(pinnedCount), memberName)
            : vscode.l10n.t(`No history to clear for this member.`)
        );
        return;
      }
      const keptNote = pinnedCount > 0
        ? ` ${vscode.l10n.t(`{0} pinned snapshot(s) will be kept.`, String(pinnedCount))}`
        : ``;
      const detail = vscode.l10n.t(`This will delete {0} snapshot(s) for {1}. This cannot be undone.`, String(unpinnedCount), memberName) + keptNote;
      const confirm = await vscode.window.showWarningMessage(
        vscode.l10n.t(`Clear unpinned history for {0}?`, memberName),
        { modal: true, detail },
        vscode.l10n.t(`Clear All`)
      );
      if (confirm !== vscode.l10n.t(`Clear All`)) {
        return;
      }
      provider.selectedForCompare = undefined;
      await vscode.commands.executeCommand(`setContext`, `memberTimeline:hasCompareSelection`, false);
      await service.deleteMemberHistory(member);
      await provider.refreshForActiveEditor(treeView);
    }),
    vscode.commands.registerCommand(`memberTimeline.storageSummary`, async () => {
      const { memberCount, snapshotCount, totalBytes } = await service.getStorageSummary();
      const message = snapshotCount === 0
        ? vscode.l10n.t(`Source Member Timeline: No snapshots stored.`)
        : vscode.l10n.t(`Source Member Timeline: {0} snapshot(s) across {1} member(s) — {2} on disk.`, String(snapshotCount), String(memberCount), formatBytes(totalBytes));
      void vscode.window.showInformationMessage(message);
    }),
    vscode.commands.registerCommand(`memberTimeline.deleteAllSnapshots`, async () => {
      const { memberCount, snapshotCount, pinnedCount } = await service.getStorageSummary();
      if (snapshotCount === 0) {
        void vscode.window.showInformationMessage(vscode.l10n.t(`Source Member Timeline: No snapshots to delete.`));
        return;
      }
      const pinnedNote = pinnedCount > 0
        ? ` ${vscode.l10n.t(`This includes {0} pinned snapshot(s).`, String(pinnedCount))}`
        : ``;
      const detail = vscode.l10n.t(`This will delete all {0} snapshot(s) across {1} member(s). This cannot be undone.`, String(snapshotCount), String(memberCount)) + pinnedNote;
      const confirm = await vscode.window.showWarningMessage(
        vscode.l10n.t(`Delete all Source Member Timeline snapshots?`),
        { modal: true, detail },
        vscode.l10n.t(`Delete All`)
      );
      if (confirm !== vscode.l10n.t(`Delete All`)) {
        return;
      }
      provider.selectedForCompare = undefined;
      await vscode.commands.executeCommand(`setContext`, `memberTimeline:hasCompareSelection`, false);
      await service.deleteAllSnapshots();
      await provider.refreshForActiveEditor(treeView);
    }),
    vscode.commands.registerCommand(`memberTimeline.selectForCompare`, async (item?: MemberTimelineTreeItem) => {
      const entry = item?.entry;
      if (!entry) {
        return;
      }
      provider.selectedForCompare = entry;
      await vscode.commands.executeCommand(`setContext`, `memberTimeline:hasCompareSelection`, true);
      provider.fireRefresh();
      vscode.window.setStatusBarMessage(
        vscode.l10n.t(`Selected for compare: {0} ({1})`, `${entry.member.name}.${entry.member.extension}`, new Date(entry.timestamp).toLocaleString()),
        3000
      );
    }),
    vscode.commands.registerCommand(`memberTimeline.compareWithActiveMember`, async (item?: MemberTimelineTreeItem) => {
      const entry = item?.entry;
      if (!entry) {
        return;
      }
      const snapshotUri = await resolveSnapshotUri(entry.snapshotPath);
      if (!snapshotUri) {
        return;
      }
      const rightUri = vscode.window.activeTextEditor?.document.uri;
      if (!rightUri) {
        void vscode.window.showErrorMessage(vscode.l10n.t(`No active editor to compare with.`));
        return;
      }
      const title = vscode.l10n.t(`History: {0} ({1})`, `${entry.member.name}.${entry.member.extension}`, new Date(entry.timestamp).toLocaleString());
      await vscode.commands.executeCommand(`vscode.diff`, snapshotUri, rightUri, title);
    }),
    vscode.commands.registerCommand(`memberTimeline.compareWithSelected`, async (item?: MemberTimelineTreeItem) => {
      const entry = item?.entry;
      if (!entry || !provider.selectedForCompare) {
        return;
      }
      const snapshotUri = await resolveSnapshotUri(entry.snapshotPath);
      if (!snapshotUri) {
        return;
      }
      const selectedUri = await resolveSnapshotUri(provider.selectedForCompare.snapshotPath);
      if (!selectedUri) {
        return;
      }
      const leftLabel = `${provider.selectedForCompare.member.name}.${provider.selectedForCompare.member.extension} (${new Date(provider.selectedForCompare.timestamp).toLocaleString()})`;
      const rightLabel = `${entry.member.name}.${entry.member.extension} (${new Date(entry.timestamp).toLocaleString()})`;
      await vscode.commands.executeCommand(`vscode.diff`, selectedUri, snapshotUri, `${leftLabel} ↔ ${rightLabel}`);
    }),
    vscode.commands.registerCommand(`memberTimeline.compareWithLocalFile`, async (item?: MemberTimelineTreeItem) => {
      const entry = item?.entry;
      if (!entry) {
        return;
      }
      const snapshotUri = await resolveSnapshotUri(entry.snapshotPath);
      if (!snapshotUri) {
        return;
      }
      const picks = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: vscode.l10n.t(`Compare`) });
      if (!picks?.length) {
        return;
      }
      const title = vscode.l10n.t(`History: {0} ({1})`, `${entry.member.name}.${entry.member.extension}`, new Date(entry.timestamp).toLocaleString());
      await vscode.commands.executeCommand(`vscode.diff`, snapshotUri, picks[0], title);
    }),
    vscode.commands.registerCommand(`memberTimeline.compareWithIfsFile`, async (item?: MemberTimelineTreeItem) => {
      const entry = item?.entry;
      if (!entry) {
        return;
      }
      const snapshotUri = await resolveSnapshotUri(entry.snapshotPath);
      if (!snapshotUri) {
        return;
      }
      const ifsPath = await vscode.window.showInputBox({
        prompt: vscode.l10n.t(`Enter the IFS file path (requires active IBM i connection)`),
        placeHolder: `/home/user/file.rpgle`
      });
      if (!ifsPath?.trim()) {
        return;
      }
      const ifsUri = vscode.Uri.from({ scheme: `streamfile`, path: ifsPath.trim() });
      const title = vscode.l10n.t(`History: {0} ({1})`, `${entry.member.name}.${entry.member.extension}`, new Date(entry.timestamp).toLocaleString());
      await vscode.commands.executeCommand(`vscode.diff`, snapshotUri, ifsUri, title);
    }),
    vscode.commands.registerCommand(`memberTimeline.compareWithMember`, async (item?: MemberTimelineTreeItem) => {
      const entry = item?.entry;
      if (!entry) {
        return;
      }
      const snapshotUri = await resolveSnapshotUri(entry.snapshotPath);
      if (!snapshotUri) {
        return;
      }
      const defaultValue = `${entry.member.library}/${entry.member.file}/${entry.member.name}.${entry.member.extension}`;
      const input = await vscode.window.showInputBox({
        prompt: vscode.l10n.t(`Enter member path (LIBRARY/FILE/NAME.EXT or ASP/LIBRARY/FILE/NAME.EXT)`),
        placeHolder: `MYLIB/QRPGLESRC/MYPROG.RPGLE`,
        value: defaultValue
      });
      if (!input?.trim()) {
        return;
      }
      const parts = input.trim().toUpperCase().split(`/`);
      let memberUri: vscode.Uri;
      if (parts.length === 3) {
        memberUri = vscode.Uri.from({ scheme: `member`, path: `/${parts[0]}/${parts[1]}/${parts[2]}` });
      } else if (parts.length === 4) {
        memberUri = vscode.Uri.from({ scheme: `member`, path: `/${parts[0]}/${parts[1]}/${parts[2]}/${parts[3]}` });
      } else {
        void vscode.window.showErrorMessage(vscode.l10n.t(`Invalid member path. Use format: LIBRARY/FILE/NAME.EXT`));
        return;
      }
      const title = vscode.l10n.t(`History: {0} ({1})`, `${entry.member.name}.${entry.member.extension}`, new Date(entry.timestamp).toLocaleString());
      await vscode.commands.executeCommand(`vscode.diff`, snapshotUri, memberUri, title);
    })
  );

  codeForIBMi.instance.subscribe(context, `connected`, `Refresh member timeline`, () => {
    const connection = codeForIBMi.instance.getConnection();
    service.setCurrentSystem(connection?.currentHost);
    void provider.refreshForActiveEditor(treeView);
    void recentProvider.refresh();
  });
  codeForIBMi.instance.subscribe(context, `disconnected`, `Clear member timeline`, () => {
    service.setCurrentSystem(undefined);
    provider.clear(treeView);
    void recentProvider.refresh();
  });

  const initialConnection = codeForIBMi.instance.getConnection();
  if (initialConnection) {
    service.setCurrentSystem(initialConnection.currentHost);
  }

  void provider.refreshForActiveEditor(treeView);
  void recentProvider.refresh();
}

class MemberTimelineViewProvider implements vscode.TreeDataProvider<MemberTimelineItem> {
  private readonly emitter = new vscode.EventEmitter<MemberTimelineItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private entries: MemberTimelineItem[] = [];
  selectedForCompare: TimelineEntry | undefined;

  constructor(private readonly service: MemberTimelineService) {}

  getTreeItem(element: MemberTimelineItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.ProviderResult<MemberTimelineItem[]> {
    return this.entries;
  }

  fireRefresh(): void {
    this.emitter.fire(undefined);
  }

  async refreshForActiveEditor(treeView: vscode.TreeView<MemberTimelineItem>): Promise<void> {
    if (!this.service.isEnabled()) {
      this.entries = [new MemberTimelineDisabledItem()];
      treeView.message = undefined;
      await vscode.commands.executeCommand(`setContext`, `memberTimeline:memberActive`, false);
      this.emitter.fire(undefined);
      return;
    }

    const activeUri = resolveTrackedMemberUri();

    if (!activeUri) {
      this.entries = [];
      treeView.message = vscode.l10n.t(`Open an IBM i source member to view history.`);
      await vscode.commands.executeCommand(`setContext`, `memberTimeline:memberActive`, false);
      this.emitter.fire(undefined);
      return;
    }

    const member = this.service.parseMemberFromUri(activeUri);
    if (!member) {
      this.clear(treeView);
      return;
    }

    const snapshots = await this.service.getSnapshotsForMember(member);
    this.service.schedulePruneMember(member);

    this.entries = snapshots.map(snapshot => new MemberTimelineTreeItem(snapshot));
    treeView.message = snapshots.length
      ? undefined
      : vscode.l10n.t(`No history yet for the active member.`);

    await vscode.commands.executeCommand(`setContext`, `memberTimeline:memberActive`, true);
    this.emitter.fire(undefined);
  }

  clear(treeView: vscode.TreeView<MemberTimelineItem>): void {
    this.entries = [];
    treeView.message = vscode.l10n.t(`Open an IBM i source member to view history.`);
    void vscode.commands.executeCommand(`setContext`, `memberTimeline:memberActive`, false);
    this.emitter.fire(undefined);
  }
}

class RecentMembersViewProvider implements vscode.TreeDataProvider<RecentMemberTreeItem> {
  private readonly emitter = new vscode.EventEmitter<RecentMemberTreeItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private entries: RecentMemberTreeItem[] = [];

  constructor(private readonly service: MemberTimelineService) {}

  getTreeItem(element: RecentMemberTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.ProviderResult<RecentMemberTreeItem[]> {
    return this.entries;
  }

  async refresh(): Promise<void> {
    const recents = await this.service.getRecentMembers();
    this.entries = recents.map(recent => new RecentMemberTreeItem(recent));
    this.emitter.fire(undefined);
  }
}

class RecentMemberTreeItem extends vscode.TreeItem {
  constructor(readonly recent: RecentMemberEntry) {
    const label = `${recent.member.name}.${recent.member.extension}`;
    super(label, vscode.TreeItemCollapsibleState.None);

    const qualified = `${recent.member.library}/${recent.member.file}`;
    const opened = new Date(recent.timestamp).toLocaleString();
    this.description = `${qualified} — ${opened}`;
    this.tooltip = vscode.l10n.t(`{0}\nLast opened: {1}`, `${qualified}/${label}`, opened);
    this.iconPath = new vscode.ThemeIcon(`file-code`);
    this.contextValue = `memberTimelineRecentEntry`;
    this.command = {
      command: `memberTimeline.openRecentMember`,
      title: vscode.l10n.t(`Open Member`),
      arguments: [this]
    };
  }
}

class MemberTimelineDisabledItem extends vscode.TreeItem {
  constructor() {
    super(vscode.l10n.t(`Source Member Timeline is disabled`), vscode.TreeItemCollapsibleState.None);
    this.description = vscode.l10n.t(`Open VS Code settings to enable`);
    this.iconPath = new vscode.ThemeIcon(`gear`);
    this.command = {
      command: `workbench.action.openSettings`,
      title: vscode.l10n.t(`Open Settings`),
      arguments: [`memberTimeline.enabled`]
    };
    this.contextValue = `memberTimelineDisabled`;
  }
}

class MemberTimelineTreeItem extends vscode.TreeItem {
  constructor(readonly entry: TimelineEntry) {
    const created = new Date(entry.timestamp);
    const label = `${entry.member.name}.${entry.member.extension}`;
    super(label, vscode.TreeItemCollapsibleState.None);

    const actionLabel = entry.action.charAt(0).toUpperCase() + entry.action.slice(1);
    this.tooltip = entry.comment
      ? `${actionLabel} — ${created.toLocaleString()}\n${entry.comment}`
      : `${actionLabel} — ${created.toLocaleString()}`;
    this.description = entry.comment
      ? `${created.toLocaleString()} — ${entry.comment}`
      : created.toLocaleString();
    this.iconPath = new vscode.ThemeIcon(entry.pinned ? `pinned` : `history`);
    this.contextValue = entry.pinned ? `memberTimelineEntryPinned` : `memberTimelineEntry`;
    this.command = {
      command: `memberTimeline.openDiff`,
      title: vscode.l10n.t(`Open Diff`),
      arguments: [this]
    };
  }
}
