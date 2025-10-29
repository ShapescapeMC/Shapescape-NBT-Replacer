/**
 * NBT Replacer - A high-performance tool for finding and replacing strings in NBT files
 * @module nbt-replacer
 * @requires node:fs/promises
 * @requires node:path
 * @requires fast-glob
 * @requires deepslate
 * @requires node:os
 */

import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { NbtFile, NbtType, NbtString } from "deepslate";
import { cpus } from "node:os";

/**
 * Global flag to enable debug logging
 * @type {boolean}
 */
let DEBUG_MODE = false;

/**
 * Logs debug messages if DEBUG_MODE is enabled
 * @param {...*} args - Arguments to log
 */
function debug(...args) {
	if (DEBUG_MODE) {
		console.log(...args);
	}
}

/**
 * @typedef {Object} ReplacementRule
 * @property {string} path - Glob pattern including filename (supports * and **)
 * @property {string} [property] - Optional tag name to target
 * @property {string} from - String to find (or regex pattern if regex=true)
 * @property {string} to - String to write as replacement
 * @property {boolean} [regex=false] - Treat 'from' as regex pattern
 * @property {string} [flags='g'] - Regex flags when regex is true
 * @property {number} [maxConcurrency] - Number of concurrent file operations (default: CPU cores * 2)
 * @property {boolean} [debug=false] - Enable verbose debug logging
 * @property {boolean} [notify=false] - Log every individual replacement with file & tag path
 */

/**
 * @typedef {Object} Config
 * @property {ReplacementRule[]} [rules] - Array of replacement rules
 * @property {number} [maxConcurrency] - Global max concurrency setting
 * @property {boolean} [debug=false] - Global debug flag
 * @property {boolean} [notify=false] - Global notify flag
 */

/**
 * Adaptive concurrency controller that dynamically adjusts concurrency
 * based on disk I/O performance metrics
 * @class
 */
class AdaptiveConcurrencyController {
	/**
	 * Creates an instance of AdaptiveConcurrencyController
	 * @param {number} [initialConcurrency] - Initial concurrency level (default: CPU cores * 2)
	 */
	constructor(initialConcurrency = cpus().length * 2) {
		/** @type {number} Maximum allowed concurrency */
		this.maxConcurrency = Math.max(1, initialConcurrency);
		/** @type {number} Current concurrency level */
		this.currentConcurrency = Math.max(1, Math.floor(initialConcurrency / 2));
		/** @type {number} Number of currently active tasks */
		this.activeTasks = 0;
		/** @type {Array<{task: Function, resolve: Function, reject: Function}>} Task queue */
		this.queue = [];
		/** @type {number[]} Recent task completion times in milliseconds */
		this.recentTimes = [];
		/** @type {number} Maximum number of recent times to track */
		this.maxTimeHistory = 10;
		/** @type {number} Number of tasks to complete before adjusting concurrency */
		this.adjustmentInterval = 5;
		/** @type {number} Counter for tasks completed since last adjustment */
		this.completedSinceAdjust = 0;
	}

	/**
	 * Executes a task with adaptive concurrency control
	 * @param {Function} task - Async function to execute
	 * @returns {Promise<*>} Result of the task
	 */
	async run(task) {
		return new Promise((resolve, reject) => {
			this.queue.push({ task, resolve, reject });
			this.processQueue();
		});
	}

	/**
	 * Processes queued tasks respecting current concurrency limit
	 * @private
	 */
	async processQueue() {
		while (
			this.queue.length > 0 &&
			this.activeTasks < this.currentConcurrency
		) {
			const { task, resolve, reject } = this.queue.shift();
			this.activeTasks++;

			const startTime = Date.now();

			task()
				.then((result) => {
					const duration = Date.now() - startTime;
					this.recordCompletion(duration);
					resolve(result);
				})
				.catch((err) => {
					this.recordCompletion(Date.now() - startTime);
					reject(err);
				})
				.finally(() => {
					this.activeTasks--;
					this.processQueue();
				});
		}
	}

	/**
	 * Records task completion time and triggers concurrency adjustment if needed
	 * @param {number} duration - Task duration in milliseconds
	 * @private
	 */
	recordCompletion(duration) {
		this.recentTimes.push(duration);
		if (this.recentTimes.length > this.maxTimeHistory) {
			this.recentTimes.shift();
		}

		this.completedSinceAdjust++;
		if (this.completedSinceAdjust >= this.adjustmentInterval) {
			this.adjustConcurrency();
			this.completedSinceAdjust = 0;
		}
	}

	/**
	 * Adjusts concurrency level based on performance metrics
	 * Increases concurrency if recent tasks are faster, decreases if slower
	 * @private
	 */
	adjustConcurrency() {
		if (this.recentTimes.length < 3) return;

		const avgTime =
			this.recentTimes.reduce((a, b) => a + b, 0) / this.recentTimes.length;
		const recentAvg = this.recentTimes.slice(-3).reduce((a, b) => a + b, 0) / 3;

		if (
			recentAvg < avgTime * 0.8 &&
			this.currentConcurrency < this.maxConcurrency
		) {
			this.currentConcurrency = Math.min(
				this.maxConcurrency,
				this.currentConcurrency + 1,
			);
			debug(
				`[Concurrency] Increased to ${
					this.currentConcurrency
				} (avg: ${avgTime.toFixed(0)}ms, recent: ${recentAvg.toFixed(0)}ms)`,
			);
		} else if (recentAvg > avgTime * 1.2 && this.currentConcurrency > 1) {
			this.currentConcurrency = Math.max(1, this.currentConcurrency - 1);
			debug(
				`[Concurrency] Decreased to ${
					this.currentConcurrency
				} (avg: ${avgTime.toFixed(0)}ms, recent: ${recentAvg.toFixed(0)}ms)`,
			);
		}
	}

	/**
	 * Waits for all queued and active tasks to complete
	 * @returns {Promise<void>}
	 */
	async waitAll() {
		while (this.activeTasks > 0 || this.queue.length > 0) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
}

/**
 * Main entry point for the NBT replacer
 * Parses CLI arguments, validates configuration, and processes replacement rules
 * @returns {Promise<void>}
 */
async function main() {
	const arg = process.argv[2];
	if (!arg) {
		console.error(
			'Pass a JSON argument. Example: {"rules":[{"path":"**/*.nbt","from":"OLD","to":"NEW"}] }',
		);
		process.exit(1);
	}

	let cfg;
	try {
		cfg = JSON.parse(arg);
	} catch (e) {
		console.error("Invalid JSON for parameters:", e.message);
		process.exit(1);
	}

	const rules = Array.isArray(cfg.rules) ? cfg.rules : [cfg];

	DEBUG_MODE = cfg.debug === true;

	const maxConcurrency =
		typeof cfg.maxConcurrency === "number" && cfg.maxConcurrency > 0
			? cfg.maxConcurrency
			: cpus().length * 2;

	debug(
		`[Init] Starting with max concurrency: ${maxConcurrency} (${
			cpus().length
		} CPU cores detected)`,
	);
	const controller = new AdaptiveConcurrencyController(maxConcurrency);

	let totalFilesChanged = 0;
	let totalStringsChanged = 0;

	for (let rIndex = 0; rIndex < rules.length; rIndex++) {
		const rule = rules[rIndex] ?? {};
		const globPattern = rule.path;
		const propFilter = rule.property ?? null;
		const from = String(rule.from ?? "");
		const to = String(rule.to ?? "");
		const useRegex = rule.regex === true;
		const notify =
			(rule.notify !== undefined ? rule.notify : cfg.notify) === true;
		let regex = null;

		if (!globPattern || rule.from === undefined || rule.to === undefined) {
			console.error(
				`Rule #${
					rIndex + 1
				}: Required fields: path, from, to. Optional: property, regex, flags`,
			);
			process.exit(1);
		}

		if (useRegex) {
			try {
				const flags = typeof rule.flags === "string" ? rule.flags : "g";
				const normPattern = from.replace(/\u0008/g, "\\b");
				regex = new RegExp(normPattern, flags);
			} catch (e) {
				console.error(
					`Rule #${rIndex + 1} invalid regex pattern or flags:`,
					e.message,
				);
				process.exit(1);
			}
		}

		const files = await fg(globPattern, { dot: true, onlyFiles: true });
		if (files.length === 0) {
			debug(`Rule #${rIndex + 1}: No files matched:`, globPattern);
			continue;
		}

		debug(`Rule #${rIndex + 1}: Processing ${files.length} files...`);

		const fileResults = await Promise.allSettled(
			files.map((filePath) =>
				controller.run(() =>
					processFile(
						filePath,
						rIndex,
						propFilter,
						from,
						to,
						useRegex,
						regex,
						notify,
					),
				),
			),
		);

		await controller.waitAll();

		for (const result of fileResults) {
			if (result.status === "fulfilled") {
				const { filesChanged, stringsChanged } = result.value;
				totalFilesChanged += filesChanged;
				totalStringsChanged += stringsChanged;
			} else {
				console.error(
					`Error processing file:`,
					result.reason?.message || result.reason,
				);
			}
		}
	}

	console.log(
		`Done. Files changed: ${totalFilesChanged}, strings replaced: ${totalStringsChanged}`,
	);
}

/**
 * Processes a single NBT file and performs string replacements
 * @param {string} filePath - Absolute path to the NBT file
 * @param {number} rIndex - Rule index for logging purposes
 * @param {string|null} propFilter - Optional property filter
 * @param {string} from - String or pattern to find
 * @param {string} to - Replacement string
 * @param {boolean} useRegex - Whether to use regex matching
 * @param {RegExp|null} regex - Compiled regex pattern
 * @param {boolean} notify - Whether to log each replacement
 * @returns {Promise<{filesChanged: number, stringsChanged: number}>} Result statistics
 */
async function processFile(
	filePath,
	rIndex,
	propFilter,
	from,
	to,
	useRegex,
	regex,
	notify,
) {
	try {
		const buf = await fs.readFile(filePath);
		const u8 = new Uint8Array(buf);
		const lower = filePath.toLowerCase();
		let nbtFile;
		const attempts = [];

		if (lower.endsWith(".mcstructure.gz")) {
			attempts.push({
				opts: { bedrockHeader: true, compression: "gzip" },
				label: "bedrock+gzip",
			});
		}
		if (lower.endsWith(".mcstructure")) {
			attempts.push({ opts: { bedrockHeader: true }, label: "bedrock" });
			attempts.push({
				opts: { bedrockHeader: true, compression: "zlib" },
				label: "bedrock+zlib",
			});
			attempts.push({
				opts: { bedrockHeader: true, compression: "gzip" },
				label: "bedrock+gzip",
			});
		}

		attempts.push({ opts: undefined, label: "auto" });
		attempts.push({ opts: { littleEndian: true }, label: "littleEndian" });
		attempts.push({ opts: { compression: "gzip" }, label: "gzip" });
		attempts.push({ opts: { compression: "zlib" }, label: "zlib" });

		let lastErr;
		for (const a of attempts) {
			try {
				nbtFile = NbtFile.read(u8, a.opts);
				break;
			} catch (e) {
				lastErr = e;
			}
		}
		if (!nbtFile) throw lastErr ?? new Error("Failed to parse NBT file");

		debug(
			`-- [Rule #${rIndex + 1}] String tags in ${path.relative(
				process.cwd(),
				filePath,
			)} --`,
		);
		const loggedCount = logAllStringTags(nbtFile.root, [], {
			property: propFilter,
			from,
			regex: useRegex ? regex : null,
		});
		if (loggedCount === 0) {
			debug("(none) - retrying alternate parse strategies...");
			const retryStrategies = [
				{ label: "auto", opts: undefined },
				{ label: "bedrockHeader", opts: { bedrockHeader: true } },
				{ label: "littleEndian", opts: { littleEndian: true } },
				{ label: "javaLike", opts: { littleEndian: false } },
			];
			let reparsed = null;
			for (const strat of retryStrategies) {
				try {
					const tmp = NbtFile.read(new Uint8Array(buf), strat.opts);
					const cnt = logAllStringTags(tmp.root, [], {
						property: propFilter,
						from,
						regex: useRegex ? regex : null,
					});
					if (cnt > 0) {
						debug(
							`Re-parse succeeded with strategy: ${strat.label} (found ${cnt} strings)`,
						);
						nbtFile = tmp; // switch to reparsed file for replacement phase
						break;
					}
				} catch (_) {}
			}
		}

		const relativePath = path.relative(process.cwd(), filePath);
		const onReplace = notify
			? (tagPath, oldVal, newVal) => {
					console.log(
						`[Replace] ${relativePath} :: ${tagPath} :: "${oldVal}" -> "${newVal}"`,
					);
			  }
			: null;

		const changed = replaceStringsDeep(
			nbtFile.root,
			propFilter,
			from,
			to,
			null,
			useRegex,
			regex,
			[],
			onReplace,
		);

		if (changed > 0) {
			const out = nbtFile.write();
			await fs.writeFile(filePath, Buffer.from(out));
			return { filesChanged: 1, stringsChanged: changed };
		}
		return { filesChanged: 0, stringsChanged: 0 };
	} catch (err) {
		console.error(`Rule #${rIndex + 1} failed on ${filePath}: ${err.message}`);
		throw err;
	}
}

/**
 * Recursively traverses NBT structure and replaces matching strings
 * Handles Compounds, Lists, and nested structures
 * @param {*} tag - NBT tag to process
 * @param {string|null} property - Optional property filter
 * @param {string} from - String or pattern to find
 * @param {string} to - Replacement string
 * @param {string|null} [currentKey=null] - Current compound key
 * @param {boolean} [useRegex=false] - Whether to use regex matching
 * @param {RegExp|null} [regex=null] - Compiled regex pattern
 * @param {string[]} [pathParts=[]] - Path components for logging
 * @param {Function|null} [onReplace=null] - Callback function for each replacement
 * @returns {number} Number of replacements made
 */
function replaceStringsDeep(
	tag,
	property,
	from,
	to,
	currentKey = null,
	useRegex = false,
	regex = null,
	pathParts = [],
	onReplace = null,
) {
	let changes = 0;
	const id = tag.getId();

	if (id === NbtType.String) {
		return 0;
	}

	if (id === NbtType.Compound) {
		for (const k of tag.keys()) {
			const child = tag.get(k);
			if (!child) continue;
			if (child.getId() === NbtType.String) {
				if (!property || property === k) {
					const oldVal = child.getAsString();
					let newVal = oldVal;
					if (useRegex && regex) {
						newVal = oldVal.replace(regex, to);
						if (newVal !== oldVal) {
							tag.set(k, new NbtString(newVal));
							if (onReplace) {
								const tagPath = [...pathParts, k].join(" > ");
								onReplace(tagPath, oldVal, newVal);
							}
							changes += 1;
							continue;
						}
					} else if (oldVal === from) {
						tag.set(k, new NbtString(to));
						if (onReplace) {
							const tagPath = [...pathParts, k].join(" > ");
							onReplace(tagPath, oldVal, to);
						}
						changes += 1;
						continue;
					}
				}
			}
			changes += replaceStringsDeep(
				child,
				property,
				from,
				to,
				k,
				useRegex,
				regex,
				[...pathParts, k],
				onReplace,
			);
		}
		return changes;
	}

	if (id === NbtType.List) {
		const len = tag.length ?? 0;
		for (let i = 0; i < len; i++) {
			const child = tag.get(i);
			if (!child) continue;
			if (child.getId() === NbtType.String) {
				if (!property) {
					const oldVal = child.getAsString();
					let newVal = oldVal;
					if (useRegex && regex) {
						newVal = oldVal.replace(regex, to);
						if (newVal !== oldVal) {
							tag.set(i, new NbtString(newVal));
							if (onReplace) {
								const tagPath = [...pathParts, `[${i}]`].join(" > ");
								onReplace(tagPath, oldVal, newVal);
							}
							changes += 1;
							continue;
						}
					} else if (oldVal === from) {
						tag.set(i, new NbtString(to));
						if (onReplace) {
							const tagPath = [...pathParts, `[${i}]`].join(" > ");
							onReplace(tagPath, oldVal, to);
						}
						changes += 1;
						continue;
					}
				}
			}
			changes += replaceStringsDeep(
				child,
				property,
				from,
				to,
				null,
				useRegex,
				regex,
				[...pathParts, `[${i}]`],
				onReplace,
			);
		}
		return changes;
	}

	return 0;
}

/**
 * Logs all String tags found in the NBT structure with their hierarchical paths
 * @param {*} tag - NBT tag to inspect
 * @param {string[]} [pathParts=[]] - Current path components
 * @param {Object|null} [matchCtx=null] - Match context for highlighting matches
 * @param {string|null} [matchCtx.property] - Property filter
 * @param {string} [matchCtx.from] - String to find
 * @param {RegExp|null} [matchCtx.regex] - Regex pattern
 * @returns {number} Number of String tags found
 */
function logAllStringTags(tag, pathParts = [], matchCtx = null) {
	let count = 0;
	const id = tag.getId();

	if (id === NbtType.String) {
		const pathStr = pathParts.length ? pathParts.join(" > ") : "(root)";
		const val = tag.getAsString();
		let matchMark = "";
		if (matchCtx) {
			const { property, from, regex } = matchCtx;
			const lastKey = pathParts[pathParts.length - 1];
			const propertyOk = !property || property === lastKey;
			if (propertyOk) {
				if (regex) {
					if (regex.test(val)) matchMark = " [MATCH]";
					regex.lastIndex = 0;
				} else if (val === from) {
					matchMark = " [MATCH]";
				}
			}
		}
		debug(`${pathStr} = "${val}"${matchMark}`);
		return 1;
	}

	if (id === NbtType.Compound) {
		for (const k of tag.keys()) {
			const child = tag.get(k);
			if (!child) continue;
			count += logAllStringTags(child, [...pathParts, k], matchCtx);
		}
		return count;
	}

	if (id === NbtType.List) {
		const len = tag.length ?? 0;
		for (let i = 0; i < len; i++) {
			const child = tag.get(i);
			if (!child) continue;
			count += logAllStringTags(child, [...pathParts, `[${i}]`], matchCtx);
		}
		return count;
	}

	return 0;
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
