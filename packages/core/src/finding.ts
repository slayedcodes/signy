import type { DeviationCheck, DeviationKind } from './types.js';

/** The facts that identify one Deviation, before an ID or Sign-off status is attached. */
export interface Finding {
  kind: DeviationKind;
  check: DeviationCheck;
  target: string;
  detail: string;
  /** What the Deviation consists of; any change to it gives a new Deviation Fingerprint. */
  content: string;
}
