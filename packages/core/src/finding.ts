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

/** The usual Finding content: what was there before and after, split by a NUL line. */
export const beforeAfter = (before: string | undefined, after: string | undefined): string =>
  `${before ?? ''}\n\0\n${after ?? ''}`;
