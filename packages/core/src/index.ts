export { validateContract } from './validate-contract.js';
export type {
  ChangeContract,
  ContractValidationError,
  ContractValidationResult,
  ValidateOptions,
} from './validate-contract.js';
export { runGate } from './gate.js';
export { prepareApproval, type ApprovalDecision } from './prepare-approval.js';
export { renderSummary } from './render.js';
export { renderFeedback } from './render-feedback.js';
export { buildRunSummary, type RunSummary } from './run-summary.js';
export { GATE_CONFIG_FILE } from './config.js';
export { contractHash, isContractFile } from './contract-structure.js';
export type * from './types.js';
export type { AgentDetectionConfig, GateConfig, SignoffPolicyConfig } from './config.js';
