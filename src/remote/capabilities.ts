// Graph behaviors the docs leave open, fixed at build time from the M3 probe (run-diagnostics) so the choice is
// reviewable (design §5.5). Values below come from the owner's Ubuntu runs (probe v1 and v2, 2026-10-12, recorded
// in docs/plan.md M3). They are server behaviors, so they don't depend on the device. CAPABILITIES_PROBED stays
// false until the upload host is allowlisted and the large-file round trip passes on the iPad; M6 must not ship
// with it false.

export type DeltaForm = "approot-colon" | "items-id" | "children-walk";

/** True once every probe question is settled on both devices (docs/plan.md M3). */
export const CAPABILITIES_PROBED: boolean = false;

/**
 * Whether `PUT /items/{id}/content` returns 412 on a stale If-Match [G-UP-3] (D-11). Observed: 412 (code
 * `notAllowed`) in both Ubuntu runs, so small replaces may use simple PUT with If-Match.
 */
export const PUT_HONORS_IF_MATCH: boolean = true;

/**
 * Which delta form works on the App Folder [G-DL-1]. Observed (probe v2): `/me/drive/items/{approotId}/delta`
 * works, lists the approot, and carries QuickXorHash on every file [G-DL-8]; `approot:/:/delta` doesn't pass our
 * validation. children-walk stays as the design §5.2 fallback.
 */
export const DELTA_FORM: DeltaForm = "items-id";

/** Longest name segment we send, in UTF-16 units [G-NM-6]. Observed: 256 accepted, 300 rejected (badArgument). */
export const NAME_MAX: number = 255;
