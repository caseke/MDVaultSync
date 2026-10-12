// Graph behaviors the docs leave open, fixed at build time from the M3 probe (run-diagnostics) so the choice is
// reviewable (design §5.5). Values come from the owner's probe runs on Ubuntu (v1–v4) and the iPad (v4 on 0.3.5),
// 2026-10-12, recorded in docs/plan.md M3. They are server behaviors and matched on both devices.

export type DeltaForm = "approot-colon" | "items-id" | "children-walk";

/** Every probe question settled on both devices: the 0.3.5 probe passed with errors 0 on Ubuntu and the iPad. */
export const CAPABILITIES_PROBED: boolean = true;

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
