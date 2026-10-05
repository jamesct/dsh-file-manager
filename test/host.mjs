/**
 * dsh-file-manager 宿主半的功能自测（临时目录 + 假 ctx，不碰生产）。
 * 覆盖：软删/恢复/彻底删除/同名冲突/递归开关/自动清理，以及全部拒绝路径与符号链接穿透。
 */
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
const failures = [];
/**
 * 断言。
 * @param label - 用例名。
 * @param ok - 是否通过。
 * @param detail - 失败时附带的细节。
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

/** 假的工作区服务内容（测试里随时替换；插件在 apply 时抓到的是这个闭包）。 */
const registryHolder = { workspaces: [], fail: false };

const root = await mkdtemp(join(tmpdir(), "trash-test-"));
const base = join(root, "base");
const outputs = join(base, "outputs");
const secret = join(base, "secret");
const configPath = join(root, "file-manager.yml");
/** 回收站目录名：默认值，只有"默认值断言"用得到；拼路径一律走 TRASH_DIR。 */
const TRASH_NAME = ".dsh-trash";
/** 默认回收站的绝对路径。 */
const TRASH_DIR = join(outputs, TRASH_NAME);

await mkdir(join(outputs, "sub", "deep"), { recursive: true });
await mkdir(secret, { recursive: true });
await writeFile(join(outputs, "a.md"), "A1\n");
await writeFile(join(outputs, "f.md"), "F\n");
await writeFile(join(outputs, "conflict.md"), "ORIGINAL\n");
await writeFile(join(outputs, "sub", "b.md"), "B\n");
await writeFile(join(outputs, "sub", "deep", "c.md"), "C\n");
await writeFile(join(secret, "x.txt"), "SECRET\n");
await writeFile(join(base, "outside.md"), "OUTSIDE\n");
// outputs 里的符号链接指向外部目录 —— 穿透测试的主角
await symlink(secret, join(outputs, "link-out"));
// 固定修改时间，验证冲突改名用的是源文件 mtime
await utimes(join(outputs, "conflict.md"), new Date("2026-09-18T05:53:00"), new Date("2026-09-18T05:53:00"));

/**
 * 写配置。
 * @param text - YAML 内容。
 */
async function writeConfig(text) {
	await writeFile(configPath, text, "utf8");
	// 让 mtime 一定变化，避免同毫秒内改配置却不生效
	await utimes(configPath, new Date(), new Date());
}

await writeConfig(`mode: paths
manage:
  - path: ${outputs}
    recursive: true
retention_days: 7
cleanup_interval_hours: 6
`);

process.env.DSH_FILE_MANAGER_CONFIG = configPath;
/** 审计日志落点（默认是 <DSH_HOME>/file-manager.log，测试指到临时目录）。 */
const auditPath = join(root, "file-manager.log");
process.env.DSH_FILE_MANAGER_LOG = auditPath;

// ── 假 ctx：捕获路由 ──────────────────────────────────────────────────────────
const routes = new Map();
const logs = [];
const ctx = {
	connection: {
		fetch: {
			register(route) {
				if (routes.has(route.path)) throw new Error(`重复注册 ${route.path}`);
				routes.set(route.path, route);
				return () => routes.delete(route.path);
			}
		}
	},
	effect(fn) {
		const disposer = fn();
		return () => {
			if (typeof disposer === "function") disposer();
		};
	},
	logger: {
		info: (text) => logs.push(["info", text]),
		warn: (text) => logs.push(["warn", text]),
		error: (text) => logs.push(["error", text])
	},
	get: (name) =>
		name === "workspaceRegistry"
			? {
					list: () => {
						if (registryHolder.fail) throw new Error("boom");
						return registryHolder.workspaces;
					}
				}
			: undefined
};

// 直接加载源码（不再用副本 —— 副本曾经让我跑了一轮"假绿灯"）
const { apply } = await import("../lib/index.js");
apply(ctx);

/**
 * 调一次路由（自定义请求体）。
 * @param name - 路由名。
 * @param body - 请求体对象（config 不传）。
 * @returns {status, body}。
 */
async function callBody(name, body) {
	const route = routes.get(`/api/file-manager/${name}`);
	if (route === undefined) throw new Error(`路由未注册：${name}`);
	const init = body === undefined ? { method: "GET" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
	const response = await route.fetch(new Request(`http://localhost/api/file-manager/${name}`, init));
	return { status: response.status, body: await response.json() };
}

/**
 * 调一次路由（只带 path 的旧写法）。
 * @param name - config | trash | restore | purge | move | rename | mkdir | empty-trash。
 * @param path - 目标路径（config 不传）。
 * @returns {status, body}。
 */
async function call(name, path) {
	return callBody(name, name === "config" ? undefined : { path });
}

/**
 * 调一次 GET 路由并带上查询串（browse 用）。
 * @param name - 路由名。
 * @param query - 形如 `?path=...` 的查询串。
 * @returns {status, body}。
 */
async function callQuery(name, query) {
	const route = routes.get(`/api/file-manager/${name}`);
	if (route === undefined) throw new Error(`路由未注册：${name}`);
	const response = await route.fetch(new Request(`http://localhost/api/file-manager/${name}${query}`, { method: "GET" }));
	return { status: response.status, body: await response.json() };
}

/**
 * lstat 版存在性（不跟随符号链接）。
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
 * 读回收站元数据。
 * @returns 记录表。
 */
async function meta() {
	try {
		return JSON.parse(await readFile(join(TRASH_DIR, ".meta.json"), "utf8"));
	} catch {
		return {};
	}
}

/**
 * 读指定回收站的元数据。
 * @param dir - 回收站目录。
 * @returns 记录表。
 */
async function metaIn(dir) {
	try {
		return JSON.parse(await readFile(join(dir, ".meta.json"), "utf8"));
	} catch {
		return {};
	}
}

console.log("\n== 1. 路由注册与配置下发 ==");
check(
	"注册了 12 条路由",
	routes.size === 12 &&
		["config", "settings", "browse", "info", "trash", "restore", "purge", "move", "rename", "mkdir", "copy", "empty-trash"].every((name) => routes.has(`/api/file-manager/${name}`)),
	[...routes.keys()].join(",")
);
const cfg = await call("config");
check("config 返回 200", cfg.status === 200);
check("config 无错误", cfg.body.error === undefined, JSON.stringify(cfg.body.error));
check("roots 只有 outputs", cfg.body.roots.length === 1, JSON.stringify(cfg.body.roots));
check("declared 是拼接后的绝对路径", cfg.body.roots[0]?.declared === outputs, String(cfg.body.roots[0]?.declared));
check("recursive 透传", cfg.body.roots[0]?.recursive === true);

console.log("\n== 1b. 回收站目录名来自配置（不是写死的）==");

await writeConfig(`mode: paths
manage:
  - path: ${outputs}
    recursive: true
trash_dirname: .custom-trash
`);
await writeFile(join(outputs, "custom.md"), "C\n");
const customCfg = await call("config");
check("config 下发的目录名跟着配置走", customCfg.body.trashDirname === ".custom-trash", String(customCfg.body.trashDirname));
const customTrash = await call("trash", join(outputs, "custom.md"));
check(
	"搬进了配置指定的目录",
	customTrash.status === 200 && (await exists(join(outputs, ".custom-trash", "custom.md"))),
	JSON.stringify(customTrash.body)
);
check("没有落到默认目录", !(await exists(join(TRASH_DIR, "custom.md"))));
const customBack = await call("restore", join(outputs, ".custom-trash", "custom.md"));
check("也能从自定义目录恢复", customBack.status === 200 && (await exists(join(outputs, "custom.md"))), JSON.stringify(customBack.body));
await call("trash", join(outputs, "custom.md"));
await call("purge", join(outputs, ".custom-trash", "custom.md"));
await rm(join(outputs, ".custom-trash"), { recursive: true, force: true });
check("自定义目录用例自清理干净", !(await exists(join(outputs, "custom.md"))) && !(await exists(join(outputs, ".custom-trash"))));
await writeConfig(`mode: paths
manage:
  - path: ${outputs}
    recursive: true
`);
check("retentionDays = 7", cfg.body.retentionDays === 7);
check("默认目录名来自 DEFAULTS", cfg.body.trashDirname === TRASH_NAME, String(cfg.body.trashDirname));

console.log("\n== 2. 软删（含子目录里的文件） ==");
const t1 = await call("trash", join(outputs, "sub", "b.md"));
check("trash 子目录文件 200", t1.status === 200, JSON.stringify(t1.body));
check("按原相对路径镜像落点", t1.body.stored === "sub/b.md", String(t1.body.stored));
check("原位置已不存在", !(await exists(join(outputs, "sub", "b.md"))));
check("回收站里存在", await exists(join(TRASH_DIR, "sub", "b.md")));
check("元数据键 = 原相对路径", Object.keys(await meta()).includes("sub/b.md"), JSON.stringify(await meta()));
check("元数据记了 stored/type/deletedAt", (await meta())["sub/b.md"]?.deletedAt !== undefined);

const t2 = await call("trash", join(outputs, "a.md"));
check("trash 根下文件 200", t2.status === 200);
check("元数据键 = a.md", (await meta())["a.md"]?.stored === "a.md");

console.log("\n== 3. 同名冲突改名（用源文件 mtime） ==");
const t3a = await call("trash", join(outputs, "conflict.md"));
check("第一次删用原名", t3a.body.stored === "conflict.md", String(t3a.body.stored));
await writeFile(join(outputs, "conflict.md"), "SECOND\n");
await utimes(join(outputs, "conflict.md"), new Date("2026-09-18T05:53:00"), new Date("2026-09-18T05:53:00"));
const t3 = await call("trash", join(outputs, "conflict.md"));
check("冲突时改名成功", t3.status === 200, JSON.stringify(t3.body));
check("名字形如 conflict.<14位时间>.md", /^conflict\.\d{14}\.md$/.test(t3.body.stored ?? ""), String(t3.body.stored));
check("前缀是源文件 mtime 20260918", String(t3.body.stored).startsWith("conflict.20260918"), String(t3.body.stored));

console.log("\n== 4. 恢复 ==");
const r1 = await call("restore", join(TRASH_DIR, "sub", "b.md"));
check("restore 200", r1.status === 200, JSON.stringify(r1.body));
check("回到原相对路径 sub/b.md", r1.body.restoredTo === join(outputs, "sub", "b.md"), String(r1.body.restoredTo));
check("文件真的回来了", await exists(join(outputs, "sub", "b.md")));
check("回收站里没了", !(await exists(join(TRASH_DIR, "sub", "b.md"))));
check("元数据记录已清掉", (await meta())["sub/b.md"] === undefined);

console.log("\n== 5. 恢复冲突不覆盖 ==");
await writeFile(join(outputs, "sub", "b.md"), "NEWER\n");
await call("trash", join(outputs, "sub", "b.md"));
await writeFile(join(outputs, "sub", "b.md"), "OCCUPIED\n");
const r2 = await call("restore", join(TRASH_DIR, "sub", "b.md"));
check("恢复时改名", r2.status === 200 && r2.body.restoredTo !== join(outputs, "sub", "b.md"), JSON.stringify(r2.body));
check("占用者内容没被动", (await readFile(join(outputs, "sub", "b.md"), "utf8")) === "OCCUPIED\n");
check("恢复后的内容是新版", (await readFile(r2.body.restoredTo, "utf8")) === "NEWER\n", r2.body.restoredTo);

console.log("\n== 6. 彻底删除 ==");
const t4 = await call("trash", join(outputs, "f.md"));
check("先移入回收站", t4.status === 200);
const p1 = await call("purge", join(TRASH_DIR, "f.md"));
check("purge 200", p1.status === 200, JSON.stringify(p1.body));
check("回收站里真没了", !(await exists(join(TRASH_DIR, "f.md"))));
check("元数据也清了", (await meta())["f.md"] === undefined);

console.log("\n== 7. 拒绝路径 ==");
const bad = [
	["非绝对路径", "relative/x.md", 400],
	["回收站自身", TRASH_DIR, 403],
	["元数据文件", join(TRASH_DIR, ".meta.json"), 403],
	["允许范围外", join(secret, "x.txt"), 403],
	["不在允许范围内（base 自身）", join(base, "outside.md"), 403]
];
for (const [label, path, want] of bad) {
	const result = await call("trash", path);
	check(`trash 拒绝：${label} -> ${want}`, result.status === want, `得到 ${result.status} ${result.body.error ?? ""}`);
}
check("不存在的目标 -> 404", (await call("trash", join(outputs, "ghost.md"))).status === 404);

console.log("\n== 8. 路径穿越 ==");
const trav1 = await call("trash", join(outputs, "..", "secret", "x.txt"));
check("../secret/x.txt -> 403", trav1.status === 403, `得到 ${trav1.status}`);
const trav2 = await call("trash", join(outputs, "sub", "..", "..", "secret", "x.txt"));
check("sub/../../secret/x.txt -> 403", trav2.status === 403, `得到 ${trav2.status}`);
check("secret 没被动", (await readFile(join(secret, "x.txt"), "utf8")) === "SECRET\n");

console.log("\n== 9. 符号链接（最关键） ==");
// outputs/link-out -> secret；删 link-out/x.txt 必须被拒（父目录 realpath 不在 outputs 内）
const viaLink = await call("trash", join(outputs, "link-out", "x.txt"));
check("经符号链接删外部文件 -> 403", viaLink.status === 403, `得到 ${viaLink.status}`);
check("外部文件安然无恙", await exists(join(secret, "x.txt")));
// 删符号链接本身：搬走的是链接，不是它指向的目录
const tLink = await call("trash", join(outputs, "link-out"));
check("删符号链接本身 200", tLink.status === 200, JSON.stringify(tLink.body));
check("外部目录还在", await exists(join(secret, "x.txt")));
check("回收站里是个符号链接", (await lstat(join(TRASH_DIR, "link-out"))).isSymbolicLink());
// 彻底删除该链接：绝不能跟着链接把外部目录删掉
const pLink = await call("purge", join(TRASH_DIR, "link-out"));
check("彻底删除符号链接 200", pLink.status === 200, JSON.stringify(pLink.body));
check("链接本身没了", !(await exists(join(TRASH_DIR, "link-out"))));
check("外部目录与文件仍在（没被穿透）", await exists(join(secret, "x.txt")));

console.log("\n== 10. 回收站被换成符号链接 ==");
await rm(TRASH_DIR, { recursive: true, force: true });
await mkdir(join(base, "evil"), { recursive: true });
await writeFile(join(outputs, "f2.md"), "F2\n");
await symlink(join(base, "evil"), TRASH_DIR);
const evilResult = await call("trash", join(outputs, "f2.md"));
check("回收站是符号链接 -> 409", evilResult.status === 409, `得到 ${evilResult.status} ${evilResult.body.error ?? ""}`);
check("evil 目录仍为空", (await readdir(join(base, "evil"))).length === 0);
check("待删文件没被搬走", await exists(join(outputs, "f2.md")));
await rm(TRASH_DIR, { force: true });

console.log("\n== 11. 只有回收站里的条目能恢复/彻底删除 ==");
check("恢复普通文件 -> 403", (await call("restore", join(outputs, "f2.md"))).status === 403);
check("彻底删除普通文件 -> 403", (await call("purge", join(outputs, "f2.md"))).status === 403);
check("普通文件仍在", await exists(join(outputs, "f2.md")));

console.log("\n== 12. recursive: false 只允许直接子项 ==");
await mkdir(TRASH_DIR, { recursive: true });
await writeConfig(`mode: paths
manage:
  - path: ${outputs}
    recursive: false
retention_days: 7
cleanup_interval_hours: 6
`);
await new Promise((done) => setTimeout(done, 10));
const deepBlocked = await call("trash", join(outputs, "sub", "b.md"));
check("子目录里的文件 -> 403", deepBlocked.status === 403, `得到 ${deepBlocked.status} ${deepBlocked.body.error ?? ""}`);
const shallowOk = await call("trash", join(outputs, "sub"));
check("直接子目录本身 -> 200", shallowOk.status === 200, JSON.stringify(shallowOk.body));
check("整个子目录被搬进回收站", await exists(join(TRASH_DIR, "sub")));
check("元数据键 = sub", (await meta()).sub?.type === "directory", JSON.stringify(await meta()));
const subRestore = await call("restore", join(TRASH_DIR, "sub"));
check("目录也能整棵恢复", subRestore.status === 200 && (await exists(join(outputs, "sub", "deep", "c.md"))), JSON.stringify(subRestore.body));

console.log("\n== 13. 配置失效时 fail-safe ==");
await writeConfig("这不是: [合法的 yaml : : :\n  - broken\n");
await new Promise((done) => setTimeout(done, 10));
const brokenTrash = await call("trash", join(outputs, "f2.md"));
check("配置解析失败 -> 拒绝删除", brokenTrash.status === 409, `得到 ${brokenTrash.status} ${brokenTrash.body.error ?? ""}`);
check("文件仍在", await exists(join(outputs, "f2.md")));
const brokenCfg = await call("config");
check("config 带 error 且 roots 为空", brokenCfg.status === 200 && brokenCfg.body.error !== undefined && brokenCfg.body.roots.length === 0, JSON.stringify(brokenCfg.body));

console.log("\n== 14. 移动 ==");
await writeConfig(`mode: paths
manage:
  - path: ${outputs}
    recursive: true
`);
await writeFile(join(outputs, "move-me.md"), "MOVE\n");
await mkdir(join(outputs, "target"), { recursive: true });
const mv1 = await callBody("move", { path: join(outputs, "move-me.md"), targetDir: join(outputs, "target") });
check("移动成功", mv1.status === 200, JSON.stringify(mv1.body));
check("文件到了新目录", await exists(join(outputs, "target", "move-me.md")));
check("原位置没了", !(await exists(join(outputs, "move-me.md"))));

// 同名：自动加时间戳，绝不覆盖（与删除/恢复同一套规则）
await writeFile(join(outputs, "dup.md"), "SRC\n");
await writeFile(join(outputs, "target", "dup.md"), "EXIST\n");
await utimes(join(outputs, "dup.md"), new Date("2026-09-18T05:53:00"), new Date("2026-09-18T05:53:00"));
const mv2 = await callBody("move", { path: join(outputs, "dup.md"), targetDir: join(outputs, "target") });
check("同名移动不覆盖既有文件", (await readFile(join(outputs, "target", "dup.md"), "utf8")) === "EXIST\n");
check("同名移动用了源文件 mtime", mv2.body.stored === "dup.20260918055300.md", String(mv2.body.stored));

await mkdir(join(outputs, "tree", "inner"), { recursive: true });
const mv3 = await callBody("move", { path: join(outputs, "tree"), targetDir: join(outputs, "tree", "inner") });
check("不能移进自己的子目录 -> 400", mv3.status === 400, JSON.stringify(mv3.body));
await writeFile(join(outputs, "guard.md"), "GUARD\n");
const mv4 = await callBody("move", { path: join(outputs, "guard.md"), targetDir: secret });
check("目标在允许范围外 -> 403", mv4.status === 403, JSON.stringify(mv4.body));
await mkdir(TRASH_DIR, { recursive: true });
const mv5 = await callBody("move", { path: join(outputs, "guard.md"), targetDir: TRASH_DIR });
check("不能移进回收站 -> 403", mv5.status === 403, JSON.stringify(mv5.body));
const mv7 = await callBody("move", { path: join(outputs, "guard.md"), targetDir: outputs });
check("目标就是当前目录 -> 400", mv7.status === 400, JSON.stringify(mv7.body));
check("被拒的移动没动文件", await exists(join(outputs, "guard.md")));

// 从回收站移出 = 恢复到指定位置，并清掉时间记录
await writeFile(join(outputs, "out-of-trash.md"), "OT\n");
await call("trash", join(outputs, "out-of-trash.md"));
check("移出前 meta 有记录", Object.keys(await meta()).includes("out-of-trash.md"));
const mv6 = await callBody("move", { path: join(TRASH_DIR, "out-of-trash.md"), targetDir: join(outputs, "target") });
check("从回收站移出成功", mv6.status === 200, JSON.stringify(mv6.body));
check("移出后在目标目录", await exists(join(outputs, "target", "out-of-trash.md")));
check("移出后 meta 记录清掉", !Object.keys(await meta()).includes("out-of-trash.md"));

console.log("\n== 15. 重命名 ==");
await writeFile(join(outputs, "old-name.md"), "R\n");
const rn1 = await callBody("rename", { path: join(outputs, "old-name.md"), name: "new-name.md" });
check("改名成功", rn1.status === 200, JSON.stringify(rn1.body));
check("新名字在", await exists(join(outputs, "new-name.md")));
check("旧名字没了", !(await exists(join(outputs, "old-name.md"))));

await writeFile(join(outputs, "taken.md"), "T\n");
const rn2 = await callBody("rename", { path: join(outputs, "new-name.md"), name: "taken.md" });
check("同名改名 -> 409", rn2.status === 409, JSON.stringify(rn2.body));
check("同名失败后原文件没动", await exists(join(outputs, "new-name.md")));

for (const [label, name] of [["带斜杠", "a/b.md"], ["点点", ".."], ["空名字", "   "], ["控制面", TRASH_NAME], ["元数据名", ".meta.json"]]) {
	const bad = await callBody("rename", { path: join(outputs, "new-name.md"), name });
	check(`非法名字被拒（${label}）`, bad.status === 400 || bad.status === 403, `${bad.status} ${JSON.stringify(bad.body)}`);
}
const rnSame = await callBody("rename", { path: join(outputs, "new-name.md"), name: "new-name.md" });
check("改成同名 = 幂等成功", rnSame.status === 200, JSON.stringify(rnSame.body));

// 决策 D4c：回收站里不改名
await writeFile(join(outputs, "to-trash.md"), "Z\n");
await call("trash", join(outputs, "to-trash.md"));
const rn3 = await callBody("rename", { path: join(TRASH_DIR, "to-trash.md"), name: "renamed-in-trash.md" });
check("回收站里改名 -> 403", rn3.status === 403, JSON.stringify(rn3.body));
check("回收站里的文件没动", await exists(join(TRASH_DIR, "to-trash.md")));
const rn4 = await callBody("rename", { path: join(base, "outside.md"), name: "x.md" });
check("允许范围外改名 -> 403", rn4.status === 403, JSON.stringify(rn4.body));

await mkdir(join(outputs, "dir-old", "kid"), { recursive: true });
await writeFile(join(outputs, "dir-old", "kid", "k.md"), "K\n");
const rn5 = await callBody("rename", { path: join(outputs, "dir-old"), name: "dir-new" });
check("目录改名连带整棵子树", rn5.status === 200 && (await exists(join(outputs, "dir-new", "kid", "k.md"))), JSON.stringify(rn5.body));

console.log("\n== 16. 新建文件夹 ==");
const mk1 = await callBody("mkdir", { parent: outputs, name: "fresh" });
check("新建成功", mk1.status === 200, JSON.stringify(mk1.body));
check("目录真的建了", (await lstat(join(outputs, "fresh"))).isDirectory() === true);
const mk2 = await callBody("mkdir", { parent: outputs, name: "fresh" });
check("同名新建 -> 409", mk2.status === 409, JSON.stringify(mk2.body));
const mk3 = await callBody("mkdir", { parent: secret, name: "nope" });
check("允许范围外新建 -> 403", mk3.status === 403, JSON.stringify(mk3.body));
const mk4 = await callBody("mkdir", { parent: TRASH_DIR, name: "in-trash" });
check("回收站里新建 -> 403", mk4.status === 403, JSON.stringify(mk4.body));
const mk5 = await callBody("mkdir", { parent: outputs, name: ".meta.json" });
check("控制面名字 -> 403", mk5.status === 403, JSON.stringify(mk5.body));
const mk6 = await callBody("mkdir", { parent: join(outputs, "sub", "deep"), name: "深处" });
check("子目录里也能建", mk6.status === 200 && (await exists(join(outputs, "sub", "deep", "深处"))), JSON.stringify(mk6.body));

console.log("\n== 17. 清空回收站 ==");
await writeFile(join(outputs, "e1.md"), "1\n");
await writeFile(join(outputs, "e2.md"), "2\n");
await call("trash", join(outputs, "e1.md"));
await call("trash", join(outputs, "e2.md"));
const beforeEmpty = (await readdir(TRASH_DIR)).filter((n) => n !== ".meta.json" && !n.startsWith(".meta.json.tmp-")).length;
check("清空前回收站非空", beforeEmpty >= 2, String(beforeEmpty));
const dry = await callBody("empty-trash", { dryRun: true });
check("dryRun 只数不删：报出将要删除的数量", dry.status === 200 && dry.body.dryRun === true && dry.body.removed === beforeEmpty, JSON.stringify(dry.body));
check("dryRun 之后回收站原封不动", (await exists(TRASH_DIR)) && (await readdir(TRASH_DIR)).includes("e1.md"));
const et = await callBody("empty-trash", {});
check("清空成功", et.status === 200, JSON.stringify(et.body));
check("清空数量与看到的条目一致（不含 .meta.json）", et.body.removed === beforeEmpty, `${et.body.removed} vs ${beforeEmpty}`);
check("整个回收站目录连元数据一起删掉", (await exists(TRASH_DIR)) === false);
const et2 = await callBody("empty-trash", {});
check("空回收站再清 -> removed 0", et2.status === 200 && et2.body.removed === 0, JSON.stringify(et2.body));
const et3 = await callBody("empty-trash", { root: secret });
check("指定不允许的 root -> 403", et3.status === 403, JSON.stringify(et3.body));

console.log("\n== 18. 自动清理（retention_days: 0，等第一次 tick） ==");
await writeConfig(`mode: paths
manage:
  - path: ${outputs}
    recursive: true
retention_days: 0
cleanup_interval_hours: 1
`);
await call("trash", join(outputs, "f2.md"));
await writeFile(join(TRASH_DIR, "orphan.txt"), "ORPHAN\n");
check("回收站里有 2 个条目", (await readdir(TRASH_DIR)).filter((n) => n !== ".meta.json").length === 2);
console.log("  等 24 秒让 sweep 跑第一轮…");
await new Promise((done) => setTimeout(done, 24000));
const left = (await readdir(TRASH_DIR)).filter((n) => n !== ".meta.json");
check("超过保留期的条目被清掉", left.length === 0, `剩下 ${JSON.stringify(left)}`);
check("元数据一并清空", Object.keys(await meta()).length === 0, JSON.stringify(await meta()));

console.log("\n== 19. 日志 ==");
check("有启用日志", logs.some(([, text]) => text.includes("已启用")));
check("有移入回收站日志", logs.some(([, text]) => text.includes("移入回收站")));
check("有自动清理日志", logs.some(([, text]) => text.includes("自动清理")));
check("没有 error 日志", !logs.some(([level]) => level === "error"), JSON.stringify(logs.filter(([level]) => level === "error")));


console.log("\n== 20. 工作区模式（mode: workspace） ==");
const wsA = join(root, "wsA");
const wsB = join(wsA, "wsB");
const wsC = join(root, "wsC");
await mkdir(join(wsB, "sub"), { recursive: true });
await mkdir(join(wsA, "plain"), { recursive: true });
await mkdir(wsC, { recursive: true });
await writeFile(join(wsA, "root.md"), "AR\n");
await writeFile(join(wsA, "wsB", "inner.md"), "IN\n");
await writeFile(join(wsA, "wsB", "sub", "deep.md"), "DEEP\n");
await writeFile(join(wsC, "sibling.md"), "SI\n");

registryHolder.workspaces = [
	{ path: wsA, title: "A" },
	{ path: wsB, title: "B" },
	{ path: wsC, title: "C" }
];
await writeConfig(`mode: workspace
workspace:
  scope: all
  recursive: true
`);
const wcfg = await call("config");
check("工作区模式：3 个根都在", wcfg.body.roots.length === 3, JSON.stringify(wcfg.body.roots));
check("根带 workspace 标记与标题", wcfg.body.roots.every((entry) => entry.workspace === true) && wcfg.body.roots.some((entry) => entry.title === "B"));
check("mode 下发为 workspace", wcfg.body.mode === "workspace", String(wcfg.body.mode));

console.log("\n== 21. 最长命中：内层工作区的东西进内层回收站 ==");
const w1 = await callBody("trash", { path: join(wsB, "inner.md"), view: wsA });
check("B 里的条目进 B 的回收站", w1.body.trashDir === join(wsB, TRASH_NAME), JSON.stringify(w1.body));
check("镜像落点 = 原相对路径", w1.body.stored === "inner.md", String(w1.body.stored));
check("物理位置在 B 的回收站", await exists(join(wsB, TRASH_NAME, "inner.md")));
const w1a = await callBody("trash", { path: join(wsA, "root.md"), view: wsA });
check("A 里的条目进 A 的回收站", w1a.body.trashDir === join(wsA, TRASH_NAME), JSON.stringify(w1a.body));

console.log("\n== 22. 镜像层级 + 深层逐项恢复 ==");
const w2 = await callBody("trash", { path: join(wsB, "sub"), view: wsA });
check("文件夹整体进回收站（保留内部结构）", w2.status === 200 && (await exists(join(wsB, TRASH_NAME, "sub", "deep.md"))), JSON.stringify(w2.body));
check("记录键 = 原相对路径 sub", (await metaIn(join(wsB, TRASH_NAME)))["sub"]?.type === "directory");
const deepRestore = await callBody("restore", { path: join(wsB, TRASH_NAME, "sub", "deep.md") });
check("里面的文件能单独恢复", deepRestore.status === 200 && deepRestore.body.restoredTo === join(wsB, "sub", "deep.md"), JSON.stringify(deepRestore.body));
check("文件回到原位", await exists(join(wsB, "sub", "deep.md")));
check("父记录仍在（整包恢复还可用）", (await metaIn(join(wsB, TRASH_NAME)))["sub"] !== undefined);
const wholeRestore = await callBody("restore", { path: join(wsB, TRASH_NAME, "sub") });
check("顶层条目仍能整包恢复", wholeRestore.status === 200, JSON.stringify(wholeRestore.body));

console.log("\n== 23. 纯容器：恢复/彻底删除 = 作用于覆盖的删除单元 ==");
await writeFile(join(wsA, "plain", "x.md"), "X\n");
await writeFile(join(wsA, "plain", "y.md"), "Y\n");
await callBody("trash", { path: join(wsA, "plain", "x.md"), view: wsA });
await callBody("trash", { path: join(wsA, "plain", "y.md"), view: wsA });
const plainKeys = Object.keys(await metaIn(join(wsA, TRASH_NAME)));
check("回收站里出现 plain 容器（两个单元）", (await exists(join(wsA, TRASH_NAME, "plain"))) && plainKeys.includes("plain/x.md") && plainKeys.includes("plain/y.md"), JSON.stringify(plainKeys));
const containerPurge = await callBody("purge", { path: join(wsA, TRASH_NAME, "plain") });
check("纯容器彻底删除：units = 2", containerPurge.status === 200 && containerPurge.body.units === 2, JSON.stringify(containerPurge.body));
check("容器被剪掉", !(await exists(join(wsA, TRASH_NAME, "plain"))));
check("这批记录清空", (await metaIn(join(wsA, TRASH_NAME)))["plain/x.md"] === undefined);

await writeFile(join(wsA, "plain", "x.md"), "X2\n");
await writeFile(join(wsA, "plain", "y.md"), "Y2\n");
await callBody("trash", { path: join(wsA, "plain", "x.md"), view: wsA });
await callBody("trash", { path: join(wsA, "plain", "y.md"), view: wsA });
const containerRestore = await callBody("restore", { path: join(wsA, TRASH_NAME, "plain") });
check(
	"纯容器恢复：两项都回到原位",
	containerRestore.status === 200 &&
		(await readFile(join(wsA, "plain", "x.md"), "utf8")) === "X2\n" &&
		(await readFile(join(wsA, "plain", "y.md"), "utf8")) === "Y2\n",
	JSON.stringify(containerRestore.body)
);

console.log("\n== 24. 视图规则（同一路径：A 能删 B 的回收站，B 不能删自己的） ==");
check("B 视图不能删自己的回收站", (await callBody("trash", { path: join(wsB, TRASH_NAME), view: wsB })).status === 403);
const byA = await callBody("trash", { path: join(wsB, TRASH_NAME), view: wsA });
check("A 视图能删 B 的回收站", byA.status === 200, JSON.stringify(byA.body));
check("镜像落点在 A 的回收站里（出处可见）", await exists(join(wsA, TRASH_NAME, "wsB", TRASH_NAME)));
check("A 视图不能删 A 自己的回收站", (await callBody("trash", { path: join(wsA, TRASH_NAME), view: wsA })).status === 403);
check("没有 view 时保守拒绝", (await callBody("trash", { path: join(wsA, TRASH_NAME) })).status === 403);
check("非法 view 也按保守处理", (await callBody("trash", { path: join(wsA, TRASH_NAME), view: join(root, "not-a-workspace") })).status === 403);

console.log("\n== 25. disable（工作区模式下的禁止清单） ==");
await writeConfig(`mode: workspace
workspace:
  scope: all
  recursive: true
  disable:
    - locked
`);
await mkdir(join(wsA, "locked"), { recursive: true });
await writeFile(join(wsA, "locked", "keep.md"), "KEEP\n");
check("disable 下发到客户端", (await call("config")).body.disable.includes("locked"));
check("disable 命中的不能删", (await callBody("trash", { path: join(wsA, "locked", "keep.md"), view: wsA })).status === 403);
check("disable 命中的不能新建", (await callBody("mkdir", { parent: join(wsA, "locked"), name: "nd", view: wsA })).status === 403);
check("disable 命中的不能改名", (await callBody("rename", { path: join(wsA, "locked", "keep.md"), name: "r.md", view: wsA })).status === 403);
await writeFile(join(wsA, "movable.md"), "M\n");
check("不能移动到 disable 的位置", (await callBody("move", { path: join(wsA, "movable.md"), targetDir: join(wsA, "locked"), view: wsA })).status === 403);
check("disable 命中的文件没被动", (await readFile(join(wsA, "locked", "keep.md"), "utf8")) === "KEEP\n");

console.log("\n== 25b. disable 段匹配：裸名规则挡任意深度（.git / node_modules），带 / 的锚定在根 ==");
await writeConfig(`mode: workspace
workspace:
  scope: all
  recursive: true
  disable:
    - .git
    - node_modules
    - docs/tmp
`);
await mkdir(join(wsA, "sub", "repo", ".git", "objects"), { recursive: true });
await writeFile(join(wsA, "sub", "repo", ".git", "objects", "pack.idx"), "P\n");
await mkdir(join(wsA, "sub", "app", "node_modules", "pkg"), { recursive: true });
await writeFile(join(wsA, "sub", "app", "node_modules", "pkg", "index.js"), "I\n");
await writeFile(join(wsA, "sub", "app", "ok.md"), "OK\n");
await mkdir(join(wsA, "docs", "tmp"), { recursive: true });
await writeFile(join(wsA, "docs", "tmp", "draft.md"), "D\n");
await mkdir(join(wsA, "other", "tmp"), { recursive: true });
await writeFile(join(wsA, "other", "tmp", "keep.md"), "K\n");
check("嵌套的 .git 目录不能删（旧语义会漏）", (await callBody("trash", { path: join(wsA, "sub", "repo", ".git"), view: wsA })).status === 403);
check(".git 内部的文件不能删", (await callBody("trash", { path: join(wsA, "sub", "repo", ".git", "objects", "pack.idx"), view: wsA })).status === 403);
check("任意深度的 node_modules 不能删", (await callBody("trash", { path: join(wsA, "sub", "app", "node_modules", "pkg", "index.js"), view: wsA })).status === 403);
check("嵌套的 .git 不能新建", (await callBody("mkdir", { parent: join(wsA, "sub", "repo", ".git"), name: "nd", view: wsA })).status === 403);
check("嵌套的 .git 不能移动进去", (await callBody("move", { path: join(wsA, "sub", "app", "ok.md"), targetDir: join(wsA, "sub", "repo", ".git"), view: wsA })).status === 403);
check("带 / 的规则命中锚定位置", (await callBody("trash", { path: join(wsA, "docs", "tmp", "draft.md"), view: wsA })).status === 403);
check("带 / 的规则不挡别处的同名目录", (await callBody("rename", { path: join(wsA, "other", "tmp", "keep.md"), name: "kept.md", view: wsA })).status === 200);
check("没命中规则的普通文件照常可改名（正面对照）", (await callBody("rename", { path: join(wsA, "sub", "app", "ok.md"), name: "ok2.md", view: wsA })).status === 200);
check(".git 里的东西一个字节没动", (await readFile(join(wsA, "sub", "repo", ".git", "objects", "pack.idx"), "utf8")) === "P\n");

console.log("\n== 26. 清空回收站按视图（A 的视图：清 A + 视图内嵌套的 B，不动 A 之外的 C） ==");
await writeConfig(`mode: workspace
workspace:
  scope: all
  recursive: true
`);
await writeFile(join(wsA, "for-a.md"), "A\n");
await writeFile(join(wsB, "for-b.md"), "B\n");
await writeFile(join(wsC, "for-c.md"), "C\n");
await callBody("trash", { path: join(wsA, "for-a.md"), view: wsA });
await callBody("trash", { path: join(wsB, "for-b.md"), view: wsA });
await callBody("trash", { path: join(wsC, "for-c.md"), view: wsC });
const emptied = await callBody("empty-trash", { view: wsA });
check("scope = view", emptied.body.scope === "view", JSON.stringify(emptied.body));
check("清了 A 和 B 两个回收站", emptied.body.cleared.length === 2, JSON.stringify(emptied.body.cleared));
check("A 的回收站空了", Object.keys(await metaIn(join(wsA, TRASH_NAME))).length === 0);
check("B 的实时回收站空了", Object.keys(await metaIn(join(wsB, TRASH_NAME))).length === 0);
check("C（视图外）的回收站没被动", Object.keys(await metaIn(join(wsC, TRASH_NAME))).length === 1, JSON.stringify(await metaIn(join(wsC, TRASH_NAME))));

console.log("\n== 27. 旧键 base / allow_delete 被忽略并提示 ==");
await writeConfig(`base: ${base}
allow_delete:
  - path: outputs
    recursive: true
`);
const legacy = await call("config");
check("base 已移除的提示", legacy.body.warnings.some((text) => text.includes("base 已移除")), JSON.stringify(legacy.body.warnings));
check("allow_delete 已改名的提示", legacy.body.warnings.some((text) => text.includes("allow_delete 已改名")), JSON.stringify(legacy.body.warnings));
check("旧键不产生任何根", legacy.body.roots.length === 0, JSON.stringify(legacy.body.roots));

console.log("\n== 28. 工作区服务异常 / 空列表 ==");
registryHolder.fail = true;
await writeConfig("mode: workspace\n");
const broken = await call("config");
check("registry 抛错 → 提示且不崩", broken.body.warnings.some((text) => text.includes("读取工作区列表失败")) && broken.body.roots.length === 0, JSON.stringify(broken.body.warnings));
registryHolder.fail = false;
registryHolder.workspaces = [];
await writeConfig("mode: workspace\n");
const emptyWs = await call("config");
check("工作区列表为空 → 提示且没有根", emptyWs.body.warnings.some((text) => text.includes("一个可用的工作区根都没有")) && emptyWs.body.roots.length === 0);

console.log("\n== 29. mode: paths 下 workspace 段被忽略 ==");
await writeConfig(`mode: paths
manage:
  - path: ${outputs}
    recursive: true
workspace:
  scope: all
`);
const pathsMode = await call("config");
check("提示 workspace 段被忽略", pathsMode.body.warnings.some((text) => text.includes("workspace 段被忽略")), JSON.stringify(pathsMode.body.warnings));
check("manage 仍然生效", pathsMode.body.roots.length === 1 && pathsMode.body.roots[0].recursive === true, JSON.stringify(pathsMode.body.roots));


console.log("\n== 30. 恢复时目录重名 → 合并（M2） ==");
const mergeRoot = join(root, "merge");
await mkdir(join(mergeRoot, "日报", "内层"), { recursive: true });
await writeFile(join(mergeRoot, "日报", "a.md"), "A1\n");
await writeFile(join(mergeRoot, "日报", "同.md"), "OLD\n");
await writeFile(join(mergeRoot, "日报", "内层", "深.md"), "DEEP\n");
await writeConfig(`mode: paths
manage:
  - path: ${mergeRoot}
    recursive: true
`);
const delFolder = await callBody("trash", { path: join(mergeRoot, "日报") });
check("先删掉整个文件夹", delFolder.status === 200 && delFolder.body.stored === "日报", JSON.stringify(delFolder.body));
// 原位重建同名文件夹：一个同名文件（内容不同）+ 一个独占文件
await mkdir(join(mergeRoot, "日报", "内层"), { recursive: true });
await writeFile(join(mergeRoot, "日报", "keep.md"), "KEEP\n");
await writeFile(join(mergeRoot, "日报", "同.md"), "NEW\n");
const mergedBack = await callBody("restore", { path: join(mergeRoot, TRASH_NAME, "日报") });
check("恢复报告 merged = true", mergedBack.status === 200 && mergedBack.body.merged === true, JSON.stringify(mergedBack.body));
check("独占文件被合并回来", (await readFile(join(mergeRoot, "日报", "a.md"), "utf8")) === "A1\n");
check("深层内容递归合并", (await readFile(join(mergeRoot, "日报", "内层", "深.md"), "utf8")) === "DEEP\n");
check(
	"现有文件一个字节没动",
	(await readFile(join(mergeRoot, "日报", "keep.md"), "utf8")) === "KEEP\n" && (await readFile(join(mergeRoot, "日报", "同.md"), "utf8")) === "NEW\n"
);
const mergedNames = await readdir(join(mergeRoot, "日报"));
check("同名文件给搬来那一份加了时间戳后缀", mergedNames.some((name) => /^同\.\d{14}\.md$/.test(name)), JSON.stringify(mergedNames));
check("回收站里的单元记录与目录都清掉了", !(await exists(join(mergeRoot, TRASH_NAME, "日报"))), JSON.stringify(await metaIn(join(mergeRoot, TRASH_NAME))));

console.log("\n== 31. 文件↔目录重名：给恢复的那一份加后缀 ==");
await writeFile(join(mergeRoot, "冲突"), "FILE\n");
check("先删这个文件", (await callBody("trash", { path: join(mergeRoot, "冲突") })).status === 200);
await mkdir(join(mergeRoot, "冲突"), { recursive: true });
await writeFile(join(mergeRoot, "冲突", "inner.md"), "IN\n");
const clash = await callBody("restore", { path: join(mergeRoot, TRASH_NAME, "冲突") });
check("恢复成功但没有覆盖目录", clash.status === 200 && clash.body.restoredTo !== join(mergeRoot, "冲突"), JSON.stringify(clash.body));
check("恢复出来的文件带后缀", /\/冲突\.\d{14}$/.test(String(clash.body.restoredTo)), String(clash.body.restoredTo));
check("现有目录没被动", (await readFile(join(mergeRoot, "冲突", "inner.md"), "utf8")) === "IN\n");

console.log("\n== 32. 从回收站「移动到…」同样合并（F3） ==");
await mkdir(join(mergeRoot, "目标", "移动源"), { recursive: true });
await writeFile(join(mergeRoot, "目标", "移动源", "y.md"), "Y\n");
await mkdir(join(mergeRoot, "移动源"), { recursive: true });
await writeFile(join(mergeRoot, "移动源", "x.md"), "X\n");
await callBody("trash", { path: join(mergeRoot, "移动源") });
const movedMerge = await callBody("move", { path: join(mergeRoot, TRASH_NAME, "移动源"), targetDir: join(mergeRoot, "目标") });
check("移动报告 merged = true", movedMerge.status === 200 && movedMerge.body.merged === true, JSON.stringify(movedMerge.body));
check(
	"内容合并进目标的同名文件夹",
	(await exists(join(mergeRoot, "目标", "移动源", "x.md"))) && (await readFile(join(mergeRoot, "目标", "移动源", "y.md"), "utf8")) === "Y\n"
);
check("回收站里清掉了", !(await exists(join(mergeRoot, TRASH_NAME, "移动源"))));

console.log("\n== 33. 配置编辑：读草稿 ==");
await writeConfig(`mode: paths
manage:
  - path: ${outputs}
    recursive: true
retention_days: 7
cleanup_interval_hours: 6
`);
const read1 = await callBody("settings", undefined);
check("settings GET 200", read1.status === 200, JSON.stringify(read1.body).slice(0, 200));
check("回的是配置文件路径", read1.body.path === configPath, String(read1.body.path));
check("草稿带 mode / manage", read1.body.draft?.mode === "paths" && read1.body.draft?.manage?.[0]?.path === outputs, JSON.stringify(read1.body.draft));
check("缺省的 auto_cleanup 补成 true", read1.body.draft?.auto_cleanup === true, JSON.stringify(read1.body.draft?.auto_cleanup));
check("带 mtime（保存时当并发栅栏）", typeof read1.body.mtimeMs === "number" && read1.body.mtimeMs > 0, String(read1.body.mtimeMs));
check("suggests 用当前根当起点", Array.isArray(read1.body.suggests) && read1.body.suggests.includes(outputs), JSON.stringify(read1.body.suggests));
check("effective 回显生效值", read1.body.effective?.mode === "paths" && read1.body.effective?.autoCleanup === true, JSON.stringify(read1.body.effective));

console.log("\n== 34. 配置编辑：保存（写盘 + 备份 + 热生效）==");
const save1 = await callBody("settings", {
	mtimeMs: read1.body.mtimeMs,
	config: {
		mode: "paths",
		manage: [{ path: outputs, recursive: true }],
		retention_days: 30,
		auto_cleanup: false,
		cleanup_interval_hours: 12,
		trash_dirname: ".custom-trash"
	}
});
check("保存 200", save1.status === 200, JSON.stringify(save1.body));
check("返回备份路径", typeof save1.body.backup === "string" && save1.body.backup.includes(".bak-"), String(save1.body.backup));
check("备份文件真的存在", await exists(String(save1.body.backup)));
const savedText = await readFile(configPath, "utf8");
check("落盘是带注释头的 YAML", savedText.startsWith("# dsh-file-manager 配置") && /mode: paths/.test(savedText), savedText.slice(0, 100));
const cfgAfter = await call("config");
check("热生效：保留天数 30", cfgAfter.body.retentionDays === 30, String(cfgAfter.body.retentionDays));
check("热生效：自动清理关", cfgAfter.body.autoCleanup === false, String(cfgAfter.body.autoCleanup));
check("热生效：回收站目录名换了", cfgAfter.body.trashDirname === ".custom-trash", String(cfgAfter.body.trashDirname));
const read2 = await callBody("settings", undefined);
check(
	"重新读到的草稿与写入一致",
	read2.body.draft?.retention_days === 30 && read2.body.draft?.auto_cleanup === false && read2.body.draft?.trash_dirname === ".custom-trash",
	JSON.stringify(read2.body.draft)
);

console.log("\n== 35. 配置编辑：并发栅栏 ==");
const stale = await callBody("settings", {
	mtimeMs: read2.body.mtimeMs - 60000,
	config: { mode: "paths", manage: [{ path: outputs, recursive: true }], retention_days: 7, auto_cleanup: true, cleanup_interval_hours: 6, trash_dirname: ".dsh-trash" }
});
check("过期 mtime 被拒（409）", stale.status === 409, `${stale.status} ${JSON.stringify(stale.body)}`);
check("被拒后文件没被动", (await readFile(configPath, "utf8")).includes("retention_days: 30"));

console.log("\n== 36. 配置编辑：严格校验（拒绝且一个字节都不写）==");
const beforeInvalid = await readFile(configPath, "utf8");
const invalidCases = [
	["未知键", { mode: "paths", manage: [{ path: outputs }], nonsense: 1 }],
	["mode 非法", { mode: "nope" }],
	["paths 下带 workspace", { mode: "paths", manage: [{ path: outputs }], workspace: { recursive: true } }],
	["manage 为空", { mode: "paths", manage: [] }],
	["manage 缺 path", { mode: "paths", manage: [{ recursive: true }] }],
	["相对路径", { mode: "paths", manage: [{ path: "outputs" }] }],
	["目录不存在", { mode: "paths", manage: [{ path: join(root, "没有这个目录") }] }],
	["不是目录", { mode: "paths", manage: [{ path: join(outputs, "a.md") }] }],
	["同一个目录写两次", { mode: "paths", manage: [{ path: outputs }, { path: outputs }] }],
	["保留天数超范围", { mode: "paths", manage: [{ path: outputs }], retention_days: 0 }],
	["回收站目录名带斜杠", { mode: "paths", manage: [{ path: outputs }], trash_dirname: "a/b" }],
	["回收站目录名是元数据名", { mode: "paths", manage: [{ path: outputs }], trash_dirname: ".meta.json" }],
	["自动清理开关不是布尔", { mode: "paths", manage: [{ path: outputs }], auto_cleanup: "yes" }],
	["workspace 下带 manage", { mode: "workspace", manage: [{ path: outputs }] }],
	["disable 用绝对路径", { mode: "workspace", workspace: { disable: ["/etc"] } }],
	["disable 用 ..", { mode: "workspace", workspace: { disable: ["../x"] } }],
	["workspace 未知键", { mode: "workspace", workspace: { scope: "all", whatever: 1 } }],
	["旧键 base", { mode: "paths", manage: [{ path: outputs }], base: "/x" }],
	["旧键 allow_delete", { mode: "paths", manage: [{ path: outputs }], allow_delete: true }]
];
for (const [label, config] of invalidCases) {
	const result = await callBody("settings", { config });
	check(`拒绝：${label}`, result.status === 400 && result.body.ok === false && typeof result.body.error === "string", `${result.status} ${JSON.stringify(result.body)}`);
}
check("一连串拒绝之后文件仍然没动", (await readFile(configPath, "utf8")) === beforeInvalid);

console.log("\n== 37. 配置编辑：workspace 模式 ==");
const saveWs = await callBody("settings", {
	config: {
		mode: "workspace",
		workspace: { scope: "all", recursive: true, disable: [".git", "node_modules"] },
		retention_days: 7,
		auto_cleanup: true,
		cleanup_interval_hours: 6,
		trash_dirname: ".dsh-trash"
	}
});
check("保存 workspace 模式 200", saveWs.status === 200, JSON.stringify(saveWs.body));
const wsDraft = await callBody("settings", undefined);
check(
	"草稿回的是 workspace 段",
	wsDraft.body.draft?.mode === "workspace" && wsDraft.body.draft?.workspace?.disable?.includes(".git") && wsDraft.body.draft?.manage === undefined,
	JSON.stringify(wsDraft.body.draft)
);

console.log("\n== 38. 目录浏览（配置页选路径）==");
registryHolder.workspaces = [{ path: outputs, title: "测试工作区" }];
await mkdir(join(outputs, "子目录甲"), { recursive: true });
await writeFile(join(outputs, "浏览用.txt"), "X\n");
const start = await callBody("browse", undefined);
check("无 path 时给起点建议", start.status === 200 && Array.isArray(start.body.suggests) && start.body.suggests.includes(outputs), JSON.stringify(start.body.suggests));
const outList = await callQuery("browse", `?path=${encodeURIComponent(outputs)}`);
check("列目录 200", outList.status === 200, JSON.stringify(outList.body).slice(0, 200));
const outNames = (outList.body.dirs ?? []).map((entry) => entry.name);
check("只列目录、不列文件", outNames.includes("sub") && !outNames.includes("a.md"), JSON.stringify(outNames));
check("每个条目都带绝对路径", (outList.body.dirs ?? []).every((entry) => entry.path === join(outputs, entry.name)));
check("parent 指回上级", outList.body.parent === base, String(outList.body.parent));
check("文件不是目录 → 400", (await callQuery("browse", `?path=${encodeURIComponent(join(outputs, "浏览用.txt"))}`)).status === 400);
check("不存在 → 404", (await callQuery("browse", `?path=${encodeURIComponent(join(root, "莫须有"))}`)).status === 404);
check("相对路径 → 400", (await callQuery("browse", "?path=outputs")).status === 400);

console.log("\n== 39. 关掉自动清理后，人工清空照常可用 ==");
await callBody("settings", {
	config: { mode: "paths", manage: [{ path: outputs, recursive: true }], retention_days: 7, auto_cleanup: false, cleanup_interval_hours: 6, trash_dirname: ".dsh-trash" }
});
await writeFile(join(outputs, "手动清.md"), "M\n");
const manualTrash = await callBody("trash", { path: join(outputs, "手动清.md") });
check("软删仍然可用", manualTrash.status === 200, JSON.stringify(manualTrash.body));
const manualEmpty = await callBody("empty-trash", {});
check("清空回收站仍然可用", manualEmpty.status === 200 && manualEmpty.body.removed >= 1, JSON.stringify(manualEmpty.body));

console.log("\n== 40. 插件展示元信息（侧栏「插件」页那张卡片的标题与简介）==");
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
check("package.json 有 description（英文兜底）", typeof manifest.description === "string" && manifest.description.trim() !== "");
check("exports 暴露 ./package.json（不导出的话宿主读不到任何展示信息）", manifest.exports?.["./package.json"] === "./package.json", JSON.stringify(manifest.exports));
check("exports 暴露 ./locale/*.json", manifest.exports?.["./locale/*.json"] === "./locale/*.json");
check("files 带上 locale/*.json（打包含进去）", Array.isArray(manifest.files) && manifest.files.includes("locale/*.json"), JSON.stringify(manifest.files));
const localeDir = new URL("../locale/", import.meta.url);
const localeNames = (await readdir(localeDir)).filter((name) => name.endsWith(".json")).sort();
check("有 en.json（词典入口，缺了整条词典链都不读）与 zh.json", localeNames.includes("en.json") && localeNames.includes("zh.json"), JSON.stringify(localeNames));
let metaShapeOk = true;
for (const name of localeNames) {
	const meta = JSON.parse(await readFile(new URL(name, localeDir), "utf8"))?.meta ?? {};
	if (typeof meta.title !== "string" || meta.title.trim() === "" || typeof meta.description !== "string" || meta.description.trim() === "") metaShapeOk = false;
}
check("每份词典的 meta.title / meta.description 都是非空字符串", metaShapeOk, JSON.stringify(localeNames));

console.log("\n== 41. 行元信息：大小与修改时间（GET /info）==");
await writeConfig(`mode: paths
manage:
  - path: ${outputs}
    recursive: true
row_show:
  - size
  - mtime
  - trash
  - download
`);
const infoCfg = await call("config");
check("row_show 下发到客户端（按固定顺序归一）", JSON.stringify(infoCfg.body.rowShow) === '["download","trash","mtime","size"]', JSON.stringify(infoCfg.body.rowShow));
await mkdir(join(outputs, "元信息目录", "子"), { recursive: true });
await writeFile(join(outputs, "元信息目录", "小.txt"), "12345");
await utimes(join(outputs, "元信息目录", "小.txt"), new Date("2026-09-01T10:20:30"), new Date("2026-09-01T10:20:30"));
const info = await callQuery("info", `?dir=${encodeURIComponent(join(outputs, "元信息目录"))}`);
check("info 200", info.status === 200, JSON.stringify(info.body).slice(0, 200));
const infoFile = (info.body.entries ?? []).find((entry) => entry.name === "小.txt");
const infoDir = (info.body.entries ?? []).find((entry) => entry.name === "子");
check("文件带 size", infoFile?.size === 5, JSON.stringify(infoFile));
check("文件带 mtimeMs（就是我们设的那个时间）", Math.abs((infoFile?.mtimeMs ?? 0) - Date.parse("2026-09-01T10:20:30")) < 2000, String(infoFile?.mtimeMs));
check("目录只有 mtime、没有 size", infoDir?.size === undefined && typeof infoDir?.mtimeMs === "number", JSON.stringify(infoDir));
check("每个条目都有 type", (info.body.entries ?? []).every((entry) => typeof entry.type === "string"));
check("默认不截断就不报 truncated", info.body.truncated === false, String(info.body.truncated));
check("允许根之外 → 403", (await callQuery("info", `?dir=${encodeURIComponent(secret)}`)).status === 403);
check("不是目录 → 400", (await callQuery("info", `?dir=${encodeURIComponent(join(outputs, "元信息目录", "小.txt"))}`)).status === 400);
check("不存在 → 404", (await callQuery("info", `?dir=${encodeURIComponent(join(root, "莫须有2"))}`)).status === 404);
check("相对路径 → 400", (await callQuery("info", "?dir=outputs")).status === 400);
check("缺 dir → 400", (await callQuery("info", "")).status === 400);
check("保存 row_show 成功", (await callBody("settings", { config: { mode: "paths", manage: [{ path: outputs, recursive: true }], row_show: ["size", "download"] } })).status === 200);
const rowDraft = await callBody("settings", undefined);
check("回读的草稿带 row_show", JSON.stringify(rowDraft.body.draft?.row_show) === '["download","size"]', JSON.stringify(rowDraft.body.draft?.row_show));
check("拒绝未知 row_show 取值", (await callBody("settings", { config: { mode: "paths", manage: [{ path: outputs, recursive: true }], row_show: ["nope"] } })).status === 400);
check("拒绝非数组 row_show", (await callBody("settings", { config: { mode: "paths", manage: [{ path: outputs, recursive: true }], row_show: "size" } })).status === 400);
await writeConfig(`mode: workspace
workspace:
  scope: all
  recursive: true
  disable:
    - .git
`);
registryHolder.workspaces = [{ path: outputs, title: "测试工作区" }];
await mkdir(join(outputs, ".git"), { recursive: true });
check("disable 命中的目录 → 403", (await callQuery("info", `?dir=${encodeURIComponent(join(outputs, ".git"))}`)).status === 403);
check("没写 row_show 时回默认（只有 download）", JSON.stringify((await call("config")).body.rowShow) === '["download"]', JSON.stringify((await call("config")).body.rowShow));

console.log("\n== 42. 复制到…（POST /copy）==");
await writeConfig(`mode: paths
manage:
  - path: ${outputs}
    recursive: true
`);
await mkdir(join(outputs, "复制目标"), { recursive: true });
await mkdir(join(outputs, "复制目标2"), { recursive: true });
await writeFile(join(outputs, "源.md"), "COPY\n");
const c1 = await callBody("copy", { path: join(outputs, "源.md"), targetDir: join(outputs, "复制目标") });
check("文件复制 200", c1.status === 200, JSON.stringify(c1.body));
check("副本内容一致", (await readFile(join(outputs, "复制目标", "源.md"), "utf8")) === "COPY\n");
check("源还在（复制不是移动）", await exists(join(outputs, "源.md")));
const c2 = await callBody("copy", { path: join(outputs, "源.md"), targetDir: join(outputs, "复制目标") });
check("重名给副本加时间戳后缀", c2.status === 200 && /^源\.\d{14}\.md$/.test(String(c2.body.stored)), String(c2.body.stored));
const c3 = await callBody("copy", { path: join(outputs, "源.md"), targetDir: outputs });
check("允许原地另存一份（同目录）", c3.status === 200 && c3.body.stored !== "源.md", JSON.stringify(c3.body));
await mkdir(join(outputs, "复制源目录", "内层"), { recursive: true });
await writeFile(join(outputs, "复制源目录", "a.md"), "A\n");
await writeFile(join(outputs, "复制源目录", "内层", "b.md"), "B\n");
const c4 = await callBody("copy", { path: join(outputs, "复制源目录"), targetDir: join(outputs, "复制目标") });
check("目录递归复制 200 且报了条目数（含目录自己）", c4.status === 200 && c4.body.entries === 4, JSON.stringify(c4.body));
check("深层内容也复制到了", (await readFile(join(outputs, "复制目标", "复制源目录", "内层", "b.md"), "utf8")) === "B\n");
check("源目录整棵还在", await exists(join(outputs, "复制源目录", "内层", "b.md")));
check("不能复制进自己", (await callBody("copy", { path: join(outputs, "复制源目录"), targetDir: join(outputs, "复制源目录") })).status === 400);
check("不能复制进自己的子目录", (await callBody("copy", { path: join(outputs, "复制源目录"), targetDir: join(outputs, "复制源目录", "内层") })).status === 400);
check("符号链接按链接复制（不跟随进树外）", await (async () => {
	await symlink(secret, join(outputs, "复制源目录", "链接"));
	const copied = await callBody("copy", { path: join(outputs, "复制源目录"), targetDir: join(outputs, "复制目标2") });
	const info = await lstat(join(outputs, "复制目标2", "复制源目录", "链接")).catch(() => undefined);
	return copied.status === 200 && info?.isSymbolicLink() === true;
})());
await writeFile(join(outputs, "进回收站.md"), "T\n");
await callBody("trash", { path: join(outputs, "进回收站.md") });
check("回收站里的条目不给复制", (await callBody("copy", { path: join(TRASH_DIR, "进回收站.md"), targetDir: outputs })).status === 403);
check("不能复制到回收站里", (await callBody("copy", { path: join(outputs, "源.md"), targetDir: TRASH_DIR })).status === 403);
check("源在允许根外 → 403", (await callBody("copy", { path: join(secret, "x.txt"), targetDir: outputs })).status === 403);
check("目标在允许根外 → 403", (await callBody("copy", { path: join(outputs, "源.md"), targetDir: secret })).status === 403);
check("目标不是目录 → 400", (await callBody("copy", { path: join(outputs, "源.md"), targetDir: join(outputs, "源.md") })).status === 400);
check("元数据文件不给复制", (await callBody("copy", { path: join(TRASH_DIR, ".meta.json"), targetDir: outputs })).status === 403);

console.log("\n== 43. 跨工作区开关（cross_workspace）+ 选目录（GET /browse）==");
await mkdir(join(outputs, "选目录测试"), { recursive: true });
await writeConfig(`mode: workspace
workspace:
  scope: all
  recursive: true
`);
registryHolder.workspaces = [
	{ path: wsA, title: "A" },
	{ path: wsB, title: "B" },
	{ path: wsC, title: "C" }
];
const crossOn = await call("config");
check("默认跨工作区是开的", crossOn.body.crossWorkspace === true, String(crossOn.body.crossWorkspace));
const browseA = await callQuery("browse", `?path=${encodeURIComponent(wsA)}&view=${encodeURIComponent(wsA)}`);
check("browse 列出子目录", browseA.status === 200 && Array.isArray(browseA.body.dirs), JSON.stringify(browseA.body).slice(0, 160));
check("browse 回 parent 绝对路径", browseA.body.parent === root, String(browseA.body.parent));
check("browse 给可跳转的根清单", (browseA.body.roots ?? []).some((entry) => entry.path === wsC), JSON.stringify(browseA.body.roots));
check("browse 标出当前视图根", (browseA.body.roots ?? []).filter((entry) => entry.current).length === 1, JSON.stringify(browseA.body.roots));
check("浏览允许根之外也放行（只读）", (await callQuery("browse", `?path=${encodeURIComponent(secret)}`)).status === 200);
await writeFile(join(wsA, "浏览用.txt"), "F\n");
check("浏览不是目录 → 400", (await callQuery("browse", `?path=${encodeURIComponent(join(wsA, "浏览用.txt"))}`)).status === 400);
check("浏览不存在 → 404", (await callQuery("browse", `?path=${encodeURIComponent(join(root, "莫须有3"))}`)).status === 404);
check("浏览相对路径 → 400", (await callQuery("browse", "?path=wsA")).status === 400);
await writeFile(join(wsA, "跨根.md"), "X\n");
check("开着的时候能移动到别的根", (await callBody("move", { path: join(wsA, "跨根.md"), targetDir: wsC, view: wsA })).status === 200);
check("开着的时候能复制到别的根", (await callBody("copy", { path: join(wsC, "跨根.md"), targetDir: wsA, view: wsA })).status === 200);

await writeConfig(`mode: workspace
workspace:
  scope: all
  recursive: true
cross_workspace: false
`);
const crossOff = await call("config");
check("关掉后下发 false", crossOff.body.crossWorkspace === false, String(crossOff.body.crossWorkspace));
const browseOff = await callQuery("browse", `?path=${encodeURIComponent(wsA)}&view=${encodeURIComponent(wsA)}`);
check("关掉后：浏览照样能用（只管写入）", browseOff.status === 200);
check("关掉后：跳转清单照样列出所有允许根", (browseOff.body.roots ?? []).some((entry) => entry.path === wsC), JSON.stringify(browseOff.body.roots));
check("关掉后：也能浏览别的根（只读）", (await callQuery("browse", `?path=${encodeURIComponent(wsC)}&view=${encodeURIComponent(wsA)}`)).status === 200);
await writeFile(join(wsA, "跨根2.md"), "Y\n");
check("关掉后：不能移动到别的根（写时才拦）", (await callBody("move", { path: join(wsA, "跨根2.md"), targetDir: wsC, view: wsA })).status === 403);
check("关掉后：不能复制到别的根", (await callBody("copy", { path: join(wsA, "跨根2.md"), targetDir: wsC, view: wsA })).status === 403);
check("关掉后：不能到别的根新建文件夹", (await callBody("mkdir", { parent: wsC, name: "新目录", view: wsA })).status === 403);
check("关掉后：自己根内照常新建", (await callBody("mkdir", { parent: join(wsA, "plain"), name: "新目录", view: wsA })).status === 200);
check("关掉后又没带视图 → 拒绝（无法判断边界）", (await callBody("copy", { path: join(wsA, "跨根2.md"), targetDir: wsA })).status === 403);
check("保存 cross_workspace 成功", (await callBody("settings", { config: { mode: "workspace", workspace: { scope: "all", recursive: true }, cross_workspace: false } })).status === 200);
check("回读草稿带 cross_workspace", (await callBody("settings", undefined)).body.draft?.cross_workspace === false);
check("拒绝非布尔 cross_workspace", (await callBody("settings", { config: { mode: "workspace", cross_workspace: "yes" } })).status === 400);

console.log("\n== 44. 第一批缺陷修复（D1 元数据留证 / D4 mode / D7 落点 / 审计日志）==");
// D1：损坏的 .meta.json 不再静默当空后覆盖 —— 改名留证，回收站继续能用
await writeConfig(`mode: paths
manage:
  - path: ${outputs}
    recursive: true
`);
await mkdir(TRASH_DIR, { recursive: true });
await writeFile(join(TRASH_DIR, ".meta.json"), "{ 这不是合法 JSON", "utf8");
await writeFile(join(outputs, "坏了也要能删.md"), "B\n");
const afterBroken = await callBody("trash", { path: join(outputs, "坏了也要能删.md") });
check("元数据损坏后删除仍然成功", afterBroken.status === 200, JSON.stringify(afterBroken.body));
const trashNames = await readdir(TRASH_DIR);
check("坏元数据被改名留证（不是删掉）", trashNames.some((name) => name.startsWith(".meta.json.corrupt-")), JSON.stringify(trashNames));
check("新的元数据只记新的一条", Object.keys(await meta()).length >= 1, JSON.stringify(await meta()));

// D4：保存配置保留原文件 mode
await chmod(configPath, 0o600);
const savedMode = await callBody("settings", { config: { mode: "paths", manage: [{ path: outputs, recursive: true }] } });
check("保存配置成功", savedMode.status === 200, JSON.stringify(savedMode.body));
check("保存后仍是 600（没被 umask 改成 644）", ((await stat(configPath)).mode & 0o777) === 0o600, String(((await stat(configPath)).mode & 0o777).toString(8)));

// D7：视图是一个"已注册但不在 manage 里"的目录时，拒绝而不是把回收站搬进它自己
const keepWs = registryHolder.workspaces;
registryHolder.workspaces = [{ path: root, title: "外层" }];
await writeConfig(`mode: paths
manage:
  - path: ${wsA}
    recursive: true
`);
await mkdir(join(wsA, TRASH_NAME), { recursive: true });
const selfMove = await callBody("trash", { path: join(wsA, TRASH_NAME), view: root });
check("落点算不出来时拒绝（不会 rename 到自己里面）", selfMove.status === 409, `${selfMove.status} ${JSON.stringify(selfMove.body)}`);
registryHolder.workspaces = keepWs;

// 审计日志：JSONL，一行一条，动作齐全
await writeConfig(`mode: paths
manage:
  - path: ${outputs}
    recursive: true
`);
await writeFile(join(outputs, "审计.md"), "A\n");
await call("trash", join(outputs, "审计.md"));
await callBody("restore", { path: join(TRASH_DIR, "审计.md") });
await callBody("mkdir", { parent: outputs, name: "审计目录" });
await callBody("copy", { path: join(outputs, "审计.md"), targetDir: outputs });
await call("trash", join(outputs, "审计.md"));
await callBody("purge", { path: join(TRASH_DIR, "审计.md") });
await callBody("empty-trash", {});
const auditLines = (await readFile(auditPath, "utf8")).trim().split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
const audited = auditLines.map((one) => one.action);
check("审计日志写进了文件", auditLines.length > 0, String(auditLines.length));
check("每条都有时间戳", auditLines.every((one) => typeof one.ts === "string" && one.ts.includes("T")), JSON.stringify(auditLines[0]));
for (const action of ["trash", "restore", "mkdir", "copy", "purge", "empty-trash"]) {
	check(`审计里有 ${action}`, audited.includes(action), JSON.stringify(audited));
}
check("审计条目带路径（能查清删的是哪一个）", auditLines.some((one) => one.action === "trash" && String(one.path).endsWith("审计.md")), JSON.stringify(auditLines.find((one) => one.action === "trash")));
check("dryRun 不写审计（只数不删）", auditLines.every((one) => one.dryRun !== true));

console.log("\n== 45. 工具栏显示项（toolbar_show） ==");
await writeConfig(`mode: paths
manage:
  - path: ${outputs}
    recursive: true
`);
const toolbarDefault = (await call("config")).body.toolbarShow;
check("默认全显示（11 项）", Array.isArray(toolbarDefault) && toolbarDefault.length === 11 && toolbarDefault.includes("zip_root"), JSON.stringify(toolbarDefault));
const toolbarSaved = await callBody("settings", {
	config: { mode: "paths", manage: [{ path: outputs, recursive: true }], toolbar_show: ["multi", "mkdir", "zip_root"] }
});
check("保存 toolbar_show 成功", toolbarSaved.status === 200, JSON.stringify(toolbarSaved.body));
const toolbarBack = await callBody("settings", undefined);
check("回读草稿按宿主顺序归一", JSON.stringify(toolbarBack.body.draft?.toolbar_show) === '["multi","mkdir","zip_root"]', JSON.stringify(toolbarBack.body.draft?.toolbar_show));
check("下发到客户端", JSON.stringify((await call("config")).body.toolbarShow) === '["multi","mkdir","zip_root"]', JSON.stringify((await call("config")).body.toolbarShow));
check("拒绝未知 toolbar_show 取值", (await callBody("settings", { config: { mode: "paths", manage: [{ path: outputs, recursive: true }], toolbar_show: ["nope"] } })).status === 400);
check("拒绝非数组 toolbar_show", (await callBody("settings", { config: { mode: "paths", manage: [{ path: outputs, recursive: true }], toolbar_show: "multi" } })).status === 400);
check("写回 YAML 里带上 toolbar_show", (await readFile(configPath, "utf8")).includes("toolbar_show"), (await readFile(configPath, "utf8")).slice(0, 200));
check("显式空数组 = 工具栏什么都不显示（合法）", (await callBody("settings", { config: { mode: "paths", manage: [{ path: outputs, recursive: true }], toolbar_show: [] } })).status === 200);
check("空数组确实下发成 []", JSON.stringify((await call("config")).body.toolbarShow) === "[]", JSON.stringify((await call("config")).body.toolbarShow));

console.log(`\n========== 通过 ${passed}，失败 ${failures.length} ==========`);
if (failures.length > 0) for (const name of failures) console.log(`  - ${name}`);
console.log(`临时目录：${root}`);
process.exit(failures.length === 0 ? 0 : 1);
