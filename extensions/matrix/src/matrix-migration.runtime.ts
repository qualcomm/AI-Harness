// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export { autoMigrateLegacyMatrixState, detectLegacyMatrixState } from "./legacy-state.js";
export { autoPrepareLegacyMatrixCrypto, detectLegacyMatrixCrypto } from "./legacy-crypto.js";
export {
  hasActionableMatrixMigration,
  hasPendingMatrixMigration,
  resolveMatrixMigrationStatus,
  type MatrixMigrationStatus,
} from "./migration-snapshot.js";
export { maybeCreateMatrixMigrationSnapshot } from "./migration-snapshot-backup.js";
