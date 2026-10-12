import { test } from "node:test";
import assert from "node:assert/strict";
import { QuickXorHasher, quickXorHash } from "../src/core/quickxor.ts";
import { probeBytes } from "../src/remote/probe.ts";

function b64(s: string): Uint8Array {
	return new Uint8Array(Buffer.from(s, "base64"));
}

// OneDrive's own hashes of the M3 probe files (plan.md M3 hashVectors, research.md [G-HASH-2]).
test("matches the QuickXorHash OneDrive returned for probe.md", () => {
	assert.equal(quickXorHash(new TextEncoder().encode("MDVaultSync probe\n")), "DCznRcJQBzbQYQp5YsMYQAAHObw=");
});
test("empty input gives the all-zero hash", () => {
	assert.equal(quickXorHash(new ArrayBuffer(0)), "AAAAAAAAAAAAAAAAAAAAAAAAAAA=");
});
test("matches OneDrive for seq.bin = probeBytes(1000, 7)", () => {
	assert.equal(quickXorHash(probeBytes(1000, 7)), "RW+Rh6PcZW2m++mFuOGq5DBJwQk=");
});
test("matches OneDrive for large.bin = probeBytes(12582912, 1296324179)", () => {
	assert.equal(quickXorHash(probeBytes(12582912, 1296324179)), "ZxozysDdwfh/G5yk00nGRvIqEAI=");
});

// Second, independent implementation [G-HASH-3]: rclone's Go QuickXorHash test vectors (MIT), copied from
// https://github.com/rclone/rclone/blob/4f19e9cd6f442282d7fa8d5fdbd28ebb68be1131/backend/onedrive/quickxorhash/quickxorhash_test.go
// Rows are [size, base64 input, base64 hash].
const RCLONE: readonly [number, string, string][] = [
	[0, "", "AAAAAAAAAAAAAAAAAAAAAAAAAAA="],
	[1, "Sg==", "SgAAAAAAAAAAAAAAAQAAAAAAAAA="],
	[2, "tbQ=", "taAFAAAAAAAAAAAAAgAAAAAAAAA="],
	[3, "0pZP", "0rDEEwAAAAAAAAAAAwAAAAAAAAA="],
	[4, "jRRDVA==", "jaDAEKgAAAAAAAAABAAAAAAAAAA="],
	[5, "eAV52qE=", "eChAHrQRCgAAAAAABQAAAAAAAAA="],
	[6, "luBZlaT6", "lgBHFipBCn0AAAAABgAAAAAAAAA="],
	[7, "qaApEj66lw==", "qQBFCiTgA11cAgAABwAAAAAAAAA="],
	[8, "/aNzzCFPS/A=", "/RjFHJgRgicsAR4ACAAAAAAAAAA="],
	[9, "n6Neh7p6fFgm", "nxiFFw6hCz3wAQsmCQAAAAAAAAA="],
	[10, "J9iPGCbfZSTNyw==", "J8DGIzBggm+UgQTNUgYAAAAAAAA="],
	[11, "i+UZyUGJKh+ISbk=", "iyhHBpIRhESo4AOIQ0IuAAAAAAA="],
	[12, "h490d57Pqz5q2rtT", "h3gEHe7giWeswgdq3MYupgAAAAA="],
	[13, "vPgoDjOfO6fm71RxLw==", "vMAHChwwg0/s4BTmdQcV4vACAAA="],
	[14, "XoJ1AsoR4fDYJrDqYs4=", "XhBEHQSgjAiEAx7YPgEs1CEGZwA="],
	[15, "gQaybEqS/4UlDc8e4IJm", "gDCALNigBEn8oxAlZ8AzPAAOQZg="],
	[16, "2fuxhBJXtpWFe8dOfdGeHw==", "O9tHLAghgSvYohKFyMMxnNCHaHg="],
	[17, "XBV6YKU9V7yMakZnFIxIkuU=", "HbplHsBQih5cgReMQYMRzkABRiA="],
	[18, "XJZSOiNO2bmfKnTKD7fztcQX", "/6ZArHQwAidkIxefQgEdlPGAW8w="],
	[19, "g8VtAh+2Kf4k0kY5tzji2i2zmA==", "wDNrgwHWAVukwB8kg4YRcnALHIg="],
	[20, "T6LYJIfDh81JrAK309H2JMJTXis=", "zBTHrspn3mEcohlJdIUAbjGNaNg="],
	[21, "DWAAX5/CIfrmErgZa8ot6ZraeSbu", "LR2Z0PjuRYGKQB/mhQAuMrAGZbQ="],
	[22, "N9abi3qy/mC1THZuVLHPpx7SgwtLOA==", "1KTYttCBEen8Hwy1doId3ECFWDw="],
	[23, "LlUe7wHerLqEtbSZLZgZa9u0m7hbiFs=", "TqVZpxs3cN61BnuFvwUtMtECTGQ="],
	[24, "bU2j/0XYdgfPFD4691jV0AOUEUPR4Z5E", "bnLBiLpVgnxVkXhNsIAPdHAPLFQ="],
	[25, "lScPwPsyUsH2T1Qsr31wXtP55Wqbe47Uyg==", "VDMSy8eI26nBHCB0e8gVWPCKPsA="],
	[26, "rJaKh1dLR1k+4hynliTZMGf8Nd4qKKoZiAM=", "r7bjwkl8OYQeNaMcCY8fTmEJEmQ="],
	[27, "pPsT0CPmHrd3Frsnva1pB/z1ytARLeHEYRCo", "Rdg7rCcDomL59pL0s6GuTvqLVqQ="],
	[28, "wSRChaqmrsnMrfB2yqI43eRWbro+f9kBvh+01w==", "YTtloIi6frI7HX3vdLvE7I2iUOA="],
	[29, "apL67KMIRxQeE9k1/RuW09ppPjbF1WeQpTjSWtI=", "CIpedls+ZlSQ654fl+X26+Q7LVU="],
	[30, "53yx0/QgMTVb7OOzHRHbkS7ghyRc+sIXxi7XHKgT", "zfJtLGFgR9DB3Q64fAFIp+S5iOY="],
	[31, "PwXNnutoLLmxD8TTog52k8cQkukmT87TTnDipKLHQw==", "PTaGs7yV3FUyBy/SfU6xJRlCJlI="],
	[32, "NbYXsp5/K6mR+NmHwExjvWeWDJFnXTKWVlzYHoesp2E=", "wjuAuWDiq04qDt1R8hHWDDcwVoQ="],
	[33, "qQ70RB++JAR5ljNv3lJt1PpqETPsckopfonItu18Cr3E", "FkJaeg/0Z5+euShYlLpE2tJh+Lo="],
	[34, "RhzSatQTQ9/RFvpHyQa1WLdkr3nIk6MjJUma998YRtp44A==", "SPN2D29reImAqJezlqV2DLbi8tk="],
	[35, "DND1u1uZ5SqZVpRUk6NxSUdVo7IjjL9zs4A1evDNCDLcXWc=", "S6lBk2hxI2SWBfn7nbEl7D19UUs="],
	[36, "jEi62utFz69JMYHjg1iXy7oO6ZpZSLcVd2B+pjm6BGsv/CWi", "s0lYU9tr/bp9xsnrrjYgRS5EvV8="],
	[37, "hfS3DZZnhy0hv7nJdXLv/oJOtIgAuP9SInt/v8KeuO4/IvVh4A==", "CV+HQCdd2A/e/vdi12f2UU55GLA="],
	[38, "EkPQAC6ymuRrYjIXD/LT/4Vb+7aTjYVZOHzC8GPCEtYDP0+T3Nc=", "kE9H9sEmr3vHBYUiPbvsrcDgSEo="],
	[39, "vtBOGIENG7yQ/N7xNWPNIgy66Gk/I2Ur/ZhdFNUK9/1FCZuu/KeS", "+Fgp3HBimtCzUAyiinj3pkarYTk="],
	[40, "YnF4smoy9hox2jBlJ3VUa4qyCRhOZbWcmFGIiszTT4zAdYHsqJazyg==", "arkIn+ELddmE8N34J9ydyFKW+9w="],
	[41, "0n7nl3YJtipy6yeUbVPWtc2h45WbF9u8hTz5tNwj3dZZwfXWkk+GN3g=", "YJLNK7JR64j9aODWfqDvEe/u6NU="],
	[42, "FnIIPHayc1pHkY4Lh8+zhWwG8xk6Knk/D3cZU1/fOUmRAoJ6CeztvMOL", "22RPOylMtdk7xO/QEQiMli4ql0k="],
	[43, "J82VT7ND0Eg1MorSfJMUhn+qocF7PsUpdQAMrDiHJ2JcPZAHZ2nyuwjoKg==", "pOR5eYfwCLRJbJsidpc1rIJYwtM="],
	[44, "Zbu+78+e35ZIymV5KTDdub5McyI3FEO8fDxs62uWHQ9U3Oh3ZqgaZ30SnmQ=", "DbvbTkgNTgWRqRidA9r1jhtUjro="],
	[45, "lgybK3Da7LEeY5aeeNrqcdHvv6mD1W4cuQ3/rUj2C/CNcSI0cAMw6vtpVY3y", "700RQByn1lRQSSme9npQB/Ye+bY="],
	[46, "jStZgKHv4QyJLvF2bYbIUZi/FscHALfKHAssTXkrV1byVR9eACwW9DNZQRHQwg==", "uwN55He8xgE4g93dH9163xPew4U="],
	[47, "V1PSud3giF5WW72JB/bgtltsWtEB5V+a+wUALOJOGuqztzVXUZYrvoP3XV++gM0=", "U+3ZfUF/6mwOoHJcSHkQkckfTDA="],
	[48, "VXs4t4tfXGiWAL6dlhEMm0YQF0f2w9rzX0CvIVeuW56o6/ec2auMpKeU2VeteEK5", "sq24lSf7wXLH8eigHl07X+qPTps="],
	[49, "bLUn3jLH+HFUsG3ptWTHgNvtr3eEv9lfKBf0jm6uhpqhRwtbEQ7Ovj/hYQf42zfdtQ==", "uC8xrnopGiHebGuwgq607WRQyxQ="],
	[50, "4SVmjtXIL8BB8SfkbR5Cpaljm2jpyUfAhIBf65XmKxHlz9dy5XixgiE/q1lv+esZW/E=", "wxZ0rxkMQEnRNAp8ZgEZLT4RdLM="],
	[51, "pMljctlXeFUqbG3BppyiNbojQO3ygg6nZPeUZaQcVyJ+Clgiw3Q8ntLe8+02ZSfyCc39", "aZEPmNvOXnTt7z7wt+ewV7QGMlg="],
	[52, "C16uQlxsHxMWnV2gJhFPuJ2/guZ4N1YgmNvAwL1yrouGQtwieGx8WvZsmYRnX72JnbVtTw==", "QtlSNqXhVij64MMhKJ3EsDFB/z8="],
	[53, "7ZVDOywvrl3L0GyKjjcNg2CcTI81n2CeUbzdYWcZOSCEnA/xrNHpiK01HOcGh3BbxuS4S6g=", "4NznNJc4nmXeApfiCFTq/H5LbHw="],
	[54, "JXm2tTVqpYuuz2Cc+ZnPusUb8vccPGrzWK2oVwLLl/FjpFoxO9FxGlhnB08iu8Q/XQSdzHn+", "IwE5+2pKNcK366I2k2BzZYPibSI="],
	[55, "TiiU1mxzYBSGZuE+TX0l9USWBilQ7dEml5lLrzNPh75xmhjIK8SGqVAkvIMgAmcMB+raXdMPZg==", "yECGHtgR128ScP4XlvF96eLbIBE="],
	[56, "zz+Q4zi6wh0fCJUFU9yUOqEVxlIA93gybXHOtXIPwQQ44pW4fyh6BRgc1bOneRuSWp85hwlTJl8=", "+3Ef4D6yuoC8J+rbFqU1cegverE="],
	[57, "sa6SHK9z/G505bysK5KgRO2z2cTksDkLoFc7sv0tWBmf2G2mCiozf2Ce6EIO+W1fRsrrtn/eeOAV", "xZg1CwMNAjN0AIXw2yh4+1N3oos="],
	[58, "0qx0xdyTHhnKJ22IeTlAjRpWw6y2sOOWFP75XJ7cleGJQiV2kyrmQOST4DGHIL0qqA7sMOdzKyTViw==", "bS0tRYPkP1Gfc+ZsBm9PMzPunG8="],
	[59, "QuzaF0+5ooig6OLEWeibZUENl8EaiXAQvK9UjBEauMeuFFDCtNcGs25BDtJGGbX90gH4VZvCCDNCq4s=", "rggokuJq1OGNOfB6aDp2g4rdPgw="],
	[60, "+wg2x23GZQmMLkdv9MeAdettIWDmyK6Wr+ba23XD+Pvvq1lIMn9QIQT4Z7QHJE3iC/ZMFgaId9VAyY3d", "ahQbTmOdiKUNdhYRHgv5/Ky+Y6k="],
	[61, "y0ydRgreRQwP95vpNP92ioI+7wFiyldHRbr1SfoPNdbKGFA0lBREaBEGNhf9yixmfE+Azo2AuROxb7Yc7g==", "cJKFc0dXfiN4hMg1lcMf5E4gqvo="],
	[62, "LxlVvGXSQlSubK8r0pGf9zf7s/3RHe75a2WlSXQf3gZFR/BtRnR7fCIcaG//CbGfodBFp06DBx/S9hUV8Bk=", "NwuwhhRWX8QZ/vhWKWgQ1+rNomI="],
	[63, "L+LSB8kmGMnHaWVA5P/+qFnfQliXvgJW7d2JGAgT6+koi5NQujFW1bwQVoXrBVyob/gBxGizUoJMgid5gGNo", "ndX/KZBtFoeO3xKeo1ajO/Jy+rY="],
	[64, "Mb7EGva2rEE5fENDL85P+BsapHEEjv2/siVhKjvAQe02feExVOQSkfmuYzU/kTF1MaKjPmKF/w+cbvwfdWL8aQ==", "n1anP5NfvD4XDYWIeRPW3ZkPv1Y="],
	[111, "jyibxJSzO6ZiZ0O1qe3tG/bvIAYssvukh9suIT5wEy1JBINVgPiqdsTW0cOpP0aUfP7mgqLfADkzI/m/GgCuVhr8oFLrOCoTx1/psBOWwhltCbhUx51Icm9aH8tY4Z3ccU+6BKpYQkLCy0B/A9Zc", "hZfLIilSITC6N3e3tQ/iSgEzkto="],
	[128, "ikwCorI7PKWz17EI50jZCGbV9JU2E8bXVfxNMg5zdmqSZ2NlsQPp0kqYIPjzwTg1MBtfWPg53k0h0P2naJNEVgrqpoHTfV2b3pJ4m0zYPTJmUX4Bg/lOxcnCxAYKU29Y5F0U8Quz7ZXFBEweftXxJ7RS4r6N7BzJrPsLhY7hgck=", "imAoFvCWlDn4yVw3/oq1PDbbm6U="],
	[222, "PfxMcUd0vIW6VbHG/uj/Y0W6qEoKmyBD0nYebEKazKaKG+UaDqBEcmQjbfQeVnVLuodMoPp7P7TR1htX5n2VnkHh22xDyoJ8C/ZQKiSNqQfXvh83judf4RVr9exJCud8Uvgip6aVZTaPrJHVjQhMCp/dEnGvqg0oN5OVkM2qqAXvA0teKUDhgNM71sDBVBCGXxNOR2bpbD1iM4dnuT0ey4L+loXEHTL0fqMeUcEi2asgImnlNakwenDzz0x57aBwyq3AspCFGB1ncX4yYCr/OaCcS5OKi/00WH+wNQU3", "QX/YEpG0gDsmhEpCdWhsxDzsfVE="],
	[256, "qwGf2ESubE5jOUHHyc94ORczFYYbc2OmEzo+hBIyzJiNwAzC8PvJqtTzwkWkSslgHFGWQZR2BV5+uYTrYT7HVwRM40vqfj0dBgeDENyTenIOL1LHkjtDKoXEnQ0mXAHoJ8PjbNC93zi5TovVRXTNzfGEs5dpWVqxUzb5lc7dwkyvOluBw482mQ4xrzYyIY1t+//OrNi1ObGXuUw2jBQOFfJVj2Y6BOyYmfB1y36eBxi3zxeG5d5NYjm2GSh6e08QMAwu3zrINcqIzLOuNIiGXBtl7DjKt7b5wqi4oFiRpZsCyx2smhSrdrtK/CkdU6nDN+34vSR/M8rZpWQdBE7a8g==", "WYT9JY3JIo/pEBp+tIM6Gt2nyTM="],
	[333, "w0LGhqU1WXFbdavqDE4kAjEzWLGGzmTNikzqnsiXHx2KRReKVTxkv27u3UcEz9+lbMvYl4xFf2Z4aE1xRBBNd1Ke5C0zToSaYw5o4B/7X99nKK2/XaUX1byLow2aju2XJl2OpKpJg+tSJ2fmjIJTkfuYUz574dFX6/VXxSxwGH/xQEAKS5TCsBK3CwnuG1p5SAsQq3gGVozDWyjEBcWDMdy8/AIFrj/y03Lfc/RNRCQTAfZbnf2QwV7sluw4fH3XJr07UoD0YqN+7XZzidtrwqMY26fpLZnyZjnBEt1FAZWO7RnKG5asg8xRk9YaDdedXdQSJAOy6bWEWlABj+tVAigBxavaluUH8LOj+yfCFldJjNLdi90fVHkUD/m4Mr5OtmupNMXPwuG3EQlqWUVpQoYpUYKLsk7a5Mvg6UFkiH596y5IbJEVCI1Kb3D1", "e3+wo77iKcILiZegnzyUNcjCdoQ="],
];

test("rclone vector table is complete", () => {
	assert.equal(RCLONE.length, 70);
});
for (const [size, input, hash] of RCLONE) {
	test(`matches rclone vector of size ${size}`, () => {
		const data = b64(input);
		assert.equal(data.length, size);
		assert.equal(quickXorHash(data), hash);
	});
}

test("chunked updates give the same hash for every block size (rclone's by-block test)", () => {
	for (const block of [1, 2, 4, 7, 8, 16, 32, 64, 128, 159, 160, 161, 256, 512]) {
		for (const [, input, hash] of RCLONE) {
			const data = b64(input);
			const h = new QuickXorHasher();
			for (let i = 0; i < data.length; i += block) h.update(data.subarray(i, i + block));
			assert.equal(h.digest(), hash, `block ${block} size ${data.length}`);
		}
	}
});

test("chunking across the 160-byte period matches the one-shot hash", () => {
	const data = new Uint8Array(probeBytes(5000, 99));
	const whole = quickXorHash(data);
	for (const block of [3, 159, 160, 161, 1000, 4999]) {
		const h = new QuickXorHasher();
		for (let i = 0; i < data.length; i += block) h.update(data.subarray(i, i + block));
		assert.equal(h.digest(), whole, `block ${block}`);
	}
});

test("hashes only the bytes of a Uint8Array view, not its whole buffer", () => {
	const buf = new Uint8Array(probeBytes(300, 5));
	const view = buf.subarray(17, 217);
	assert.equal(quickXorHash(view), quickXorHash(buf.slice(17, 217).buffer));
});

test("digest does not consume the hasher; later updates continue", () => {
	const data = new Uint8Array(probeBytes(500, 3));
	const h = new QuickXorHasher().update(data.subarray(0, 200));
	assert.equal(h.digest(), quickXorHash(data.subarray(0, 200)));
	h.update(data.subarray(200));
	assert.equal(h.digest(), quickXorHash(data));
});

test("hash is 28 base64 characters", () => {
	assert.match(quickXorHash(probeBytes(777, 1)), /^[A-Za-z0-9+/]{27}=$/);
});

test("100 MiB timing (logged, not asserted)", (t) => {
	const data = new Uint8Array(100 * 1024 * 1024);
	for (let i = 0; i < data.length; i += 4096) data[i] = i & 0xff;
	const start = performance.now();
	quickXorHash(data);
	t.diagnostic(`quickXorHash 100 MiB: ${Math.round(performance.now() - start)} ms`);
});
