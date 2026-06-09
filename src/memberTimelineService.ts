import vscode from 'vscode';
import {
  buildMemberQsysPath,
  buildMemberTimelineKey,
  createSnapshotFileName,
  createEmptyTimelineIndex,
  hashContent,
  normalizeMember,
  MEMBER_TIMELINE_MAX_ENTRIES,
  MemberTimelineAction,
  MemberTimelineEntry,
  MemberTimelineIndex,
  MemberTimelineMember,
  pruneTimelineEntries,
  parseMemberFromUri
} from './memberTimelineUtils';

export class MemberTimelineService implements vscode.Disposable {
  private readonly updatedEmitter = new vscode.EventEmitter<void>();
  readonly onDidUpdate = this.updatedEmitter.event;
  private cachedIndex?: MemberTimelineIndex;
  private readonly scheduledPrunes = new Set<string>();
  private readonly snapshotsUri: vscode.Uri;
  private readonly indexUri: vscode.Uri;
  private storageInitialized = false;

  constructor(storageUri: vscode.Uri) {
    this.snapshotsUri = vscode.Uri.joinPath(storageUri, `snapshots`);
    this.indexUri = vscode.Uri.joinPath(storageUri, `index.json`);
  }

  dispose(): void {
    this.updatedEmitter.dispose();
  }

  isEnabled(): boolean {
    return vscode.workspace.getConfiguration(`memberTimeline`).get<boolean>(`enabled`, true);
  }

  private getSnapshotLimit(): number {
    return Math.max(1, Math.min(500, vscode.workspace.getConfiguration(`memberTimeline`).get<number>(`snapshotLimit`, MEMBER_TIMELINE_MAX_ENTRIES)));
  }

  private async ensureStorageExists(): Promise<void> {
    if (this.storageInitialized) {
      return;
    }
    await vscode.workspace.fs.createDirectory(this.snapshotsUri);
    this.storageInitialized = true;
  }

  resetStorage(): void {
    this.cachedIndex = undefined;
    this.scheduledPrunes.clear();
  }

  private log(message: string, error?: unknown): void {
    if (error) {
      console.error(`[Member Timeline] ${message}`, error);
    } else {
      console.log(`[Member Timeline] ${message}`);
    }
  }

  private async loadIndex(): Promise<MemberTimelineIndex> {
    if (this.cachedIndex) {
      return this.cachedIndex;
    }
    try {
      const raw = await vscode.workspace.fs.readFile(this.indexUri);
      const parsed = JSON.parse(Buffer.from(raw).toString(`utf8`)) as MemberTimelineIndex;
      if (parsed?.members) {
        this.cachedIndex = { version: parsed.version || 1, members: parsed.members };
        return this.cachedIndex;
      }
    } catch {
      // index does not exist yet
    }
    this.cachedIndex = createEmptyTimelineIndex();
    return this.cachedIndex;
  }

  private async saveIndex(index: MemberTimelineIndex): Promise<void> {
    await this.ensureStorageExists();
    await vscode.workspace.fs.writeFile(this.indexUri, Buffer.from(JSON.stringify(index, null, 2), `utf8`));
    this.cachedIndex = index;
  }

  private async deleteSnapshotFile(snapshotPath: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(snapshotPath), { useTrash: false });
    } catch {
      // file already gone
    }
  }

  private async pruneBucket(bucketEntries: MemberTimelineEntry[]): Promise<MemberTimelineEntry[]> {
    const { kept, removed } = pruneTimelineEntries(bucketEntries, this.getSnapshotLimit());
    await Promise.allSettled(removed.map(e => this.deleteSnapshotFile(e.snapshotPath)));
    return kept;
  }

  async captureMemberSnapshot(member: MemberTimelineMember, action: MemberTimelineAction = `saved`, content: string): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    try {
      const normalizedMember = normalizeMember(member);
      const memberPath = buildMemberQsysPath(normalizedMember);

      await this.ensureStorageExists();
      const index = await this.loadIndex();
      const key = buildMemberTimelineKey(normalizedMember);

      const contentHash = hashContent(content);
      const bucket = index.members[key] || { qsysPath: memberPath, entries: [] };

      if (bucket.hash === contentHash) {
        this.log(`No changes detected for ${memberPath}. Skipping snapshot.`);
        return;
      }

      this.log(`Capturing snapshot (${action}) for ${memberPath}.`);

      const timestamp = new Date().toISOString();
      const snapshotFileName = createSnapshotFileName(normalizedMember, timestamp);
      const snapshotUri = vscode.Uri.joinPath(this.snapshotsUri, snapshotFileName);

      await vscode.workspace.fs.writeFile(snapshotUri, Buffer.from(content, `utf8`));

      const isFirst = bucket.entries.length === 0;
      bucket.hash = contentHash;
      bucket.entries.unshift({
        id: `${Date.now()}_${Math.random().toString(36).substring(2, 10)}`,
        timestamp,
        snapshotPath: snapshotUri.fsPath,
        action,
        ...(isFirst ? { pinned: true, comment: `Initial Snapshot` } : {}),
        member: normalizedMember
      });

      index.members[key] = bucket;
      await this.saveIndex(index);
      this.updatedEmitter.fire();
      this.log(`Snapshot captured for ${memberPath}. Total: ${bucket.entries.length}.`);
    } catch (error) {
      this.log(`Failed to capture snapshot for ${member.library}/${member.file}(${member.name}).`, error);
    }
  }

  async getSnapshotsForMember(member: MemberTimelineMember): Promise<MemberTimelineEntry[]> {
    if (!this.isEnabled()) {
      return [];
    }
    const normalizedMember = normalizeMember(member);
    const index = await this.loadIndex();
    const key = buildMemberTimelineKey(normalizedMember);
    const bucket = index.members[key];
    if (!bucket) {
      return [];
    }
    return [...bucket.entries].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  async pruneMember(member: MemberTimelineMember): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }
    try {
      const normalizedMember = normalizeMember(member);
      const index = await this.loadIndex();
      const key = buildMemberTimelineKey(normalizedMember);
      const bucket = index.members[key];
      if (!bucket) {
        return;
      }

      const originalCount = bucket.entries.length;
      bucket.entries = await this.pruneBucket(bucket.entries);
      if (bucket.entries.length !== originalCount) {
        index.members[key] = bucket;
        await this.saveIndex(index);
        this.updatedEmitter.fire();
        this.log(`Pruned ${originalCount - bucket.entries.length} snapshot(s) for ${bucket.qsysPath}.`);
      }
    } catch (error) {
      this.log(`Failed to prune timeline for ${member.library}/${member.file}(${member.name}).`, error);
    }
  }

  schedulePruneMember(member: MemberTimelineMember): void {
    if (!this.isEnabled()) {
      return;
    }
    const key = buildMemberTimelineKey(normalizeMember(member));
    if (this.scheduledPrunes.has(key)) {
      return;
    }
    this.scheduledPrunes.add(key);
    setTimeout(async () => {
      try {
        await this.pruneMember(member);
      } finally {
        this.scheduledPrunes.delete(key);
      }
    }, 0);
  }

  async deleteSnapshots(entries: MemberTimelineEntry[]): Promise<void> {
    try {
      const index = await this.loadIndex();

      const byKey = new Map<string, MemberTimelineEntry[]>();
      for (const entry of entries) {
        const key = buildMemberTimelineKey(entry.member);
        if (!byKey.has(key)) {
          byKey.set(key, []);
        }
        byKey.get(key)!.push(entry);
      }

      for (const [key, toDelete] of byKey) {
        const bucket = index.members[key];
        if (!bucket) {
          continue;
        }
        await Promise.allSettled(toDelete.map(e => this.deleteSnapshotFile(e.snapshotPath)));
        const deleteIds = new Set(toDelete.map(e => e.id));
        bucket.entries = bucket.entries.filter(e => !deleteIds.has(e.id));
        if (bucket.entries.length === 0) {
          delete index.members[key];
        } else {
          bucket.hash = undefined;
          index.members[key] = bucket;
        }
      }

      await this.saveIndex(index);
      this.updatedEmitter.fire();
      this.log(`Deleted ${entries.length} snapshot(s).`);
    } catch (error) {
      this.log(`Failed to delete snapshot(s).`, error);
    }
  }

  async pinSnapshot(entryId: string, member: MemberTimelineMember, pinned: boolean): Promise<void> {
    try {
      const normalizedMember = normalizeMember(member);
      const index = await this.loadIndex();
      const key = buildMemberTimelineKey(normalizedMember);
      const bucket = index.members[key];
      if (!bucket) { return; }
      const entry = bucket.entries.find(e => e.id === entryId);
      if (!entry) { return; }
      if (pinned) {
        entry.pinned = true;
      } else {
        delete entry.pinned;
      }
      await this.saveIndex(index);
      this.updatedEmitter.fire();
    } catch (error) {
      this.log(`Failed to update pin for entry ${entryId}.`, error);
    }
  }

  async addComment(entryId: string, member: MemberTimelineMember, comment: string | undefined): Promise<void> {
    try {
      const normalizedMember = normalizeMember(member);
      const index = await this.loadIndex();
      const key = buildMemberTimelineKey(normalizedMember);
      const bucket = index.members[key];
      if (!bucket) {
        return;
      }
      const entry = bucket.entries.find(e => e.id === entryId);
      if (!entry) {
        return;
      }
      if (comment?.trim()) {
        entry.comment = comment.trim();
      } else {
        delete entry.comment;
      }
      await this.saveIndex(index);
      this.updatedEmitter.fire();
    } catch (error) {
      this.log(`Failed to update comment for entry ${entryId}.`, error);
    }
  }

  async deleteMemberHistory(member: MemberTimelineMember): Promise<void> {
    try {
      const normalizedMember = normalizeMember(member);
      const index = await this.loadIndex();
      const key = buildMemberTimelineKey(normalizedMember);
      const bucket = index.members[key];
      if (!bucket || bucket.entries.length === 0) {
        return;
      }
      const toDelete = bucket.entries.filter(e => !e.pinned);
      const toKeep = bucket.entries.filter(e => e.pinned);
      await Promise.allSettled(toDelete.map(e => this.deleteSnapshotFile(e.snapshotPath)));
      if (toKeep.length === 0) {
        delete index.members[key];
      } else {
        bucket.entries = toKeep;
        bucket.hash = undefined;
        index.members[key] = bucket;
      }
      await this.saveIndex(index);
      this.updatedEmitter.fire();
      this.log(`Cleared ${toDelete.length} snapshot(s) for ${bucket.qsysPath}. Kept ${toKeep.length} pinned.`);
    } catch (error) {
      this.log(`Failed to clear history for ${member.library}/${member.file}(${member.name}).`, error);
    }
  }

  async getStorageSummary(): Promise<{ memberCount: number; snapshotCount: number; totalBytes: number; pinnedCount: number }> {
    const index = await this.loadIndex();
    const memberCount = Object.keys(index.members).length;
    let snapshotCount = 0;
    let totalBytes = 0;
    let pinnedCount = 0;
    for (const bucket of Object.values(index.members)) {
      for (const entry of bucket.entries) {
        snapshotCount++;
        if (entry.pinned) { pinnedCount++; }
        try {
          const stat = await vscode.workspace.fs.stat(vscode.Uri.file(entry.snapshotPath));
          totalBytes += stat.size;
        } catch {
          // file missing, skip
        }
      }
    }
    return { memberCount, snapshotCount, totalBytes, pinnedCount };
  }

  async deleteAllSnapshots(): Promise<void> {
    try {
      const index = await this.loadIndex();
      const allEntries: MemberTimelineEntry[] = Object.values(index.members).flatMap(b => b.entries);
      await Promise.allSettled(allEntries.map(e => this.deleteSnapshotFile(e.snapshotPath)));
      await this.saveIndex(createEmptyTimelineIndex());
      this.updatedEmitter.fire();
      this.log(`Deleted all ${allEntries.length} snapshot(s).`);
    } catch (error) {
      this.log(`Failed to delete all snapshots.`, error);
    }
  }

  parseMemberFromUri(uri: vscode.Uri): MemberTimelineMember | undefined {
    return parseMemberFromUri(uri);
  }
}
