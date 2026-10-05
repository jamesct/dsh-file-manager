/**
 * dsh-file-manager — 宿主半：为「允许删除」的文件夹提供回收站
 * （软删进回收站目录 / 从回收站恢复 / 从回收站彻底删除 / 按天自动清理）。
 * 回收站目录名由配置 `trash_dirname` 决定（DEFAULTS 里的 ".dsh-trash" 只是缺省值）。
 *
 * ── 为什么必须有宿主半 ────────────────────────────────────────────────────────
 * DSH 底座**没有任何删除文件的通道**：workspaceFiles remote 只有
 * list/read/readBytes/stat（只读），全仓没有文件级 delete 服务，连 dsh-fs-local 的
 * fs 服务都没有删除原语（只有 readText/readBytes/listDir/stat/lstat/watch/writeText/
 * editText/resolve/withLock）——DSH 本身从不删文件。浏览器触达宿主只有 remote 与
 * HTTP 路由两条路，两条都不提供删除。所以删除按钮必须自带一个宿主执行体，
 * 本文件就是那个执行体。
 *
 * ── 认证 ─────────────────────────────────────────────────────────────────────
 * 由 Connection 的 fetch 围栏提供（Host/Origin fence + 浏览器会话令牌），
 * 与全站其余路由同一道门；本文件不重复实现鉴权。
 *
 * ── ⚠️ 这里不是权限边界 ───────────────────────────────────────────────────────
 * outputs 是 rw bind mount、容器以 root 运行，持链接者本来就能读任意工作区文件。
 * 本文件的职责是**防误删**，不是防越权：
 *   1. 只允许配置里点名的文件夹；
 *   2. 只允许符合该项 recursive 设置的深度（默认 false = 仅直接子项）；
 *   3. 拒绝任何回收站目录自身与回收站元数据文件；
 *   4. 递归删除**绝不跟随符号链接**（lstat + unlink，只递归真实目录）；
 *   5. 客户端传来的路径一律当不可信输入，每条路由重新做 lstat/realpath 校验。
 */
import { chmod, copyFile, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rmdir, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** 回收站元数据文件名（每个回收站目录里一份）。 */
const META_FILE = ".meta.json";
/** 元数据临时文件前缀（原子写用，扫描时跳过）。 */
const META_TMP = ".meta.json.tmp-";
/** 元数据损坏时的留证前缀：改名保留，绝不静默清空后覆盖（那会丢掉全部记录 → 条目变孤儿）。 */
const META_CORRUPT = ".meta.json.corrupt-";
/** 审计日志文件名（放 <DSH_HOME> 下；可用 DSH_FILE_MANAGER_LOG 覆盖，测试就靠它）。 */
const AUDIT_FILE = "file-manager.log";
/** 审计日志轮转阈值：超过就把当前日志改名成 `<file>.1`（只留一代）。 */
const AUDIT_MAX_BYTES = 4 * 1024 * 1024;
/** 路由前缀。 */
const ROUTE = "/api/file-manager";
/** 行上可以显示的东西（`row_show` 的合法取值；数组顺序 = 从右往左的排布顺序）。 */
const ROW_TOKENS = ["download", "trash", "mtime", "size"];
/** 工具栏上可以显示的各项（`toolbar_show` 的合法取值；**必须与客户端 TOOLBAR_TOKENS 一致**）。 */
const TOOLBAR_TOKENS = ["multi", "mkdir", "zip_root", "empty_trash", "download", "delete", "rename", "restore", "purge", "move", "clear"];
/** 配置缺省值。 */
const DEFAULTS = {
	retentionDays: 7,
	cleanupIntervalHours: 6,
	trashDirname: ".dsh-trash",
	autoCleanup: true,
	rowShow: ["download"],
	// 工具栏默认**全显示**（与历史行为一致；藏起来是用户显式配置的结果）。
	toolbarShow: [...TOOLBAR_TOKENS],
	crossWorkspace: true
};
/** 一次元信息查询返回的子项上限（跟上游 workspaceFiles 的 maxEntries 默认值一致：2000）。 */
const META_LIMIT = 2000;
/** 一次复制最多处理多少个条目 / 多深 / 多少字节（与 ZIP 那套口径同源）。 */
const COPY_LIMIT_ENTRIES = 10000;
const COPY_LIMIT_DEPTH = 64;
const COPY_LIMIT_BYTES = 4 * 1024 * 1024 * 1024;

/** 预期内的拒绝：带 HTTP 状态码与中文人话消息。 */
class Denied extends Error {
	/**
	 * @param status - HTTP 状态码。
	 * @param message - 面向用户的中文说明。
	 */
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

/**
 * lstat 版存在性判断：不跟随符号链接。
 * @param path - 目标路径。
 * @returns 存在与否。
 */
async function exists(path) {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * 纯字符串判断 target 是否等于 root 或位于 root 之下；两侧都应已 realpath。
 * @param root - 允许范围的根（realpath）。
 * @param target - 待判断路径（realpath）。
 * @returns 相对路径（等于 root 时为空串）；不在其中则为 undefined。
 */
function insideOrEqual(root, target) {
	const rel = relative(root, target);
	if (rel === "") return "";
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
	return rel;
}

/**
 * 递归删除，**绝不跟随符号链接**：符号链接与非目录一律 unlink，只对真实目录递归。
 * 这是全插件风险最高的操作，故意不复用 fs.rm —— 自己写死语义，杜绝穿透。
 * @param target - 待删除路径。
 */
async function removePath(target) {
	const info = await lstat(target);
	if (!info.isDirectory()) {
		await unlink(target);
		return;
	}
	for (const child of await readdir(target)) await removePath(join(target, child));
	await rmdir(target);
}

/**
 * 生成 `yyyymmddhhmmss` 时间戳。
 * @param date - 时间来源。
 * @returns 14 位时间戳。
 */
function stamp(date) {
	const pad = (value) => String(value).padStart(2, "0");
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * 把名字改成 `<stem>.<yyyymmddhhmmss>[-序号]<ext>`；目录名（无扩展名）同样处理。
 * @param name - 原始名字。
 * @param date - 修改时间。
 * @param index - 冲突序号（0 表示不加）。
 * @returns 新名字。
 */
function stampedName(name, date, index = 0) {
	const suffix = index === 0 ? stamp(date) : `${stamp(date)}-${index}`;
	const ext = extname(name);
	const stem = ext === "" ? name : name.slice(0, -ext.length);
	return `${stem}.${suffix}${ext}`;
}

/**
 * 在目录里找一个不冲突的名字：先用原名，再用「原名+修改时间」，最后再补序号。
 * @param dir - 目标目录。
 * @param name - 期望的名字。
 * @param date - 冲突时使用的修改时间。
 * @returns 可用的名字。
 */
async function uniqueName(dir, name, date) {
	if (!(await exists(join(dir, name)))) return name;
	for (let index = 0; index <= 100; index += 1) {
		const candidate = stampedName(name, date, index);
		if (!(await exists(join(dir, candidate)))) return candidate;
	}
	throw new Denied(409, "回收站里同名条目太多，无法生成唯一名字。");
}

/** 每个回收站目录一条串行链，避免连点造成的读-改-写竞争。 */
const chains = new Map();

/**
 * 串行化对同一 key 的异步操作。
 * @param key - 串行键。
 * @param task - 待执行任务。
 * @returns 任务结果。
 */
function withLock(key, task) {
	const previous = chains.get(key) ?? Promise.resolve();
	const run = previous.then(() => task(), () => task());
	chains.set(
		key,
		run.then(
			() => undefined,
			() => undefined
		)
	);
	return run;
}

/** 元数据修复的播报口：apply() 里接到 ctx.logger（模块级函数拿不到 ctx）。 */
let reportMetaProblem = () => {};

/**
 * 读取回收站元数据。
 *
 * **缺失**返回空对象（新回收站，正常）；但**损坏**（非法 JSON / 形状不对）**不再静默当空** ——
 * 那会让紧随其后的 updateMeta 把整份记录覆盖掉，回收站里的条目全部变成"没有记录覆盖的孤儿"
 * （只能彻底删除、恢复不了）。现在的做法：把坏文件**改名留证**（`.meta.json.corrupt-<时间戳>`），
 * 再按空继续，并播报一条 error 日志。
 * @param trashDir - 回收站目录。
 * @returns 以「原相对路径」为键的记录表。
 */
async function readMeta(trashDir) {
	const file = join(trashDir, META_FILE);
	let text;
	try {
		text = await readFile(file, "utf8");
	} catch {
		return {}; // 缺失：新回收站，正常
	}
	let parsed;
	let broken = false;
	try {
		parsed = JSON.parse(text);
	} catch {
		broken = true;
	}
	if (!broken && (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))) broken = true;
	if (!broken) return parsed;
	const kept = join(trashDir, `${META_CORRUPT}${stamp(new Date())}`);
	try {
		await rename(file, kept);
		reportMetaProblem(`回收站元数据损坏，已留证改名：${file} → ${kept}（接下来的记录从那之后重新开始，旧条目只能"彻底删除"）`);
	} catch (error) {
		reportMetaProblem(`回收站元数据损坏且改名失败（${file}）：${String(error?.message ?? error)}`);
	}
	return {};
}

/**
 * 追加一条审计记录（JSONL，一行一条）。**失败绝不影响主流程**。
 * @param file - 日志文件绝对路径。
 * @param entry - 记录体（action / path / … 由调用方给）。
 */
async function appendAudit(file, entry) {
	try {
		const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
		const info = await stat(file).catch(() => undefined);
		if (info !== undefined && info.size > AUDIT_MAX_BYTES) await rename(file, `${file}.1`).catch(() => undefined);
		await writeFile(file, line, { encoding: "utf8", flag: "a" });
	} catch {
		/* 审计写不进去也不能连累主流程 */
	}
}

/**
 * 原子更新回收站元数据。
 * @param trashDir - 回收站目录。
 * @param mutate - 就地修改函数。
 */
async function updateMeta(trashDir, mutate) {
	await withLock(trashDir, async () => {
		const meta = await readMeta(trashDir);
		mutate(meta);
		const tmp = join(trashDir, `${META_TMP}${process.pid}`);
		await writeFile(tmp, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
		await rename(tmp, join(trashDir, META_FILE));
	});
}

/**
 * 定位 DSH 主目录，用于找配置文件。
 * @returns DSH_HOME 绝对路径。
 */
function dshHome() {
	if (typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME !== "") return process.env.DSH_HOME;
	// <DSH_HOME>/profiles/<name>/node_modules/dsh-file-manager/lib/index.js
	return resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
}

/**
 * 把 disable 列表规整成「相对路径规则」数组（拒绝绝对路径与 ..）。
 * @param raw - 配置里的 disable。
 * @param warnings - 收集提醒。
 * @returns 规整后的规则数组。
 */
function normalizeDisable(raw, warnings) {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) {
		warnings.push("workspace.disable 必须是数组，已忽略。");
		return [];
	}
	const out = [];
	for (const item of raw) {
		if (typeof item !== "string" || item.trim() === "") {
			warnings.push(`跳过一条看不懂的 disable 配置：${JSON.stringify(item)}`);
			continue;
		}
		const cleaned = item.trim().replace(/^\/+/, "").replace(/\/+$/, "");
		if (cleaned === "" || isAbsolute(item.trim()) || cleaned.split("/").includes("..")) {
			warnings.push(`disable 里必须是「相对工作区根的相对路径」（不能是绝对路径或含 ..），已跳过：${item}`);
			continue;
		}
		out.push(cleaned);
	}
	return out;
}

/**
 * 规整 `row_show`（行上显示哪些东西）：未知取值丢掉 + warning，非数组回落默认值。
 * 显式写 `row_show: []` 表示"行上什么都不显示"，那是合法选择，不 warning。
 * @param raw - 配置里的 row_show。
 * @param warnings - 收集提醒。
 * @returns 规整后的开关数组（按 ROW_TOKENS 的固定顺序）。
 */
function normalizeTokens(raw, tokens, fallback, key, warnings) {
	if (raw === undefined) return [...fallback];
	if (!Array.isArray(raw)) {
		warnings.push(`${key} 必须是数组，已按默认值处理。`);
		return [...fallback];
	}
	const wanted = new Set();
	for (const item of raw) {
		const token = typeof item === "string" ? item.trim() : "";
		if (!tokens.includes(token)) {
			warnings.push(`跳过看不懂的 ${key} 取值：${JSON.stringify(item)}（可用：${tokens.join(" / ")}）`);
			continue;
		}
		wanted.add(token);
	}
	return tokens.filter((token) => wanted.has(token));
}

/**
 * 规整 `row_show`：未知取值丢掉 + warning，非数组回落默认值；显式空数组 = 行上什么都不显示（合法）。
 * @param raw - 配置里的 row_show。
 * @param warnings - 收集提醒。
 * @returns 规整后的开关数组（按 ROW_TOKENS 的固定顺序）。
 */
function normalizeRowShow(raw, warnings) {
	return normalizeTokens(raw, ROW_TOKENS, DEFAULTS.rowShow, "row_show", warnings);
}

/**
 * 规整 `toolbar_show`（工具栏显示哪些项）；缺省 = 全显示。
 * @param raw - 配置里的 toolbar_show。
 * @param warnings - 收集提醒。
 * @returns 规整后的开关数组（按 TOOLBAR_TOKENS 的固定顺序）。
 */
function normalizeToolbarShow(raw, warnings) {
	return normalizeTokens(raw, TOOLBAR_TOKENS, DEFAULTS.toolbarShow, "toolbar_show", warnings);
}

/**
 * 把一个候选目录变成根（realpath + 必须是目录）。
 * @param want - 期望路径（绝对）。
 * @param recursive - 该根是否允许管到深层。
 * @param declared - 配置里写的原样（回包给客户端做拼写匹配）。
 * @param extra - 附加字段（例如 title / workspace 标记）。
 * @param warnings - 收集提醒。
 * @returns 根对象；不可用则 undefined。
 */
async function makeRoot(want, recursive, declared, extra, warnings) {
	try {
		const real = await realpath(want);
		const info = await stat(real);
		if (!info.isDirectory()) throw new Error("不是目录");
		return { root: real, recursive: recursive === true, declared, ...extra };
	} catch (error) {
		warnings.push(`跳过不可用的目录 ${want}：${String(error?.message ?? error)}`);
		return undefined;
	}
}

/**
 * 解析配置文件（**所有 path 都是绝对路径**；不再有 base）。
 * @param configPath - 配置文件路径。
 * @param registry - 可选的工作区服务（mode: workspace 时用来取根）。
 * @returns 生效配置、已 realpath 的根列表、以及需要提醒的问题。
 */
async function readConfig(configPath, registry) {
	let text;
	try {
		text = await readFile(configPath, "utf8");
	} catch (error) {
		return { error: `读不到配置文件 ${configPath}：${String(error?.message ?? error)}` };
	}
	let raw;
	try {
		const { parse } = await import("yaml");
		raw = parse(text) ?? {};
	} catch (error) {
		return { error: `解析 ${configPath} 失败：${String(error?.message ?? error)}` };
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: `${configPath} 顶层必须是映射（key: value）。` };

	const warnings = [];
	// 旧键：忽略 + 提醒（决策 D6：不保留兼容）
	if (raw.base !== undefined) warnings.push("base 已移除：所有 path 请写绝对路径（base 已被忽略）。");
	if (raw.allow_delete !== undefined) warnings.push("allow_delete 已改名为 manage（语义不变：允许「管理」的目录清单），该键已被忽略。");

	const rawMode = raw.mode === undefined ? "paths" : String(raw.mode).trim();
	if (rawMode !== "paths" && rawMode !== "workspace") warnings.push(`mode 只支持 paths | workspace，收到 ${JSON.stringify(raw.mode)}，已按 paths 处理。`);
	const mode = rawMode === "workspace" ? "workspace" : "paths";

	const number = (value, fallback) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback);
	const flag = (value, fallback, key) => {
		if (value === undefined) return fallback;
		if (typeof value === "boolean") return value;
		warnings.push(`${key} 必须是 true / false，收到 ${JSON.stringify(value)}，已按 ${fallback} 处理。`);
		return fallback;
	};
	const config = {
		mode,
		retentionDays: number(raw.retention_days, DEFAULTS.retentionDays),
		cleanupIntervalHours: number(raw.cleanup_interval_hours, DEFAULTS.cleanupIntervalHours),
		trashDirname: typeof raw.trash_dirname === "string" && raw.trash_dirname.trim() !== "" ? raw.trash_dirname.trim() : DEFAULTS.trashDirname,
		autoCleanup: flag(raw.auto_cleanup, DEFAULTS.autoCleanup, "auto_cleanup"),
		crossWorkspace: flag(raw.cross_workspace, DEFAULTS.crossWorkspace, "cross_workspace"),
		rowShow: normalizeRowShow(raw.row_show, warnings),
		toolbarShow: normalizeToolbarShow(raw.toolbar_show, warnings),
		disable: [],
		configPath
	};

	const roots = [];
	if (mode === "paths") {
		if (raw.workspace !== undefined) warnings.push("mode: paths 下 workspace 段被忽略（要用工作区模式请把 mode 改成 workspace）。");
		const declared = Array.isArray(raw.manage) ? raw.manage : [];
		if (declared.length === 0) warnings.push("mode: paths 下没有 manage 清单，任何条目都不会出现按钮。");
		for (const item of declared) {
			const entry = typeof item === "string" ? { path: item, recursive: false } : item;
			if (typeof entry !== "object" || entry === null || typeof entry.path !== "string" || entry.path.trim() === "") {
				warnings.push(`跳过一条看不懂的 manage 配置：${JSON.stringify(item)}`);
				continue;
			}
			const want = entry.path.trim();
			if (!isAbsolute(want)) {
				warnings.push(`manage 里的 path 必须是绝对路径，已跳过：${want}`);
				continue;
			}
			const root = await makeRoot(want, entry.recursive, want, {}, warnings);
			if (root !== undefined) roots.push(root);
		}
	} else {
		if (raw.manage !== undefined) warnings.push("mode: workspace 下 manage 清单被忽略（两种模式互斥）。");
		const section = typeof raw.workspace === "object" && raw.workspace !== null && !Array.isArray(raw.workspace) ? raw.workspace : {};
		const scope = section.scope === undefined ? "all" : String(section.scope).trim();
		if (scope !== "all") warnings.push(`workspace.scope 目前只支持 all，收到 ${JSON.stringify(section.scope)}，已按 all 处理。`);
		config.disable = normalizeDisable(section.disable, warnings);
		if (registry === undefined || typeof registry.list !== "function") {
			warnings.push("mode: workspace 但拿不到工作区服务（workspaceRegistry），没有产生任何根。");
		} else {
			let list;
			try {
				list = registry.list() ?? [];
			} catch (error) {
				warnings.push(`读取工作区列表失败：${String(error?.message ?? error)}`);
				list = [];
			}
			for (const item of list) {
				const want = typeof item?.path === "string" ? item.path : undefined;
				if (want === undefined || !isAbsolute(want)) {
					warnings.push(`跳过一条没有绝对 path 的工作区记录：${JSON.stringify(item?.path)}`);
					continue;
				}
				const root = await makeRoot(want, section.recursive, want, { workspace: true, title: item?.title }, warnings);
				if (root !== undefined) roots.push(root);
			}
			if (roots.length === 0) warnings.push("mode: workspace 但一个可用的工作区根都没有。");
		}
	}
	return { config, roots, warnings };
}

/**
 * 建一个「按 mtime 热更新」的配置源：每次请求比一次 mtime，改了立刻生效，不需要重启。
 * @param configPath - 配置文件路径。
 * @param registry - 可选的工作区服务。
 * @returns 取当前生效配置的异步函数。
 */
function createSource(configPath, registry) {
	let cache;
	return async () => {
		let mtimeMs = 0;
		try {
			mtimeMs = (await stat(configPath)).mtimeMs;
		} catch {
			mtimeMs = 0;
		}
		let signature = "";
		try {
			signature = JSON.stringify((registry?.list?.() ?? []).map((item) => item?.path ?? null));
		} catch {
			signature = "unavailable";
		}
		if (cache !== undefined && cache.mtimeMs === mtimeMs && cache.signature === signature) return cache;
		const loaded = await readConfig(configPath, registry);
		cache = { mtimeMs, signature, ...loaded };
		return cache;
	};
}

/**
 * 配置文件里允许出现的键（配置页写回时按白名单严格校验）。
 * 旧键 base / allow_delete 不在表内，会被明确拒绝而不是静默忽略。
 */
const CONFIG_KEYS = [
	"mode",
	"manage",
	"workspace",
	"retention_days",
	"cleanup_interval_hours",
	"trash_dirname",
	"auto_cleanup",
	"row_show",
	"toolbar_show",
	"cross_workspace"
];

/**
 * 把文件里的 snake_case 配置补齐成编辑器用的完整草稿。
 * 与 readConfig 的分工：这里**只做形状归一**，不 resolve 路径、不产生根、不校验存在性
 * （那些留给保存时的 validateDraft），所以「文件读坏了也还能打开配置页」。
 * @param raw - 文件解析结果（可为 undefined）。
 * @returns 编辑器草稿。
 */
function draftOf(raw) {
	const source = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {};
	const mode = source.mode === "workspace" ? "workspace" : "paths";
	const draft = {
		mode,
		retention_days: typeof source.retention_days === "number" ? source.retention_days : DEFAULTS.retentionDays,
		cleanup_interval_hours: typeof source.cleanup_interval_hours === "number" ? source.cleanup_interval_hours : DEFAULTS.cleanupIntervalHours,
		trash_dirname: typeof source.trash_dirname === "string" && source.trash_dirname.trim() !== "" ? source.trash_dirname.trim() : DEFAULTS.trashDirname,
		auto_cleanup: typeof source.auto_cleanup === "boolean" ? source.auto_cleanup : DEFAULTS.autoCleanup,
		cross_workspace: typeof source.cross_workspace === "boolean" ? source.cross_workspace : DEFAULTS.crossWorkspace,
		row_show: Array.isArray(source.row_show)
			? ROW_TOKENS.filter((token) => source.row_show.some((item) => typeof item === "string" && item.trim() === token))
			: [...DEFAULTS.rowShow],
		toolbar_show: Array.isArray(source.toolbar_show)
			? TOOLBAR_TOKENS.filter((token) => source.toolbar_show.some((item) => typeof item === "string" && item.trim() === token))
			: [...DEFAULTS.toolbarShow]
	};
	if (mode === "paths") {
		draft.manage = (Array.isArray(source.manage) ? source.manage : []).flatMap((item) => {
			const entry = typeof item === "string" ? { path: item, recursive: false } : item;
			if (typeof entry !== "object" || entry === null || typeof entry.path !== "string" || entry.path.trim() === "") return [];
			return [{ path: entry.path.trim(), recursive: entry.recursive === true }];
		});
	} else {
		const section = typeof source.workspace === "object" && source.workspace !== null && !Array.isArray(source.workspace) ? source.workspace : {};
		draft.workspace = {
			scope: "all",
			recursive: section.recursive === true,
			disable: (Array.isArray(section.disable) ? section.disable : []).filter((item) => typeof item === "string" && item.trim() !== "").map((item) => item.trim())
		};
	}
	return draft;
}

/**
 * 严格校验一个「token 列表」型字段（配置页提交的草稿）。
 * @param raw - 提交上来的值。
 * @param tokens - 合法取值。
 * @param key - 配置键名（进错误文案）。
 * @returns 归一后的数组（按 tokens 的固定顺序）。
 */
function strictTokens(raw, tokens, key) {
	if (!Array.isArray(raw)) throw new Denied(400, `${key} 必须是数组（可用取值：${tokens.join(" / ")}）。`);
	const wanted = new Set();
	for (const item of raw) {
		const token = typeof item === "string" ? item.trim() : "";
		if (!tokens.includes(token)) throw new Denied(400, `${key} 只支持 ${tokens.join(" / ")}，收到 ${JSON.stringify(item)}。`);
		wanted.add(token);
	}
	return tokens.filter((token) => wanted.has(token));
}

/**
 * 严格校验配置页提交的草稿，并补全缺省值。
 * 与 readConfig「宽进 + warning」相反：这里**一律拒绝需要猜的输入**，错误消息直接给用户看。
 * @param raw - 请求体里的 config 字段。
 * @returns 已补全、可直接落盘的规范配置（snake_case，键序固定）。
 */
async function validateDraft(raw) {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Denied(400, "配置必须是一个映射（key: value）。");
	if (raw.base !== undefined) throw new Denied(400, "base 已移除：请把所有 path 写成绝对路径。");
	if (raw.allow_delete !== undefined) throw new Denied(400, "allow_delete 已改名为 manage，请改用 manage。");
	for (const key of Object.keys(raw)) {
		if (!CONFIG_KEYS.includes(key)) throw new Denied(400, `不认识的配置项 ${key}（可用：${CONFIG_KEYS.join("、")}）。`);
	}
	const mode = raw.mode === "paths" || raw.mode === "workspace" ? raw.mode : undefined;
	if (mode === undefined) throw new Denied(400, "mode 必须是 paths 或 workspace。");

	const out = {
		mode,
		retention_days: DEFAULTS.retentionDays,
		cleanup_interval_hours: DEFAULTS.cleanupIntervalHours,
		trash_dirname: DEFAULTS.trashDirname,
		auto_cleanup: DEFAULTS.autoCleanup,
		cross_workspace: DEFAULTS.crossWorkspace,
		row_show: [...DEFAULTS.rowShow],
		toolbar_show: [...DEFAULTS.toolbarShow]
	};

	if (raw.retention_days !== undefined) {
		const value = raw.retention_days;
		if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 3650) throw new Denied(400, "保留天数必须是 1~3650 的整数。");
		out.retention_days = value;
	}
	if (raw.cleanup_interval_hours !== undefined) {
		const value = raw.cleanup_interval_hours;
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 8760) throw new Denied(400, "清理检查间隔必须是大于 0 且不超过 8760 的小时数。");
		out.cleanup_interval_hours = value;
	}
	if (raw.auto_cleanup !== undefined) {
		if (typeof raw.auto_cleanup !== "boolean") throw new Denied(400, "自动清理开关必须是 true 或 false。");
		out.auto_cleanup = raw.auto_cleanup;
	}
	if (raw.cross_workspace !== undefined) {
		if (typeof raw.cross_workspace !== "boolean") throw new Denied(400, "跨工作区开关必须是 true 或 false。");
		out.cross_workspace = raw.cross_workspace;
	}
	if (raw.trash_dirname !== undefined) {
		const name = typeof raw.trash_dirname === "string" ? raw.trash_dirname.trim() : "";
		if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) {
			throw new Denied(400, "回收站目录名必须是单个目录名（不能为空、不能含路径分隔符）。");
		}
		if (name === META_FILE) throw new Denied(400, `${META_FILE} 是回收站的元数据文件名，不能用作回收站目录名。`);
		out.trash_dirname = name;
	}
	if (raw.row_show !== undefined) out.row_show = strictTokens(raw.row_show, ROW_TOKENS, "row_show");
	if (raw.toolbar_show !== undefined) out.toolbar_show = strictTokens(raw.toolbar_show, TOOLBAR_TOKENS, "toolbar_show");

	if (mode === "paths") {
		if (raw.workspace !== undefined) throw new Denied(400, "mode: paths 下不要写 workspace 段（两种模式互斥）。");
		if (!Array.isArray(raw.manage) || raw.manage.length === 0) throw new Denied(400, "按目录管理时至少要有一个目录。");
		const manage = [];
		const seen = new Set();
		for (const item of raw.manage) {
			if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Denied(400, `manage 每一项必须是 {path, recursive}，收到 ${JSON.stringify(item)}。`);
			for (const key of Object.keys(item)) {
				if (key !== "path" && key !== "recursive") throw new Denied(400, `manage 项里有不认识的键 ${key}。`);
			}
			if (typeof item.path !== "string" || item.path.trim() === "") throw new Denied(400, "manage 每一项都要有非空的 path。");
			const want = item.path.trim();
			if (!isAbsolute(want)) throw new Denied(400, `manage 的 path 必须是绝对路径：${want}`);
			const info = await stat(want).catch(() => undefined);
			if (info === undefined) throw new Denied(400, `目录不存在：${want}`);
			if (!info.isDirectory()) throw new Denied(400, `不是目录：${want}`);
			if (item.recursive !== undefined && typeof item.recursive !== "boolean") throw new Denied(400, "manage 的 recursive 必须是 true 或 false。");
			const real = await realpath(want).catch(() => want);
			if (seen.has(real)) throw new Denied(400, `同一个目录写了两次：${want}`);
			seen.add(real);
			manage.push({ path: want, recursive: item.recursive === true });
		}
		out.manage = manage;
	} else {
		if (raw.manage !== undefined) throw new Denied(400, "mode: workspace 下不要写 manage 段（两种模式互斥）。");
		const section = raw.workspace ?? {};
		if (typeof section !== "object" || section === null || Array.isArray(section)) throw new Denied(400, "workspace 必须是映射（scope / recursive / disable）。");
		for (const key of Object.keys(section)) {
			if (key !== "scope" && key !== "recursive" && key !== "disable") throw new Denied(400, `workspace 里有不认识的键 ${key}。`);
		}
		if (section.scope !== undefined && String(section.scope).trim() !== "all") throw new Denied(400, "workspace.scope 目前只支持 all。");
		if (section.recursive !== undefined && typeof section.recursive !== "boolean") throw new Denied(400, "workspace.recursive 必须是 true 或 false。");
		const workspace = { scope: "all", recursive: section.recursive === true };
		if (section.disable !== undefined) {
			if (!Array.isArray(section.disable)) throw new Denied(400, "workspace.disable 必须是数组。");
			const disable = [];
			for (const item of section.disable) {
				if (typeof item !== "string" || item.trim() === "") throw new Denied(400, `workspace.disable 每一项都必须是非空字符串，收到 ${JSON.stringify(item)}。`);
				const rel = item.trim().replace(/^\.\//, "");
				if (rel === "." || rel === ".." || isAbsolute(rel) || rel.startsWith("../") || rel.includes("/../")) {
					throw new Denied(400, `workspace.disable 只能是工作区内的相对路径：${item}`);
				}
				disable.push(rel);
			}
			workspace.disable = disable;
		}
		out.workspace = workspace;
	}
	return out;
}

/**
 * 把校验过的配置渲染成落盘的 YAML 文本（固定键序 + 顶部注释）。
 * @param config - validateDraft 的返回值。
 * @param when - 写盘时间。
 * @returns YAML 文本。
 */
async function renderConfigYaml(config, when) {
	const { stringify } = await import("yaml");
	const ordered = { mode: config.mode };
	if (config.mode === "paths") ordered.manage = config.manage;
	else ordered.workspace = config.workspace;
	ordered.retention_days = config.retention_days;
	ordered.auto_cleanup = config.auto_cleanup;
	ordered.cross_workspace = config.cross_workspace;
	ordered.row_show = config.row_show;
	ordered.toolbar_show = config.toolbar_show;
	ordered.cleanup_interval_hours = config.cleanup_interval_hours;
	ordered.trash_dirname = config.trash_dirname;
	const pad = (value) => String(value).padStart(2, "0");
	const text = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`;
	const header = [
		"# dsh-file-manager 配置",
		`# 由配置页保存于 ${text}；保存即生效，不需要重启 dsh。`,
		"# 手工编辑同样有效（宿主按文件 mtime 热更新）。",
		""
	].join("\n");
	return `${header}${stringify(ordered, { lineWidth: 0 })}`;
}

/**
 * 保存前留一份带时间戳的备份，只保留最近 5 份。备份失败不阻断保存。
 * @param configPath - 配置文件路径。
 * @returns 备份文件路径（没有原文件时为 undefined）。
 */
async function backupConfig(configPath) {
	const info = await stat(configPath).catch(() => undefined);
	if (info === undefined) return undefined;
	const dir = dirname(configPath);
	const base = basename(configPath);
	const target = join(dir, `${base}.bak-${stamp(new Date())}`);
	try {
		await copyFile(configPath, target);
		const names = (await readdir(dir)).filter((name) => name.startsWith(`${base}.bak-`)).sort();
		for (const name of names.slice(0, Math.max(0, names.length - 5))) await unlink(join(dir, name)).catch(() => undefined);
	} catch {
		return undefined;
	}
	return target;
}

/**
 * 列出一个目录的直接子目录（配置页「浏览…」用）。
 * 只列目录、不读任何文件内容；与本插件其它路由同处 Connection 的信任栅栏之内，
 * 和整个插件一样**不是权限边界**（见 README「安全边界」）。
 * @param target - 绝对路径；空串表示还没选起点。
 * @param suggests - 没给 path 时返回的起点建议。
 * @returns 浏览结果。
 */
async function listDirectories(target, suggests) {
	if (target === undefined || target === "") return { path: "", parent: null, dirs: [], truncated: false, suggests };
	if (!isAbsolute(target)) throw new Denied(400, "path 必须是绝对路径。");
	const info = await stat(target).catch(() => undefined);
	if (info === undefined) throw new Denied(404, `目录不存在：${target}`);
	if (!info.isDirectory()) throw new Denied(400, `不是目录：${target}`);
	let entries;
	try {
		entries = await readdir(target, { withFileTypes: true });
	} catch (error) {
		throw new Denied(403, `读不到目录 ${target}：${String(error?.message ?? error)}`);
	}
	const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => ({ name: entry.name, path: join(target, entry.name) }));
	dirs.sort((left, right) => left.name.localeCompare(right.name, "zh"));
	return {
		path: target,
		parent: dirname(target) === target ? null : dirname(target),
		dirs: dirs.slice(0, 500),
		truncated: dirs.length > 500,
		suggests: []
	};
}

/**
 * 列出一个目录里每个直接子项的大小与修改时间 —— 给文件树的行显示用。
 * 权限口径与行按钮**完全一致**（同一套允许根 + disable 判定），不另造第二套；
 * 只回元信息，不回任何文件内容。
 * @param dir - 目录绝对路径。
 * @param roots - 允许根列表。
 * @param config - 生效配置。
 * @returns `{dir, truncated, entries}`；entries 里 size 只给普通文件。
 */
async function listEntries(dir, roots, config) {
	if (typeof dir !== "string" || dir.trim() === "") throw new Denied(400, "缺少 dir。");
	if (!isAbsolute(dir)) throw new Denied(400, "dir 必须是绝对路径。");
	const target = await realpath(dir.trim()).catch(() => undefined);
	if (target === undefined) throw new Denied(404, `目录不存在：${dir}`);
	const info = await lstat(target).catch(() => undefined);
	if (info === undefined || !info.isDirectory()) throw new Denied(400, `不是目录：${dir}`);
	const hit = longestRoot(roots ?? [], target);
	if (hit === undefined) throw new Denied(403, "这个位置不在允许管理的文件夹里。");
	if (disabledBy(config, hit.entry, target) !== undefined) throw new Denied(403, "这个位置被配置排除（disable）。");
	let dirents;
	try {
		dirents = await readdir(target, { withFileTypes: true });
	} catch (error) {
		throw new Denied(403, `读不到目录 ${dir}：${String(error?.message ?? error)}`);
	}
	const entries = [];
	for (const dirent of dirents.slice(0, META_LIMIT)) {
		const childInfo = await lstat(join(target, dirent.name)).catch(() => undefined);
		if (childInfo === undefined) continue;
		const kind = childInfo.isDirectory() ? "directory" : childInfo.isFile() ? "file" : "other";
		entries.push({
			name: dirent.name,
			type: kind,
			...(kind === "file" ? { size: Number(childInfo.size) || 0 } : {}),
			mtimeMs: Number(childInfo.mtimeMs) || 0
		});
	}
	return { dir: target, truncated: dirents.length > META_LIMIT, entries };
}

/**
 * 在一组根里取「包含 targetReal 且最长」的那个（决策 D7：最长命中 / R1）。
 * @param roots - 已解析的根列表。
 * @param targetReal - 目标路径（realpath）。
 * @returns `{entry, rel}`；未命中则 undefined。
 */
function longestRoot(roots, targetReal) {
	let best;
	for (const entry of roots) {
		const rel = insideOrEqual(entry.root, targetReal);
		if (rel === undefined) continue;
		if (best === undefined || entry.root.length > best.entry.root.length) best = { entry, rel };
	}
	return best;
}

/**
 * 判断「父目录」的归属：是否位于某个根的回收站里、深度是否被允许。
 * 回收站判定优先（回收站内部一律走恢复/彻底删除/移动那条路）。
 * @param roots - 已解析的根列表。
 * @param trashDirname - 回收站目录名。
 * @param parentReal - 目标父目录的 realpath。
 * @returns 命中信息；未命中则 undefined。
 */
function locateParent(roots, trashDirname, parentReal) {
	for (const entry of roots) {
		if (insideOrEqual(join(entry.root, trashDirname), parentReal) !== undefined) return { entry, inTrash: true };
	}
	const hit = longestRoot(roots, parentReal);
	if (hit === undefined) return undefined;
	if (!hit.entry.recursive && hit.rel !== "") return undefined;
	return { entry: hit.entry, inTrash: false };
}

/**
 * 定位「正好位于某个回收站根层」的条目（保留给回滚语义使用；现在没有"只认第一层"的限制了）。
 * @param roots - 已解析的根列表。
 * @param trashDirname - 回收站目录名。
 * @param parentReal - 目标父目录的 realpath。
 * @returns 命中的根；未命中则 undefined。
 */
function locateTrashEntry(roots, trashDirname, parentReal) {
	for (const entry of roots) {
		if (parentReal === join(entry.root, trashDirname)) return entry;
	}
	return undefined;
}

/**
 * 这个路径是不是「实时回收站目录」（= 某个根的 `<root>/<trash_dirname>`）。
 * 回收站里的镜像副本（例如 `<A 的回收站>/B/<trash_dirname>`，其父不是配置里的根）不算。
 * @param roots - 根列表。
 * @param trashDirname - 回收站目录名。
 * @param target - 目标路径（realpath）。
 * @returns 拥有它的根；不是实时回收站则 undefined。
 */
function liveTrashOwner(roots, trashDirname, target) {
	for (const entry of roots) {
		if (target === join(entry.root, trashDirname)) return entry;
	}
	return undefined;
}

/**
 * 该不该保护这个「回收站目录」不让删/改名/移动（决策 D11：按视图）。
 * 只保护「视图所在根」自己的回收站；没有视图时按最保守处理（任何根的实时回收站都保护）。
 * @param roots - 根列表。
 * @param trashDirname - 回收站目录名。
 * @param viewRoot - 视图根的 realpath（可缺省）。
 * @param target - 目标路径（realpath）。
 * @returns 被保护则返回拥有它的根；否则 undefined。
 */
function protectedTrash(roots, trashDirname, viewRoot, target) {
	const owner = liveTrashOwner(roots, trashDirname, target);
	if (owner === undefined) return undefined;
	if (viewRoot === undefined) return owner;
	return viewRoot === owner.root ? owner : undefined;
}

/**
 * 判断「相对某个根的路径」是否被 disable 规则命中（**宿主与客户端必须同语义**，改这里要一起改）。
 *
 * 规则语义（2026-10-04 修订，对齐 .gitignore 的直觉）：
 *   - **含 `/` 的规则** = 锚定在该根上的多级相对路径（`docs/tmp` 只挡这一个位置）；
 *   - **不含 `/` 的规则** = 匹配**任意深度**上的同名路径段（`.git` 挡得住任何一层里的 .git，
 *     以及它下面的全部内容）。
 * 旧语义是「一律锚定在根」，于是裸写的 `.git` 只挡得住 `<根>/.git`，
 * 嵌套子仓库（`<根>/子项目/.git`）照样给按钮、宿主也照样放行 —— 这是修掉的 bug。
 * @param rules - 规整后的 disable 规则数组。
 * @param rel - 相对根的路径（不带前导斜杠；空串表示就是根本身）。
 * @returns 命中的规则；未命中则 undefined。
 */
function disableHit(rules, rel) {
	if (typeof rel !== "string" || rel === "") return undefined;
	const segments = rel.split("/");
	for (const rule of rules ?? []) {
		if (rule.includes("/")) {
			if (rel === rule || rel.startsWith(`${rule}/`)) return rule;
			continue;
		}
		if (segments.includes(rule)) return rule;
	}
	return undefined;
}

/**
 * 该绝对路径是否被配置的 disable 规则排除（规则是相对某个根的相对路径）。
 * @param config - 生效配置。
 * @param entry - 归属的根。
 * @param target - 目标绝对路径。
 * @returns 命中的规则；未命中则 undefined。
 */
function disabledBy(config, entry, target) {
	const rel = insideOrEqual(entry.root, target);
	if (rel === undefined || rel === "") return undefined;
	return disableHit(config.disable, rel);
}

/**
 * 校验请求里带的 `view`（当前文件树所在的工作区/根）：只认配置里的根，或已注册的工作区路径。
 * @param raw - 请求体里的 view。
 * @param roots - 根列表。
 * @param registry - 可选的工作区服务。
 * @returns 视图根的 realpath；不合法则 undefined（按"无视图"处理）。
 */
async function resolveView(raw, roots, registry) {
	if (typeof raw !== "string" || raw.trim() === "" || !isAbsolute(raw)) return undefined;
	const real = await realpath(raw.trim()).catch(() => undefined);
	if (real === undefined) return undefined;
	if ((roots ?? []).some((entry) => entry.root === real)) return real;
	try {
		for (const item of registry?.list?.() ?? []) {
			if (typeof item?.path !== "string") continue;
			const known = await realpath(item.path).catch(() => undefined);
			if (known === real) return real;
		}
	} catch {
		/* 拿不到就按无视图处理 */
	}
	return undefined;
}

/**
 * 读出请求体里的 path（必填）与 view（可选：客户端所在文件树的根，用于"按视图保护回收站"）。
 * @param request - 入站请求。
 * @returns `{path, view}`。
 */
async function readTarget(request) {
	const body = await readBody(request);
	const path = body?.path;
	if (typeof path !== "string" || path === "") throw new Denied(400, "缺少 path。");
	if (!isAbsolute(path)) throw new Denied(400, "path 必须是绝对路径。");
	return { path, view: body?.view };
}

/**
 * 读出请求体（buffered）并要求它是 JSON 对象。
 * @param request - 入站请求。
 * @returns 解析后的对象。
 */
async function readBody(request) {
	try {
		const body = await request.json();
		if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Denied(400, "请求体必须是 JSON 对象。");
		return body;
	} catch (error) {
		if (error instanceof Denied) throw error;
		throw new Denied(400, "请求体不是合法 JSON。");
	}
}

/**
 * 校验「单个路径段」形式的新名字（重命名、新建文件夹共用）。
 * @param raw - 原始名字。
 * @param trashDirname - 回收站目录名（连同 .meta.json 一起作为禁区名）。
 * @returns 去掉首尾空白后的合法名字。
 */
function checkName(raw, trashDirname) {
	if (typeof raw !== "string") throw new Denied(400, "缺少 name。");
	const name = raw.trim();
	if (name === "") throw new Denied(400, "名字不能为空。");
	if (name === "." || name === "..") throw new Denied(400, "这个名字不能用。");
	if (name.includes("/") || name.includes("\0")) throw new Denied(400, "名字里不能带 / 或空字符。");
	if (Buffer.byteLength(name, "utf8") > 255) throw new Denied(400, "名字太长（超过 255 字节）。");
	if (name === trashDirname || name === META_FILE) throw new Denied(403, `${name} 是本插件的控制面，不能占用这个名字。`);
	return name;
}

/**
 * 判断一个 realpath 能否当作「目标目录」：必须在允许根之内、不在任何回收站里；
 * 非递归的根只接受根目录自身（与删除规则的深度约束保持一致）。
 * @param roots - 已解析的根列表。
 * @param trashDirname - 回收站目录名。
 * @param targetReal - 目标目录的 realpath。
 * @returns 命中的根与相对路径；不合法则 undefined。
 */
function locateTarget(roots, trashDirname, targetReal) {
	for (const entry of roots) {
		if (insideOrEqual(join(entry.root, trashDirname), targetReal) !== undefined) return undefined;
	}
	const hit = longestRoot(roots, targetReal);
	if (hit === undefined) return undefined;
	if (!hit.entry.recursive && hit.rel !== "") return undefined;
	return { entry: hit.entry, rel: hit.rel };
}

/**
 * 取一条记录的 stored（兼容旧格式：老 meta 以「原相对路径」为键、stored 是扁平名字）。
 * @param id - 记录在 meta 里的键。
 * @param record - 记录本身。
 * @returns 回收站内的实际相对路径。
 */
function storedOf(id, record) {
	return typeof record?.stored === "string" && record.stored !== "" ? record.stored : id;
}

/**
 * 给回收站里的一个相对路径，找覆盖它的**最深记录**（决策：镜像布局下的任意深度操作）。
 * @param meta - 回收站元数据。
 * @param rel - 目标相对回收站的路径。
 * @returns `{id, record, key, stored, rest}`；没有记录覆盖则 undefined。
 */
function coveringRecord(meta, rel) {
	let best;
	for (const [id, record] of Object.entries(meta)) {
		const stored = storedOf(id, record);
		if (rel !== stored && !rel.startsWith(`${stored}/`)) continue;
		if (best === undefined || stored.length > best.stored.length) {
			best = {
				id,
				record,
				key: typeof record?.key === "string" ? record.key : stored,
				stored,
				rest: rel === stored ? "" : rel.slice(stored.length + 1)
			};
		}
	}
	return best;
}

/**
 * 找出「覆盖在某个回收站路径之下」的全部删除单元（纯容器上的恢复/彻底删除要用）。
 * @param meta - 回收站元数据。
 * @param rel - 目标相对回收站的路径。
 * @returns `[{id, stored, key}]`。
 */
function recordsUnder(meta, rel) {
	const out = [];
	for (const [id, record] of Object.entries(meta)) {
		const stored = storedOf(id, record);
		if (stored === rel || stored.startsWith(`${rel}/`)) out.push({ id, stored, key: typeof record?.key === "string" ? record.key : stored });
	}
	return out;
}

/**
 * 算出一个删除单元在回收站里的落点：优先用原相对路径；已存在时**只给基名**加修改时间后缀
 * （决策：冲突只后缀基名，父级镜像不变）。父目录会按需建好。
 * @param trashDir - 回收站绝对路径。
 * @param key - 原相对路径。
 * @param date - 冲突时用的时间。
 * @returns 回收站内的相对落点。
 */
async function mirrorSlot(trashDir, key, date) {
	const segments = key.split("/").filter((part) => part !== "");
	const head = segments.slice(0, -1);
	const name = segments[segments.length - 1];
	await mkdir(join(trashDir, ...head), { recursive: true });
	for (let index = 0; index <= 100; index += 1) {
		const candidate = index === 0 ? name : stampedName(name, date, index - 1);
		const storedRel = [...head, candidate].join("/");
		if (!(await exists(join(trashDir, storedRel)))) return storedRel;
	}
	throw new Denied(409, "回收站里同名条目太多，无法生成唯一名字。");
}

/**
 * 递归剪掉回收站里的空目录（保留回收站本身与 .meta.json）。
 * @param trashDir - 回收站绝对路径。
 * @param dir - 当前目录。
 */
async function pruneEmpty(trashDir, dir = trashDir) {
	const meta = await readMeta(trashDir);
	// 本身是一个删除单元的目录（例如被删的文件夹）绝不能剪掉，否则记录还在、东西没了。
	const keep = new Set(Object.entries(meta).map(([id, record]) => storedOf(id, record)));
	const walk = async (current) => {
		let names = [];
		try {
			names = await readdir(current);
		} catch {
			return;
		}
		for (const name of names) {
			if (name === META_FILE || name.startsWith(META_TMP)) continue;
			const full = join(current, name);
			const info = await lstat(full).catch(() => undefined);
			if (info === undefined || !info.isDirectory()) continue;
			await walk(full);
			if (keep.has(relative(trashDir, full))) continue;
			const left = await readdir(full).catch(() => []);
			if (left.length === 0) await rmdir(full).catch(() => undefined);
		}
	};
	await walk(dir);
}

/**
 * 保证目标的上级目录存在且是目录；被同名文件占住时给明确的中文原因。
 * @param target - 目标绝对路径。
 * @param verb - 动作名（用于文案）。
 */
async function ensureParentDir(target, verb) {
	const parent = dirname(target);
	const info = await lstat(parent).catch(() => undefined);
	if (info !== undefined && !info.isDirectory()) throw new Denied(409, `上级目录被一个同名文件占着，无法${verb}。`);
	await mkdir(parent, { recursive: true }).catch((error) => {
		throw new Denied(409, `上级目录建不出来（${String(error?.code ?? error)}），无法${verb}。`);
	});
	const after = await lstat(parent).catch(() => undefined);
	if (after === undefined || !after.isDirectory()) throw new Denied(409, `上级目录不是目录（被同名文件占着？），无法${verb}。`);
}

/**
 * 判断一个路径是否落在某个根的回收站里（**任意深度**；回收站自身不算）。
 * @param roots - 根列表。
 * @param trashDirname - 回收站目录名。
 * @param targetReal - 目标路径（realpath 拼出来的逻辑路径）。
 * @returns `{entry, trashDir, meta, rel}`；未命中则 undefined。
 */
async function locateInTrash(roots, trashDirname, targetReal) {
	for (const entry of roots) {
		const trashDir = join(entry.root, trashDirname);
		const rel = insideOrEqual(trashDir, targetReal);
		if (rel === undefined || rel === "") continue;
		return { entry, trashDir, meta: await readMeta(trashDir), rel };
	}
	return undefined;
}

/**
 * 把来源目录的内容**递归合并**进目标目录（决策 M2）：同名项给"来源那一份"加时间戳后缀，
 * 绝不覆盖目标里的任何东西。
 * @param sourceDir - 来源目录（回收站里那一份）。
 * @param targetDir - 目标目录（原位已有的那一份）。
 * @param stamp - 冲突时用的时间。
 * @returns 因重名而改过名的条目数。
 */
async function mergeInto(sourceDir, targetDir, stamp) {
	let renamed = 0;
	let names = [];
	try {
		names = await readdir(sourceDir);
	} catch {
		return renamed;
	}
	for (const name of names) {
		const from = join(sourceDir, name);
		const target = join(targetDir, name);
		const sourceInfo = await lstat(from).catch(() => undefined);
		if (sourceInfo === undefined) continue;
		const destinationInfo = await lstat(target).catch(() => undefined);
		if (destinationInfo === undefined) {
			await rename(from, target);
			continue;
		}
		if (sourceInfo.isDirectory() && destinationInfo.isDirectory()) {
			renamed += await mergeInto(from, target, stamp);
			continue;
		}
		// 文件↔文件 / 文件↔目录 / 目录↔文件：给来源这一份加时间戳后缀再搬进来。
		await rename(from, join(targetDir, await uniqueName(targetDir, name, stamp)));
		renamed += 1;
	}
	return renamed;
}

/**
 * 把一个回收站条目放到目标路径上（恢复与"从回收站移出"共用）：
 *   目标不存在        → 直接搬过去（整棵子树一次搬完）；
 *   两边都是目录      → **递归合并**（M2：文件夹只是容器，要的是里面的文件）；
 *   其它重名组合      → 给搬过去的那一份加时间戳后缀。
 * **绝不覆盖任何现有内容。**
 * @param options.from - 来源绝对路径（在回收站里）。
 * @param options.target - 期望的目标绝对路径。
 * @param options.info - 来源的 lstat 结果（取 mtime 用）。
 * @param options.verb - 动作名（中文，用于错误文案）。
 * @returns `{placed, merged, renamed}`。
 */
async function placeInto({ from, target, info, verb }) {
	const source = await lstat(from).catch(() => undefined);
	if (source === undefined) throw new Denied(409, `回收站里这一项已经不在了，无法${verb}。`);
	const stamp = info?.mtime ?? source.mtime ?? new Date();
	const destination = await lstat(target).catch(() => undefined);
	if (destination === undefined) {
		await ensureParentDir(target, verb);
		await rename(from, target);
		return { placed: target, merged: false, renamed: false };
	}
	if (source.isDirectory() && destination.isDirectory()) {
		const renamed = await mergeInto(from, target, stamp);
		return { placed: target, merged: true, renamed: renamed > 0 };
	}
	await ensureParentDir(target, verb);
	const placed = join(dirname(target), await uniqueName(dirname(target), basename(target), stamp));
	await rename(from, placed);
	return { placed, merged: false, renamed: true };
}

/**
 * 递归复制一棵子树（**不跟随符号链接**：链接按链接重建，绝不复制出树外的内容）。
 * 与删除的 removePath 同一口径；配额按条目数 / 深度 / 总字节三重限制。
 * @param from - 源路径。
 * @param to - 目标路径（调用方保证它还不存在）。
 * @param budget - 累加器 `{count, bytes}`；超限抛 413。
 * @param depth - 当前深度（内部递归用）。
 */
async function copyTree(from, to, budget, depth = 0) {
	if (depth > COPY_LIMIT_DEPTH) throw new Denied(413, `目录层级超过 ${COPY_LIMIT_DEPTH} 层，复制不动。`);
	const info = await lstat(from).catch(() => undefined);
	if (info === undefined) throw new Denied(404, `复制时源已经不在了：${from}`);
	budget.count += 1;
	if (budget.count > COPY_LIMIT_ENTRIES) throw new Denied(413, `条目超过 ${COPY_LIMIT_ENTRIES} 个，复制不动。`);
	if (info.isSymbolicLink()) {
		const target = await readlink(from);
		await symlink(target, to);
		return;
	}
	if (info.isDirectory()) {
		await mkdir(to);
		for (const name of await readdir(from)) await copyTree(join(from, name), join(to, name), budget, depth + 1);
		return;
	}
	if (!info.isFile()) throw new Denied(400, `只支持普通文件与目录，遇到特殊文件：${basename(from)}`);
	budget.bytes += Number(info.size) || 0;
	if (budget.bytes > COPY_LIMIT_BYTES) throw new Denied(413, `总大小超过 ${Math.round(COPY_LIMIT_BYTES / 1024 / 1024 / 1024)} GiB，复制不动。`);
	await copyFile(from, to);
	await utimes(to, info.atime, info.mtime).catch(() => undefined);
}

/**
 * 「跨工作区」开关的落点：`cross_workspace: false` 时，写操作的目标只能落在**当前视图根之内**。
 * 目标的允许根判定（locateTarget）与这条是两回事：前者说"在某个允许根里"，后者说"就在你看的这个工作区里"。
 * @param config - 生效配置。
 * @param viewRoot - 视图根（resolveView 的结果）；未带/非法视图时为 undefined。
 * @param target - 目标绝对路径（realpath）。
 * @returns 拒绝原因；允许则 undefined。
 */
function crossRootDenied(config, viewRoot, target) {
	if (config?.crossWorkspace !== false) return undefined;
	if (viewRoot === undefined) return "跨工作区已关闭，但这次请求没有可识别的当前工作区，已拒绝。";
	if (insideOrEqual(viewRoot, target) === undefined) return "跨工作区已关闭：目标不在当前工作区之内。";
	return undefined;
}

/** cordis 插件名（日志与插件树里的标识）。 */
export const name = "dsh-file-manager";

/**
 * 依赖声明。cordis 只在显式声明后才允许访问服务代理，
 * 少了这一行 apply 会直接以
 * `cannot get property "connection" without inject` 失败、整行不激活。
 */
export const inject = ["connection"];

/**
 * 插件入口。
 * @param ctx - 宿主上下文。
 */
export function apply(ctx) {
	const configPath =
		typeof process.env.DSH_FILE_MANAGER_CONFIG === "string" && process.env.DSH_FILE_MANAGER_CONFIG !== ""
			? process.env.DSH_FILE_MANAGER_CONFIG
			: join(dshHome(), "file-manager.yml");

	/**
	 * 写下一条插件日志；ctx.logger 不可用时静默。
	 * @param level - 日志级别。
	 * @param text - 内容。
	 */
	const log = (level, text) => {
		try {
			ctx.logger?.[level]?.(`[dsh-file-manager] ${text}`);
		} catch {
			/* 日志失败不影响功能 */
		}
	};

	// 审计日志：一行一条 JSONL，落在 <DSH_HOME>/file-manager.log（可用 DSH_FILE_MANAGER_LOG 覆盖）。
	// 目的：那些"永久删除"的动作（彻底删除 / 清空 / 自动清理）事后能查证 —— 曾出现"条目不见了却分不清是谁删的"。
	const auditFile =
		typeof process.env.DSH_FILE_MANAGER_LOG === "string" && process.env.DSH_FILE_MANAGER_LOG !== ""
			? process.env.DSH_FILE_MANAGER_LOG
			: join(dshHome(), AUDIT_FILE);
	const audit = (entry) => void appendAudit(auditFile, entry);
	reportMetaProblem = (text) => log("error", text);

	/**
	 * 取工作区服务（可选）。拿不到就让插件照常激活，只是 mode: workspace 会报一条 warning。
	 * @returns 工作区服务或 undefined。
	 */
	const workspaceRegistry = () => {
		try {
			return ctx.get?.("workspaceRegistry", false) ?? undefined;
		} catch {
			return undefined;
		}
	};

	const registry = workspaceRegistry();
	const current = createSource(configPath, registry);

	/** 统一包一层：把拒绝变成中文 JSON，未预期错误记日志后回 500。 */
	const route = (handler) => async (request) => {
		const headers = { "cache-control": "no-store" };
		try {
			return Response.json({ ok: true, ...(await handler(request)) }, { headers });
		} catch (error) {
			if (error instanceof Denied) return Response.json({ ok: false, error: error.message }, { status: error.status, headers });
			log("error", `未预期错误：${String(error?.stack ?? error)}`);
			return Response.json({ ok: false, error: "操作失败，请查看 dsh 日志。" }, { status: 500, headers });
		}
	};

	// ── 1. 配置：客户端靠它决定哪些行显示按钮 ──────────────────────────────────
	ctx.effect(
		() =>
			ctx.connection.fetch.register({
				path: `${ROUTE}/config`,
				methods: ["GET"],
				requestBody: "buffered",
				fetch: route(async () => {
					const { config, roots, warnings, error } = await current();
					return {
						error,
						warnings: warnings ?? [],
						mode: config?.mode ?? "paths",
						retentionDays: config?.retentionDays ?? DEFAULTS.retentionDays,
						autoCleanup: config?.autoCleanup ?? DEFAULTS.autoCleanup,
						crossWorkspace: config?.crossWorkspace ?? DEFAULTS.crossWorkspace,
						rowShow: config?.rowShow ?? DEFAULTS.rowShow,
						toolbarShow: config?.toolbarShow ?? DEFAULTS.toolbarShow,
						trashDirname: config?.trashDirname ?? DEFAULTS.trashDirname,
						disable: config?.disable ?? [],
						roots: (roots ?? []).map((entry) => ({
							root: entry.root,
							declared: entry.declared,
							recursive: entry.recursive,
							workspace: entry.workspace === true,
							title: entry.title
						}))
					};
				})
			}),
		"dsh-file-manager: config route"
	);

	// ── 1b. 配置编辑（决策 D2：数据面仍在本插件自己的文件里，不走 Loader 配置）──────
	// GET  → 把文件原样读成草稿（含 mtime，保存时当并发栅栏用）
	// POST → 严格校验 → 备份 → 原子替换（tmp + rename），mtime 一变即热更新
	ctx.effect(
		() =>
			ctx.connection.fetch.register({
				path: `${ROUTE}/settings`,
				methods: ["GET", "POST"],
				requestBody: "buffered",
				fetch: route(async (request) => {
					if (request.method !== "POST") {
						const { config, roots, warnings, error } = await current();
						const info = await stat(configPath).catch(() => undefined);
						let draft;
						let parseError;
						if (info !== undefined) {
							try {
								const { parse } = await import("yaml");
								draft = draftOf(parse(await readFile(configPath, "utf8")) ?? {});
							} catch (problem) {
								parseError = `现有配置文件解析失败，请先手工修好再改：${String(problem?.message ?? problem)}`;
							}
						}
						return {
							path: configPath,
							exists: info !== undefined,
							mtimeMs: info?.mtimeMs ?? 0,
							draft: draft ?? draftOf(undefined),
							parseError,
							error,
							warnings: warnings ?? [],
							suggests: [
								...new Set((roots ?? []).map((entry) => entry.declared).filter((item) => typeof item === "string" && item !== ""))
							].slice(0, 8),
							effective: {
								mode: config?.mode ?? "paths",
								retentionDays: config?.retentionDays ?? DEFAULTS.retentionDays,
								autoCleanup: config?.autoCleanup ?? DEFAULTS.autoCleanup,
								trashDirname: config?.trashDirname ?? DEFAULTS.trashDirname,
								roots: (roots ?? []).map((entry) => ({
									root: entry.root,
									recursive: entry.recursive,
									workspace: entry.workspace === true,
									title: entry.title
								}))
							}
						};
					}
					const body = await readBody(request);
					const normalized = await validateDraft(body?.config);
					const expected = typeof body?.mtimeMs === "number" ? body.mtimeMs : undefined;
					const before = await stat(configPath).catch(() => undefined);
					if (expected !== undefined && before !== undefined && Math.abs(before.mtimeMs - expected) > 1) {
						throw new Denied(409, "配置文件已被别处改过，请先刷新页面再保存。");
					}
					const when = new Date();
					const text = await renderConfigYaml(normalized, when);
					const backup = await backupConfig(configPath);
					// 保留原文件的权限位：手写 tmp+rename 会让新文件吃 umask（600 会被悄悄改成 644）。
					const previous = await stat(configPath).catch(() => undefined);
					const mode = previous === undefined ? undefined : previous.mode & 0o777;
					const tmp = `${configPath}.tmp-${stamp(when)}-${Math.random().toString(36).slice(2, 8)}`;
					try {
						await writeFile(tmp, text, mode === undefined ? { encoding: "utf8" } : { encoding: "utf8", mode });
						if (mode !== undefined) await chmod(tmp, mode).catch(() => undefined);
						await rename(tmp, configPath);
					} catch (problem) {
						await unlink(tmp).catch(() => undefined);
						throw new Denied(500, `写入配置失败：${String(problem?.message ?? problem)}`);
					}
					const after = await stat(configPath).catch(() => undefined);
					log("info", `配置已更新：${configPath}（mode=${normalized.mode}，自动清理=${normalized.auto_cleanup ? "开" : "关"}）`);
					audit({ action: "settings", path: configPath, mode: normalized.mode, autoCleanup: normalized.auto_cleanup, rowShow: normalized.row_show, crossWorkspace: normalized.cross_workspace, result: "ok" });
					return { path: configPath, backup, bytes: Buffer.byteLength(text), mtimeMs: after?.mtimeMs ?? 0 };
				})
			}),
		"dsh-file-manager: settings route"
	);

	// ── 1c. 目录浏览：配置页选 path、移动/复制弹窗选落点，共用这一条 ────────────────
	//     **只读、不设限**：只要求"是个真目录"。允许根 / disable / 跨工作区都属于**写入**时的校验
	//     （move / copy / mkdir 各自做），浏览层不再拦 —— 否则「上一层」走到根的父目录就会报错，
	//     而且「跳转工作区」那一行会跟着消失（用户 2026-10-04 反馈）。
	//     回包里的 roots 是"可跳转的允许根"，**任何情况下都返回**（前端据此画那一行，出错也不清空）。
	ctx.effect(
		() =>
			ctx.connection.fetch.register({
				path: `${ROUTE}/browse`,
				methods: ["GET"],
				requestBody: "buffered",
				fetch: route(async (request) => {
					const url = new URL(request.url);
					const { roots } = await current().catch(() => ({}));
					const all = roots ?? [];
					const viewRoot = await resolveView(url.searchParams.get("view"), all, registry);
					const suggests = [...new Set(all.map((entry) => entry.declared).filter((item) => typeof item === "string" && item !== ""))].slice(0, 8);
					const listed = await listDirectories(url.searchParams.get("path") ?? "", suggests);
					return {
						...listed,
						roots: all.map((entry) => ({
							path: entry.root,
							title: typeof entry.title === "string" ? entry.title : undefined,
							current: viewRoot !== undefined && entry.root === viewRoot
						}))
					};
				})
			}),
		"dsh-file-manager: browse route"
	);

	// ── 1d. 行元信息：文件树每行的大小 / 修改时间（权限口径与行按钮一致）───────────
	ctx.effect(
		() =>
			ctx.connection.fetch.register({
				path: `${ROUTE}/info`,
				methods: ["GET"],
				requestBody: "buffered",
				fetch: route(async (request) => {
					const dir = new URL(request.url).searchParams.get("dir") ?? "";
					const { config, roots } = await current();
					if (config === undefined) throw new Denied(409, "配置文件读取失败。");
					return listEntries(dir, roots ?? [], config);
				})
			}),
		"dsh-file-manager: info route"
	);


	// ── 2. 软删：按「原相对路径」镜像进回收站（决策：镜像布局；冲突只后缀基名）──────
	ctx.effect(
		() =>
			ctx.connection.fetch.register({
				path: `${ROUTE}/trash`,
				methods: ["POST"],
				requestBody: "buffered",
				fetch: route(async (request) => {
					const { path, view } = await readTarget(request);
					const info = await lstat(path).catch(() => undefined);
					if (info === undefined) throw new Denied(404, "这个文件或文件夹已经不在了。");

					const parentReal = await realpath(dirname(path)).catch(() => undefined);
					if (parentReal === undefined) throw new Denied(404, "上级目录不在了。");

					const { config, roots } = await current();
					if (config === undefined) throw new Denied(409, "配置文件读取失败，已拒绝删除。");
					const all = roots ?? [];
					const name = basename(path);
					if (name === META_FILE) throw new Denied(403, "这是回收站的元数据文件名，不能删除。");

					const hit = locateParent(all, config.trashDirname, parentReal);
					if (hit === undefined) throw new Denied(403, "这个位置不在允许管理的文件夹里。");
					if (hit.inTrash) throw new Denied(400, "它已经在回收站里了，请用「恢复」「移动到…」或「彻底删除」。");

					const targetReal = join(parentReal, name);
					if (insideOrEqual(hit.entry.root, targetReal) === undefined) throw new Denied(403, "目标不在允许管理的文件夹里。");
					// 回收站保护（决策 D11）：只保护「视图所在根」自己的实时回收站；镜像副本可以删。
					const viewRoot = await resolveView(view, all, registry);
					if (protectedTrash(all, config.trashDirname, viewRoot, targetReal) !== undefined) throw new Denied(403, "回收站自身不能删除。");
					if (disabledBy(config, hit.entry, targetReal) !== undefined) throw new Denied(403, "这个位置被配置排除（disable），不能删除。");

					// 目标是「某个根的实时回收站」时（只可能是外层视图在删内层工作区的回收站），
					// 落点必须算在外层视图自己的回收站里，否则会把它搬进它自己（EINVAL）。
					const liveOwner = liveTrashOwner(all, config.trashDirname, targetReal);
					if (liveOwner !== undefined && (viewRoot === undefined || insideOrEqual(viewRoot, targetReal) === undefined)) {
						throw new Denied(403, "只有视图之内的工作区回收站才能被删除。");
					}
					// 删的是「某个根的实时回收站」时，落点必须是**外层视图根**的回收站；
					// 算不出来（视图是一个已注册但不在 manage 里的目录）就拒绝 ——
					// 旧代码 `?? hit.entry` 会回退成目标自己，于是把它 rename 到自己里面（EINVAL 500）。
					const viewEntry = viewRoot === undefined ? undefined : all.find((candidate) => candidate.root === viewRoot);
					if (liveOwner !== undefined && viewEntry === undefined) {
						throw new Denied(409, "当前视图所在的目录不是一个允许管理的根，找不到可用的落点，已拒绝（避免把回收站搬进它自己）。");
					}
					// 普通删除（liveOwner 未定义）落点就是它**自己的**根；只有"删回收站本身"才换到视图根。
					const storeEntry = liveOwner === undefined ? hit.entry : viewEntry;
					const trashDir = join(storeEntry.root, config.trashDirname);
					await mkdir(trashDir, { recursive: true });
					const trashInfo = await lstat(trashDir).catch(() => undefined);
					if (trashInfo === undefined || !trashInfo.isDirectory()) throw new Denied(409, `回收站路径 ${trashDir} 不是目录，已拒绝删除。`);

					const key = relative(storeEntry.root, targetReal);
					if (key === "" || key.startsWith("..") || isAbsolute(key)) throw new Denied(403, "无法算出原相对路径，已拒绝删除。");
					const deletedAt = new Date();
					const storedRel = await mirrorSlot(trashDir, key, info.mtime ?? deletedAt);
					await rename(path, join(trashDir, storedRel));
					await updateMeta(trashDir, (meta) => {
						meta[storedRel] = {
							key,
							stored: storedRel,
							type: info.isDirectory() ? "directory" : "file",
							deletedAt: deletedAt.toISOString(),
							size: info.isDirectory() ? undefined : Number(info.size) || 0
						};
					});
					log("info", `移入回收站：${targetReal} -> ${join(trashDir, storedRel)}`);
					audit({ action: "trash", path: targetReal, stored: storedRel, originalRelPath: key, trashDir, view, result: "ok" });
					return { stored: storedRel, originalRelPath: key, trashDir };
				})
			}),
		"dsh-file-manager: trash route"
	);

	// ── 3. 恢复：回收站里**任意深度**都能恢复（决策：镜像布局 + 逐项可操作）────────────
	ctx.effect(
		() =>
			ctx.connection.fetch.register({
				path: `${ROUTE}/restore`,
				methods: ["POST"],
				requestBody: "buffered",
				fetch: route(async (request) => {
					const { path } = await readTarget(request);
					const info = await lstat(path).catch(() => undefined);
					if (info === undefined) throw new Denied(404, "这个条目已经不在了。");

					const parentReal = await realpath(dirname(path)).catch(() => undefined);
					if (parentReal === undefined) throw new Denied(404, "回收站目录不在了。");
					const name = basename(path);
					if (name === META_FILE) throw new Denied(403, "这是回收站的元数据文件。");

					const { config, roots } = await current();
					if (config === undefined) throw new Denied(409, "配置文件读取失败，已拒绝恢复。");
					const targetReal = join(parentReal, name);
					const place = await locateInTrash(roots ?? [], config.trashDirname, targetReal);
					if (place === undefined) throw new Denied(403, "只有回收站里的条目才能恢复。");

					const { entry, trashDir, meta, rel } = place;
					const hit = coveringRecord(meta, rel);
					if (hit === undefined) {
						// 纯容器（决策 L3）：把它覆盖的每个删除单元各自搬回原位。
						const under = recordsUnder(meta, rel);
						if (under.length === 0) {
							throw new Denied(409, "回收站里没有这条记录，无法恢复（它可能是手工放进去的，只能彻底删除）。");
						}
						const restored = [];
						for (const unit of under) {
							const from = join(trashDir, unit.stored);
							const infoOfUnit = await lstat(from).catch(() => undefined);
							if (infoOfUnit === undefined) {
								await updateMeta(trashDir, (store) => {
									delete store[unit.id];
								});
								continue;
							}
							let unitTarget = join(entry.root, unit.key);
							if (insideOrEqual(entry.root, unitTarget) === undefined || insideOrEqual(trashDir, unitTarget) !== undefined) {
								throw new Denied(409, `记录里的原路径不合法，已拒绝恢复：${unit.key}`);
							}
							const placedUnit = await placeInto({ from, target: unitTarget, info: infoOfUnit, verb: "恢复" });
							await updateMeta(trashDir, (store) => {
								delete store[unit.id];
							});
							restored.push(placedUnit.placed);
						}
						await pruneEmpty(trashDir);
						log("info", `已恢复容器（${restored.length} 项）：${path}`);
						audit({ action: "restore", path, restoredTo: restored, container: true, restored: restored.length, result: "ok" });
						return { restoredTo: restored, restored, container: true };
					}
					const originalRel = hit.rest === "" ? hit.key : `${hit.key}/${hit.rest}`;
					let target = join(entry.root, originalRel);
					if (insideOrEqual(entry.root, target) === undefined || insideOrEqual(trashDir, target) !== undefined) {
						throw new Denied(409, "记录里的原路径不合法，已拒绝恢复。");
					}

					if (hit.rest === "" && disabledBy(config, entry, target) !== undefined) {
						throw new Denied(403, "原位置被配置排除（disable），不能恢复到那里。");
					}
					const placed = await placeInto({ from: path, target, info, verb: "恢复" });
					if (hit.rest === "") {
						await updateMeta(trashDir, (store) => {
							delete store[hit.id];
						});
					}
					await pruneEmpty(trashDir);
					log("info", placed.merged ? `已合并恢复：${path} -> ${placed.placed}` : `已恢复：${path} -> ${placed.placed}`);
					audit({ action: "restore", path, restoredTo: placed.placed, originalRelPath: originalRel, merged: placed.merged, result: "ok" });
					return { restoredTo: placed.placed, originalRelPath: originalRel, merged: placed.merged };
				})
			}),
		"dsh-file-manager: restore route"
	);

	// ── 4. 彻底删除：回收站里任意深度都能删；纯容器 = 删掉它覆盖的全部删除单元 ─────────
	ctx.effect(
		() =>
			ctx.connection.fetch.register({
				path: `${ROUTE}/purge`,
				methods: ["POST"],
				requestBody: "buffered",
				fetch: route(async (request) => {
					const { path } = await readTarget(request);
					const info = await lstat(path).catch(() => undefined);
					if (info === undefined) throw new Denied(404, "这个条目已经不在了。");

					const parentReal = await realpath(dirname(path)).catch(() => undefined);
					if (parentReal === undefined) throw new Denied(404, "回收站目录不在了。");
					const name = basename(path);
					if (name === META_FILE) throw new Denied(403, "这是回收站的元数据文件。");

					const { config, roots } = await current();
					if (config === undefined) throw new Denied(409, "配置文件读取失败，已拒绝删除。");
					const targetReal = join(parentReal, name);
					const place = await locateInTrash(roots ?? [], config.trashDirname, targetReal);
					if (place === undefined) throw new Denied(403, "只有回收站里的条目才能彻底删除。");

					const { trashDir, meta, rel } = place;
					const hit = coveringRecord(meta, rel);
					if (hit === undefined) {
						// 纯容器（或没有任何记录覆盖的目录）：把它覆盖的删除单元一起删掉，再剪枝。
						const under = recordsUnder(meta, rel);
						for (const unit of under) {
							await removePath(join(trashDir, unit.stored)).catch(() => undefined);
							await updateMeta(trashDir, (store) => {
								delete store[unit.id];
							});
						}
						if (await exists(path)) await removePath(path).catch(() => undefined);
						await pruneEmpty(trashDir);
						log("info", `已彻底删除（容器，覆盖 ${under.length} 个条目）：${path}`);
						audit({ action: "purge", path, units: under.length, container: true, result: "ok" });
						return { purged: path, units: under.length };
					}

					await removePath(path);
					if (hit.rest === "") {
						await updateMeta(trashDir, (store) => {
							delete store[hit.id];
						});
					}
					await pruneEmpty(trashDir);
					log("info", `已彻底删除：${path}`);
					audit({ action: "purge", path, units: hit.rest === "" ? 1 : 0, container: false, result: "ok" });
					return { purged: path, units: hit.rest === "" ? 1 : 0 };
				})
			}),
		"dsh-file-manager: purge route"
	);

	// ── 5. 移动：允许根之间搬；回收站里任意深度的条目也能移出（= 恢复到指定位置）────────
	ctx.effect(
		() =>
			ctx.connection.fetch.register({
				path: `${ROUTE}/move`,
				methods: ["POST"],
				requestBody: "buffered",
				fetch: route(async (request) => {
					const body = await readBody(request);
					const path = typeof body.path === "string" && body.path !== "" && isAbsolute(body.path) ? body.path : undefined;
					const targetDir = typeof body.targetDir === "string" && body.targetDir !== "" && isAbsolute(body.targetDir) ? body.targetDir : undefined;
					if (path === undefined) throw new Denied(400, "缺少 path（必须是绝对路径）。");
					if (targetDir === undefined) throw new Denied(400, "缺少 targetDir（必须是绝对路径）。");

					const info = await lstat(path).catch(() => undefined);
					if (info === undefined) throw new Denied(404, "这个条目已经不在了。");
					const parentReal = await realpath(dirname(path)).catch(() => undefined);
					if (parentReal === undefined) throw new Denied(404, "上级目录不在了。");
					const name = basename(path);
					if (name === META_FILE) throw new Denied(403, "这是回收站的元数据文件，不能移动。");

					const { config, roots } = await current();
					if (config === undefined) throw new Denied(409, "配置文件读取失败，已拒绝移动。");
					const all = roots ?? [];
					const viewRoot = await resolveView(body.view, all, registry);

					// 目标：必须存在、是真目录、在允许根内、不在回收站里、且没被 disable。
					const targetReal = await realpath(targetDir).catch(() => undefined);
					if (targetReal === undefined) throw new Denied(404, "目标目录不在了。");
					const targetInfo = await lstat(targetReal).catch(() => undefined);
					if (targetInfo === undefined || !targetInfo.isDirectory()) throw new Denied(400, "目标不是一个目录。");
					const targetHit = locateTarget(all, config.trashDirname, targetReal);
					if (targetHit === undefined) throw new Denied(403, "只能移动到允许管理的文件夹里（回收站除外）。");
					if (disabledBy(config, targetHit.entry, join(targetReal, name)) !== undefined) {
						throw new Denied(403, "目标位置被配置排除（disable），不能移动到那里。");
					}
					const crossed = crossRootDenied(config, viewRoot, targetReal);
					if (crossed !== undefined) throw new Denied(403, crossed);

					const sourceReal = join(parentReal, name);
					if (targetReal === parentReal) throw new Denied(400, "它已经在这个目录里了。");
					if (insideOrEqual(sourceReal, targetReal) !== undefined) throw new Denied(400, "不能移动到它自己或它自己的子目录里。");

					// 源 A：回收站里（任意深度）→ 移出 = 恢复到指定位置
					const place = await locateInTrash(all, config.trashDirname, sourceReal);
					if (place !== undefined) {
						const { trashDir, meta, rel } = place;
						const hit = coveringRecord(meta, rel);
						if (hit === undefined) throw new Denied(409, "回收站里没有这条记录，无法移动（只能彻底删除）。");
						const placed = await placeInto({ from: path, target: join(targetReal, name), info, verb: "移动" });
						if (hit.rest === "") {
							await updateMeta(trashDir, (store) => {
								delete store[hit.id];
							});
						}
						await pruneEmpty(trashDir);
						log("info", placed.merged ? `从回收站合并移出：${path} -> ${placed.placed}` : `从回收站移出：${path} -> ${placed.placed}`);
						audit({ action: "move", path, targetDir: targetReal, stored: basename(placed.placed), fromTrash: true, merged: placed.merged, view: body.view, result: "ok" });
						return { stored: basename(placed.placed), targetDir: targetReal, fromTrash: true, merged: placed.merged };
					}

					// 源 B：允许根里的条目
					const home = locateParent(all, config.trashDirname, parentReal);
					if (home === undefined) throw new Denied(403, "这个位置不在允许管理的文件夹里。");
					if (home.inTrash) throw new Denied(403, "回收站里的条目请用「恢复」或「彻底删除」。");
					if (disabledBy(config, home.entry, sourceReal) !== undefined) throw new Denied(403, "这个位置被配置排除（disable），不能移动。");
					if (protectedTrash(all, config.trashDirname, viewRoot, sourceReal) !== undefined) throw new Denied(403, "回收站自身不能移动。");

					const stored = await uniqueName(targetReal, name, info.mtime ?? new Date());
					await rename(path, join(targetReal, stored));
					log("info", `移动：${sourceReal} -> ${join(targetReal, stored)}`);
					audit({ action: "move", path: sourceReal, targetDir: targetReal, stored, fromTrash: false, view: body.view, result: "ok" });
					return { stored, targetDir: targetReal, fromTrash: false };
				})
			}),
		"dsh-file-manager: move route"
	);

	// ── 6. 重命名：只改允许根里的条目；回收站里一律不改（记录会失效）──────────────────
	ctx.effect(
		() =>
			ctx.connection.fetch.register({
				path: `${ROUTE}/rename`,
				methods: ["POST"],
				requestBody: "buffered",
				fetch: route(async (request) => {
					const body = await readBody(request);
					const path = typeof body.path === "string" && body.path !== "" && isAbsolute(body.path) ? body.path : undefined;
					if (path === undefined) throw new Denied(400, "缺少 path（必须是绝对路径）。");

					const info = await lstat(path).catch(() => undefined);
					if (info === undefined) throw new Denied(404, "这个条目已经不在了。");
					const parentReal = await realpath(dirname(path)).catch(() => undefined);
					if (parentReal === undefined) throw new Denied(404, "上级目录不在了。");

					const { config, roots } = await current();
					if (config === undefined) throw new Denied(409, "配置文件读取失败，已拒绝改名。");
					const all = roots ?? [];
					const name = basename(path);
					if (name === META_FILE) throw new Denied(403, "这是回收站的元数据文件，不能改名。");

					const sourceReal = join(parentReal, name);
					const place = await locateInTrash(all, config.trashDirname, sourceReal);
					if (place !== undefined) throw new Denied(403, "回收站里的条目不支持改名（先恢复出来再改）。");
					const viewRoot = await resolveView(body.view, all, registry);
					if (protectedTrash(all, config.trashDirname, viewRoot, sourceReal) !== undefined) throw new Denied(403, "回收站自身不能改名。");

					const home = locateParent(all, config.trashDirname, parentReal);
					if (home === undefined || home.inTrash) throw new Denied(403, "这个位置不在允许改名的文件夹里。");
					if (disabledBy(config, home.entry, sourceReal) !== undefined) throw new Denied(403, "这个位置被配置排除（disable），不能改名。");

					const next = checkName(body.name, config.trashDirname);
					if (next === name) return { renamed: path, name };
					const target = join(parentReal, next);
					if (disabledBy(config, home.entry, target) !== undefined) throw new Denied(403, "新位置被配置排除（disable）。");
					if (await exists(target)) throw new Denied(409, "已存在同名条目，改名没有执行。");
					await rename(path, target);
					log("info", `重命名：${path} -> ${target}`);
					return { renamed: target, name: next };
				})
			}),
		"dsh-file-manager: rename route"
	);

	// ── 7. 新建文件夹：在允许范围内建目录（同名报错）──────────────────────────────
	ctx.effect(
		() =>
			ctx.connection.fetch.register({
				path: `${ROUTE}/mkdir`,
				methods: ["POST"],
				requestBody: "buffered",
				fetch: route(async (request) => {
					const body = await readBody(request);
					const parent = typeof body.parent === "string" && body.parent !== "" && isAbsolute(body.parent) ? body.parent : undefined;
					if (parent === undefined) throw new Denied(400, "缺少 parent（必须是绝对路径）。");

					const parentReal = await realpath(parent).catch(() => undefined);
					if (parentReal === undefined) throw new Denied(404, "上级目录不在了。");
					const parentInfo = await lstat(parentReal).catch(() => undefined);
					if (parentInfo === undefined || !parentInfo.isDirectory()) throw new Denied(400, "上级不是一个目录。");

					const { config, roots } = await current();
					if (config === undefined) throw new Denied(409, "配置文件读取失败，已拒绝新建。");
					const all = roots ?? [];
					const hit = locateTarget(all, config.trashDirname, parentReal);
					if (hit === undefined) throw new Denied(403, "只能在允许管理的文件夹里新建目录（回收站除外）。");
					const crossed = crossRootDenied(config, await resolveView(body.view, all, registry), parentReal);
					if (crossed !== undefined) throw new Denied(403, crossed);
					const name = checkName(body.name, config.trashDirname);
					const target = join(parentReal, name);
					if (disabledBy(config, hit.entry, target) !== undefined) throw new Denied(403, "这个位置被配置排除（disable），不能新建。");
					if (await exists(target)) throw new Denied(409, "已存在同名条目，换个名字。");
					await mkdir(target);
					log("info", `新建文件夹：${target}`);
					audit({ action: "mkdir", parent: parentReal, name, created: target, view: body.view, result: "ok" });
					return { created: target, name };
				})
			}),
		"dsh-file-manager: mkdir route"
	);

	// ── 7b. 复制到…：与移动同一套源/目标校验；源永远在允许根里（回收站条目不给复制）────
	//     重名语义与**普通移动**完全一致：给复制过去的那一份加时间戳后缀，绝不覆盖、不合并。
	ctx.effect(
		() =>
			ctx.connection.fetch.register({
				path: `${ROUTE}/copy`,
				methods: ["POST"],
				requestBody: "buffered",
				fetch: route(async (request) => {
					const body = await readBody(request);
					const path = typeof body.path === "string" && body.path !== "" && isAbsolute(body.path) ? body.path : undefined;
					const targetDir = typeof body.targetDir === "string" && body.targetDir !== "" && isAbsolute(body.targetDir) ? body.targetDir : undefined;
					if (path === undefined) throw new Denied(400, "缺少 path（必须是绝对路径）。");
					if (targetDir === undefined) throw new Denied(400, "缺少 targetDir（必须是绝对路径）。");

					const info = await lstat(path).catch(() => undefined);
					if (info === undefined) throw new Denied(404, "这个条目已经不在了。");
					const parentReal = await realpath(dirname(path)).catch(() => undefined);
					if (parentReal === undefined) throw new Denied(404, "上级目录不在了。");
					const name = basename(path);
					if (name === META_FILE) throw new Denied(403, "这是回收站的元数据文件，不能复制。");

					const { config, roots } = await current();
					if (config === undefined) throw new Denied(409, "配置文件读取失败，已拒绝复制。");
					const all = roots ?? [];

					const targetReal = await realpath(targetDir).catch(() => undefined);
					if (targetReal === undefined) throw new Denied(404, "目标目录不在了。");
					const targetInfo = await lstat(targetReal).catch(() => undefined);
					if (targetInfo === undefined || !targetInfo.isDirectory()) throw new Denied(400, "目标不是一个目录。");
					const targetHit = locateTarget(all, config.trashDirname, targetReal);
					if (targetHit === undefined) throw new Denied(403, "只能复制到允许管理的文件夹里（回收站除外）。");
					if (disabledBy(config, targetHit.entry, join(targetReal, name)) !== undefined) {
						throw new Denied(403, "目标位置被配置排除（disable），不能复制到那里。");
					}

					const sourceReal = join(parentReal, name);
					// 复制**允许**回到同一个目录（那就是"原地另存一份"，重名会自动加后缀）；
					// 但目录不能复制进它自己或它的子目录（会无限递归）。
					if (info.isDirectory() && insideOrEqual(sourceReal, targetReal) !== undefined) {
						throw new Denied(400, "不能复制到它自己或它自己的子目录里。");
					}

					const home = locateParent(all, config.trashDirname, parentReal);
					if (home === undefined) throw new Denied(403, "这个位置不在允许管理的文件夹里。");
					if (home.inTrash) throw new Denied(403, "回收站里的条目不支持复制（可以先恢复出来）。");
					if (disabledBy(config, home.entry, sourceReal) !== undefined) throw new Denied(403, "这个位置被配置排除（disable），不能复制。");
					const viewRoot = await resolveView(body.view, all, registry);
					if (protectedTrash(all, config.trashDirname, viewRoot, sourceReal) !== undefined) throw new Denied(403, "回收站自身不能复制。");
					const crossed = crossRootDenied(config, viewRoot, targetReal);
					if (crossed !== undefined) throw new Denied(403, crossed);

					const stored = await uniqueName(targetReal, name, info.mtime ?? new Date());
					const budget = { count: 0, bytes: 0 };
					try {
						await copyTree(sourceReal, join(targetReal, stored), budget);
					} catch (error) {
						// 复制是纯新增：不回滚已复制的部分，但如实报"已经复制了多少"。
						const reason = String(error?.message ?? error);
						throw new Denied(error instanceof Denied ? error.status : 500, `已复制 ${budget.count} 项后失败：${reason}`);
					}
					log("info", `复制：${sourceReal} -> ${join(targetReal, stored)}（${budget.count} 项）`);
					audit({ action: "copy", path: sourceReal, targetDir: targetReal, stored, entries: budget.count, bytes: budget.bytes, view: body.view, result: "ok" });
					return { stored, targetDir: targetReal, entries: budget.count, bytes: budget.bytes };
				})
			}),
		"dsh-file-manager: copy route"
	);

	// ── 8. 清空回收站：把允许根里的回收站真删（不可恢复），顺带清空元数据 ─────────────
	//    带 view 时只清「视图根 + 视图内的嵌套根」；带 root 时只清那一个根；都没有才清全部。
	ctx.effect(
		() =>
			ctx.connection.fetch.register({
				path: `${ROUTE}/empty-trash`,
				methods: ["POST"],
				requestBody: "buffered",
				fetch: route(async (request) => {
					const body = await readBody(request);
					const { config, roots } = await current();
					if (config === undefined) throw new Denied(409, "配置文件读取失败，已拒绝清空。");
					const all = roots ?? [];
					const viewRoot = await resolveView(body.view, all, registry);
					const wanted = typeof body.root === "string" && body.root !== "" ? body.root : undefined;
					const chosen = all.filter((entry) => {
						if (wanted !== undefined) return wanted === entry.root || wanted === join(entry.root, config.trashDirname);
						if (viewRoot !== undefined) return entry.root === viewRoot || insideOrEqual(viewRoot, entry.root) !== undefined;
						return true;
					});
					if (chosen.length === 0) throw new Denied(403, "没有匹配到允许管理的回收站。");

					let removed = 0;
					const cleared = [];
					// dryRun：只数不删（确认框拿它显示"将要删除多少"，跟真删同一套口径）。
					const dryRun = body.dryRun === true;
					for (const entry of chosen) {
						const trashDir = join(entry.root, config.trashDirname);
						const trashInfo = await lstat(trashDir).catch(() => undefined);
						if (trashInfo === undefined) continue;
						// 与删除时同样的保护：回收站被换成符号链接就宁可不做。
						if (!trashInfo.isDirectory()) throw new Denied(409, `回收站路径 ${trashDir} 不是目录，已拒绝清空。`);
						// 数"删除单元"：meta 记录 + 没被任何记录覆盖的孤儿；**不含 .meta.json，也不含目录本身**
						// （用户 2026-10-04：确认框的数跟实际删的数对不上，就是因为那边把 .meta.json 也数进去了）。
						const meta = await readMeta(trashDir);
						const covered = new Set();
						for (const [id, record] of Object.entries(meta)) {
							const parts = storedOf(id, record).split("/");
							for (let index = 1; index <= parts.length; index += 1) covered.add(parts.slice(0, index).join("/"));
						}
						let names = [];
						try {
							names = await readdir(trashDir);
						} catch {
							names = [];
						}
						const orphans = names.filter((name) => name !== META_FILE && !name.startsWith(META_TMP) && !covered.has(name));
						const count = Object.keys(meta).length + orphans.length;
						if (!dryRun) {
							// **整个回收站目录一次删掉（含 .meta.json）**：用户 2026-10-04 定"清空就该把它也删了"。
							// 下次删除会 mkdir 重建（trash 路由里有）；自动清理遇到不存在的目录也直接跳过。
							await removePath(trashDir).catch(() => undefined);
							log("info", `清空回收站：${trashDir}（${count} 项，目录连元数据一并删除）`);
						}
						removed += count;
						cleared.push({ trashDir, removed: count });
					}
					if (!dryRun && removed > 0) audit({ action: "empty-trash", removed, trashDirs: cleared.map((one) => one.trashDir), scope: wanted !== undefined ? "root" : viewRoot !== undefined ? "view" : "all", view: body.view, result: "ok" });
					return { removed, cleared, dryRun, scope: wanted !== undefined ? "root" : viewRoot !== undefined ? "view" : "all" };
				})
			}),
		"dsh-file-manager: empty-trash route"
	);

	// ── 9. 自动清理：每分钟看一眼是否到了检查间隔，到点就按天清 ─────────────────
	let lastSweep = 0;
	let sweeping = false;
	/**
	 * 扫一遍所有回收站：**按记录**清理到期的删除单元，磁盘上没有记录覆盖的孤儿按 mtime 兜底，
	 * 最后剪掉空容器目录。
	 */
	const sweep = async () => {
		if (sweeping) return;
		sweeping = true;
		try {
			const { config, roots } = await current();
			if (config === undefined) return;
			// 配置里可以关掉自动清理（关掉后回收站只增不减，完全靠人工「彻底删除/清空」）。
			if (config.autoCleanup === false) return;
			const ttl = config.retentionDays * 86400000;
			const now = Date.now();
			let removed = 0;
			const touched = [];
			for (const entry of roots ?? []) {
				const trashDir = join(entry.root, config.trashDirname);
				const meta = await readMeta(trashDir);

				// 1) 记录 = 一个删除单元：到期就整棵删掉；记录指向的对象没了就丢弃记录。
				for (const [id, record] of Object.entries(meta)) {
					const stored = storedOf(id, record);
					const full = join(trashDir, stored);
					const info = await lstat(full).catch(() => undefined);
					if (info === undefined) {
						await updateMeta(trashDir, (store) => {
							delete store[id];
						});
						log("warn", `回收站记录指向的条目不存在，已丢弃记录：${stored}`);
						continue;
					}
					let deletedAt = Date.parse(record?.deletedAt ?? "");
					if (!Number.isFinite(deletedAt)) deletedAt = info.mtimeMs ?? now;
					if (now - deletedAt < ttl) continue;
					await removePath(full).catch(() => undefined);
					await updateMeta(trashDir, (store) => {
						delete store[id];
					});
					removed += 1;
					if (!touched.includes(trashDir)) touched.push(trashDir);
					log("info", `自动清理（超过 ${config.retentionDays} 天）：${full}`);
				}

				// 2) 孤儿：磁盘上有、但没有任何记录覆盖（手工拖进来的、历史遗留的）→ mtime 兜底。
				const fresh = await readMeta(trashDir);
				const covered = new Set();
				for (const [id, record] of Object.entries(fresh)) {
					const parts = storedOf(id, record).split("/");
					for (let index = 1; index <= parts.length; index += 1) covered.add(parts.slice(0, index).join("/"));
				}
				let names = [];
				try {
					names = await readdir(trashDir);
				} catch {
					names = [];
				}
				for (const name of names) {
					if (name === META_FILE || name.startsWith(META_TMP) || covered.has(name)) continue;
					const full = join(trashDir, name);
					const info = await lstat(full).catch(() => undefined);
					if (info === undefined) continue;
					if (now - (info.mtimeMs ?? now) < ttl) continue;
					await removePath(full).catch(() => undefined);
					removed += 1;
					if (!touched.includes(trashDir)) touched.push(trashDir);
					log("info", `自动清理孤儿（超过 ${config.retentionDays} 天）：${full}`);
				}

				// 3) 剪掉空容器（保留回收站本身与元数据）。
				await pruneEmpty(trashDir);
			}
			if (removed > 0) audit({ action: "auto-cleanup", removed, retentionDays: config.retentionDays, trashDirs: touched, result: "ok" });
			lastSweep = Date.now();
		} catch (error) {
			log("error", `自动清理失败：${String(error?.stack ?? error)}`);
		} finally {
			sweeping = false;
		}
	};

	ctx.effect(() => {
		const tick = async () => {
			const { config } = await current().catch(() => ({}));
			if (config?.autoCleanup === false) return;
			const intervalMs = (config?.cleanupIntervalHours ?? DEFAULTS.cleanupIntervalHours) * 3600000;
			if (Date.now() - lastSweep < intervalMs) return;
			await sweep();
		};
		const first = setTimeout(() => void tick(), 20000);
		const timer = setInterval(() => void tick(), 60000);
		return () => {
			clearTimeout(first);
			clearInterval(timer);
		};
	}, "dsh-file-manager: sweep timer");

	void current()
		.then(({ config }) => log("info", `已启用（配置文件 ${configPath}${config?.autoCleanup === false ? "，自动清理已关闭" : ""}）。`))
		.catch(() => log("info", `已启用（配置文件 ${configPath}）。`));
}
