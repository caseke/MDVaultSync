// How many times something happened in the last `windowMs` (M8 matrix row 10: the settings refresh breadcrumb
// carries this count, so a refresh storm shows as a fast-rising number). Pure; the history is capped.
export class RecentCounter {
	private readonly windowMs: number;
	private readonly cap: number;
	private readonly times: number[] = [];

	constructor(windowMs: number, cap = 1_000) {
		this.windowMs = windowMs;
		this.cap = cap;
	}

	/** Records a hit at `now` and returns the hits inside the window, at most `cap`. */
	hit(now: number): number {
		this.times.push(now);
		while (this.times.length > 0 && now - (this.times[0] ?? now) >= this.windowMs) this.times.shift();
		if (this.times.length > this.cap) this.times.splice(0, this.times.length - this.cap);
		return this.times.length;
	}
}
