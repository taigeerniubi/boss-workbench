import { join } from "node:path";
import { DATA_DIR, readJson, writeJson } from "./lib.mjs";
import { runScrape } from "./jobs.mjs";

export const WATCH_PATH = join(DATA_DIR, "watch.json");
export const DEFAULT_WATCH_INTERVAL_MINUTES = 360;

export function computeWatchDelta(previousIds, jobs) {
	const before = new Set((previousIds ?? []).map(String));
	const newItems = (jobs ?? []).filter((job) => job?.id && !before.has(String(job.id)));
	const seenIds = [...before];
	for (const job of jobs ?? []) if (job?.id && !before.has(String(job.id))) {
		before.add(String(job.id));
		seenIds.push(String(job.id));
	}
	return { newItems, seenIds };
}

export function canRunWatch(watch, now = Date.now()) {
	if (watch?.lastRunAt === null || watch?.lastRunAt === undefined) return { ok: true, remainingMs: 0 };
	const interval = Math.max(Number(watch.minIntervalMinutes) || DEFAULT_WATCH_INTERVAL_MINUTES, 30) * 60 * 1000;
	const remainingMs = Date.parse(watch.lastRunAt) + interval - now;
	return { ok: remainingMs <= 0, remainingMs: Math.max(0, remainingMs) };
}

export function readWatch() { return readJson(WATCH_PATH, null); }

export function saveWatch(criteria) {
	const previous = readWatch();
	const normalizedCriteria = {
		mode: criteria.mode === "recommend" ? "recommend" : "search",
		city: String(criteria.city ?? ""),
		query: String(criteria.query ?? ""),
		pageSize: Math.min(Math.max(Number(criteria.pageSize) || 30, 1), 30),
		experience: criteria.experience ?? null,
		degree: criteria.degree ?? null,
		salary: criteria.salary ?? null,
		industry: criteria.industry ?? null,
		scale: criteria.scale ?? null,
		stage: criteria.stage ?? null,
		jobType: criteria.jobType ?? null,
	};
	const sameCriteria = JSON.stringify(previous?.criteria ?? null) === JSON.stringify(normalizedCriteria);
	const next = {
		version: 1,
		enabled: true,
		criteria: normalizedCriteria,
		minIntervalMinutes: Math.max(Number(criteria.minIntervalMinutes) || DEFAULT_WATCH_INTERVAL_MINUTES, 30),
		seenIds: sameCriteria ? previous?.seenIds ?? [] : [],
		lastRunAt: sameCriteria ? previous?.lastRunAt ?? null : null,
		lastResult: sameCriteria ? previous?.lastResult ?? null : null,
		savedAt: new Date().toISOString(),
	};
	writeJson(WATCH_PATH, next);
	return next;
}

/** 一次手动检查就是一次搜索；不在进程内 setInterval，避免意外高频。 */
export async function runWatch({ scrape = runScrape, now = Date.now() } = {}) {
	const watch = readWatch();
	if (watch === null || watch.enabled !== true) return { ok: false, reason: "not-configured", error: "还没有保存监听条件" };
	const gate = canRunWatch(watch, now);
	if (!gate.ok) return { ok: false, reason: "watch-interval", error: `监听最短间隔还没到（约 ${Math.ceil(gate.remainingMs / 60000)} 分钟）`, remainingMs: gate.remainingMs };
	const result = await scrape({ ...watch.criteria, pages: 1, save: true });
	if (!result.ok || result.stopped) return { ...result, watch: true };
	const current = (result.fetchedJobs ?? []).filter((job) => {
		if (watch.criteria.city && job.city !== watch.criteria.city) return false;
		const q = watch.criteria.query.trim().toLowerCase();
		return q === "" || `${job.title} ${job.company} ${job.jd}`.toLowerCase().includes(q);
	});
	const delta = computeWatchDelta(watch.seenIds, current);
	const next = {
		...watch,
		seenIds: delta.seenIds.slice(-5000),
		lastRunAt: new Date(now).toISOString(),
		lastResult: { newCount: delta.newItems.length, seenCount: delta.seenIds.length },
	};
	writeJson(WATCH_PATH, next);
	return { ok: true, newCount: delta.newItems.length, seenCount: delta.seenIds.length, newItems: delta.newItems, watch: next };
}
