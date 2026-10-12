// Graph behaviors the docs leave open, fixed at build time from the M3 probe (run-diagnostics) so the choice is
// reviewable (design §5.5). Until the owner's probe results are applied these are conservative placeholders, and
// CAPABILITIES_PROBED stays false; M6 must not ship with it false.

export type DeltaForm = "approot-colon" | "items-id" | "children-walk";

/** True once the values below come from probe JSON recorded in docs/plan.md M3. */
export const CAPABILITIES_PROBED: boolean = false;

/**
 * Whether `PUT /items/{id}/content` returns 412 on a stale If-Match [G-UP-3] (D-11). false (the safe default)
 * routes every replace through a single-fragment upload session, where If-Match is documented [G-UP-5].
 */
export const PUT_HONORS_IF_MATCH: boolean = false;

/** Which delta form works on the App Folder [G-DL-1]; children-walk is the design §5.2 fallback. */
export const DELTA_FORM: DeltaForm = "approot-colon";

/** Longest accepted name segment, in UTF-16 units [G-NM-6]. */
export const NAME_MAX: number = 255;
