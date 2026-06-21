# Changelog

## 1.0.2

- Snapshots are now scoped per IBM i system — identically named members on different systems are tracked independently
- Existing snapshots from prior versions are automatically migrated to the current system on first access
- Consistent naming throughout the extension ("Source Member Timeline")
- Pin/Unpin snapshots — pinned snapshots are exempt from automatic pruning and survive Clear Member History
- First snapshot for a member is automatically pinned as "Initial Snapshot"
- Clear Member History now preserves pinned snapshots

## 1.0.1

- Skip creating a snapshot for blank/empty source members (e.g. newly created members with no content yet)

## 1.0.0

- Initial release
