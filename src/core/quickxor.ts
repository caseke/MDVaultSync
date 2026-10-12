// QuickXorHash, the only hash OneDrive personal guarantees [G-HASH-1]. Port of Microsoft's reference
// implementation [G-HASH-2]: a 160-bit circular register where byte n is XORed in at bit (n × 11) mod 160,
// then the 64-bit little-endian byte count is XORed into the last 8 bytes, and the 20 bytes are base64-encoded.
// Checked against OneDrive's own hashes (M3 probe) and rclone's vectors [G-HASH-3] in test/quickxor.test.ts.

const WIDTH = 160; // register width in bits; also the period of (n × SHIFT) mod WIDTH
const SHIFT = 11;
const OUT_BYTES = WIDTH / 8;

/** Incremental hasher. `update` may be called with chunks of any size; the result doesn't depend on chunking. */
export class QuickXorHasher {
	// Byte n always lands at the same bit offset as byte n + 160, and XOR is linear, so the hot loop only folds
	// each byte into acc[n mod 160]; digest() applies the 160 shifts once.
	private readonly acc = new Uint8Array(WIDTH);
	private length = 0;

	update(bytes: Uint8Array): this {
		const acc = this.acc;
		const n = bytes.length;
		let k = this.length % WIDTH;
		let i = 0;
		// Unaligned head, then whole 160-byte blocks, then the tail.
		while (i < n && k !== 0) {
			acc[k] = (acc[k] ?? 0) ^ (bytes[i] ?? 0);
			i++;
			k = k + 1 === WIDTH ? 0 : k + 1;
		}
		for (; i + WIDTH <= n; i += WIDTH) {
			for (let j = 0; j < WIDTH; j++) acc[j] = (acc[j] ?? 0) ^ (bytes[i + j] ?? 0);
		}
		for (; i < n; i++) {
			acc[k] = (acc[k] ?? 0) ^ (bytes[i] ?? 0);
			k++;
		}
		this.length += n;
		return this;
	}

	/** Base64 of the 20-byte hash (28 characters). Doesn't reset the hasher. */
	digest(): string {
		const out = new Uint8Array(OUT_BYTES);
		for (let k = 0; k < WIDTH; k++) {
			const b = this.acc[k] ?? 0;
			if (b === 0) continue;
			const bit = (k * SHIFT) % WIDTH;
			const at = bit >> 3;
			const s = bit & 7;
			out[at] = (out[at] ?? 0) ^ ((b << s) & 0xff);
			if (s !== 0) {
				const next = (at + 1) % OUT_BYTES; // bits past 160 wrap to bit 0
				out[next] = (out[next] ?? 0) ^ (b >> (8 - s));
			}
		}
		// Byte count as a 64-bit little-endian integer into bytes 12–19, split in 32-bit halves (no BigInt).
		const lo = this.length >>> 0;
		const hi = Math.floor(this.length / 0x1_0000_0000) >>> 0;
		for (let i = 0; i < 4; i++) {
			out[12 + i] = (out[12 + i] ?? 0) ^ ((lo >>> (8 * i)) & 0xff);
			out[16 + i] = (out[16 + i] ?? 0) ^ ((hi >>> (8 * i)) & 0xff);
		}
		let bin = "";
		for (const b of out) bin += String.fromCharCode(b);
		return btoa(bin);
	}
}

/** QuickXorHash of `data` as base64. A Uint8Array view hashes only its own bytes. */
export function quickXorHash(data: ArrayBuffer | Uint8Array): string {
	return new QuickXorHasher().update(data instanceof Uint8Array ? data : new Uint8Array(data)).digest();
}
