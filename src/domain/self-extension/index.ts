export { writeJsonAtomic } from '../persistence/atomic.js'
export { PersistenceIntegrityError, PersistenceSchemaError } from './errors.js'
export { SELF_EXTENSION_SCHEMA_VERSION, resolveAssistantHome, selfExtensionPaths } from './home.js'
export { DurableAuthorityStore, parseAuthorityFile } from './authority-store.js'
export { DurableCandidateIndex, ARTIFACT_RETENTIONS, parseCandidateIndexFile, type ArtifactRetention } from './candidate-index.js'
export { openDurableSelfExtension, hydrateFromAuthority, persistGovernance } from './durable.js'
export { reconstructCommittedExtensions } from './reconstruct.js'
export { operatorStatus, formatOperatorStatus, type OperatorStatus } from './status.js'
export {
  BACKUP_KIND,
  BACKUP_SCHEMA_VERSION,
  BACKUP_EXCLUDES,
  backupSelfExtension,
  restoreSelfExtension,
  parseBackupManifest,
  assertDisjointPaths,
  requiredBackupRows,
  type SelfExtensionBackupManifest,
} from './backup.js'
