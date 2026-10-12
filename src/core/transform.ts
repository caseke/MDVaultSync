// The content transform seam (D-10, R-ENG-4, design §13). Every byte between the vault and Graph passes
// through a ContentTransform inside RemoteContent (M6). v1 ships only the identity transform; end-to-end
// encryption can be added later as another implementation without changing the engine.
import type { ContentTransform, TransformContext } from "./ports.ts";

export type { ContentTransform, TransformContext };

/** v1 transform: stored bytes are the plaintext bytes, so localHash equals remoteHash. */
export class IdentityTransform implements ContentTransform {
	readonly id = "identity";

	encode(plain: ArrayBuffer, _ctx: TransformContext): Promise<ArrayBuffer> {
		return Promise.resolve(plain);
	}

	decode(stored: ArrayBuffer, _ctx: TransformContext): Promise<ArrayBuffer> {
		return Promise.resolve(stored);
	}
}
