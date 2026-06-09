import vscode from 'vscode';
import { createHash } from 'crypto';

export const MEMBER_TIMELINE_SCHEMA_VERSION = 1;
export const MEMBER_TIMELINE_MAX_ENTRIES = 20;

export type MemberTimelineAction = "saved" | "compiled" | "opened";

export interface MemberTimelineMember {
  asp?: string;
  library: string;
  file: string;
  name: string;
  extension: string;
}

export interface MemberTimelineEntry {
  id: string;
  timestamp: string;
  snapshotPath: string;
  action: MemberTimelineAction;
  comment?: string;
  pinned?: boolean;
  member: MemberTimelineMember;
}

export interface MemberTimelineMemberIndex {
  hash?: string;
  qsysPath: string;
  entries: MemberTimelineEntry[];
}

export interface MemberTimelineIndex {
  version: number;
  members: Record<string, MemberTimelineMemberIndex>;
}

export function normalizeMember(member: MemberTimelineMember): MemberTimelineMember {
  return {
    asp: member.asp?.toUpperCase(),
    library: member.library.toUpperCase(),
    file: member.file.toUpperCase(),
    name: member.name.toUpperCase(),
    extension: (member.extension || `MBR`).toUpperCase()
  };
}

export function buildMemberTimelineKey(member: MemberTimelineMember): string {
  const normalized = normalizeMember(member);
  const aspSegment = normalized.asp ? `${normalized.asp}/` : ``;
  return `${aspSegment}${normalized.library}/${normalized.file}/${normalized.name}.${normalized.extension}`;
}

export function buildMemberQsysPath(member: MemberTimelineMember): string {
  const normalized = normalizeMember(member);
  const aspSegment = normalized.asp ? `${normalized.asp.toLowerCase()}.asp/` : ``;
  return `/${aspSegment}qsys.lib/${normalized.library.toLowerCase()}.lib/${normalized.file.toLowerCase()}.file/${normalized.name.toLowerCase()}.${normalized.extension.toLowerCase()}`;
}

export function createSnapshotFileName(member: MemberTimelineMember, isoTimestamp: string): string {
  const normalized = normalizeMember(member);
  const safeTimestamp = isoTimestamp.replace(/[.:]/g, `-`);
  const segments = [normalized.asp, normalized.library, normalized.file, normalized.name]
    .filter(Boolean)
    .map(segment => segment!.toLowerCase());
  return `${segments.join(`_`)}_${safeTimestamp}.${normalized.extension.toLowerCase()}`;
}

export function pruneTimelineEntries(entries: MemberTimelineEntry[], maxEntries = MEMBER_TIMELINE_MAX_ENTRIES) {
  const pinned = entries.filter(e => e.pinned);
  const unpinned = [...entries.filter(e => !e.pinned)].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return {
    kept: [...pinned, ...unpinned.slice(0, maxEntries)],
    removed: unpinned.slice(maxEntries)
  };
}

export function hashContent(content: string): string {
  return createHash(`sha256`).update(content, `utf8`).digest(`hex`);
}

export function createEmptyTimelineIndex(): MemberTimelineIndex {
  return {
    version: MEMBER_TIMELINE_SCHEMA_VERSION,
    members: {}
  };
}

export function getMemberUri(member: MemberTimelineMember): vscode.Uri {
  const path = `/${member.asp ? `${member.asp}/` : ``}${member.library}/${member.file}/${member.name}.${member.extension}`;
  return vscode.Uri.from({ scheme: `member`, path });
}

export function parseMemberFromUri(uri: vscode.Uri): MemberTimelineMember | undefined {
  if (uri.scheme !== `member`) {
    return undefined;
  }
  const parts = uri.path.split(`/`).filter(Boolean);
  if (parts.length < 3) {
    return undefined;
  }
  const last = parts[parts.length - 1];
  const dotIdx = last.lastIndexOf(`.`);
  if (dotIdx < 0) {
    return undefined;
  }
  const name = last.substring(0, dotIdx);
  const extension = last.substring(dotIdx + 1) || `MBR`;
  const file = parts[parts.length - 2];
  const library = parts[parts.length - 3];
  const asp = parts.length >= 4 ? parts[parts.length - 4] : undefined;
  return { asp, library, file, name, extension };
}
