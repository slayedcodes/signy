import { detectAgent } from './agent-detection.js';
import { checkApproval } from './approval.js';
import { resolveConfig } from './config.js';
import { checkContractStructure } from './contract-structure.js';
import { detectDeviations } from './deviations.js';
import { applySignoffs } from './signoffs.js';
import type { CommandError, ContractApproval, Deviation, GateFailure, GateInput, GateResult } from './types.js';

/** The gate pipeline (PLAN.md §5). Every check runs; failures are collected, not short-circuited. */
export async function runGate(input: GateInput): Promise<GateResult> {
  const config = resolveConfig(input.config);
  const detection = detectAgent(input, config);
  if (!detection.agentAuthored) {
    return { status: 'pass', applicable: false, notes: [detection.note], failures: [], deviations: [], commandErrors: [] };
  }

  const notes = [detection.note];
  const structure = await checkContractStructure(input);
  const failures: GateFailure[] = [...structure.failures];
  let deviations: Deviation[] = [];
  let commandErrors: CommandError[] = [];
  let approval: ContractApproval | undefined;
  if (structure.contract) {
    const approvalCheck = checkApproval(input, structure.contract, config);
    if (approvalCheck.note) notes.push(approvalCheck.note);
    failures.push(...approvalCheck.failures);
    approval = approvalCheck.approval;
    if (structure.contract.document) {
      deviations = await detectDeviations(input, structure.contract.document, config);
    }
  }
  ({ deviations, commandErrors } = applySignoffs(input, deviations, config));
  if (input.local) {
    notes.push("Checked locally: comments aren't available, so the approval comment and Sign-offs weren't verified.");
  }
  const pass = failures.length === 0 && deviations.every((d) => d.status === 'accepted');
  return {
    status: pass ? 'pass' : 'fail',
    applicable: true,
    notes,
    failures,
    deviations,
    commandErrors,
    ...(approval ? { approval } : {}),
  };
}
