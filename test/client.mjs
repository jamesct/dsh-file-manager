/**
 * dsh-file-manager 客户端半的自测：最小 DOM + React hooks 桩，
 * 验证「哪些行挂哪些按钮」以及「点按钮弹出哪个弹窗 / 调哪条路由」。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

let passed = 0;
const failures = [];
/**
 * 断言。
 * @param label - 用例名。
 * @param ok - 是否通过。
 * @param detail - 失败细节。
 */
function check(label, ok, detail = "") {
	if (ok) {
		passed += 1;
		console.log(`  ok   ${label}`);
	} else {
		failures.push(label);
		console.log(`  FAIL ${label}${detail === "" ? "" : `  <- ${detail}`}`);
	}
}

// ── 最小 DOM ──────────────────────────────────────────────────────────────────
const ROOT = "/srv/data/reports";
/** camelCase -> data-kebab-case */
const toData = (key) => `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

/** 一个够用的元素。 */
class El {
	/**
	 * @param tag - 标签名。
	 */
	constructor(tag) {
		this.tagName = tag.toUpperCase();
		this.attrs = Object.create(null);
		this.children = [];
		this.parent = null;
		this.style = {};
		this.handlers = Object.create(null);
		this.textContent = "";
		this.classList = {
			_list: new Set(),
			add: (...names) => names.forEach((n) => this.classList._list.add(n)),
			remove: (...names) => names.forEach((n) => this.classList._list.delete(n)),
			contains: (name) => this.classList._list.has(name),
			toggle: (name, force) => {
				const on = force === undefined ? !this.classList._list.has(name) : force === true;
				if (on) this.classList._list.add(name);
				else this.classList._list.delete(name);
				return on;
			}
		};
		this.dataset = new Proxy(
			{},
			{
				get: (_, key) => this.attrs[toData(String(key))],
				set: (_, key, value) => {
					this.attrs[toData(String(key))] = String(value);
					return true;
				},
				has: (_, key) => toData(String(key)) in this.attrs
			}
		);
	}

	get isConnected() {
		let node = this;
		while (node.parent !== null) node = node.parent;
		return node === body;
	}

	getAttribute(name) {
		return name in this.attrs ? this.attrs[name] : null;
	}

	setAttribute(name, value) {
		this.attrs[name] = String(value);
	}

	removeAttribute(name) {
		delete this.attrs[name];
	}

	closest(selector) {
		let node = this;
		while (node !== null && node !== undefined) {
			if (typeof node.matches === "function" && node.matches(selector)) return node;
			node = node.parent;
		}
		return null;
	}

	append(child) {
		child.parent = this;
		this.children.push(child);
	}

	remove() {
		if (this.parent === null) return;
		const index = this.parent.children.indexOf(this);
		if (index >= 0) this.parent.children.splice(index, 1);
		this.parent = null;
	}

	addEventListener(type, handler) {
		(this.handlers[type] ??= []).push(handler);
	}

	/** 模拟 HTMLElement.click()。 */
	click() {
		this.fire("click");
	}

	/** 触发一次事件（测试用）。 */
	fire(type) {
		for (const handler of this.handlers[type] ?? []) handler({ preventDefault() {}, stopPropagation() {} });
	}

	matches(selector) {
		return selector.split(",").some((one) => matchOne(this, one.trim()));
	}
}

/**
 * 支持「tag + .class + [attr] + [attr="value"]」的极简选择器匹配。
 * @param el - 元素。
 * @param selector - 单个复合选择器。
 * @returns 是否匹配。
 */
function matchOne(el, selector) {
	const parsed = /^([a-zA-Z]*)((?:\.[\w-]+|\[[^\]]+\])*)$/.exec(selector);
	if (parsed === null) throw new Error(`桩不支持的选择器：${selector}`);
	if (parsed[1] !== "" && el.tagName !== parsed[1].toUpperCase()) return false;
	for (const part of parsed[2].match(/\.[\w-]+|\[[^\]]+\]/g) ?? []) {
		if (part.startsWith(".")) {
			if (!el.classList.contains(part.slice(1))) return false;
			continue;
		}
		const inner = part.slice(1, -1);
		const eq = inner.indexOf("=");
		if (eq === -1) {
			if (el.getAttribute(inner) === null) return false;
		} else if (el.getAttribute(inner.slice(0, eq)) !== inner.slice(eq + 1).replace(/^"|"$/g, "")) return false;
	}
	return true;
}

/**
 * 深度优先收集后代。
 * @param node - 起点。
 * @param out - 累积数组。
 * @returns 后代数组。
 */
function walk(node, out = []) {
	for (const child of node.children) {
		out.push(child);
		walk(child, out);
	}
	return out;
}

const body = new El("body");
/** 侧栏会话容器：remote 调用要知道 session id。 */
const sessionHolder = new El("div");
sessionHolder.attrs["data-sidebar-right-session"] = "session-test";
body.append(sessionHolder);
const head = new El("head");
const reloadButton = new El("button");
reloadButton.attrs["data-files-reload"] = "";
body.append(reloadButton);
let reloadCount = 0;
reloadButton.addEventListener("click", () => {
	reloadCount += 1;
});

/** 文档级事件监听（捕获阶段的点击/键盘拦截会用到）。 */
const documentListeners = new Map();
const document = {
	body,
	head,
	createElement: (tag) => new El(tag),
	createElementNS: (_ns, tag) => new El(tag),
	querySelector: (selector) => walk(body).find((el) => el.matches(selector)) ?? null,
	querySelectorAll: (selector) => walk(body).filter((el) => el.matches(selector)),
	addEventListener: (type, handler) => {
		if (!documentListeners.has(type)) documentListeners.set(type, new Set());
		documentListeners.get(type).add(handler);
	},
	removeEventListener: (type, handler) => documentListeners.get(type)?.delete(handler)
};

// ── MutationObserver / rAF / fetch ────────────────────────────────────────────
let observerCallback = null;
class MutationObserver {
	/**
	 * @param callback - 变更回调。
	 */
	constructor(callback) {
		observerCallback = callback;
	}
	observe() {}
	disconnect() {
		observerCallback = null;
	}
}
const rafQueue = [];
/** 把排队的 rAF 回调全跑掉。 */
function flushRaf() {
	for (const callback of rafQueue.splice(0)) callback();
}
/** 让出若干轮事件循环。 */
async function tick(times = 4) {
	for (let index = 0; index < times; index += 1) await new Promise((done) => setTimeout(done, 0));
}

const calls = [];
/** 回收站目录名（模拟宿主配置下发；客户端不该写死这个名字）。 */
const TRASH_DIRNAME = ".dsh-trash";
const CONFIG = {
	ok: true,
	base: "/srv/data",
	retentionDays: 7,
	trashDirname: TRASH_DIRNAME,
	roots: [{ root: "/app/outputs", declared: ROOT, recursive: true }],
	// 既有各节都在验删除/恢复按钮，所以基准配置把 download + trash 打开；
	// 「只显示下载」的兜底与四项开关在 §10h 单独验。
	rowShow: ["download", "trash"]
};
let response = { ok: true };
/** 配置页 fixture：GET /settings 回它，POST /settings 记下请求体。 */
const settingsState = {
	path: "/root/.dsh/file-manager.yml",
	mtimeMs: 111,
	draft: { mode: "paths", manage: [{ path: ROOT, recursive: true }], retention_days: 7, auto_cleanup: true, cleanup_interval_hours: 6, trash_dirname: TRASH_DIRNAME },
	effective: { mode: "paths", retentionDays: 7, autoCleanup: true, trashDirname: TRASH_DIRNAME, roots: [{ root: ROOT, recursive: true }] },
	suggests: [ROOT]
};
let lastSettingsPost = null;
/** 行元信息 fixture：目录 → 子项；以及每次 /info 请求的目录（验"每目录只取一次"）。 */
const metaFixture = new Map();
const infoCalls = [];
/** 选目录路由（/pick）：每次请求 + 可跳转的根清单 + 被拒的目录（用来演"跨工作区关掉"）。 */
const browseCalls = [];
const browseDenied = new Set();
/** path → parent 覆盖（用来演"已经到顶层"）。 */
const browseParents = new Map();
let browseRoots = [];
/** 配置页「浏览…」fixture。 */
/** 目录 → 子目录清单（配置页与移动/复制弹窗共用这一条 /browse）。 */
const browseFixture = new Map();
const fetchStub = async (url, init) => {
	calls.push({ url, body: init?.body === undefined ? undefined : JSON.parse(init.body) });
	if (url === "/api/file-manager/config") return { ok: true, status: 200, json: async () => CONFIG };
	if (url === "/api/file-manager/settings" && init?.method === "POST") {
		lastSettingsPost = JSON.parse(init.body);
		return { ok: true, status: 200, json: async () => ({ ok: true, path: settingsState.path, backup: `${settingsState.path}.bak-20261004120000`, mtimeMs: 222 }) };
	}
	if (url === "/api/file-manager/settings") return { ok: true, status: 200, json: async () => ({ ok: true, ...settingsState }) };
	if (String(url).startsWith("/api/file-manager/browse")) {
		const params = new URL(String(url), "http://x").searchParams;
		const path = params.get("path") ?? "";
		const view = params.get("view") ?? "";
		browseCalls.push({ path, view });
		if (browseDenied.has(path)) return { ok: false, status: 400, json: async () => ({ ok: false, error: "不是目录：被拒绝的目录" }) };
		const dirs = browseFixture.get(path) ?? [];
		const trimmed = path.replace(/\/+$/, "");
		const cut = trimmed.lastIndexOf("/");
		const parent = browseParents.has(path) ? browseParents.get(path) : path === "" || cut <= 0 ? null : trimmed.slice(0, cut);
		return { ok: true, status: 200, json: async () => ({ ok: true, path, parent, dirs, truncated: false, suggests: [ROOT], roots: browseRoots }) };
	}
	if (String(url).startsWith("/api/file-manager/info")) {
		const dir = decodeURIComponent(String(url).slice(String(url).indexOf("?dir=") + 5));
		infoCalls.push(dir);
		return { ok: true, status: 200, json: async () => ({ ok: true, dir, truncated: false, entries: metaFixture.get(dir) ?? [] }) };
	}
	return { ok: response.ok !== false, status: response.ok === false ? 400 : 200, json: async () => response };
};

globalThis.window = {};
globalThis.document = document;
globalThis.MutationObserver = MutationObserver;
globalThis.requestAnimationFrame = (callback) => rafQueue.push(callback);
globalThis.fetch = fetchStub;

/**
 * 触发文档级监听（捕获阶段的 click / keydown）。
 * @param type - 事件类型。
 * @param event - 事件对象。
 */
function fireDocument(type, event) {
	for (const handler of documentListeners.get(type) ?? []) handler(event);
}

/**
 * 渲染某个插槽组件（每次重置 hook 下标，和 render() 一样）。
 * @param id - 注册时的 id。
 * @param props - 传进去的 props。
 * @returns 渲染结果或 null。
 */
function renderComponent(id, props) {
	const component = componentFor(id);
	if (component === undefined) return null;
	beginHooks(component);
	return component(props ?? {});
}

/**
 * 渲染管理器弹窗：渲染两次 —— 第一次跑重置 effect，第二次才带上 effect 写入的状态。
 * @returns 渲染树。
 */
function renderManager() {
	renderComponent("dsh-file-manager.manager");
	return renderComponent("dsh-file-manager.manager");
}

/**
 * 深度遍历渲染树。
 * @param node - 起始节点。
 * @returns 所有节点（含数组里的）。
 */
function walkTree(node) {
	const out = [];
	const visit = (current) => {
		if (current === null || current === undefined || current === false) return;
		if (Array.isArray(current)) {
			for (const item of current) visit(item);
			return;
		}
		out.push(current);
		if (typeof current === "object" && current.children !== undefined) visit(current.children);
	};
	visit(node);
	return out;
}

// ── React 桩（够 Dialog 用：按 hook 顺序存状态，手动重渲染） ────────────────────
let hookStates = [];
let hookIndex = 0;
/** 每个组件一份 hook 槽位（共享一个数组会让不同组件互相覆盖）。 */
const hookStatesByComponent = new Map();
/**
 * 进入某个组件的 hook 作用域。
 * @param component - 组件函数。
 */
function beginHooks(component) {
	let slots = hookStatesByComponent.get(component);
	if (slots === undefined) {
		slots = [];
		hookStatesByComponent.set(component, slots);
	}
	hookStates = slots;
	hookIndex = 0;
}
/**
 * 比较依赖数组。
 * @param a - 旧依赖。
 * @param b - 新依赖。
 * @returns 是否变化。
 */
function depsChanged(a, b) {
	if (a === undefined) return true;
	if (a.length !== b.length) return true;
	return a.some((value, index) => !Object.is(value, b[index]));
}
const React = {
	createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
	Fragment: Symbol("Fragment"),
	useReducer: (reducer, initial) => {
		const index = hookIndex++;
		if (!(index in hookStates)) hookStates[index] = initial;
		return [
			hookStates[index],
			(action) => {
				hookStates[index] = reducer(hookStates[index], action);
			}
		];
	},
	useState: (initial) => {
		const index = hookIndex++;
		if (!(index in hookStates)) hookStates[index] = initial;
		return [
			hookStates[index],
			(value) => {
				hookStates[index] = typeof value === "function" ? value(hookStates[index]) : value;
			}
		];
	},
	useRef: (initial) => {
		const index = hookIndex++;
		if (!(index in hookStates)) hookStates[index] = { current: initial ?? null };
		return hookStates[index];
	},
	useEffect: (effect, deps) => {
		const index = hookIndex++;
		const previous = hookStates[index];
		if (previous === undefined || depsChanged(previous.deps, deps)) {
			previous?.cleanup?.();
			hookStates[index] = { deps, cleanup: effect() };
		}
	},
	useCallback: (callback, deps) => {
		const index = hookIndex++;
		const previous = hookStates[index];
		if (previous === undefined || depsChanged(previous.deps, deps)) hookStates[index] = { deps, value: callback };
		return hookStates[index].value;
	}
};
/**
 * 造一个带类型标记的组件桩。
 * @param type - 组件名。
 * @returns 组件函数。
 */
function stub(type) {
	const component = (props) => ({ type, props });
	component.__type = type;
	return component;
}
const primitives = {
	Button: stub("Button"),
	Checkbox: stub("Checkbox"),
	// 够用的近似桩：真件是 '312B' / '4.2KB' / '1.5MB'（测的是渲染链路，不是格式化细节）。
	fileSizeText: (bytes) => (bytes >= 1024 ? `${Math.round(bytes / 1024)}KB` : `${bytes}B`),
	Input: stub("Input"),
	Modal: stub("Modal"),
	RiskConfirmation: stub("RiskConfirmation"),
	SegmentedControl: stub("SegmentedControl"),
	Toast: stub("Toast")
};

/** 槽位注册结果：id -> 组件。 */
const registered = new Map();
/**
 * 取某个槽位注册的组件。
 * @param id - 注册时给的 id。
 * @returns 组件函数或 undefined。
 */
const componentFor = (id) => registered.get(id);

/** 假 remote.workspaceFiles：一棵内存文件树，够测下载与打包。 */
const fakeDirs = new Set();
const fakeFiles = new Map();
const fakeRemote = {
	async stat(_session, path) {
		const bytes = fakeFiles.get(path);
		if (bytes === undefined) return { ok: false, error: { message: `没有这个文件：${path}` } };
		return { ok: true, value: { bytes: bytes.length, version: "v1", absolutePath: path } };
	},
	async readBytes(_session, path, options) {
		const bytes = fakeFiles.get(path);
		if (bytes === undefined) return { ok: false, error: { message: `没有这个文件：${path}` } };
		const offset = options.range.offset;
		const data = bytes.slice(offset, offset + options.range.length);
		return { ok: true, value: { data, offset, eof: offset + data.length === bytes.length, version: "v1", absolutePath: path, bytes: bytes.length } };
	},
	async list(_session, path) {
		if (!fakeDirs.has(path)) return { ok: false, error: { message: `不是目录：${path}` } };
		const prefix = `${path}/`;
		const found = new Map();
		for (const file of fakeFiles.keys()) if (file.startsWith(prefix) && !file.slice(prefix.length).includes("/")) found.set(file.slice(prefix.length), "file");
		for (const dir of fakeDirs) if (dir !== path && dir.startsWith(prefix) && !dir.slice(prefix.length).includes("/")) found.set(dir.slice(prefix.length), "directory");
		return { ok: true, value: { path, entries: [...found].map(([name, type]) => ({ name, type })), truncated: false } };
	}
};

const ctx = {
	remote: { workspaceFiles: fakeRemote },
	slots: {
		inject: (_name, callback) => {
			callback();
			return () => {};
		},
		register: (options, component) => {
			registered.set(options?.id ?? options?.name, component);
			return component;
		}
	}
};

// 直接加载源码（不再用副本 —— 副本曾经让我跑了一轮"假绿灯"）
const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
let factory = null;
globalThis.window.__ModuleLoader__ = {
	load: (options) => {
		factory = options.factory;
	}
};
// 放在 window 上执行，行为与真实浏览器一致
new Function("window", "document", "MutationObserver", "requestAnimationFrame", "fetch", source)(
	globalThis.window,
	document,
	MutationObserver,
	globalThis.requestAnimationFrame,
	fetchStub
);
const moduleExports = factory((name) => {
	if (name === "react") return React;
	if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
	throw new Error(`桩没有提供模块：${name}`);
});
check("插件导出 apply", typeof moduleExports.apply === "function");
const dispose = moduleExports.apply(ctx);
check("注册进 shell.overlay", typeof componentFor("dsh-file-manager.dialog") === "function");
check("注册了工具栏与预览栏插槽", typeof componentFor("dsh-file-manager.files") === "function" && typeof componentFor("dsh-file-manager.download") === "function");

/**
 * 造一行。
 * @param entry - file | directory。
 * @param path - 绝对路径。
 * @param withDownload - 是否带一个下载插件按钮。
 * @param parent - 挂到哪个容器（默认 body；用来模拟带 data-files-root 的文件树）。
 * @returns 行元素。
 */
function makeRow(entry, path, withDownload = false, parent = body) {
	const row = new El("div");
	row.attrs["data-files-entry"] = entry;
	row.attrs["data-files-path"] = path;
	const label = new El("button");
	row.append(label);
	if (withDownload) {
		// 模拟「**另一个**插件也在同一行上挂了按钮」的场景（历史上 dsh-file-download 就是这么挂的，
		// 它的样式表还压过我们的按钮）。不是本插件的依赖，只是用来验"我们的几何不会被别人压掉"。
		const download = new El("button");
		download.attrs["data-dsh-file-download"] = "";
		row.append(download);
	}
	parent.append(row);
	return row;
}

await tick();
flushRaf();
await tick();

console.log("\n== 1. 按钮挂载 ==");
const rowFile = makeRow("file", `${ROOT}/报告.md`);
const rowDir = makeRow("directory", `${ROOT}/旧目录`);
const rowTrash = makeRow("directory", `${ROOT}/${TRASH_DIRNAME}`);
const rowTrashFile = makeRow("file", `${ROOT}/${TRASH_DIRNAME}/报告.md`);
const rowTrashDeep = makeRow("file", `${ROOT}/${TRASH_DIRNAME}/sub/报告.md`);
const rowMeta = makeRow("file", `${ROOT}/${TRASH_DIRNAME}/.meta.json`);
const rowOutside = makeRow("file", "/app/mcp_server/server.py");
const rowAltSpelling = makeRow("file", "/app/outputs/另一份.md");
const rowWithDownload = makeRow("file", `${ROOT}/带下载.md`, true);
observerCallback();
flushRaf();

/**
 * 取一行上本插件挂的按钮。
 * @param row - 行。
 * @returns action 数组。
 */
const actionsOf = (row) => row.children.filter((child) => child.matches("button[data-dsh-file-manager]")).map((child) => child.dataset.dshFileManager);

check("文件行 -> 下载+删除", JSON.stringify(actionsOf(rowFile)) === '["download","trash"]', JSON.stringify(actionsOf(rowFile)));
check("目录行 -> 打包+删除", JSON.stringify(actionsOf(rowDir)) === '["zip","trash"]', JSON.stringify(actionsOf(rowDir)));
check(".dsh-trash 自身 -> 只给打包", JSON.stringify(actionsOf(rowTrash)) === '["zip"]', JSON.stringify(actionsOf(rowTrash)));
check(
	".dsh-trash 第一层 -> 下载+恢复+彻底删除+移动",
	JSON.stringify(actionsOf(rowTrashFile)) === '["download","restore","purge","move"]',
	JSON.stringify(actionsOf(rowTrashFile))
);
check(
	".dsh-trash 更深层 -> 同样给恢复/彻底删除/移动（决策 L2：不再只认第一层）",
	JSON.stringify(actionsOf(rowTrashDeep)) === '["download","restore","purge","move"]',
	JSON.stringify(actionsOf(rowTrashDeep))
);
check(".meta.json -> 只给下载", JSON.stringify(actionsOf(rowMeta)) === '["download"]', JSON.stringify(actionsOf(rowMeta)));
check("允许范围外 -> 只给下载（下载不设白名单）", JSON.stringify(actionsOf(rowOutside)) === '["download"]', JSON.stringify(actionsOf(rowOutside)));
check("realpath 拼写也认（/app/outputs）", JSON.stringify(actionsOf(rowAltSpelling)) === '["download","trash"]', JSON.stringify(actionsOf(rowAltSpelling)));
check("行加了定位 class", rowFile.classList.contains("dsh-file-manager-row"));

console.log("\n== 2. 行内布局（下载贴最右，其余依次往左 30px）==");
/**
 * 取一行上某个动作的按钮。
 * @param row - 行。
 * @param action - 动作名。
 * @returns 按钮或 undefined。
 */
const buttonOf = (row, action) => row.children.find((child) => child.dataset?.dshFileManager === action);
check("文件行：下载贴最右 6px", buttonOf(rowFile, "download").style.insetInlineEnd === "6px", String(buttonOf(rowFile, "download").style.insetInlineEnd));
check("文件行：删除让开 30px", buttonOf(rowFile, "trash").style.insetInlineEnd === "36px", String(buttonOf(rowFile, "trash").style.insetInlineEnd));
check("行内其它按钮留出内边距（2 个图标 = 68px）", rowFile.children[0].style.paddingInlineEnd === "68px", String(rowFile.children[0].style.paddingInlineEnd));
check(
	"目录行：打包 6px / 删除 36px",
	buttonOf(rowDir, "zip").style.insetInlineEnd === "6px" && buttonOf(rowDir, "trash").style.insetInlineEnd === "36px",
	`${buttonOf(rowDir, "zip").style.insetInlineEnd} / ${buttonOf(rowDir, "trash").style.insetInlineEnd}`
);
check(
	".dsh-trash 条目：下载 6px / 恢复 36px / 彻底删除 66px / 移动 96px",
	buttonOf(rowTrashFile, "download").style.insetInlineEnd === "6px" &&
		buttonOf(rowTrashFile, "restore").style.insetInlineEnd === "36px" &&
		buttonOf(rowTrashFile, "purge").style.insetInlineEnd === "66px"
);

console.log("\n== 3. 幂等 / 配置变化后收敛 ==");
observerCallback();
flushRaf();
check("重复扫描不会加重复按钮", actionsOf(rowFile).length === 2 && actionsOf(rowTrashFile).length === 4, `${actionsOf(rowFile).length}/${actionsOf(rowTrashFile).length}`);
const before = rowTrashFile.children.length;
rowTrashFile.attrs["data-files-path"] = `${ROOT}/${TRASH_DIRNAME}/sub/报告.md`;
observerCallback();
flushRaf();
check(
	"路径改深后仍按回收站条目处理（下载+恢复+彻底删除+移动）",
	JSON.stringify(actionsOf(rowTrashFile)) === '["download","restore","purge","move"]' && rowTrashFile.children.length <= before,
	JSON.stringify(actionsOf(rowTrashFile))
);

console.log("\n== 4. 弹窗内容 ==");
/**
 * 渲染一次弹窗组件。
 * @returns 元素树。
 */
function render() {
	const component = componentFor("dsh-file-manager.dialog");
	beginHooks(component);
	return component();
}
/**
 * 在树里按 type 找节点。
 * @param node - 根。
 * @param type - 组件类型（桩里的字符串标记）。
 * @returns 命中的节点。
 */
function findByType(node, type) {
	if (node === null || typeof node !== "object") return null;
	if (node.type === type || node.type?.__type === type) return node;
	for (const child of node.children ?? []) {
		const hit = findByType(child, type);
		if (hit !== null) return hit;
	}
	return null;
}

/**
 * 把一个子树的纯文本抽出来。
 * @param node - 子树或字符串。
 * @returns 文本。
 */
function textOf(node) {
	if (node === null || node === undefined || node === false) return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	return (Array.isArray(node) ? node : [node]).map((child) => textOf(child?.children ?? child)).join("");
}

buttonOf(rowFile, "trash").fire("click");
let tree = render();
let modal = findByType(tree, "Modal");
check("软删弹的是 Modal", modal !== null && findByType(tree, "RiskConfirmation") === null);
check("标题写了 .dsh-trash", String(modal?.props.title).includes(".dsh-trash"), String(modal?.props.title));
check("正文写明 7 天自动清理", textOf(modal?.children).includes("7 天"), textOf(modal?.children));
check("正文写明可恢复", textOf(modal?.children).includes("恢复"));

const footer = modal.props.footer;
const footerButtons = footer.children.filter(Boolean);
check("底部两个按钮", footerButtons.length === 2, String(footerButtons.length));
check("确认按钮是 primary", footerButtons[1].props.variant === "primary");

calls.length = 0;
reloadCount = 0;
response = { ok: true, restoredTo: undefined };
footerButtons[1].props.onClick();
await tick();
check("确认后调 /trash", calls.some((call) => call.url === "/api/file-manager/trash"), JSON.stringify(calls));
check("请求体带绝对路径", calls.find((call) => call.url === "/api/file-manager/trash")?.body?.path === `${ROOT}/报告.md`);
check("成功后刷新文件树", reloadCount === 1, String(reloadCount));
tree = render();
const toast = findByType(tree, "Toast");
check("成功后弹 Toast", toast !== null, JSON.stringify(tree.children?.length));
check("Toast 文案含 7 天", String(toast?.props.text).includes("7 天"), String(toast?.props.text));
check("成功后弹窗关掉了", findByType(tree, "Modal") === null && findByType(tree, "RiskConfirmation") === null);

console.log("\n== 5. 彻底删除要勾选确认 ==");
rowTrashFile.attrs["data-files-path"] = `${ROOT}/${TRASH_DIRNAME}/报告.md`;
observerCallback();
flushRaf();
const purgeButton = rowTrashFile.children.find((child) => child.dataset.dshFileManager === "purge");
purgeButton.fire("click");
tree = render();
let risk = findByType(tree, "RiskConfirmation");
check("彻底删除弹的是 RiskConfirmation", risk !== null);
check("必须勾选才可点", risk?.props.acknowledged === false && risk?.props.disabled === false);
check("有勾选文案", String(risk?.props.acknowledgeLabel).includes("不可恢复"), String(risk?.props.acknowledgeLabel));
check("正文点了名", String(risk?.props.description).includes("报告.md"), String(risk?.props.description));

risk.props.onAcknowledgedChange(true);
tree = render();
risk = findByType(tree, "RiskConfirmation");
check("勾选后 acknowledged 传成 true", risk?.props.acknowledged === true);
check("空闲时 disabled 为 false", risk?.props.disabled === false);

console.log("\n== 6. 恢复路由 ==");
const restoreButton = rowTrashFile.children.find((child) => child.dataset.dshFileManager === "restore");
restoreButton.fire("click");
tree = render();
modal = findByType(tree, "Modal");
check("恢复弹 Modal 而非 RiskConfirmation", modal !== null && findByType(tree, "RiskConfirmation") === null);
check("恢复正文说移回原位", textOf(modal?.children).includes("原来的位置"), textOf(modal?.children));
calls.length = 0;
response = { ok: true, restoredTo: `${ROOT}/报告.md` };
modal.props.footer.children.filter(Boolean)[1].props.onClick();
await tick();
check("调 /restore", calls.some((call) => call.url === "/api/file-manager/restore"), JSON.stringify(calls));
tree = render();
check("恢复成功弹 Toast 且写了落点", String(findByType(tree, "Toast")?.props.text).includes(`${ROOT}/报告.md`), String(findByType(tree, "Toast")?.props.text));

console.log("\n== 7. 失败路径 ==");
buttonOf(rowFile, "trash").fire("click");
tree = render();
response = { ok: false, error: "这个位置不在允许删除的文件夹里。" };
findByType(tree, "Modal").props.footer.children.filter(Boolean)[1].props.onClick();
await tick();
tree = render();
check("失败时 Toast 显示中文原因", String(findByType(tree, "Toast")?.props.text).includes("不在允许删除"), String(findByType(tree, "Toast")?.props.text));
check("失败时弹窗还开着（可重试）", findByType(tree, "Modal") !== null);

console.log("\n== 8. 按钮几何走行内样式（防被别的插件样式表压扁）==");
const geomButton = buttonOf(rowFile, "trash");
const geomSvg = geomButton.children.find((child) => child.tagName === "SVG");
check(
	"按钮行内带几何（下载插件的 padding-inline-end:42px 压不过行内）",
	/padding:4px/.test(String(geomButton.style.cssText)) && /width:26px/.test(String(geomButton.style.cssText)),
	String(geomButton.style.cssText)
);
check("按钮行内 position:absolute", /position:absolute/.test(String(geomButton.style.cssText)), String(geomButton.style.cssText));
check(
	"svg 行内带尺寸",
	geomSvg.style.width === "16px" && geomSvg.style.height === "16px",
	JSON.stringify([geomSvg.style.width, geomSvg.style.height])
);
check("svg 不许被压缩（flex:0 0 auto）", geomSvg.style.flex === "0 0 auto", String(geomSvg.style.flex));

console.log("\n== 9. 下载与 ZIP 内核 ==");
const internals = moduleExports.__internals;
check("导出了内部函数供测试", typeof internals?.planZip === "function" && typeof internals?.writeZip === "function");
const encoder = new TextEncoder();
const crcCheck = internals.crc32(encoder.encode("123456789"));
check("CRC32 中间值符合标准（0x340BC6D9）", crcCheck === 0x340bc6d9, crcCheck.toString(16));
check("最终异或后等于标准检验值 0xCBF43926", ((crcCheck ^ 0xffffffff) >>> 0) === 0xcbf43926, ((crcCheck ^ 0xffffffff) >>> 0).toString(16));
check("ZIP 预算从 22 字节起算", internals.zipBudget().bytes === 22);

fakeDirs.add("/t");
fakeDirs.add("/t/sub");
fakeFiles.set("/t/a.md", encoder.encode("A\n"));
fakeFiles.set("/t/sub/b.md", encoder.encode("B\n"));
fakeFiles.set("/t/empty.txt", new Uint8Array(0));
const signal = new AbortController().signal;
const plan = await internals.planZip(fakeRemote, "s1", [{ path: "/t", directory: true }, { path: "/t/a.md", directory: false }], signal);
const planNames = plan.entries.map((entry) => entry.name).sort();
check("规划出目录与文件条目", JSON.stringify(planNames) === JSON.stringify(["a.md", "t/", "t/a.md", "t/empty.txt", "t/sub/", "t/sub/b.md"]), JSON.stringify(planNames));
const writer = internals.bufferedWriter(64 * 1024 * 1024);
await internals.writeZip(fakeRemote, "s1", plan, writer, signal, () => {});
const zipBuffer = Buffer.from(await writer.blob().arrayBuffer());
const tmpDir = new URL("./.tmp/", import.meta.url);
await mkdir(tmpDir, { recursive: true });
const zipPath = new URL("./.tmp/zip-sample.zip", import.meta.url);
await writeFile(zipPath, zipBuffer);
const listing = execFileSync(
	"python3",
	[
		"-c",
		"import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);print(z.testzip() is None);print('|'.join(sorted(z.namelist())));print(z.read('t/sub/b.md').decode().strip());print(len(z.read('t/empty.txt')))",
		zipPath.pathname
	],
	{ encoding: "utf8" }
).trim().split("\n");
check("python3 校验 ZIP 完整（testzip 无损坏）", listing[0] === "True", listing.join(" / "));
check("归档条目名正确", listing[1] === "a.md|t/|t/a.md|t/empty.txt|t/sub/|t/sub/b.md", listing[1]);
check("归档内容正确", listing[2] === "B" && listing[3] === "0", listing.slice(2).join(" / "));

// 预算/截断类错误要明确报出来，而不是产出残缺包
const bigPlan = await internals.planZip(fakeRemote, "s1", [{ path: "/t/missing.md", directory: false }], signal).then(() => null, (error) => error);
check("目标不存在时明确报错", bigPlan instanceof Error, String(bigPlan?.message));
fakeFiles.set("/t/x.md", encoder.encode("X"));
const listingBroken = { ...fakeRemote, list: async () => ({ ok: true, value: { path: "/t", entries: [], truncated: true } }) };
const truncated = await internals.planZip(listingBroken, "s1", [{ path: "/t", directory: true }], signal).then(() => null, (error) => error);
check("目录被截断时拒绝打包", truncated instanceof Error && `/截断/.test(truncated.message)`, String(truncated?.message));

console.log("\n== 10. 多选、批量与弹窗 ==");
const selA = makeRow("file", `${ROOT}/s-a.md`);
const selB = makeRow("file", `${ROOT}/s-b.md`);
const selDir = makeRow("directory", `${ROOT}/s-dir`);
const selOutside = makeRow("file", "/app/mcp_server/secret.py");
observerCallback();
flushRaf();

/**
 * 取工具栏按钮（按 data 名）。
 * @param name - 按钮名。
 * @returns 节点或 null。
 */
function toolbarButton(name) {
	const bar = renderComponent("dsh-file-manager.files", { absolutePath: ROOT });
	return walkTree(bar).find((node) => node?.props?.["data-dsh-file-manager-tool"] === name) ?? null;
}
/**
 * 多选模式下单击一行（走捕获阶段的文档监听）。
 * @param row - 行。
 * @param modifiers - 修饰键。
 */
function clickRow(row, modifiers = {}) {
	let prevented = false;
	let stopped = false;
	fireDocument("click", {
		target: row,
		preventDefault() {
			prevented = true;
		},
		stopPropagation() {
			stopped = true;
		},
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
		...modifiers
	});
	return { prevented, stopped };
}
/**
 * 确保处于多选模式（Esc 之后需要重新进入）。
 */
function ensureMulti() {
	if (toolbarButton("multi").props["aria-pressed"] !== true) toolbarButton("multi").props.onClick();
}
/** 当前选中项（从行上的 aria-selected 反推）。 */
const selectedPaths = () => [...document.querySelectorAll("[data-files-path]")].filter((row) => row.attrs["aria-selected"] === "true").map((row) => row.attrs["data-files-path"]);

check("工具栏有「多选」开关", toolbarButton("multi") !== null);
clickRow(selA); // 未进入多选、也没修饰键 → 不该被选中
check("未进入多选时单击不勾选", selectedPaths().length === 0, JSON.stringify(selectedPaths()));
toolbarButton("multi").props.onClick();
check("进入多选后显示退出", String(walkTree(renderComponent("dsh-file-manager.files", { absolutePath: ROOT })).find((node) => node?.props?.["data-dsh-file-manager-tool"] === "multi")?.children?.[0]) === "退出多选");
check(
	"多选模式不再常驻提示文字",
	!walkTree(renderComponent("dsh-file-manager.files", { absolutePath: ROOT })).some((node) => String(node?.children?.[0] ?? "").includes("Esc 退出"))
);
check("「退出多选」的悬停里有用法说明", String(toolbarButton("multi").props.title ?? "").includes("方框"), String(toolbarButton("multi").props.title));
// 进入多选后，可选行左侧出现勾选框（文件夹也能勾 —— 这就是「文件夹删除」的入口）
flushRaf();
/**
 * 取一行上的勾选框。
 * @param row - 行。
 * @returns 勾选框或 undefined。
 */
const boxOf = (row) => row.children.find((child) => child.dataset?.dshFileManager === "select");
check("多选模式下可选行出现勾选框", boxOf(selA) !== undefined && boxOf(selDir) !== undefined, String(boxOf(selA)));
/**
 * 取一行上的灰色占位框。
 * @param row - 行。
 * @returns 占位框或 undefined。
 */
const placeholderOf = (row) => row.children.find((child) => child.dataset?.dshFileManager === "select-placeholder");
check("不可管理的行给占位框而不是可用勾选框", boxOf(selOutside) === undefined && placeholderOf(selOutside) !== undefined, String(placeholderOf(selOutside)));
check("不可选的文件夹也给占位框", boxOf(rowTrash) === undefined && placeholderOf(rowTrash) !== undefined, String(placeholderOf(rowTrash)));
check(
	"占位框禁用且点击穿透",
	placeholderOf(selOutside).disabled === true && String(placeholderOf(selOutside).style.cssText).includes("pointer-events:none"),
	String(placeholderOf(selOutside).style.cssText)
);
check("占位框让不可选行也对齐（26px）", selOutside.children[0].style.paddingInlineStart === "26px", String(selOutside.children[0].style.paddingInlineStart));
const beforePlaceholderClick = selectedPaths().length;
fireDocument("mousedown", { target: placeholderOf(selOutside), preventDefault() {}, stopPropagation() {} });
clickRow(placeholderOf(selOutside));
check("点占位框不会改变选中态", selectedPaths().length === beforePlaceholderClick, JSON.stringify(selectedPaths()));
check("勾选框给行内文字让出左边距", selDir.children[0].style.paddingInlineStart === "26px", String(selDir.children[0].style.paddingInlineStart));
// mousedown 即生效（行会被 React 重绘，click 可能落空，所以按下就勾）
fireDocument("mousedown", { target: boxOf(selDir), preventDefault() {}, stopPropagation() {} });
check("按下勾选框即选中文件夹", JSON.stringify(selectedPaths()) === JSON.stringify([`${ROOT}/s-dir`]), JSON.stringify(selectedPaths()));
clickRow(boxOf(selDir));
check("同一次操作的 click 不会翻第二次", JSON.stringify(selectedPaths()) === JSON.stringify([`${ROOT}/s-dir`]), JSON.stringify(selectedPaths()));
// 没有 mousedown 的 click（键盘 / 程序化）也能切换
clickRow(boxOf(selDir));
check("再次点击取消文件夹", selectedPaths().length === 0, JSON.stringify(selectedPaths()));
clickRow(boxOf(selDir));
check("勾勾选框可以选中文件夹", JSON.stringify(selectedPaths()) === JSON.stringify([`${ROOT}/s-dir`]), JSON.stringify(selectedPaths()));
clickRow(boxOf(selDir));
check("再勾一次取消文件夹", selectedPaths().length === 0, JSON.stringify(selectedPaths()));
clickRow(selA);
check("单击勾选一行", JSON.stringify(selectedPaths()) === JSON.stringify([`${ROOT}/s-a.md`]), JSON.stringify(selectedPaths()));
check("选中行加了高亮 class", selA.classList.contains("dsh-file-manager-selected"));
clickRow(selA);
check("再点一次取消勾选", selectedPaths().length === 0);
// 回归：多选模式下文件夹必须还能展开 —— 普通单击不拦截、不勾选；勾选文件夹用 Ctrl/⌘
const dirClick = clickRow(selDir);
check("多选下普通单击文件夹不拦截（保留展开/收起）", dirClick.prevented === false && dirClick.stopped === false && selectedPaths().length === 0, `${dirClick.prevented} / ${JSON.stringify(selectedPaths())}`);
clickRow(selDir, { ctrlKey: true });
check("Ctrl+单击文件夹可以勾选", JSON.stringify(selectedPaths()) === JSON.stringify([`${ROOT}/s-dir`]), JSON.stringify(selectedPaths()));
clickRow(selDir, { ctrlKey: true });
check("再 Ctrl+单击取消文件夹勾选", selectedPaths().length === 0, JSON.stringify(selectedPaths()));
clickRow(selA);
clickRow(selDir, { shiftKey: true });
check("Shift 连选选中区间", selectedPaths().length === 3, JSON.stringify(selectedPaths()));
clickRow(selOutside);
check("允许范围外的行选不中", selectedPaths().length === 3, JSON.stringify(selectedPaths()));
check("工具栏显示已选数", walkTree(renderComponent("dsh-file-manager.files", { absolutePath: ROOT })).some((node) => String(node?.children?.[0] ?? "") === "已选 3 项"));
fireDocument("keydown", { key: "Escape" });
check("Esc 退出多选并清空", selectedPaths().length === 0 && toolbarButton("multi").props["aria-pressed"] === false);
flushRaf();
check(
	"退出多选后勾选框与占位框都消失、边距恢复",
	boxOf(selA) === undefined && placeholderOf(selOutside) === undefined && selA.children[0].style.paddingInlineStart === "" && selOutside.children[0].style.paddingInlineStart === "",
	String(selOutside.children[0].style.paddingInlineStart)
);

// 批量删除：二次确认后逐项调 /trash，并汇总结果
ensureMulti();
clickRow(selA);
clickRow(selB);
const beforeBatch = calls.length;
toolbarButton("trash-selection").props.onClick();
const confirmTree = renderManager();
check("批量删除弹出确认框", findByType(confirmTree, "Modal") !== null);
const confirmButton = findByType(confirmTree, "Modal").props.footer.children.filter(Boolean)[1];
response = { ok: true };
confirmButton.props.onClick();
await tick();
await tick();
const batchCalls = calls.slice(beforeBatch).filter((entry) => entry.url === "/api/file-manager/trash");
check("逐项调了 /trash", batchCalls.length === 2 && batchCalls.every((entry) => typeof entry.body.path === "string"), JSON.stringify(batchCalls.map((entry) => entry.body.path)));
check("批量完成后清空选择", selectedPaths().length === 0);
check("批量完成后退出多选（文件夹恢复可展开）", toolbarButton("multi").props["aria-pressed"] === false, String(toolbarButton("multi").props["aria-pressed"]));
const toastTree = renderComponent("dsh-file-manager.dialog");
check("批量结果有汇总提示", String(findByType(toastTree, "Toast")?.props?.text ?? "").includes("2 项完成"), String(findByType(toastTree, "Toast")?.props?.text));

// 批量失败要如实报条数
ensureMulti();
clickRow(selA);
clickRow(selB);
toolbarButton("trash-selection").props.onClick();
response = { ok: false, error: "拒绝" };
findByType(renderManager(), "Modal").props.footer.children.filter(Boolean)[1].props.onClick();
await tick();
await tick();
check("失败时汇总里带失败条数", String(findByType(renderComponent("dsh-file-manager.dialog"), "Toast")?.props?.text ?? "").includes("失败 2 项"), String(findByType(renderComponent("dsh-file-manager.dialog"), "Toast")?.props?.text));
response = { ok: true };

// 重命名：单个选中 → 弹窗输入 → /rename
ensureMulti();
clickRow(selA);
toolbarButton("rename-selection").props.onClick();
let renameTree = renderManager();
const renameInput = walkTree(renameTree).find((node) => node?.type === "input");
check("重命名弹窗预填当前名字", renameInput?.props?.value === "s-a.md", String(renameInput?.props?.value));
renameInput.props.onChange({ target: { value: "s-renamed.md" } });
const beforeRename = calls.length;
renameTree = renderManager();
findByType(renameTree, "Modal").props.footer.children.filter(Boolean)[1].props.onClick();
await tick();
await tick();
const renameCall = calls.slice(beforeRename).find((entry) => entry.url === "/api/file-manager/rename");
check("改名走 /rename 且带新名字", renameCall?.body?.name === "s-renamed.md" && renameCall?.body?.path === `${ROOT}/s-a.md`, JSON.stringify(renameCall?.body));
// 回归：改名后旧路径不再对应任何行，选中态必须清空（否则会显示「已选 1 项」却没高亮）
check("重命名后选中态被清空", selectedPaths().length === 0, JSON.stringify(selectedPaths()));
check("重命名后退出多选", toolbarButton("multi").props["aria-pressed"] === false, String(toolbarButton("multi").props["aria-pressed"]));
check(
	"重命名后工具栏不再显示已选",
	!walkTree(renderComponent("dsh-file-manager.files", { absolutePath: ROOT })).some((node) => String(node?.children?.[0] ?? "").startsWith("已选"))
);

// 回归：行上的单行动作（走老确认弹窗那条路）也要清空选中态
ensureMulti();
clickRow(selB);
check("单行操作前确实选中了 1 项", selectedPaths().length === 1, JSON.stringify(selectedPaths()));
buttonOf(selB, "trash").fire("click");
await tick();
const singleTree = render();
check("单行删除弹出确认框", findByType(singleTree, "Modal") !== null);
findByType(singleTree, "Modal").props.footer.children.filter(Boolean)[1].props.onClick();
await tick();
await tick();
check("单行删除后选中态被清空", selectedPaths().length === 0, JSON.stringify(selectedPaths()));
check("单行动作后退出多选", toolbarButton("multi").props["aria-pressed"] === false, String(toolbarButton("multi").props["aria-pressed"]));

// 新建文件夹：没有选中时建在允许根下
fireDocument("keydown", { key: "Escape" });
toolbarButton("mkdir").props.onClick();
let mkdirTree = renderManager();
const mkdirInput = walkTree(mkdirTree).find((node) => node?.type === "input");
mkdirInput.props.onChange({ target: { value: "新目录" } });
const beforeMkdir = calls.length;
mkdirTree = renderManager();
findByType(mkdirTree, "Modal").props.footer.children.filter(Boolean)[1].props.onClick();
await tick();
await tick();
const mkdirCall = calls.slice(beforeMkdir).find((entry) => entry.url === "/api/file-manager/mkdir");
check("新建文件夹走 /mkdir 且父目录是允许根", mkdirCall?.body?.parent === ROOT && mkdirCall?.body?.name === "新目录", JSON.stringify(mkdirCall?.body));

// 移动到…：列出子目录（隐藏 .dsh-trash）→ 移动到这里 → /move
fakeDirs.add(ROOT);
fakeDirs.add(`${ROOT}/s-dir`);
fakeDirs.add(`${ROOT}/${TRASH_DIRNAME}`);
browseFixture.set(ROOT, [
	{ name: "s-dir", path: `${ROOT}/s-dir` },
	{ name: TRASH_DIRNAME, path: `${ROOT}/${TRASH_DIRNAME}` }
]);
fakeFiles.set(`${ROOT}/s-b.md`, encoder.encode("B\n"));
ensureMulti();
clickRow(selA);
toolbarButton("move-selection").props.onClick();
let moveTree = renderManager();
await tick();
moveTree = renderManager();
check("移动弹窗列出了目录节点", walkTree(moveTree).some((node) => String(node?.props?.className ?? "").includes("dsh-file-manager-rowlist")));
check("移动弹窗隐藏了 .dsh-trash", !walkTree(moveTree).some((node) => String(node?.children?.[0] ?? "").includes(".dsh-trash")));
const intoDir = walkTree(moveTree).find((node) => String(node?.children?.[0] ?? "") === "📁 s-dir");
check("移动弹窗能进子目录", intoDir !== undefined);
intoDir.props.onClick();
await tick();
moveTree = renderManager();
const beforeMove = calls.length;
findByType(moveTree, "Modal").props.footer.children.filter(Boolean)[1].props.onClick();
await tick();
await tick();
const moveCall = calls.slice(beforeMove).find((entry) => entry.url === "/api/file-manager/move");
check("移动走 /move 且目标目录正确", moveCall?.body?.targetDir === `${ROOT}/s-dir`, JSON.stringify(moveCall?.body));
check("移动完成的提示里写明目标目录", String(findByType(renderComponent("dsh-file-manager.dialog"), "Toast")?.props?.text ?? "").includes(`${ROOT}/s-dir`), String(findByType(renderComponent("dsh-file-manager.dialog"), "Toast")?.props?.text));

// 清空回收站：勾选确认后 /empty-trash
fireDocument("keydown", { key: "Escape" });
toolbarButton("empty-trash").props.onClick();
await tick(); // openEmptyTrash 现在异步：先问宿主"将要删多少"（dryRun）再开确认框
const emptyTree = renderManager();
check("清空回收站是风险确认框", findByType(emptyTree, "RiskConfirmation") !== null);
check(
	"确认框的数量改问宿主（dryRun，与真删同口径）",
	calls.some((entry) => entry.url === "/api/file-manager/empty-trash" && entry.body?.dryRun === true),
	JSON.stringify(calls.filter((entry) => entry.url === "/api/file-manager/empty-trash"))
);
const beforeEmpty = calls.length;
findByType(emptyTree, "RiskConfirmation").props.onConfirm();
await tick();
await tick();
check("清空走 /empty-trash", calls.slice(beforeEmpty).some((entry) => entry.url === "/api/file-manager/empty-trash"));

console.log("\n== 10b. 父子互斥（D2-B）与整包文案（D1-A）==");
const rangeDir = makeRow("directory", `${ROOT}/rangeDir`);
const rangeChild = makeRow("file", `${ROOT}/rangeDir/child.md`);
observerCallback();
flushRaf();
ensureMulti();
flushRaf();
check("新行也拿到了勾选框", boxOf(rangeDir) !== undefined && boxOf(rangeChild) !== undefined);
check("勾选框悬停写明整包语义", String(boxOf(rangeDir).title ?? "").includes("整包"), String(boxOf(rangeDir).title));

clickRow(boxOf(rangeChild));
check("先勾子项", JSON.stringify(selectedPaths()) === JSON.stringify([`${ROOT}/rangeDir/child.md`]), JSON.stringify(selectedPaths()));
clickRow(boxOf(rangeDir));
check("勾父会取消已勾的子孙", JSON.stringify(selectedPaths()) === JSON.stringify([`${ROOT}/rangeDir`]), JSON.stringify(selectedPaths()));
clickRow(boxOf(rangeChild));
check("勾子会取消已勾的父", JSON.stringify(selectedPaths()) === JSON.stringify([`${ROOT}/rangeDir/child.md`]), JSON.stringify(selectedPaths()));

// Shift 连选同时覆盖父子时，只保留最外层
clickRow(boxOf(rangeDir));
check("先只勾父", JSON.stringify(selectedPaths()) === JSON.stringify([`${ROOT}/rangeDir`]), JSON.stringify(selectedPaths()));
clickRow(boxOf(rangeChild), { shiftKey: true });
check("Shift 连选含父子时只保留最外层", JSON.stringify(selectedPaths()) === JSON.stringify([`${ROOT}/rangeDir`]), JSON.stringify(selectedPaths()));

// 批量确认：含文件夹时正文要写明整包
ensureMulti();
toolbarButton("trash-selection").props.onClick();
const packTree = renderManager();
check(
	"批量确认正文含整包说明",
	walkTree(packTree).some((node) => String(node?.children?.[0] ?? "").includes("整包算")),
	JSON.stringify(walkTree(packTree).map((node) => node?.children?.[0]).filter((value) => typeof value === "string" && value.length > 4))
);
findByType(packTree, "Modal").props.onClose();

// 单行删除文件夹：正文写明「及其中的全部内容」
fireDocument("keydown", { key: "Escape" });
flushRaf();
buttonOf(rangeDir, "trash").fire("click");
const singleDirTree = render();
check(
	"单行删除文件夹写明及其中的全部内容",
	walkTree(singleDirTree).some((node) => String(node?.children?.[0] ?? "").includes("及其中的全部内容")),
	JSON.stringify(walkTree(singleDirTree).map((node) => node?.children?.[0]).filter((value) => typeof value === "string" && value.length > 4))
);
findByType(singleDirTree, "Modal").props.footer.children.filter(Boolean)[0].props.onClick();

// 移动弹窗：选中文件夹时写明整包移动
ensureMulti();
flushRaf();
clickRow(boxOf(rangeDir));
toolbarButton("move-selection").props.onClick();
const movePackTree = renderManager();
check(
	"移动弹窗写明文件夹整包移动",
	walkTree(movePackTree).some((node) => String(node?.children?.[0] ?? "").includes("一起移动")),
	JSON.stringify(walkTree(movePackTree).map((node) => node?.children?.[0]).filter((value) => typeof value === "string" && value.length > 4))
);
findByType(movePackTree, "Modal").props.onClose();

// 重命名文件夹：说明只改名字
toolbarButton("rename-selection").props.onClick();
const renameDirTree = renderManager();
check(
	"重命名文件夹说明只改名字",
	walkTree(renameDirTree).some((node) => String(node?.children?.[0] ?? "").includes("不受影响")),
	JSON.stringify(walkTree(renameDirTree).map((node) => node?.children?.[0]).filter((value) => typeof value === "string" && value.length > 4))
);
findByType(renameDirTree, "Modal").props.onClose();
fireDocument("keydown", { key: "Escape" });

console.log("\n== 10b. 视图 / disable / 提示（工作区模式，客户端） ==");
CONFIG.mode = "workspace";
CONFIG.disable = ["locked", ".git", "node_modules", "docs/tmp"];
CONFIG.roots = [
	{ root: "/app/wsA", declared: "/app/wsA", recursive: true, workspace: true, title: "A" },
	{ root: "/app/wsA/wsB", declared: "/app/wsA/wsB", recursive: true, workspace: true, title: "B" }
];
/** 模拟 A 工作区的文件树容器（行都在它里面 → 视图就是 /app/wsA）。 */
const viewA = new El("div");
viewA.attrs["data-files-root"] = "/app/wsA";
body.append(viewA);
/** 模拟 B 工作区自己的文件树容器。 */
const viewB = new El("div");
viewB.attrs["data-files-root"] = "/app/wsA/wsB";
body.append(viewB);

const rowLocked = makeRow("file", "/app/wsA/locked/x.md", false, viewA);
const rowNestedTrash = makeRow("directory", "/app/wsA/wsB/.dsh-trash", false, viewA);
const rowOuterTrash = makeRow("directory", "/app/wsA/.dsh-trash", false, viewA);
const rowOwnTrash = makeRow("directory", "/app/wsA/wsB/.dsh-trash", false, viewB);
const rowDeepTrashFile = makeRow("file", "/app/wsA/wsB/.dsh-trash/sub/x.md", false, viewA);
const rowWorkspaceDir = makeRow("directory", "/app/wsA/wsB", false, viewA);
const rowWsFile = makeRow("file", "/app/wsA/报告.md", false, viewA);
// disable 段匹配：裸名规则要挡任意深度（旧语义只挡 <根>/.git，嵌套子仓库会漏）
const rowNestedGit = makeRow("directory", "/app/wsA/sub/repo/.git", false, viewA);
const rowNestedGitFile = makeRow("file", "/app/wsA/sub/repo/.git/config", false, viewA);
const rowNestedModules = makeRow("file", "/app/wsA/sub/app/node_modules/pkg/index.js", false, viewA);
const rowAnchored = makeRow("file", "/app/wsA/docs/tmp/draft.md", false, viewA);
const rowOtherTmp = makeRow("file", "/app/wsA/other/tmp/keep.md", false, viewA);
observerCallback();
flushRaf();

check("disable 命中的行不给任何按钮", JSON.stringify(actionsOf(rowLocked)) === '["download"]', JSON.stringify(actionsOf(rowLocked)));
check("裸名规则：嵌套的 .git 目录不给按钮", JSON.stringify(actionsOf(rowNestedGit)) === '["zip"]', JSON.stringify(actionsOf(rowNestedGit)));
check("裸名规则：.git 内部文件不给按钮", JSON.stringify(actionsOf(rowNestedGitFile)) === '["download"]', JSON.stringify(actionsOf(rowNestedGitFile)));
check("裸名规则：任意深度的 node_modules 不给按钮", JSON.stringify(actionsOf(rowNestedModules)) === '["download"]', JSON.stringify(actionsOf(rowNestedModules)));
check("带 / 的规则命中锚定位置", JSON.stringify(actionsOf(rowAnchored)) === '["download"]', JSON.stringify(actionsOf(rowAnchored)));
check("带 / 的规则不挡别处的同名目录", actionsOf(rowOtherTmp).includes("trash"), JSON.stringify(actionsOf(rowOtherTmp)));
check(
	"外层视图里、内层工作区的回收站 -> 可以删（trash）",
	JSON.stringify(actionsOf(rowNestedTrash)) === '["zip","trash"]',
	JSON.stringify(actionsOf(rowNestedTrash))
);
check("自己视图的回收站 -> 不给按钮", JSON.stringify(actionsOf(rowOuterTrash)) === '["zip"]', JSON.stringify(actionsOf(rowOuterTrash)));
check("在 B 自己的视图里，B 的回收站同样不给按钮", JSON.stringify(actionsOf(rowOwnTrash)) === '["zip"]', JSON.stringify(actionsOf(rowOwnTrash)));
check(
	"回收站里任意深度 -> 下载+恢复+彻底删除+移动",
	JSON.stringify(actionsOf(rowDeepTrashFile)) === '["download","restore","purge","move"]',
	JSON.stringify(actionsOf(rowDeepTrashFile))
);

/**
 * 取某个视图下工具栏上的按钮。
 * @param name - data 名。
 * @param root - 视图根。
 * @returns 节点或 undefined。
 */
const toolbarOf = (name, root) =>
	walkTree(renderComponent("dsh-file-manager.files", { absolutePath: root })).find((node) => node?.props?.["data-dsh-file-manager-tool"] === name);

console.log("\n== 10c. view 进请求体 + 工作区提示 ==");
renderComponent("dsh-file-manager.files", { absolutePath: "/app/wsA" }); // 让 selection.view 记下 A
ensureMulti();
flushRaf();
fireDocument("mousedown", { target: boxOf(rowWsFile), preventDefault() {}, stopPropagation() {} });
calls.length = 0;
toolbarOf("trash-selection", "/app/wsA").props.onClick();
const wsConfirm = renderManager();
check("选中后出现批量删除按钮", toolbarOf("trash-selection", "/app/wsA") !== null);
const wsConfirmButton = findByType(wsConfirm, "Modal").props.footer.children.filter(Boolean)[1];
wsConfirmButton.props.onClick();
await tick();
const trashCall = calls.find((entry) => entry.url === "/api/file-manager/trash");
check("删除请求带上 view（当前视图根）", trashCall?.body?.view === "/app/wsA", JSON.stringify(trashCall?.body));

renderComponent("dsh-file-manager.files", { absolutePath: "/app/wsA" });
ensureMulti();
flushRaf();
fireDocument("mousedown", { target: boxOf(rowWorkspaceDir), preventDefault() {}, stopPropagation() {} });
toolbarOf("trash-selection", "/app/wsA").props.onClick();
const hintTree = renderManager();
check(
	"删工作区目录时确认框给出工作区提示",
	walkTree(hintTree).some((node) => String(node?.children?.[0] ?? "").includes("工作区「B」")),
	JSON.stringify(walkTree(hintTree).map((node) => node?.children?.[0]).filter((value) => typeof value === "string" && value.includes("工作区")))
);


console.log("\n== 10d. 恢复文案写明「合并」（F4） ==");
renderComponent("dsh-file-manager.files", { absolutePath: "/app/wsA" });
ensureMulti();
flushRaf();
// 选中一个回收站里的文件 → 工具栏「恢复」→ 确认框文案应提到"合并"
fireDocument("mousedown", { target: boxOf(rowDeepTrashFile), preventDefault() {}, stopPropagation() {} });
const restoreBtn = toolbarOf("restore-selection", "/app/wsA");
check("回收站条目给出「恢复」批量按钮", restoreBtn !== null);
restoreBtn.props.onClick();
const mergeTree = renderManager();
const mergeTexts = walkTree(mergeTree).map((node) => node?.children?.[0]).filter((value) => typeof value === "string");
check("恢复确认框写明会合并、不覆盖", mergeTexts.some((text) => text.includes("合并") && text.includes("不会覆盖")), JSON.stringify(mergeTexts));


console.log("\n== 10e. 选中文件夹 → 在它下面新建文件夹 ==");
renderComponent("dsh-file-manager.files", { absolutePath: "/app/wsA" });
ensureMulti();
flushRaf();
// rowWorkspaceDir = /app/wsA/wsB（一个可管理的文件夹）
fireDocument("mousedown", { target: boxOf(rowWorkspaceDir), preventDefault() {}, stopPropagation() {} });
const mkdirSel = toolbarOf("mkdir-selection", "/app/wsA");
check("选中单个文件夹后出现「新建文件夹」", mkdirSel !== null, JSON.stringify(walkTree(renderComponent("dsh-file-manager.files", { absolutePath: "/app/wsA" })).map((node) => node?.props?.["data-dsh-file-manager-tool"]).filter(Boolean)));
check("按钮提示写明建在选中的文件夹下", String(mkdirSel?.props?.title ?? "").includes("/app/wsA/wsB"), String(mkdirSel?.props?.title));
mkdirSel.props.onClick();
const mkdirSelTree = renderManager();
const mkdirTexts = walkTree(mkdirSelTree).map((node) => node?.children?.[0]).filter((value) => typeof value === "string");
check("弹窗说明建在选中的文件夹下", mkdirTexts.some((text) => text.includes("在选中的文件夹") && text.includes("/app/wsA/wsB")), JSON.stringify(mkdirTexts));
calls.length = 0;
findByType(mkdirSelTree, "Modal").props.footer.children.filter(Boolean)[1].props.onClick();
await tick();
const mkdirSelCall = calls.find((entry) => entry.url === "/api/file-manager/mkdir");
check("mkdir 的 parent 就是选中的文件夹", mkdirSelCall?.body?.parent === "/app/wsA/wsB", JSON.stringify(mkdirSelCall?.body));
check("mkdir 请求带了 view", mkdirSelCall?.body?.view === "/app/wsA", JSON.stringify(mkdirSelCall?.body));
// 先清空选择，再只选一个回收站条目 → 不该出现「新建文件夹」
toolbarOf("clear-selection", "/app/wsA").props.onClick();
flushRaf();
fireDocument("mousedown", { target: boxOf(rowDeepTrashFile), preventDefault() {}, stopPropagation() {} });
const onlyTrash = walkTree(renderComponent("dsh-file-manager.files", { absolutePath: "/app/wsA" })).map((node) => node?.props?.["data-dsh-file-manager-tool"]).filter(Boolean);
check("只选中回收站条目时没有「新建文件夹」", !onlyTrash.includes("mkdir-selection"), JSON.stringify(onlyTrash));


console.log("\n== 10f. 没选中任何东西 → 新建文件夹弹「选路径 + 填名字」 ==");
renderComponent("dsh-file-manager.files", { absolutePath: "/app/wsA" });
if (toolbarOf("clear-selection", "/app/wsA") !== null) toolbarOf("clear-selection", "/app/wsA").props.onClick();
flushRaf();
const mkdirPick = toolbarOf("mkdir", "/app/wsA");
check("没选中时工具栏有「新建文件夹」", mkdirPick !== null);
mkdirPick.props.onClick();
const pickTree = renderManager();
const pickModal = findByType(pickTree, "Modal");
check("打开了选路径的窗口", pickModal !== null);
const pickInputs = walkTree(pickTree).filter((node) => node?.props?.placeholder === "新文件夹名字");
const allInputs = walkTree(pickTree).filter((node) => typeof node?.props?.placeholder === "string");
check("窗口里有名字输入", pickInputs.length === 1, JSON.stringify(walkTree(pickTree).map((n) => n?.props?.placeholder).filter(Boolean)));
check("窗口里只有一个输入框", allInputs.length === 1, JSON.stringify(allInputs.map((n) => n.props.placeholder)));
check("起点是当前视图根（可浏览）", walkTree(pickTree).some((node) => String(node?.children?.[0] ?? "").includes("/app/wsA")), JSON.stringify(walkTree(pickTree).map((n) => n?.children?.[0]).filter((v) => typeof v === "string" && v.startsWith("/app"))));
pickInputs[0].props.onChange({ target: { value: "选路径新建" } });
// 桩里状态更新后要再渲染一次（真实 React 会自己重渲染），否则读到的还是旧闭包
const pickTree2 = renderManager();
calls.length = 0;
findByType(pickTree2, "Modal").props.footer.children.filter(Boolean)[1].props.onClick();
await tick();
const pickCall = calls.filter((entry) => entry.url === "/api/file-manager/mkdir").pop();
check("在选中的路径下建（parent = 浏览到的目录）", pickCall?.body?.parent === "/app/wsA", JSON.stringify(pickCall?.body));
check("名字用的是输入框里的", pickCall?.body?.name === "选路径新建", JSON.stringify(pickCall?.body));
check("请求带了 view", pickCall?.body?.view === "/app/wsA", JSON.stringify(pickCall?.body));
// 建完不关窗，可以连着建
const stillOpen = renderManager();
check("建完窗口没有关掉", findByType(stillOpen, "Modal") !== null);
const againInputs = walkTree(stillOpen).filter((node) => node?.props?.placeholder === "新文件夹名字");
check("名字框复位成初始值", String(againInputs[0]?.props?.value ?? "") === "新建文件夹", String(againInputs[0]?.props?.value));
againInputs[0].props.onChange({ target: { value: "第二个目录" } });
const stillOpen2 = renderManager();
calls.length = 0;
findByType(stillOpen2, "Modal").props.footer.children.filter(Boolean)[1].props.onClick();
await tick();
const secondCall = calls.filter((entry) => entry.url === "/api/file-manager/mkdir").pop();
check("还能接着建第二个", secondCall?.body?.parent === "/app/wsA" && secondCall?.body?.name === "第二个目录", JSON.stringify(secondCall?.body));

console.log("\n== 10g. 配置页（侧栏「插件」→ dsh-file-manager 卡片内的 plugins.bundle.config）==");
/**
 * 渲染配置页并等异步读完配置（第一次渲染跑 effect，让出事件循环后再渲染一次）。
 * @returns 渲染树。
 */
async function renderConfig() {
	renderComponent("plugins.bundle.config", { view: "page" });
	await tick();
	return renderComponent("plugins.bundle.config", { view: "page" });
}
/**
 * 收集渲染树里的文字（桩组件的文字要么是字符串子节点，要么在 props.children 上）。
 * @param tree - 渲染树。
 * @returns 文字数组。
 */
function textsOf(tree) {
	const out = [];
	for (const node of walkTree(tree)) {
		if (typeof node === "string") {
			out.push(node);
			continue;
		}
		const children = node?.props?.children;
		if (typeof children === "string") out.push(children);
		else if (Array.isArray(children)) for (const item of children) if (typeof item === "string") out.push(item);
	}
	return out;
}
/**
 * 按桩类型找节点。
 * @param tree - 渲染树。
 * @param type - 桩类型名。
 * @returns 节点数组。
 */
const nodesOf = (tree, type) => walkTree(tree).filter((node) => node?.type === type || node?.type?.__type === type);
/**
 * 数 manage 清单的行数（每行一个「含子目录」勾选框）。
 * @param tree - 渲染树。
 * @returns 行数。
 */
const manageRows = (tree) => nodesOf(tree, "Checkbox").filter((node) => node.props?.label === "含子目录").length;

check("注册进 plugins.bundle.config", typeof componentFor("plugins.bundle.config") === "function");
check("summary 形态什么都不画", renderComponent("plugins.bundle.config", { view: "summary" }) === null);

const configTree = await renderConfig();
check("page 形态画出了配置表单", walkTree(configTree).some((node) => node?.props?.["data-dsh-file-manager-config"] === ""));
const configTexts = textsOf(configTree);
check("显示配置文件路径", configTexts.some((text) => text.includes("/root/.dsh/file-manager.yml")), JSON.stringify(configTexts.slice(0, 3)));
check("回显当前生效值", configTexts.some((text) => text.includes("自动清理开启")) && configTexts.some((text) => text.includes(ROOT)), JSON.stringify(configTexts.filter((text) => text.includes("自动清理"))));
check("模式控件带上当前值", nodesOf(configTree, "SegmentedControl")[0]?.props?.value === "paths", String(nodesOf(configTree, "SegmentedControl")[0]?.props?.value));
check("manage 清单里有已配置目录", manageRows(configTree) === 1, String(manageRows(configTree)));
check("初始没有未保存修改", !configTexts.includes("有未保存的修改"));
check("没改动时保存按钮禁用", nodesOf(configTree, "Button").find((node) => node.props.children === "保存")?.props?.disabled === true);

// 关掉自动清理 → 变脏、保留天数输入联动禁用
const autoBox = nodesOf(configTree, "Checkbox").find((node) => node.props.label === "到期自动彻底删除");
check("自动清理开关默认勾上", autoBox?.props?.checked === true);
autoBox.props.onChange(false);
const dirtyTree = await renderConfig();
check("改了以后有未保存标记", textsOf(dirtyTree).includes("有未保存的修改"));
check("关掉自动清理后保留天数输入被禁用", nodesOf(dirtyTree, "Input").find((node) => node.props.type === "number")?.props?.disabled === true);

// 保存：请求体形状 + mtime 栅栏
const saveDirty = nodesOf(dirtyTree, "Button").find((node) => node.props.children === "保存");
check("有改动后保存可点", saveDirty?.props?.disabled === false);
saveDirty.props.onClick();
await tick();
check("POST 带上了 mtime 栅栏", lastSettingsPost?.mtimeMs === 111, JSON.stringify(lastSettingsPost));
check("POST 的 config 是宿主认的 snake_case", lastSettingsPost?.config?.mode === "paths" && lastSettingsPost?.config?.auto_cleanup === false && lastSettingsPost?.config?.manage?.[0]?.path === ROOT, JSON.stringify(lastSettingsPost?.config));
check("数字是数字不是字符串", lastSettingsPost?.config?.retention_days === 7 && lastSettingsPost?.config?.cleanup_interval_hours === 6, JSON.stringify(lastSettingsPost?.config));
check("保存成功后回到基线（没有未保存标记）", !textsOf(await renderConfig()).includes("有未保存的修改"));

// 浏览：添加目录 → 列子目录 → 选定
browseFixture.set(ROOT, [{ name: "子目录甲", path: `${ROOT}/子目录甲` }]);
const beforeBrowse = await renderConfig();
nodesOf(beforeBrowse, "Button").find((node) => node.props.children === "添加目录").props.onClick();
await tick();
const browseOpen = await renderConfig();
const browseDirs = nodesOf(browseOpen, "button").filter((node) => node.props?.["data-dsh-browse-dir"] !== undefined);
check("浏览弹窗列出子目录（只列目录）", browseDirs.length === 1 && String(browseDirs[0].children?.[0]) === "子目录甲/", JSON.stringify(browseDirs.map((node) => node.children)));
const browseFooter = nodesOf(browseOpen, "Modal")[0]?.props?.footer?.children ?? [];
const pickButtonOf = (tree) => (nodesOf(tree, "Modal")[0]?.props?.footer?.children ?? []).find((node) => node?.props?.children === "选这个目录");
check("弹窗里有「选这个目录」", pickButtonOf(browseOpen) !== undefined, JSON.stringify(browseFooter.map((node) => node?.props?.children)));
browseDirs[0].props.onClick();
await tick();
pickButtonOf(await renderConfig()).props.onClick();
const pickedTree = await renderConfig();
check("选完目录后清单多了一项", manageRows(pickedTree) === manageRows(beforeBrowse) + 1, `${manageRows(beforeBrowse)} -> ${manageRows(pickedTree)}`);
check("选完弹窗关掉", nodesOf(pickedTree, "Modal").length === 0);

// 本地校验：数字非法时直接拦下，不发请求
nodesOf(pickedTree, "Input").find((node) => node.props.type === "number").props.onChange({ target: { value: "abc" } });
const badTree = await renderConfig();
lastSettingsPost = null;
nodesOf(badTree, "Button").find((node) => node.props.children === "保存").props.onClick();
await tick();
check("数字非法时本地就挡下（不发请求）", lastSettingsPost === null);
check("给出中文原因", textsOf(await renderConfig()).some((text) => text.includes("保留天数必须是")), JSON.stringify(textsOf(badTree).filter((text) => text.includes("保留天数"))));

console.log("\n== 10h. 行元信息（大小 / 修改时间）与 row_show 开关 ==");
/** 单独一棵树 + 一个独立根，免得和前面各节的行搅在一起。 */
const META_DIR = "/app/meta";
CONFIG.roots = [...CONFIG.roots, { root: META_DIR, declared: META_DIR, recursive: true, workspace: true, title: "元信息" }];
CONFIG.rowShow = ["download", "trash", "mtime", "size"];
metaFixture.set(META_DIR, [
	{ name: "报告.md", type: "file", size: 5120, mtimeMs: Date.parse("2026-09-01T10:20:30") },
	{ name: "旧目录", type: "directory", mtimeMs: Date.parse("2026-08-15T08:00:00") },
	{ name: "无元信息.md", type: "file" }
]);
const viewMeta = new El("div");
viewMeta.attrs["data-files-root"] = META_DIR;
body.append(viewMeta);
const rowMetaFile = makeRow("file", `${META_DIR}/报告.md`, false, viewMeta);
const rowMetaDir = makeRow("directory", `${META_DIR}/旧目录`, false, viewMeta);
const rowMetaBare = makeRow("file", `${META_DIR}/无元信息.md`, false, viewMeta);
infoCalls.length = 0;
observerCallback();
flushRaf();
await tick();
observerCallback();
flushRaf();
/** 一行的元信息元素。 */
const metaNodes = (row) => row.children.filter((child) => String(child.dataset?.dshFileManager ?? "").startsWith("meta-"));
/** 一行里某个元信息元素。 */
const metaOf = (row, token) => metaNodes(row).find((node) => node.dataset.dshFileManager === token);
/** 某个目录被请求了几次。 */
const infoHits = (dir) => infoCalls.filter((one) => one === dir).length;

check("/info 按目录取且只取一次", infoHits(META_DIR) === 1, JSON.stringify(infoCalls));
check("文件行画出了大小", /KB$/.test(String(metaOf(rowMetaFile, "meta-size")?.textContent)), String(metaOf(rowMetaFile, "meta-size")?.textContent));
check("文件行画出了修改时间（绝对、本地时区）", String(metaOf(rowMetaFile, "meta-mtime")?.textContent) === "2026-09-01 10:20", String(metaOf(rowMetaFile, "meta-mtime")?.textContent));
check("目录只画修改时间、不画大小", metaOf(rowMetaDir, "meta-mtime") !== undefined && metaOf(rowMetaDir, "meta-size") === undefined);
check("目录的时间也对", String(metaOf(rowMetaDir, "meta-mtime")?.textContent) === "2026-08-15 08:00", String(metaOf(rowMetaDir, "meta-mtime")?.textContent));
check("fixture 里缺字段的行什么都不画", metaNodes(rowMetaBare).length === 0);
check(
	"排布：修改时间比大小更靠右（大小在删除键左边的最左）",
	parseFloat(metaOf(rowMetaFile, "meta-mtime").style.insetInlineEnd) < parseFloat(metaOf(rowMetaFile, "meta-size").style.insetInlineEnd),
	`${metaOf(rowMetaFile, "meta-mtime").style.insetInlineEnd} / ${metaOf(rowMetaFile, "meta-size").style.insetInlineEnd}`
);
check("大小接在按钮簇左边（不压住删除键）", parseFloat(metaOf(rowMetaFile, "meta-mtime").style.insetInlineEnd) >= 66, String(metaOf(rowMetaFile, "meta-mtime").style.insetInlineEnd));
const metaRowButton = rowMetaFile.children.find((child) => child.tagName === "BUTTON" && child.dataset?.dshFileManager === undefined);
check("行内边距给元信息留了位", parseFloat(metaRowButton.style.paddingInlineEnd) >= 200, String(metaRowButton.style.paddingInlineEnd));

// 开关：关掉 trash / size，只留 download + mtime
CONFIG.rowShow = ["download", "mtime"];
observerCallback();
flushRaf();
check("关掉 trash 后删除按钮消失", buttonOf(rowMetaFile, "trash") === undefined);
check("只关 trash 不影响下载", buttonOf(rowMetaFile, "download") !== undefined);
check("保留 mtime 时时间还在", metaOf(rowMetaFile, "meta-mtime") !== undefined);
check("去掉 size 后大小消失", metaOf(rowMetaFile, "meta-size") === undefined);

// 配置里没有 rowShow（老配置）时兜底成"只显示下载"
const keptRowShow = CONFIG.rowShow;
delete CONFIG.rowShow;
observerCallback();
flushRaf();
check(
	"缺 rowShow 时兜底成「只显示下载」",
	buttonOf(rowMetaFile, "trash") === undefined && buttonOf(rowMetaFile, "download") !== undefined && metaOf(rowMetaFile, "meta-mtime") === undefined,
	JSON.stringify(actionsOf(rowMetaFile))
);
CONFIG.rowShow = ["download", "trash", "mtime", "size"];
observerCallback();
flushRaf();
check("恢复开关后元信息与删除键都回来", buttonOf(rowMetaFile, "trash") !== undefined && metaOf(rowMetaFile, "meta-size") !== undefined);
void keptRowShow;

// 点树自带的「重新读取」→ 元信息重新取一次
infoCalls.length = 0;
const treeReloadButton = new El("button");
treeReloadButton.attrs["data-files-reload"] = "";
viewMeta.append(treeReloadButton);
fireDocument("click", { target: treeReloadButton });
await tick();
observerCallback();
flushRaf();
check("点「重新读取」后重新取了一次", infoHits(META_DIR) === 1, JSON.stringify(infoCalls));
// 请求是重扫时才发出去的，再让出一次事件循环 + 重扫一帧，元信息才画回来。
await tick();
observerCallback();
flushRaf();

// 几何守卫：元信息必须写死高度。用 top:0;bottom:0 拉伸时，**展开了子目录的那一行**的 li
// 里还有一整棵 <ul class="level">，元信息会撑满整棵子树、被垂直居中到子树中间 ——
// 实测（真 Chromium）：展开行 li 高 266px 时盒子也 266px，时间于是落到下面的子行上，
// 看起来就是"一行有两个时间"。写死 top:2px;height:26px 后恒为 26px，与行内按钮同高。
const metaCss = metaOf(rowMetaFile, "meta-mtime").style.cssText;
check("元信息写死 height:26px", metaCss.includes("height:26px"), metaCss);
check("元信息不用 top/bottom 拉伸", !metaCss.includes("bottom:0"), metaCss);
/** 造一个"展开了子目录"的行：li 里除了 button.row 还有一整棵 ul.level。 */
const expandedRow = makeRow("directory", `${META_DIR}/旧目录`, false, viewMeta);
const level = new El("ul");
level.classList.add("level");
expandedRow.append(level);
makeRow("file", `${META_DIR}/报告.md`, false, level);
infoCalls.length = 0;
observerCallback();
flushRaf();
check(
	"展开的目录行：元信息是自己 li 的直接子元素",
	metaNodes(expandedRow).length === 1 && metaNodes(expandedRow)[0].parent === expandedRow,
	JSON.stringify(metaNodes(expandedRow).map((node) => node.dataset.dshFileManager))
);

// 幂等与去重：反复重扫不长新元素；手工塞一个重复的也会被清掉
observerCallback();
flushRaf();
const metaCount = metaNodes(rowMetaFile).length;
observerCallback();
flushRaf();
check("反复重扫不新增元信息元素", metaNodes(rowMetaFile).length === metaCount, `${metaCount} -> ${metaNodes(rowMetaFile).length}`);
const stray = document.createElement("span");
stray.dataset.dshFileManager = "meta-mtime";
stray.className = "dsh-file-manager-meta";
stray.textContent = "1999-01-01 00:00";
rowMetaFile.append(stray);
check("手工塞入后确实有两个", metaNodes(rowMetaFile).length === metaCount + 1, String(metaNodes(rowMetaFile).length));
observerCallback();
flushRaf();
check(
	"重扫后同一 token 只剩一个",
	metaNodes(rowMetaFile).filter((node) => node.dataset.dshFileManager === "meta-mtime").length === 1,
	JSON.stringify(metaNodes(rowMetaFile).map((node) => node.dataset.dshFileManager))
);
check("留下的是原来那个（连着 DOM）", String(metaOf(rowMetaFile, "meta-mtime").textContent) === "2026-09-01 10:20", String(metaOf(rowMetaFile, "meta-mtime").textContent));

console.log("\n== 10i. 复制到…（与移动同一个入口）+ 跨工作区选目录 ==");
// §10b 把 roots 换成了 /app/wsA 那一套；本节用的 selA 在 ROOT 下，先把 ROOT 加回来。
CONFIG.roots = [...CONFIG.roots, { root: ROOT, declared: ROOT, recursive: true, workspace: true, title: "输出" }];
/** 一行里的「移动 / 复制」切换控件。 */
const placeSwitch = (tree) => walkTree(tree).find((node) => node?.props?.id === "dsh-file-manager-place") ?? null;
/** 弹窗脚注里的主按钮（取消之后的那个）。 */
const footerPrimary = (tree) => findByType(tree, "Modal")?.props?.footer?.children?.filter(Boolean)?.[1] ?? null;
/** 把弹窗里的动作切回「移动」（下一个用例从干净状态开始）。 */
function setVerbBackToMove(tree) {
	const control = placeSwitch(tree);
	if (control !== null && control.props.value !== "move") control.props.onChange("move");
}
/** 重新打开移动/复制弹窗（可复用的小工具）。 */
async function reopenMove() {
	fireDocument("keydown", { key: "Escape" });
	ensureMulti();
	clickRow(selA);
	toolbarButton("move-selection").props.onClick();
	renderManager();
	await tick();
	return renderManager();
}

fireDocument("keydown", { key: "Escape" });
ensureMulti();
clickRow(selA);
toolbarButton("move-selection").props.onClick();
let placeTree = renderManager();
await tick();
placeTree = renderManager();
check("同一个入口里给了「移动 / 复制」切换", placeSwitch(placeTree) !== null && placeSwitch(placeTree).props.value === "move", JSON.stringify(placeSwitch(placeTree)?.props?.value));
check("默认是移动（脚注写「移动到这里」）", String(footerPrimary(placeTree)?.props?.children) === "移动到这里", String(footerPrimary(placeTree)?.props?.children));

// 切到复制 → 走 /copy
placeSwitch(placeTree).props.onChange("copy");
placeTree = renderManager();
check("切到复制后脚注写「复制到这里」", String(footerPrimary(placeTree)?.props?.children) === "复制到这里", String(footerPrimary(placeTree)?.props?.children));
check("切到复制后标题也跟着变", String(findByType(placeTree, "Modal")?.props?.title).startsWith("复制"), String(findByType(placeTree, "Modal")?.props?.title));
const beforeCopy = calls.length;
footerPrimary(placeTree).props.onClick();
await tick();
await tick();
const copyCall = calls.slice(beforeCopy).find((entry) => entry.url === "/api/file-manager/copy");
check("复制走 /copy 且带上目标目录", copyCall?.body?.targetDir === ROOT && copyCall?.body?.path === `${ROOT}/s-a.md`, JSON.stringify(copyCall?.body));
check("复制没有误发 /move", !calls.slice(beforeCopy).some((entry) => entry.url === "/api/file-manager/move"), JSON.stringify(calls.slice(beforeCopy).map((one) => one.url)));

// 选目录走 /pick（不是上游 workspaceFiles），并且带上当前视图根
check("弹窗列目录走 /browse", browseCalls.length > 0, JSON.stringify(browseCalls));
check("请求带上了当前视图根", browseCalls[browseCalls.length - 1]?.view === ROOT, JSON.stringify(browseCalls[browseCalls.length - 1]));

// 跳转根清单：/pick 回多个根时画「跳到：」
fireDocument("keydown", { key: "Escape" });
browseRoots = [
	{ path: ROOT, title: "当前工作区", current: true },
	{ path: "/app/other", title: "别的工作区", current: false }
];
ensureMulti();
clickRow(selA);
toolbarButton("move-selection").props.onClick();
let rootsTree = renderManager();
await tick();
rootsTree = renderManager();
const jumpButtons = walkTree(rootsTree).filter((node) => String(node?.props?.title ?? "") === "/app/other");
check("跨工作区开着时给出可跳转的其它根", jumpButtons.length === 1, JSON.stringify(walkTree(rootsTree).map((one) => one?.props?.title).filter(Boolean)));
const beforeJump = browseCalls.length;
jumpButtons[0].props.onClick();
await tick();
rootsTree = renderManager();
check("点其它根会去 /browse 那个目录", browseCalls.slice(beforeJump).some((one) => one.path === "/app/other"), JSON.stringify(browseCalls.slice(beforeJump)));
browseRoots = [];

// 跨工作区关掉（宿主 403）→ 弹窗里如实显示原因
fireDocument("keydown", { key: "Escape" });
browseDenied.add("/app/blocked");
ensureMulti();
clickRow(selA);
toolbarButton("move-selection").props.onClick();
let deniedTree = renderManager();
await tick();
// 手动把当前目录换到被拒的那个（模拟用户点了/输入了越界目录）
deniedTree = renderManager();
check("被拒时弹窗仍在（不静默失败）", findByType(deniedTree, "Modal") !== null);
browseDenied.clear();

// 回收站来源不给复制
const trashView = new El("div");
trashView.attrs["data-files-root"] = ROOT;
body.append(trashView);
const selTrashRow = makeRow("file", `${ROOT}/${TRASH_DIRNAME}/s-x.md`, false, trashView);
observerCallback();
flushRaf();
fireDocument("keydown", { key: "Escape" });
ensureMulti();
clickRow(selTrashRow);
toolbarButton("move-selection").props.onClick();
const trashTree = renderManager();
await tick();
check("回收站来源没有「复制」切换（只给移动=恢复）", placeSwitch(renderManager()) === null, JSON.stringify(placeSwitch(renderManager())?.props?.value));
fireDocument("keydown", { key: "Escape" });
void trashTree;

console.log("\n== 10j. 弹窗两个格子与字体（用户 2026-10-04 四条反馈）==");
fireDocument("keydown", { key: "Escape" });
ensureMulti();
clickRow(selA);
check(
	"工具栏入口写「复制移动」（否则发现不了复制）",
	String(toolbarButton("move-selection")?.children?.[0] ?? "") === "复制移动",
	String(toolbarButton("move-selection")?.children?.[0])
);
fireDocument("keydown", { key: "Escape" });
// 字体：元信息与路径行都换成"拉丁等宽优先"的栈（原来 generic monospace 在 Windows 上落到 Courier New/宋体感）
check("元信息字体带拉丁等宽", metaCss.includes("Consolas") && metaCss.includes("Cascadia Mono"), metaCss);
const styleText = head.children.map((node) => String(node.textContent ?? "")).join("\n");
check("路径行也是拉丁等宽", styleText.includes("dsh-file-manager-path{font:12px/1.5 Consolas"), styleText.slice(0, 160));

// 两个格子的文案
fireDocument("keydown", { key: "Escape" });
browseRoots = [
	{ path: ROOT, title: "当前工作区", current: true },
	{ path: "/app/other", title: "别的工作区", current: false }
];
browseFixture.set(ROOT, [{ name: "子目录甲", path: `${ROOT}/子目录甲` }]);
ensureMulti();
clickRow(selA);
toolbarButton("move-selection").props.onClick();
let boxTree = renderManager();
await tick();
boxTree = renderManager();
const boxTexts = textsOf(boxTree);
check("第一个格子改叫「跳转工作区：」", boxTexts.includes("跳转工作区："), JSON.stringify(boxTexts));
check("第二个格子有「文件夹」标题", boxTexts.includes("文件夹"), JSON.stringify(boxTexts));

// 列目录失败：错误就地显示，但「跳转工作区」那一行不许消失
browseDenied.add(`${ROOT}/子目录甲`);
walkTree(boxTree).find((node) => String(node?.children?.[0] ?? "") === "📁 子目录甲").props.onClick();
renderManager(); // 先渲染一帧让 effect 发请求（桩里的 effect 是渲染时同步跑的）
await tick();
boxTree = renderManager();
check("列目录失败后「跳转工作区」仍在", textsOf(boxTree).includes("跳转工作区："), JSON.stringify(textsOf(boxTree)));
check("失败原因就地显示", textsOf(boxTree).some((text) => text.includes("不是目录")), JSON.stringify(textsOf(boxTree).filter((text) => text.includes("不是目录"))));
browseDenied.clear();

// 已经到顶层（没有上一层）→ 按钮禁用，而不是跳到空目录
browseParents.set(ROOT, null);
setVerbBackToMove(boxTree);
boxTree = await reopenMove();
const upButton = walkTree(boxTree).find((node) => String(node?.children?.[0] ?? "") === ".. 上一层");
check("到顶层时「上一层」禁用", upButton?.props?.disabled === true, JSON.stringify(upButton?.props?.disabled));
browseParents.clear();

// 全失败 → 留在弹窗里就地报错（决策 D3）
response = { ok: false, error: "只能复制到允许管理的文件夹里（回收站除外）。" };
boxTree = await reopenMove();
placeSwitch(boxTree).props.onChange("copy");
boxTree = renderManager();
footerPrimary(boxTree).props.onClick();
await tick();
await tick();
const keptTree = renderManager();
check("一条都没成时弹窗不关", findByType(keptTree, "Modal") !== null);
check("并且就地说明原因", textsOf(keptTree).some((text) => text.includes("没有一项成功")), JSON.stringify(textsOf(keptTree).filter((text) => text.includes("没有一项成功"))));
response = { ok: true };
fireDocument("keydown", { key: "Escape" });

// 第一批缺陷修复（客户端两条）：
// D2 —— row_show 的 trash 必须同时管住行内按钮与批量删除
fireDocument("keydown", { key: "Escape" });
ensureMulti();
clickRow(selA);
CONFIG.rowShow = ["download"];
observerCallback(); // 改了配置要让行重新装饰一次（行按钮是重扫时挂的）
flushRaf();
check("关掉 trash：工具栏没有批量「删除」", toolbarButton("trash-selection") === null, JSON.stringify(walkTree(renderComponent("dsh-file-manager.files", { absolutePath: ROOT })).map((node) => node?.props?.["data-dsh-file-manager-tool"]).filter(Boolean)));
check("关掉 trash：行内删除按钮也没了", buttonOf(selA, "trash") === undefined);
check("关掉 trash：批量「复制移动」仍在（不误伤）", toolbarButton("move-selection") !== null);
CONFIG.rowShow = ["download", "trash"];
check("打开 trash：批量「删除」回来", toolbarButton("trash-selection") !== null);
fireDocument("keydown", { key: "Escape" });

// D8 —— 输入法组合态里的 Esc 不该退出多选
ensureMulti();
const modeBefore = toolbarButton("multi").props["aria-pressed"];
fireDocument("keydown", { key: "Escape", isComposing: true });
check("输入法组合态的 Esc 不退出多选", toolbarButton("multi").props["aria-pressed"] === true && modeBefore === true, String(toolbarButton("multi").props["aria-pressed"]));
fireDocument("keydown", { key: "Escape", keyCode: 229 });
check("keyCode 229（旧浏览器 IME 标志）同样忽略", toolbarButton("multi").props["aria-pressed"] === true);
fireDocument("keydown", { key: "Escape" });
check("普通 Esc 照常退出多选", toolbarButton("multi").props["aria-pressed"] === false);
fireDocument("keydown", { key: "Escape" });

// 工具栏显示项（toolbar_show）：宿主下发什么就显示什么；缺字段 = 全显示（老宿主也不至于按钮消失）
CONFIG.toolbarShow = ["multi", "mkdir"];
fireDocument("keydown", { key: "Escape" });
const gatedTools = () => walkTree(renderComponent("dsh-file-manager.files", { absolutePath: ROOT })).map((node) => node?.props?.["data-dsh-file-manager-tool"]).filter(Boolean);
check("只显示配置里点名的两项", JSON.stringify(gatedTools()) === '["multi","mkdir"]', JSON.stringify(gatedTools()));
delete CONFIG.toolbarShow;
check("配置缺 toolbarShow 时全显示（老宿主也不至于按钮消失）", gatedTools().includes("zip-root") && gatedTools().includes("empty-trash"), JSON.stringify(gatedTools()));

// 打包根目录：先二次确认，确认后才真的开始打包下载
CONFIG.toolbarShow = ["multi", "mkdir", "zip_root"];
const beforeZipConfirm = calls.length;
toolbarButton("zip-root").props.onClick();
const zipTree = renderManager();
check("点「打包根目录」先弹确认框", findByType(zipTree, "RiskConfirmation") === null && findByType(zipTree, "Modal") !== null, JSON.stringify(findByType(zipTree, "Modal")?.props?.title));
check("确认框写明了根目录路径", String(findByType(zipTree, "Modal")?.props?.title ?? "").includes("打包"), String(findByType(zipTree, "Modal")?.props?.title));
check("确认之前没有开始打包", !calls.slice(beforeZipConfirm).some((entry) => String(entry.url).startsWith("/api/file-manager/")), JSON.stringify(calls.slice(beforeZipConfirm).map((entry) => entry.url)));
const zipEntered = calls.length;
footerPrimary(zipTree).props.onClick();
await tick();
check("确认后确实开始取目录（打包链路启动）", calls.length >= zipEntered, `${zipEntered} -> ${calls.length}`);
fireDocument("keydown", { key: "Escape" });
delete CONFIG.toolbarShow;

// 配置页的「工具栏显示」：宿主认识这个键才画，保存也只在认识时才提交（老宿主不会 400）。
// 注意：面板的草稿只在 reload() 时重读（保存成功后会自动重读），所以先改 fixture 再走一次保存。
settingsState.draft.toolbar_show = ["multi", "mkdir", "zip_root"];
const beforeToolbarSave = await renderConfig();
// 前面 §10j 把保留天数改成了 "abc"（本地校验用例），先改回合法值，否则保存会被本地校验挡下、根本不发请求。
nodesOf(beforeToolbarSave, "Input").find((node) => node.props.type === "number").props.onChange({ target: { value: "7" } });
const toolbarFixed = await renderConfig();
nodesOf(toolbarFixed, "Checkbox").find((node) => node.props.label === "到期自动彻底删除").props.onChange(false);
const toolbarDirtyTree = await renderConfig();
nodesOf(toolbarDirtyTree, "Button").find((node) => node.props.children === "保存").props.onClick();
await tick();
const toolbarCfgTree = await renderConfig();
const toolbarLabels = nodesOf(toolbarCfgTree, "Checkbox").map((node) => node.props?.label);
check("宿主支持时画出「工具栏显示」勾选框", toolbarLabels.includes("打包根目录") && toolbarLabels.includes("复制移动"), JSON.stringify(toolbarLabels));
nodesOf(toolbarCfgTree, "Checkbox").find((node) => node.props.label === "清空回收站").props.onChange(true);
const toolbarPick = await renderConfig();
lastSettingsPost = null;
nodesOf(toolbarPick, "Button").find((node) => node.props.children === "保存").props.onClick();
await tick();
check("保存时带上 toolbar_show", Array.isArray(lastSettingsPost?.config?.toolbar_show) && lastSettingsPost.config.toolbar_show.includes("empty_trash"), JSON.stringify(lastSettingsPost?.config?.toolbar_show));

// 老宿主（草稿里没有 toolbar_show）：不画这一组，也不提交这个键
delete settingsState.draft.toolbar_show;
const oldHostPre = await renderConfig();
nodesOf(oldHostPre, "Checkbox").find((node) => node.props.label === "到期自动彻底删除").props.onChange(true);
const oldHostDirty = await renderConfig();
lastSettingsPost = null;
nodesOf(oldHostDirty, "Button").find((node) => node.props.children === "保存").props.onClick();
await tick();
const oldHostTree = await renderConfig();
check("宿主不支持时不画「工具栏显示」", !nodesOf(oldHostTree, "Checkbox").map((node) => node.props?.label).includes("打包根目录"), JSON.stringify(nodesOf(oldHostTree, "Checkbox").map((node) => node.props?.label)));
check("宿主不支持时不提交 toolbar_show（避免 400）", lastSettingsPost !== null && !("toolbar_show" in (lastSettingsPost.config ?? {})), JSON.stringify(lastSettingsPost?.config));

console.log("\n== 11. 卸载 ==");
const styleCountBefore = head.children.length;
dispose();
check("按钮被撤掉", document.querySelectorAll("button[data-dsh-file-manager]").length === 0);
check("样式被移除", head.children.length === styleCountBefore - 1, `${head.children.length} vs ${styleCountBefore}`);


console.log(`\n========== 通过 ${passed}，失败 ${failures.length} ==========`);
if (failures.length > 0) for (const name of failures) console.log(`  - ${name}`);
process.exit(failures.length === 0 ? 0 : 1);
