/**
 * dsh-file-manager — 客户端半（手写，不需要构建；React 与 ui-primitives 由 Harness 提供）。
 *
 * 做的事只有两件：
 *   1. 往文件树里「允许删除」的行上挂按钮 —— 普通文件夹里的条目挂「删除」（移入回收站目录），
 *      回收站第一层里的条目挂「恢复」与「彻底删除」，回收站自身与更深的层级什么都不挂。
 *   2. 把确认弹窗注册进 shell.overlay 全局插槽（Modal / RiskConfirmation / Toast / 图标
 *      全部取自 @deepseek-ai/dsh-client-ui-primitives，和 Harness 自带界面同款）。
 *
 * 为什么用 MutationObserver + 纯 DOM：文件树没有行级插槽（只有 sidebar.right.tab.files.actions
 * 这种整根目录级的），所以只能照 dsh-file-download 同款做法，在行元素上追加按钮。
 * 哪些行可删完全以宿主 /api/file-manager/config 为准，改配置后刷新页面即生效。
 */
window.__ModuleLoader__.load({
	id: "dsh-file-manager",
	factory: (require) => {
		const module = { exports: {} };
		const React = require("react");
		const { Button, Checkbox, fileSizeText, Input, Modal, RiskConfirmation, SegmentedControl, Toast } = require("@deepseek-ai/dsh-client-ui-primitives");

		const h = React.createElement;
		const SVG_NS = "http://www.w3.org/2000/svg";
		/** 行选择器：文件和文件夹都要（递归删除时子目录本身也可删）。 */
		const ROW = '[data-files-entry="file"][data-files-path],[data-files-entry="directory"][data-files-path]';
		/** 本插件挂的按钮。 */
		const MINE = "button[data-dsh-file-manager]";
		/** 下载插件挂的按钮（要和它错开位置，不能叠在一起）。 */
		/** 固定贴在最右 6px 的那组按钮（下载 / 打包）。 */
		const RIGHTMOST = 'button[data-dsh-file-manager="download"],button[data-dsh-file-manager="zip"]';
		const META_FILE = ".meta.json";
		/** 一个图标按钮占的横向步长。 */
		const ICON_STEP = 30;
		const CONFIG_URL = "/api/file-manager/config";
		/** 配置页的数据面（决策 D2：本插件自己的路由，不走 dsh 的 Loader 配置）。 */
		const SETTINGS_URL = "/api/file-manager/settings";
		/** 配置页「浏览…」用的目录列举路由（只列目录，配置页里没有会话可用）。 */
		const BROWSE_URL = "/api/file-manager/browse";
		/** 行元信息（大小 / 修改时间）路由。 */
		const INFO_URL = "/api/file-manager/info";
		/**
		 * 等宽字体栈。Windows 上界面字体是 **Calibri**，它的同族等宽就是 **Consolas**
		 * （同为微软 ClearType 家族），所以 Consolas 排第一 —— 用户 2026-10-04 明确要"这个字体家族的 monospace"。
		 * 原来只写 `ui-monospace,...,monospace`：generic monospace 在 Windows 上会落到
		 * Courier New（带衬线，看着像宋体）。
		 */
		const MONO_FONT = 'Consolas,"Cascadia Mono",ui-monospace,"SF Mono",Menlo,"DejaVu Sans Mono","Liberation Mono",monospace';
		/** 行上能显示的四项；顺序 = 宿主归一后的固定顺序。 */
		const ROW_TOKENS = ["download", "trash", "mtime", "size"];
		/** 工具栏能显示的各项（配置 `toolbar_show`；与宿主 TOOLBAR_TOKENS 必须一致）。 */
		const TOOLBAR_TOKENS = ["multi", "mkdir", "zip_root", "empty_trash", "download", "delete", "rename", "restore", "purge", "move", "clear"];
		/** 大小 / 修改时间两列的固定宽度（固定宽度才能免掉逐行测量带来的布局抖动）。 */
		const META_WIDTH = { size: 52, mtime: 104 };
		/**
		 * 元信息元素的几何（颜色走 CSS，宽度由 layout 逐项写）。
		 *
		 * ⚠️ 必须写死 `top:2px;height:26px`（与行内按钮同一套），**不能用 `top:0;bottom:0`**：
		 * 行是 `<li>`，**展开了子目录的 li 里还有一整棵 `<ul class="level">`**，
		 * 用 top/bottom 拉伸会让元信息撑满整棵子树、被垂直居中到子树中间 ——
		 * 于是那一行自己看不到时间，时间却出现在下面的子行上（看起来像"一行两个时间"）。
		 * 实测量过：展开行 li 高 266px 时，top/bottom 方案盒子高 266px；本方案恒为 26px。
		 */
		const META_GEOMETRY =
			`position:absolute;top:2px;height:26px;display:inline-flex;align-items:center;justify-content:flex-end;box-sizing:border-box;font:11px/1.5 ${MONO_FONT};white-space:nowrap;overflow:hidden;pointer-events:none;z-index:0`;
		/** 本插件挂的元信息元素。 */
		const META = 'span[data-dsh-file-manager="meta-size"],span[data-dsh-file-manager="meta-mtime"]';
		/** 回收站目录名的兜底值：真正来源是宿主配置的 trashDirname，这里只在配置还没读到时用一次。 */
		const DEFAULT_TRASH_DIRNAME = ".dsh-trash";

		/**
		 * 按钮几何一律走行内样式。踩过的坑：下载插件的样式表里有
		 *   .dsh-file-download-row>button:not([data-dsh-file-download]){padding-inline-end:42px}
		 * 优先级 0,2,1 高于我们的 button[data-dsh-file-manager]（0,1,1）；于是**文件行**里
		 * 26px 宽的按钮被塞进 42px 的右内边距，内容盒塌成 0，里面的 svg 作为 flex 子项
		 * 跟着缩到 0 宽——按钮还在、还能 hover 出 title 提示，但图标完全看不见。
		 * 行内样式（样式表里没有 !important 就压不过）才能保证几何不被别的插件改掉。
		 * 注意：这里只放几何，**不放 background/color**，否则会盖掉 CSS 里的 :hover 状态。
		 */
		const BUTTON_GEOMETRY = "position:absolute;top:2px;width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;padding:4px;border:0;border-radius:4px;box-sizing:border-box;cursor:pointer;z-index:1";

		/**
		 * 图标路径数据：直接从 @deepseek-ai/dsh-client-ui-primitives 的
		 * IconTrashOutlineRegular / IconUnarchiveOutlineRegular 抄来，保证与原生界面像素一致。
		 */
		const ICONS = {
			trash: {
				viewBox: "0 0 16 16",
				paths: [
					{ d: "M1.28149 3.88831H14.7187" },
					{
						d: "M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833"
					},
					{
						d: "M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831"
					},
					{ d: "M6.44946 6.98926V11.1238" },
					{ d: "M9.55054 6.98926V11.1238" }
				]
			},
			restore: {
				viewBox: "0 0 20 20",
				paths: [
					{
						d: "M15.8659 2.05975C17.2603 2.05995 18.3913 3.19096 18.3914 4.58527V5.4874C18.3914 6.02747 18.2192 6.52672 17.9303 6.93735C17.9336 6.96524 17.9388 6.99318 17.9388 7.02195V12.8884C17.9388 13.6345 17.9395 14.2379 17.8996 14.7254C17.8642 15.1593 17.7936 15.5499 17.6373 15.9141L17.5654 16.0685C17.278 16.6328 16.8405 17.1046 16.3038 17.434L16.0679 17.5661C15.66 17.7739 15.2196 17.8598 14.7237 17.9003C14.2362 17.9401 13.6327 17.9405 12.8867 17.9405H7.11122C6.36511 17.9405 5.76171 17.9401 5.27418 17.9003C4.84051 17.8649 4.44949 17.7952 4.08545 17.6391L3.93104 17.5661C3.36673 17.2785 2.89392 16.8414 2.56465 16.3044L2.43245 16.0685C2.22473 15.6608 2.13878 15.2211 2.09825 14.7254C2.05841 14.2379 2.05912 13.6345 2.05912 12.8884V7.02195C2.05912 6.99284 2.06422 6.96449 2.06758 6.93629C1.77931 6.52592 1.60858 6.02687 1.60858 5.4874V4.58527C1.60876 3.19084 2.73962 2.05975 4.1341 2.05975H15.8659ZM16.4984 7.92936C16.296 7.98169 16.0847 8.01288 15.8659 8.01291H4.1341C3.91478 8.01291 3.70246 7.98194 3.49955 7.92936V12.8884C3.49955 13.6582 3.50053 14.1927 3.53445 14.608C3.56769 15.0146 3.62923 15.244 3.71635 15.415L3.7925 15.5514C3.98339 15.8627 4.25749 16.1165 4.58464 16.2833L4.72529 16.3435C4.88095 16.3993 5.08638 16.4402 5.39158 16.4651C5.80685 16.4991 6.34138 16.5001 7.11122 16.5001H12.8867C13.6564 16.5001 14.1911 16.499 14.6063 16.4651C15.0128 16.432 15.2423 16.3703 15.4133 16.2833L15.5508 16.2061C15.8618 16.0152 16.116 15.7419 16.2827 15.415L16.3429 15.2732C16.3985 15.1177 16.4396 14.9128 16.4645 14.608C16.4985 14.1927 16.4984 13.6583 16.4984 12.8884V7.92936ZM4.1341 3.50019C3.53511 3.50019 3.0492 3.98631 3.04902 4.58527V5.4874C3.04902 6.08649 3.535 6.57248 4.1341 6.57248H15.8659C16.4648 6.57228 16.951 6.08638 16.951 5.4874V4.58527C16.9509 3.98644 16.4647 3.50038 15.8659 3.50019H4.1341Z",
						fill: true
					},
					{ d: "M10 14.1V10.1M7.85 12.05L10 9.9L12.15 12.05", round: true }
				]
			},
			move: {
				viewBox: "0 0 16 16",
				paths: [
					{ d: "M1.6 4.3h4.05l1.15 1.55h7.6v6.5H1.6z", round: true },
					{ d: "M5.5 9.2h4.6M8.3 7.3l2 1.9-2 1.9", round: true }
				]
			},
			download: {
				viewBox: "0 0 24 24",
				paths: [
					{ d: "M12 3v12M7 10l5 5 5-5", round: true },
					{ d: "M5 17v3h14v-3", round: true }
				]
			}
		};
		ICONS.purge = ICONS.trash;
		ICONS.zip = ICONS.download;

		const TITLES = {
			trash: "删除（移入回收站）",
			restore: "恢复",
			purge: "彻底删除（不可恢复）",
			move: "移动到…（从回收站移出 = 恢复到指定位置）",
			download: "下载",
			zip: "打包下载（ZIP）"
		};

		const CSS = `
.dsh-file-manager-row{position:relative}
/* 行元信息（大小 / 修改时间）：几何走行内样式，这里只给颜色/字色，免得被别的插件样式压掉几何。 */
.dsh-file-manager-meta{color:var(--dsw-alias-label-tertiary,currentColor);text-align:right}
/* 几何与 BUTTON_GEOMETRY 重复是故意的：这里保底 + 承载 background/color（:hover 要用），
   真正保证不被别的插件样式表压掉的是按钮上的行内样式。 */
button[data-dsh-file-manager]{position:absolute;top:2px;width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;padding:4px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary,currentColor);cursor:pointer;z-index:1}
button[data-dsh-file-manager]:hover{background:var(--dsw-alias-interactive-bg-hover,#8882)}
button[data-dsh-file-manager]:focus-visible{outline:2px solid var(--dsw-alias-label-primary,currentColor);outline-offset:1px}
button[data-dsh-file-manager]:disabled{opacity:.4;cursor:default}
button[data-dsh-file-manager] svg{width:16px;height:16px;pointer-events:none}
button[data-dsh-file-manager="purge"]:hover{color:var(--dsw-alias-label-error,#d33)}
/* 工具栏 / 预览栏里的文字按钮（插槽里是原生 DOM，样式自带） */
.dsh-file-manager-tool{border:0;border-radius:var(--dsw-radius-sm,4px);background:transparent;color:var(--dsw-alias-label-secondary,currentColor);font:12px/1.6 system-ui;padding:3px 8px;cursor:pointer;white-space:nowrap}
.dsh-file-manager-tool:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#8882);color:var(--dsw-alias-label-primary,inherit)}
.dsh-file-manager-tool:disabled{opacity:.4;cursor:default}
.dsh-file-manager-tool[data-dsh-transfer]{color:var(--dsw-alias-state-business-primary,currentColor)}
.dsh-file-manager-selected{background:var(--dsw-alias-interactive-bg-hover,#8882);border-radius:var(--dsw-radius-md,6px)}
.dsh-file-manager-toolbar{display:inline-flex;align-items:center;gap:2px;flex-wrap:nowrap;max-width:100%;overflow-x:auto}
.dsh-file-manager-count{font:12px/1.6 system-ui;color:var(--dsw-alias-label-tertiary,currentColor);padding:0 4px;white-space:nowrap}
.dsh-file-manager-input{box-sizing:border-box;width:100%;border:.5px solid var(--dsw-alias-border-l4,#8886);border-radius:var(--dsw-radius-sm,4px);background:var(--dsw-alias-button-elevated-fill,transparent);color:inherit;font:13px/1.6 system-ui;padding:4px 6px}
.dsh-file-manager-warn{color:var(--dsw-alias-label-warning,#b26a00)}
.dsh-file-manager-error{color:var(--dsw-alias-label-error,#d33);font:12px/1.5 system-ui;overflow-wrap:anywhere}
.dsh-file-manager-muted{color:var(--dsw-alias-label-tertiary,currentColor);font:12px/1.5 system-ui;overflow-wrap:anywhere}
.dsh-file-manager-path{font:12px/1.5 ${MONO_FONT};color:var(--dsw-alias-label-secondary,currentColor);overflow-wrap:anywhere}
.dsh-file-manager-rowlist{display:flex;flex-wrap:wrap;gap:4px;max-height:220px;overflow:auto;border:.5px solid var(--dsw-alias-border-l3,#8884);border-radius:var(--dsw-radius-sm,4px);padding:6px}
.dsh-file-manager-move{display:flex;flex-direction:column;gap:8px}
/* ── 配置页（侧栏「插件」→ dsh-file-manager 卡片里）──────────────────────────── */
.dsh-file-manager-config{display:flex;flex-direction:column;gap:14px;font:13px/1.6 system-ui;max-width:640px}
.dsh-file-manager-config-field{display:flex;flex-direction:column;gap:6px;align-items:flex-start}
.dsh-file-manager-config-label{font:12px/1.5 system-ui;color:var(--dsw-alias-label-secondary,currentColor)}
.dsh-file-manager-config-list{display:flex;flex-direction:column;gap:6px;width:100%}
.dsh-file-manager-config-row{display:flex;align-items:center;gap:8px;justify-content:space-between;width:100%;border:.5px solid var(--dsw-alias-border-l3,#8884);border-radius:var(--dsw-radius-sm,4px);padding:4px 8px;box-sizing:border-box}
.dsh-file-manager-config-row .dsh-file-manager-path{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-file-manager-config-side{display:flex;align-items:center;gap:6px;flex:0 0 auto}
.dsh-file-manager-chip{display:inline-flex;align-items:center;gap:4px;border:.5px solid var(--dsw-alias-border-l3,#8884);border-radius:999px;padding:1px 4px 1px 8px;font:12px/1.6 ui-monospace,monospace}
.dsh-file-manager-chip button{border:0;background:transparent;color:var(--dsw-alias-label-secondary,currentColor);cursor:pointer;font-size:13px;line-height:1;padding:0 2px}
.dsh-file-manager-config-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-file-manager-config-roots{display:flex;flex-direction:column;gap:2px;max-height:180px;overflow:auto;width:100%}
.dsh-file-manager-config-browse{display:flex;flex-direction:column;gap:8px;min-height:220px}
.dsh-file-manager-config-browse .dsh-file-manager-rowlist{max-height:260px;display:flex;flex-direction:column;flex-wrap:nowrap;gap:2px}
.dsh-file-manager-config-browse button[data-dsh-browse-dir]{display:block;width:100%;text-align:left;border:0;border-radius:var(--dsw-radius-sm,4px);background:transparent;color:inherit;font:13px/1.7 system-ui;padding:2px 6px;cursor:pointer}
.dsh-file-manager-config-browse button[data-dsh-browse-dir]:hover{background:var(--dsw-alias-interactive-bg-hover,#8882)}
`;

		/** 生效的宿主配置；拿到之前一个按钮都不挂。 */
		const state = { config: undefined, remote: undefined };

		// ── 弹窗与提示：模块级状态 + 订阅，唯一的 React 组件从订阅里取当前内容 ──────────
		let pending = null;
		let toastState = null;
		let toastSeq = 0;
		const listeners = new Set();

		/** 通知订阅者重绘。 */
		function notify() {
			for (const listener of listeners) listener();
		}

		/**
		 * 打开确认弹窗。
		 * @param dialog - {action, path, name, trashDirname, retentionDays}。
		 */
		function openDialog(dialog) {
			pending = dialog;
			notify();
		}

		/** 关闭确认弹窗。 */
		function closeDialog() {
			pending = null;
			notify();
		}

		/**
		 * 右下角提示（用 Harness 自带的 Toast，自动消失）。
		 * @param text - 文案。
		 * @param tone - 传 "success" 显示对勾。
		 */
		function showToast(text, tone) {
			toastSeq += 1;
			toastState = { key: toastSeq, text, tone };
			notify();
		}

		/**
		 * 清掉某个提示（Toast 到点了自己回调过来）。
		 * @param key - 提示序号。
		 */
		function clearToast(key) {
			if (toastState !== null && toastState.key === key) {
				toastState = null;
				notify();
			}
		}

		/** 触发文件树刷新（树自带重载按钮，点它最稳）。 */
		function reloadTree() {
			document.querySelector("[data-files-reload]")?.click();
		}

		/**
		 * 调宿主路由。
		 * @param action - trash | restore | purge。
		 * @param path - 目标绝对路径。
		 * @returns 宿主返回的数据。
		 */
		async function callHost(action, body, view) {
			// 允许直接传 path 字符串，或传完整对象（move/rename/mkdir/empty-trash 需要多个字段）。
			const payload = typeof body === "string" ? { path: body } : { ...(body ?? {}) };
			// view：客户端所在文件树的根。宿主用它做「按视图保护回收站」（决策 D11）。
			if (payload.view === undefined && typeof view === "string" && view !== "") payload.view = view;
			const response = await fetch(`/api/file-manager/${action}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload)
			});
			const data = await response.json().catch(() => ({}));
			if (!response.ok || data?.ok === false) throw new Error(data?.error ?? `操作失败（HTTP ${response.status}）`);
			// 写操作一律让行元信息缓存失效：可见的那几个目录会在下一帧按需重取，成本很小。
			clearMeta();
			return data;
		}

		// ══ 下载与 ZIP ══════════════════════════════════════════════════════════
		// 移植自社区插件 dsh-file-download v0.2.0（MIT License, Copyright (c) 2026
		// Aghasi Lorsabyan, https://github.com/lorsabyan/dsh-file-download）。
		// 改动：并入本插件的单文件 bundle；改走 ctx.remote.workspaceFiles 三个调用
		// （stat / readBytes / list）；ZIP 规划合并成一个 planZip，同时服务
		// 「文件下载 / 文件夹 ZIP / 打包当前根 / 多选打包」四个入口；状态提示改用本插件的 Toast。
		// ══════════════════════════════════════════════════════════════════════

		/** 每次 ranged read 的字节数。 */
		const CHUNK_BYTES = 1024 * 1024;
		/** 小于它就攒在内存里走浏览器普通下载，超过就必须走保存对话框。 */
		const BUFFER_LIMIT = 32 * 1024 * 1024;
		/** ZIP32 上限。 */
		const ZIP_LIMIT = 0xffffffff;
		const ZIP_ENTRY_LIMIT = 10000;
		const ZIP_METADATA_LIMIT = 8 * 1024 * 1024;
		const ZIP_MAX_DEPTH = 64;
		/** 决策 D1a=C：文件夹行也提供「打包 ZIP」；想关掉改成 false 即可。 */
		const FOLDER_ZIP = true;
		/** 同时最多几个下载。 */
		const TRANSFER_LIMIT = 2;

		const textEncoder = new TextEncoder();
		const textDecoder = new TextDecoder();
		const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
			let current = value;
			for (let bit = 0; bit < 8; bit += 1) current = (current >>> 1) ^ (current & 1 ? 0xedb88320 : 0);
			return current >>> 0;
		});

		/**
		 * 拆开 remote 的 `{ok,value}` / `{ok:false,error}` 信封。
		 * @param result - remote 调用结果。
		 * @returns 成功时的 value。
		 */
		function remoteValue(result) {
			if (result?.ok === true) return result.value;
			if (result?.ok === false) {
				const error = result.error;
				throw error instanceof Error ? error : new Error(error?.message ?? "服务器拒绝了这次操作。");
			}
			throw new Error("服务器返回了无法识别的结果。");
		}

		/**
		 * 取路径最后一段并清掉控制字符。
		 * @param path - 绝对路径。
		 * @returns 可安全用作文件名的名字。
		 */
		function fileNameOf(path) {
			const tail = String(path ?? "").split(/[\\/]/).pop() ?? "";
			return tail.replace(/[\u0000-\u001f\u007f]/g, "_") || "download";
		}

		/**
		 * 目录打包时的 ZIP 文件名。
		 * @param path - 目录绝对路径。
		 * @returns `<目录名>.zip`。
		 */
		function archiveNameOf(path) {
			return `${fileNameOf(path)}.zip`;
		}

		/**
		 * 校验 remote 报出的文件身份：中途被替换或改长度就中止。
		 * @param info - 本次信息。
		 * @param expected - 开始时记录的信息。
		 */
		function checkIdentity(info, expected) {
			if (info.version !== expected.version || info.absolutePath !== expected.absolutePath || info.bytes !== expected.bytes) {
				throw new Error("下载过程中文件被改动过，请重新下载。");
			}
		}

		/**
		 * stat 一个文件并校验字段。
		 * @param remote - remote.workspaceFiles 服务。
		 * @param sessionId - 属主会话 id。
		 * @param path - 文件绝对路径。
		 * @param signal - 中止信号。
		 * @returns `{bytes,version,absolutePath}`。
		 */
		async function fileInfoOf(remote, sessionId, path, signal) {
			signal.throwIfAborted();
			const info = remoteValue(await remote.stat(sessionId, path, signal));
			signal.throwIfAborted();
			if (!info || !Number.isSafeInteger(info.bytes) || info.bytes < 0 || typeof info.version !== "string" || typeof info.absolutePath !== "string" || info.absolutePath === "") {
				throw new Error("服务器没有报出合法的文件大小。");
			}
			return info;
		}

		/**
		 * 分块把一个文件写进 writer（每块都核对身份与偏移）。
		 * @param remote - remote.workspaceFiles 服务。
		 * @param sessionId - 属主会话 id。
		 * @param path - 文件绝对路径。
		 * @param expected - 开始时的 stat 信息。
		 * @param writer - 目标写入器。
		 * @param signal - 中止信号。
		 * @param progress - 进度回调 (done,total)。
		 */
		async function copyFileTo(remote, sessionId, path, expected, writer, signal, progress) {
			try {
				checkIdentity(await fileInfoOf(remote, sessionId, path, signal), expected);
				let offset = 0;
				while (offset < expected.bytes) {
					signal.throwIfAborted();
					const length = Math.min(CHUNK_BYTES, expected.bytes - offset);
					const page = remoteValue(await remote.readBytes(sessionId, path, { range: { offset, length } }, signal));
					signal.throwIfAborted();
					checkIdentity(page, expected);
					if (!(page.data instanceof Uint8Array) || page.offset !== offset || page.data.length === 0 || page.data.length > length || page.eof !== (offset + page.data.length === expected.bytes)) {
						throw new Error("服务器返回的文件不完整，请重试。");
					}
					await writer.write(page.data);
					offset += page.data.length;
					progress(offset, expected.bytes);
				}
				signal.throwIfAborted();
				checkIdentity(await fileInfoOf(remote, sessionId, path, signal), expected);
				await writer.close();
			} catch (error) {
				await writer.abort().catch(() => {});
				throw error;
			}
		}

		/**
		 * 有界内存写入器：攒成一个 Blob 交给浏览器。
		 * @param limit - 字节上限。
		 * @returns 兼容 FileSystemWritableFileStream 的写入器。
		 */
		function bufferedWriter(limit = BUFFER_LIMIT) {
			const chunks = [];
			let size = 0;
			let complete = false;
			let ended = false;
			return {
				async write(data) {
					if (ended) throw new Error("这个下载已经结束了。");
					if (size + data.length > limit) throw new Error("超过 32 MiB 的文件需要 Chrome / Edge 的保存对话框。");
					chunks.push(data.slice());
					size += data.length;
				},
				async close() {
					if (ended) throw new Error("这个下载已经结束了。");
					ended = true;
					complete = true;
				},
				async abort() {
					chunks.length = 0;
					size = 0;
					complete = false;
					ended = true;
				},
				blob() {
					if (!complete) throw new Error("下载没有完成。");
					return new Blob(chunks, { type: "application/octet-stream" });
				}
			};
		}

		// ── ZIP：STORE 不重压缩，PKWARE APPNOTE 6.3.10 的 ZIP32 记录 ────────────

		/**
		 * 增量 CRC32。
		 * @param data - 字节。
		 * @param crc - 上一次结果。
		 * @returns 新的 CRC。
		 */
		function crc32(data, crc = 0xffffffff) {
			let current = crc;
			for (const byte of data) current = (current >>> 8) ^ crcTable[(current ^ byte) & 255];
			return current >>> 0;
		}

		/**
		 * 校验一个路径段能否安全放进 ZIP。
		 * @param name - 路径段。
		 * @returns 原名字。
		 */
		function safeZipComponent(name) {
			if (typeof name !== "string" || name === "" || name === "." || name === ".." || /[\\/:\u0000-\u001f\u007f]/.test(name) || textDecoder.decode(textEncoder.encode(name)) !== name) {
				throw new Error("目录里有无法安全放进 ZIP 的名字。");
			}
			return name;
		}

		/**
		 * 造一个 ZIP 条目描述。
		 * @param name - 归档内路径（目录以 / 结尾）。
		 * @param directory - 是否目录。
		 * @param info - 文件信息（目录可省）。
		 * @param path - 源绝对路径。
		 * @returns 条目对象。
		 */
		function zipEntryOf(name, directory, info, path) {
			for (const component of name.replace(/\/$/, "").split("/")) safeZipComponent(component);
			const nameBytes = textEncoder.encode(name);
			if (nameBytes.length > 65535) throw new Error("有名字太长，ZIP 放不下。");
			return { name, nameBytes, directory, info, path, bytes: directory ? 0 : info.bytes };
		}

		/**
		 * ZIP 预算（条目数 / 总大小 / 元数据），边规划边校验。
		 * @returns 预算对象。
		 */
		function zipBudget() {
			let bytes = 22;
			let metadata = 0;
			let count = 0;
			return {
				get bytes() {
					return bytes;
				},
				add(entry) {
					count += 1;
					if (count > ZIP_ENTRY_LIMIT) throw new Error(`条目超过 ${ZIP_ENTRY_LIMIT} 个，ZIP 打不了。`);
					const recordBytes = 76 + entry.nameBytes.length * 2 + (entry.directory ? 0 : 16);
					metadata += recordBytes;
					bytes += entry.bytes + recordBytes;
					if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || bytes >= ZIP_LIMIT) throw new Error("总大小超过 ZIP32 上限（接近 4 GiB）。");
					if (metadata > ZIP_METADATA_LIMIT) throw new Error("ZIP 元数据超过 8 MiB 上限。");
					return bytes;
				}
			};
		}

		/**
		 * 造一条带签名的定长记录。
		 * @param size - 字节数。
		 * @param signature - 记录签名。
		 * @returns `{data,view}`。
		 */
		function zipRecord(size, signature) {
			const data = new Uint8Array(size);
			const view = new DataView(data.buffer);
			view.setUint32(0, signature, true);
			return { data, view };
		}

		/**
		 * 本地文件头。
		 * @param entry - ZIP 条目。
		 * @returns 字节。
		 */
		function zipLocalHeader(entry) {
			const { data, view } = zipRecord(30 + entry.nameBytes.length, 0x04034b50);
			view.setUint16(4, 20, true);
			view.setUint16(6, entry.directory ? 0x0800 : 0x0808, true);
			view.setUint16(12, 33, true);
			view.setUint16(26, entry.nameBytes.length, true);
			data.set(entry.nameBytes, 30);
			return data;
		}

		/**
		 * 数据描述符（跟在文件数据后）。
		 * @param crc - 校验和。
		 * @param bytes - 字节数。
		 * @returns 字节。
		 */
		function zipDescriptor(crc, bytes) {
			const { data, view } = zipRecord(16, 0x08074b50);
			view.setUint32(4, crc, true);
			view.setUint32(8, bytes, true);
			view.setUint32(12, bytes, true);
			return data;
		}

		/**
		 * 中央目录项。
		 * @param entry - ZIP 条目。
		 * @param crc - 校验和。
		 * @param offset - 数据起始偏移。
		 * @returns 字节。
		 */
		function zipCentralHeader(entry, crc, offset) {
			const { data, view } = zipRecord(46 + entry.nameBytes.length, 0x02014b50);
			view.setUint16(4, 20, true);
			view.setUint16(6, 20, true);
			view.setUint16(8, entry.directory ? 0x0800 : 0x0808, true);
			view.setUint16(14, 33, true);
			view.setUint32(16, crc, true);
			view.setUint32(20, entry.bytes, true);
			view.setUint32(24, entry.bytes, true);
			view.setUint16(28, entry.nameBytes.length, true);
			view.setUint32(38, entry.directory ? 0x10 : 0x20, true);
			view.setUint32(42, offset, true);
			data.set(entry.nameBytes, 46);
			return data;
		}

		/**
		 * 中央目录结束记录。
		 * @param count - 条目数。
		 * @param size - 中央目录字节数。
		 * @param offset - 中央目录起始偏移。
		 * @returns 字节。
		 */
		function zipEndRecord(count, size, offset) {
			const { data, view } = zipRecord(22, 0x06054b50);
			view.setUint16(8, count, true);
			view.setUint16(10, count, true);
			view.setUint32(12, size, true);
			view.setUint32(16, offset, true);
			return data;
		}

		/**
		 * 列一层目录（校验结构、名字与截断）。
		 * @param remote - remote.workspaceFiles 服务。
		 * @param sessionId - 属主会话 id。
		 * @param path - 目录绝对路径。
		 * @param signal - 中止信号。
		 * @returns `{path,entries}`。
		 */
		async function listDirectory(remote, sessionId, path, signal) {
			signal.throwIfAborted();
			const listing = remoteValue(await remote.list(sessionId, path || ".", signal));
			signal.throwIfAborted();
			if (!listing || typeof listing.path !== "string" || !Array.isArray(listing.entries) || typeof listing.truncated !== "boolean") {
				throw new Error("服务器返回了无法识别的目录列表。");
			}
			if (listing.truncated) throw new Error("目录太大，服务器截断了列表，无法完整打包。");
			// 真实 remote 返回的是工作区相对路径；这里兼容绝对路径（跳过空分段）。
			for (const component of listing.path.split("/")) if (component !== "") safeZipComponent(component);
			const names = new Set();
			const entries = listing.entries
				.map((entry) => {
					safeZipComponent(entry?.name);
					if (names.has(entry.name)) throw new Error("服务器返回了重复的目录项。");
					names.add(entry.name);
					if (entry.type !== "file" && entry.type !== "directory") throw new Error("目录里有符号链接或特殊条目，无法打包。");
					return { name: entry.name, type: entry.type };
				})
				.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
			return { path: listing.path, entries };
		}

		/**
		 * 把若干目标（文件或目录，可混选）规划成一个 ZIP 条目清单。
		 * @param remote - remote.workspaceFiles 服务。
		 * @param sessionId - 属主会话 id。
		 * @param targets - `[{path,directory}]`。
		 * @param signal - 中止信号。
		 * @returns `{entries,bytes}`。
		 */
		async function planZip(remote, sessionId, targets, signal) {
			const entries = [];
			const budget = zipBudget();
			const used = new Set();
			/**
			 * 归档内重名时补 -1、-2。
			 * @param candidate - 期望的归档路径。
			 * @returns 唯一路径。
			 */
			const uniqueArchivePath = (candidate) => {
				let name = candidate;
				for (let index = 1; used.has(name); index += 1) name = `${candidate}-${index}`;
				used.add(name);
				return name;
			};
			/**
			 * 递归展开一个目录。
			 * @param path - 源目录。
			 * @param archivePath - 归档内前缀。
			 * @param depth - 当前深度。
			 */
			const visitDirectory = async (path, archivePath, depth) => {
				if (depth > ZIP_MAX_DEPTH) throw new Error(`目录层级超过 ${ZIP_MAX_DEPTH} 层，无法打包。`);
				const listing = await listDirectory(remote, sessionId, path, signal);
				for (const child of listing.entries) {
					signal.throwIfAborted();
					const childPath = listing.path === "" ? child.name : `${listing.path}/${child.name}`;
					const directory = child.type === "directory";
					const archiveChild = uniqueArchivePath(`${archivePath}/${child.name}`);
					if (directory) {
						const entry = zipEntryOf(`${archiveChild}/`, true, undefined, childPath);
						budget.add(entry);
						entries.push(entry);
						await visitDirectory(childPath, archiveChild, depth + 1);
					} else {
						const info = await fileInfoOf(remote, sessionId, childPath, signal);
						const entry = zipEntryOf(archiveChild, false, info, childPath);
						budget.add(entry);
						entries.push(entry);
					}
				}
			};
			for (const target of targets) {
				signal.throwIfAborted();
				const name = fileNameOf(target.path);
				if (target.directory === true) {
					const archivePath = uniqueArchivePath(name);
					const entry = zipEntryOf(`${archivePath}/`, true, undefined, target.path);
					budget.add(entry);
					entries.push(entry);
					await visitDirectory(target.path, archivePath, 1);
				} else {
					const info = await fileInfoOf(remote, sessionId, target.path, signal);
					const entry = zipEntryOf(uniqueArchivePath(name), false, info, target.path);
					budget.add(entry);
					entries.push(entry);
				}
			}
			return { entries, bytes: budget.bytes };
		}

		/**
		 * 把规划好的 ZIP 流式写进 writer。
		 * @param remote - remote.workspaceFiles 服务。
		 * @param sessionId - 属主会话 id。
		 * @param plan - planZip 的产物。
		 * @param writer - 目标写入器。
		 * @param signal - 中止信号。
		 * @param progress - 进度回调 (done,total)。
		 */
		async function writeZip(remote, sessionId, plan, writer, signal, progress) {
			const central = [];
			let offset = 0;
			let done = 0;
			try {
				for (const entry of plan.entries) {
					signal.throwIfAborted();
					// 中央目录里存的是「本地文件头的偏移」（不是数据偏移），这里先记下来。
					const headerOffset = offset;
					const header = zipLocalHeader(entry);
					await writer.write(header);
					offset += header.length;
					done += header.length;
					if (entry.directory) {
						central.push({ entry, crc: 0, offset: headerOffset });
						continue;
					}
					const expected = entry.info;
					let crc = 0xffffffff;
					let written = 0;
					let position = 0;
					while (position < expected.bytes) {
						signal.throwIfAborted();
						const length = Math.min(CHUNK_BYTES, expected.bytes - position);
						const page = remoteValue(await remote.readBytes(sessionId, entry.path, { range: { offset: position, length } }, signal));
						signal.throwIfAborted();
						checkIdentity(page, expected);
						if (!(page.data instanceof Uint8Array) || page.offset !== position || page.data.length === 0 || page.data.length > length) {
							throw new Error(`打包 ${entry.name} 时读到了不完整的数据。`);
						}
						crc = crc32(page.data, crc);
						await writer.write(page.data);
						position += page.data.length;
						written += page.data.length;
						offset += page.data.length;
						done += page.data.length;
						progress(done, plan.bytes);
					}
					const finalCrc = (crc ^ 0xffffffff) >>> 0;
					const tail = zipDescriptor(finalCrc, written);
					await writer.write(tail);
					offset += tail.length;
					done += tail.length;
					central.push({ entry, crc: finalCrc, offset: headerOffset });
				}
				let directoryBytes = 0;
				for (const record of central) {
					const header = zipCentralHeader(record.entry, record.crc, record.offset);
					await writer.write(header);
					directoryBytes += header.length;
				}
				await writer.write(zipEndRecord(central.length, directoryBytes, offset));
				await writer.close();
			} catch (error) {
				await writer.abort().catch(() => {});
				throw error;
			}
		}

		// ── 传输调度：Toast 报状态，按钮上显示进度并可再点一次取消 ────────────────

		/** 进行中的传输：key -> {controller,label}。 */
		const transfers = new Map();

		/**
		 * 把 Blob 交给浏览器下载。
		 * @param blob - 内容。
		 * @param name - 文件名。
		 */
		function saveBlob(blob, name) {
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = name;
			anchor.hidden = true;
			document.body.append(anchor);
			anchor.click();
			anchor.remove();
			setTimeout(() => URL.revokeObjectURL(url), 60000);
		}

		/**
		 * 在按钮上画进度（非元素 key 只走 Toast）。
		 * @param key - 传输 key。
		 * @param label - 名字。
		 * @param ratio - 0–1；undefined 表示结束。
		 */
		function paintTransfer(key, label, ratio) {
			if (typeof key?.setAttribute !== "function") return;
			if (ratio === undefined) {
				key.setAttribute("aria-label", label);
				key.title = label;
				delete key.dataset.dshTransfer;
				return;
			}
			const text = ratio >= 1 ? `正在收尾 ${label}` : `取消下载 ${label}（${Math.floor(ratio * 100)}%）`;
			key.setAttribute("aria-label", text);
			key.title = text;
			key.dataset.dshTransfer = "busy";
		}

		/**
		 * 跑一次传输：同一个 key 再点一次 = 取消；同一时刻最多两个。
		 * @param key - 唯一标识（通常是按钮元素）。
		 * @param label - 用户可见的名字。
		 * @param task - `(signal,progress) => Promise<void>`。
		 */
		async function runTransfer(key, label, task) {
			const active = transfers.get(key);
			if (active !== undefined) {
				active.controller.abort();
				return;
			}
			if (transfers.size >= TRANSFER_LIMIT) {
				showToast(`同时最多 ${TRANSFER_LIMIT} 个下载，等一个结束再试。`, "warn");
				return;
			}
			const controller = new AbortController();
			transfers.set(key, { controller, label });
			paintTransfer(key, label, 0);
			let lastPaint = 0;
			try {
				showToast(`准备 ${label}…`);
				await task(controller.signal, (done, total) => {
					const ratio = total > 0 ? done / total : 0;
					const now = Date.now();
					if (now - lastPaint < 300 && ratio < 1) return;
					lastPaint = now;
					paintTransfer(key, label, ratio);
					showToast(`正在下载 ${label}：${Math.floor(ratio * 100)}%`);
				});
				showToast(`已开始下载：${label}`);
			} catch (error) {
				if (controller.signal.aborted === true || error?.name === "AbortError") showToast(`已取消：${label}`, "warn");
				else showToast(`下载失败：${String(error?.message ?? error).slice(0, 180)}`, "error");
			} finally {
				transfers.delete(key);
				paintTransfer(key, label, undefined);
			}
		}

		/**
		 * 挑一个写入器：小文件攒内存，大文件走保存对话框。
		 * @param name - 建议文件名。
		 * @param size - 预计字节数。
		 * @returns `{writer,buffered}`。
		 */
		async function chooseWriter(name, size) {
			if (size > BUFFER_LIMIT) {
				if (typeof window.showSaveFilePicker !== "function") throw new Error("超过 32 MiB 的文件需要 Chrome / Edge 的保存对话框。");
				const handle = await window.showSaveFilePicker({ suggestedName: name });
				return { writer: await handle.createWritable(), buffered: undefined };
			}
			const buffered = bufferedWriter();
			return { writer: buffered, buffered };
		}

		/**
		 * 下载单个文件。
		 * @param remote - remote.workspaceFiles 服务。
		 * @param sessionId - 属主会话 id。
		 * @param path - 文件绝对路径。
		 * @param key - 传输 key。
		 */
		async function downloadOne(remote, sessionId, path, key) {
			const label = fileNameOf(path);
			await runTransfer(key, label, async (signal, progress) => {
				const info = await fileInfoOf(remote, sessionId, path, signal);
				const { writer, buffered } = await chooseWriter(label, info.bytes);
				await copyFileTo(remote, sessionId, path, info, writer, signal, progress);
				if (buffered !== undefined) saveBlob(buffered.blob(), label);
			});
		}

		/**
		 * 打包下载若干目标（文件 / 目录混选都行）。
		 * @param remote - remote.workspaceFiles 服务。
		 * @param sessionId - 属主会话 id。
		 * @param targets - `[{path,directory}]`。
		 * @param name - ZIP 文件名。
		 * @param key - 传输 key。
		 */
		async function downloadZip(remote, sessionId, targets, name, key) {
			await runTransfer(key, name, async (signal, progress) => {
				const plan = await planZip(remote, sessionId, targets, signal);
				const { writer, buffered } = await chooseWriter(name, plan.bytes);
				await writeZip(remote, sessionId, plan, writer, signal, progress);
				if (buffered !== undefined) saveBlob(buffered.blob(), name);
			});
		}

		/** 按原生图标数据造一个 svg。 */
		function makeIcon(action) {
			const spec = ICONS[action];
			const svg = document.createElementNS(SVG_NS, "svg");
			svg.setAttribute("viewBox", spec.viewBox);
			svg.setAttribute("fill", "none");
			svg.setAttribute("stroke-width", "1");
			svg.setAttribute("aria-hidden", "true");
			// 尺寸与「不许被压缩」也走行内：flex 子项默认可收缩，一旦父级内容盒被压成 0，
			// 图标会静默缩成 0 宽（看不见但按钮能点到）。
			svg.style.width = "16px";
			svg.style.height = "16px";
			svg.style.flex = "0 0 auto";
			svg.style.pointerEvents = "none";
			for (const item of spec.paths) {
				const node = document.createElementNS(SVG_NS, "path");
				node.setAttribute("d", item.d);
				if (item.fill === true) node.setAttribute("fill", "currentColor");
				else node.setAttribute("stroke", "currentColor");
				if (item.round === true) {
					node.setAttribute("stroke-linecap", "round");
					node.setAttribute("stroke-linejoin", "round");
				}
				svg.append(node);
			}
			return svg;
		}

		// ── 下载入口：行内按钮、预览工具栏、Files 工具栏 ────────────────────────────

		/**
		 * 取一行所属的会话 id（remote 调用需要它）。
		 * @param node - 任意位于侧栏里的节点。
		 * @returns 会话 id；取不到就是 undefined。
		 */
		function sessionOf(node) {
			const holder = typeof node?.closest === "function" ? node.closest("[data-sidebar-right-session]") : undefined;
			const value = holder?.getAttribute("data-sidebar-right-session");
			return typeof value === "string" && value !== "" ? value : undefined;
		}

		/**
		 * 触发某一行的下载 / 打包；按钮上显示进度，进行中再点一次就是取消。
		 * @param button - 触发按钮（同时作为传输 key；路径与会话从它的 dataset 取）。
		 */
		function startRowDownload(button) {
			const remote = state.remote;
			const path = button.dataset.dshFilePath;
			const directory = button.dataset.dshFileEntry === "directory";
			const sessionId = button.dataset.dshFileSession === "" ? undefined : button.dataset.dshFileSession;
			if (remote === undefined || path === null || path === "" || sessionId === undefined) {
				showToast("取不到会话信息，刷新页面再试。", "warn");
				return;
			}
			if (directory) void downloadZip(remote, sessionId, [{ path, directory: true }], archiveNameOf(path), button);
			else void downloadOne(remote, sessionId, path, button);
		}


		/**
		 * 文档预览工具栏里的下载按钮（注册进 sidebar.right.tab.document.actions）。
		 * @param props - 槽位给的 `{absolutePath,sessionId}`（可能为空）。
		 * @returns React 节点。
		 */
		function PreviewDownload(props) {
			const host = React.useRef(null);
			const absolutePath = typeof props?.absolutePath === "string" ? props.absolutePath : "";
			const sessionId = typeof props?.sessionId === "string" ? props.sessionId : undefined;
			React.useEffect(() => {
				if (typeof absolutePath !== "string" || absolutePath === "") return undefined;
				const button = document.createElement("button");
				button.type = "button";
				button.className = "dsh-file-manager-tool";
				button.dataset.dshFileManagerTool = "download-preview";
				button.textContent = "下载";
				const label = `下载 ${fileNameOf(absolutePath)}`;
				button.title = label;
				button.setAttribute("aria-label", label);
				button.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					// 预览可能引用别的会话里的文件：资源地址里带着属主会话。
					const anchor = host.current;
					const address = typeof anchor?.closest === "function" ? anchor.closest("[data-textpreview-url]")?.getAttribute("data-textpreview-url") : undefined;
					const prefix = "dsh-resource://file/session/";
					let owner = sessionId ?? sessionOf(host.current);
					if (typeof address === "string" && address.startsWith(prefix)) {
						try {
							owner = decodeURIComponent(address.slice(prefix.length).split("/")[0]);
						} catch {
							/* 解析失败就用兜底会话 */
						}
					}
					if (state.remote === undefined || owner === undefined) {
						showToast("取不到会话信息，刷新页面再试。", "warn");
						return;
					}
					void downloadOne(state.remote, owner, absolutePath, button);
				});
				host.current.append(button);
				return () => button.remove();
			}, [absolutePath, sessionId]);
			return h("span", { ref: host, "data-dsh-preview-download": "" });
		}

		// ── 多选：模块级状态 + 复用同一套订阅（listeners/notify）──────────────────

		/** 已选条目：path -> {path, directory}。 */
		const selected = new Map();
		/** 多选模式 / Shift 连选锚点 / 批量执行中。 */
		const selection = { mode: false, anchor: undefined, busy: false };
		/** 管理器弹窗状态：{kind,title,hint,initial,items,acknowledge,confirmLabel,run,...}。 */
		let manager = null;

		/**
		 * 订阅 UI 变化（选择态 + 弹窗）。
		 */
		function useUi() {
			const [, force] = React.useReducer((count) => count + 1, 0);
			React.useEffect(() => {
				listeners.add(force);
				return () => listeners.delete(force);
			}, []);
		}

		/**
		 * 打开管理器弹窗。
		 * @param next - 状态对象。
		 */
		function openManager(next) {
			manager = next;
			notify();
		}

		/** 关闭管理器弹窗。 */
		function closeManager() {
			manager = null;
			notify();
		}

		/**
		 * 这个路径能不能被选中：必须在允许管理的范围内（回收站只看第一层）。
		 * @param path - 行路径。
		 * @returns 分类结果或 null。
		 */
		function selectableOf(path, view) {
			return path === null || path === "" ? null : classify(path, view);
		}

		/**
		 * 造一个选择框（只在多选模式下挂到可选的行上）。
		 * @param path - 行路径。
		 * @param directory - 是否目录。
		 * @param enabled - 是否可选；不可选时造一个灰色占位框（只为对齐，点击穿透给行本身）。
		 * @returns 复选框元素。
		 */
		function makeCheckbox(path, directory, enabled = true) {
			const box = document.createElement("input");
			box.type = "checkbox";
			box.dataset.dshFileManager = enabled ? "select" : "select-placeholder";
			box.style.cssText = enabled
				? "position:absolute;inset-inline-start:2px;top:6px;width:16px;height:16px;margin:0;z-index:1;cursor:pointer"
				: "position:absolute;inset-inline-start:2px;top:6px;width:16px;height:16px;margin:0;z-index:1;opacity:.3;pointer-events:none;cursor:default";
			if (enabled === false) {
				box.disabled = true;
				box.tabIndex = -1;
				box.setAttribute("aria-hidden", "true");
				return box;
			}
			box.setAttribute("aria-label", `选择 ${fileNameOf(path)}${directory ? "（文件夹）" : ""}`);
			box.title = directory ? `选择「${fileNameOf(path)}」：文件夹按整包处理，删除 / 移动 / 打包都会连同里面的内容` : `选择「${fileNameOf(path)}」`;
			// 不在这里挂监听：行会被 React 重建，按节点挂的监听在真实页面里靠不住。
			// 统一由 document 捕获阶段的 onSelectionClick 处理（那里已经被验证稳定）。
			return box;
		}

		/**
		 * 当前生效的回收站目录名（来自宿主配置）。
		 * @returns 目录名。
		 */
		function currentTrashDirname() {
			return state.config?.trashDirname ?? DEFAULT_TRASH_DIRNAME;
		}

		/** 把选中态画到所有行上（行会被 React 重建，所以每次重扫都要重画）。 */
		function paintSelection() {
			for (const row of document.querySelectorAll(ROW)) {
				const path = row.getAttribute("data-files-path");
				const on = path !== null && selected.has(path);
				row.classList.toggle("dsh-file-manager-selected", on);
				if (on) row.setAttribute("aria-selected", "true");
				else row.removeAttribute("aria-selected");
				for (const child of row.children) if (child.dataset?.dshFileManager === "select") child.checked = on;
			}
		}

		/**
		 * 切换一项的选中态。
		 * @param path - 路径。
		 * @param directory - 是否目录。
		 */
		function toggleSelected(path, directory, view) {
			if (selected.has(path)) {
				selected.delete(path);
			} else {
				selected.set(path, { path, directory, view });
				excludeRelatives(path);
			}
			paintSelection();
			notify();
		}

		/** 清空选择。 */
		function clearSelected() {
			selected.clear();
			paintSelection();
			notify();
		}

		/**
		 * 开关多选模式（关掉时清空选择）。
		 * @param on - 是否进入多选。
		 */
		function setMultiMode(on) {
			selection.mode = on;
			selection.anchor = undefined;
			if (on === false) selected.clear();
			boxHandledInDown = "";
			schedule();
			paintSelection();
			notify();
		}

		/**
		 * 当前已渲染、且可被选中的行（按 DOM 顺序，供 Shift 连选用）。
		 * @returns 行元素数组。
		 */
		function selectableRows() {
			return [...document.querySelectorAll(ROW)].filter((row) => {
				const path = row.getAttribute("data-files-path");
				return path !== null && path !== "" && selectableOf(path) !== null;
			});
		}

		/** 刚在 mousedown 里处理过的勾选框路径：等它的 click 到来后消费掉（避免翻两次）。 */
		let boxHandledInDown = "";

		/**
		 * 切换某个勾选框（mousedown 与 click 两条路共用）。
		 * @param box - 勾选框元素。
		 * @returns 是否处理了。
		 */
		function toggleBox(box) {
			const holder = box.parentElement ?? box.parent ?? null;
			const path = typeof box.dataset?.dshFilePath === "string" && box.dataset.dshFilePath !== "" ? box.dataset.dshFilePath : holder?.getAttribute?.("data-files-path");
			if (typeof path !== "string" || path === "") return "";
			const on = selected.has(path) === false;
			if (on) {
				selected.set(path, { path, directory: holder?.getAttribute?.("data-files-entry") === "directory", view: viewOfRow(holder) });
				excludeRelatives(path);
				// 记下锚点：勾完再按 Shift 点另一个框，应该按区间连选。
				selection.anchor = path;
			} else {
				selected.delete(path);
			}
			box.checked = on;
			paintSelection();
			notify();
			return path;
		}

		/**
		 * 捕获阶段处理勾选框的「按下」：行由 React 重绘，勾选框可能被换掉，
		 * click 要等到 mouseup 才派发（中途节点被换就落空），所以按下即生效。
		 * @param event - mousedown 事件。
		 */
		function onSelectionDown(event) {
			const target = event.target;
			if (typeof target?.closest !== "function") return;
			const box = target.closest('input[data-dsh-file-manager="select"]');
			if (box === null) {
				boxHandledInDown = "";
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			boxHandledInDown = toggleBox(box);
		}

		/**
		 * 捕获阶段拦截点击：多选模式下（或按住 Ctrl/Cmd/Shift）单击行 = 勾选，
		 * preventDefault + stopPropagation 让 React 的行点击（展开/预览）收不到。
		 * @param event - 点击事件。
		 */
		function onSelectionClick(event) {
			const target = event.target;
			if (typeof target?.closest !== "function") return;
			if (target.closest("button[data-dsh-file-manager]") !== null) return;
			const box = target.closest('input[data-dsh-file-manager="select"]');
			// Shift+点勾选框 = 连选（交给下面的区间逻辑），不是切换单个
			if (box !== null && event.shiftKey !== true) {
				event.preventDefault();
				event.stopPropagation();
				const holder = box.parentElement ?? box.parent ?? null;
				const boxPath = typeof box.dataset?.dshFilePath === "string" && box.dataset.dshFilePath !== "" ? box.dataset.dshFilePath : holder?.getAttribute?.("data-files-path");
				// 刚在 mousedown 里处理过同一个框就跳过（否则一次点击会翻两次）；
				// 键盘触发或程序化 click 没有 mousedown，这时才在这里处理。
				if (boxHandledInDown !== "" && boxHandledInDown === boxPath) {
					boxHandledInDown = "";
					return;
				}
				toggleBox(box);
				return;
			}
			const row = target.closest("[data-files-path]");
			if (row === null || row === undefined) return;
			const modifier = event.ctrlKey === true || event.metaKey === true || event.shiftKey === true;
			if (!selection.mode && !modifier) return;
			const path = row.getAttribute("data-files-path");
			if (path === null || path === "" || selectableOf(path) === null) return;
			// 多选模式下普通单击文件夹要保留「展开/收起」的导航能力（否则进不去目录里勾选），
			// 想勾选文件夹请按 Ctrl/Cmd；文件行不受影响，普通单击就是勾选。
			if (selection.mode && !modifier && row.getAttribute("data-files-entry") === "directory") return;
			event.preventDefault();
			event.stopPropagation();
			if (event.shiftKey === true && selection.anchor !== undefined) {
				const rows = selectableRows();
				const from = rows.findIndex((candidate) => candidate.getAttribute("data-files-path") === selection.anchor);
				const to = rows.findIndex((candidate) => candidate.getAttribute("data-files-path") === path);
				if (from >= 0 && to >= 0) {
					for (let index = Math.min(from, to); index <= Math.max(from, to); index += 1) {
						const candidatePath = rows[index].getAttribute("data-files-path");
						selected.set(candidatePath, { path: candidatePath, directory: rows[index].getAttribute("data-files-entry") === "directory", view: viewOfRow(rows[index]) });
					}
					keepOutermost();
					paintSelection();
					notify();
					return;
				}
			}
			selection.anchor = path;
			toggleSelected(path, row.getAttribute("data-files-entry") === "directory");
		}

		/**
		 * Esc 退出多选并清空。
		 * @param event - 键盘事件。
		 */
		function onSelectionKey(event) {
			// 输入法候选框里的 Esc 属于输入法，不是"退出多选"（中文输入时按键会带 isComposing / keyCode 229）。
			if (event.isComposing === true || event.keyCode === 229) return;
			if (event.key !== "Escape") return;
			if (!selection.mode && selected.size === 0) return;
			setMultiMode(false);
		}

		/**
		 * 逐项跑一个宿主动作并汇总（不中断；失败逐条列出来）。
		 * @param label - 动作名（中文）。
		 * @param items - `[{path,directory}]`。
		 * @param run - 单项执行函数。
		 * @param detail - 成功提示里附带的说明（例如移动的目标目录）。
		 * @returns 完成后的 Promise。
		 */
		async function runBatch(label, items, run, detail) {
			selection.busy = true;
			notify();
			const failures = [];
			let done = 0;
			for (const item of items) {
				try {
					await run(item);
					done += 1;
				} catch (error) {
					failures.push(`${fileNameOf(item.path)}：${String(error?.message ?? error)}`);
				}
			}
			selection.busy = false;
			// 动作做完了就退出多选：留着模式会让「单击文件夹=勾选」而不是展开，用起来像坏了。
			setMultiMode(false);
			reloadTree();
			const where = typeof detail === "string" && detail !== "" ? ` → ${detail}` : "";
			if (failures.length === 0) showToast(`${label}：${done} 项完成${where}。`, "success");
			else showToast(`${label}：成功 ${done} 项，失败 ${failures.length} 项（${failures.slice(0, 3).join("；")}${failures.length > 3 ? " …" : ""}）`);
			// 回传成败：调用方（移动/复制弹窗）据此决定要不要留在弹窗里让用户换个目录重试。
			return { done, failures };
		}

		/**
		 * 取侧栏的会话 id（remote 调用用）。
		 * @returns 会话 id 或 undefined。
		 */
		function sidebarSessionId() {
			return sessionOf(document.querySelector("[data-sidebar-right-session]"));
		}

		/**
		 * 下载选中项：单项是文件就直接下载，其余打成一个 ZIP（决策 D2c）。
		 * @param key - 传输 key（工具栏按钮）。
		 */
		function downloadSelection(key) {
			const items = [...selected.values()];
			if (items.length === 0) return;
			const sessionId = sidebarSessionId();
			if (state.remote === undefined || sessionId === undefined) {
				showToast("取不到会话信息，刷新页面再试。", "warn");
				return;
			}
			if (items.length === 1 && items[0].directory === false) {
				void downloadOne(state.remote, sessionId, items[0].path, key ?? "selection-download");
				return;
			}
			const name = items.length === 1 ? archiveNameOf(items[0].path) : `已选-${items.length}-项.zip`;
			void downloadZip(state.remote, sessionId, items, name, key ?? "selection-download");
		}

		/**
		 * 批量删除 / 恢复 / 彻底删除（先弹二次确认）。
		 * @param action - trash | restore | purge。
		 */
		function confirmBatch(action) {
			const items = [...selected.values()];
			if (items.length === 0) return;
			const label = action === "trash" ? "移入回收站" : action === "restore" ? "恢复" : "彻底删除";
			const retention = state.config?.retentionDays ?? 7;
			const hasDirectory = items.some((item) => item.directory === true);
			const packed = hasDirectory
				? action === "purge"
					? "（文件夹按整包算：连同里面的内容一起删除）"
					: action === "trash"
						? "（文件夹按整包算：连同里面的内容一起移入）"
						: "（文件夹按整包算：连同里面的内容一起恢复）"
				: "";
			openManager({
				kind: "confirm",
				title: `${label} ${items.length} 项？`,
				description: `${
					action === "purge"
						? "这些条目会被永久删除，无法恢复。"
						: action === "trash"
							? `这些条目会移入各自的回收站，${retention} 天后自动清理；期间可以恢复。`
							: "这些条目会移回各自原来的位置；目标已有同名**文件夹**时会直接**合并**进去（同名条目自动加时间戳后缀），不会覆盖任何现有文件。"
				}${packed}`,
				confirmLabel: label,
				acknowledge: action === "purge",
				items,
				hint: hintFor(items[0]?.path ?? ""),
				run: () => runBatch(label, items, (item) => callHost(action, item.path, item.view))
			});
		}

		/**
		 * 取路径的上一级目录。
		 * @param path - 绝对路径。
		 * @returns 上级目录绝对路径。
		 */
		function parentOf(path) {
			const cut = String(path ?? "").lastIndexOf("/");
			return cut > 0 ? String(path).slice(0, cut) : "/";
		}

		/**
		 * 互斥归一化（决策 D2-B）：选中一项后，把与它互相包含的已选项去掉。
		 * 勾子 → 去掉已勾的父；勾父 → 去掉已勾的子孙。取消勾选不级联
		 * （也就是说「整包但排除一个」表达不了，这是这个方案的固有取舍）。
		 * @param path - 刚被选中的路径。
		 */
		function excludeRelatives(path) {
			for (const key of [...selected.keys()]) {
				if (key !== path && key.startsWith(`${path}/`)) selected.delete(key);
			}
			for (let ancestor = parentOf(path); ancestor !== "" && ancestor !== "/"; ancestor = parentOf(ancestor)) {
				selected.delete(ancestor);
			}
		}

		/** Shift 连选之后整理：只保留最外层（父优先，和「整包」直觉一致）。 */
		function keepOutermost() {
			for (const path of [...selected.keys()]) {
				for (let ancestor = parentOf(path); ancestor !== "" && ancestor !== "/"; ancestor = parentOf(ancestor)) {
					if (selected.has(ancestor)) {
						selected.delete(path);
						break;
					}
				}
			}
		}

		/**
		 * 移动 / 复制选中项：**同一个入口**，弹窗里再选动作（默认移动，决策 E1=①）。
		 */
		function openMove() {
			const items = [...selected.values()];
			if (items.length === 0) return;
			const roots = (state.config?.roots ?? []).map((entry) => entry.declared ?? entry.root).filter((value) => typeof value === "string" && value !== "");
			const single = items.length === 1 && items[0].directory === true ? items[0].path : undefined;
			const fromTrash = items.some((item) => selectableOf(item.path, item.view)?.actions.includes("restore") === true);
			// 当前视图根：宿主用它判断"跨没跨工作区"（跨工作区关掉时目标只能在它之内）。
			const viewRoot = typeof selection.view === "string" && selection.view !== "" ? selection.view : items[0].view;
			openManager({
				kind: "move",
				// 回收站来源只给「移动」（=恢复到指定位置），不给复制。
				switchable: !fromTrash,
				title: `移动 ${items.length} 项`,
				note: fromTrash
					? "从回收站移出的条目：目标已有同名文件夹时会直接合并进去（同名条目自动加时间戳后缀），不会覆盖任何现有文件。"
					: "移动 = 原件搬过去；复制 = 留一份原件、再放一份副本（重名的那一份自动加时间戳后缀，绝不覆盖）。",
				items,
				sessionId: sidebarSessionId(),
				viewRoot,
				startDir: single ?? parentOf(items[0].path) ?? roots[0] ?? "",
				roots,
				hint: hintFor(items[0]?.path ?? ""),
				run: (targetDir, verb) =>
					verb === "copy"
						? runBatch("复制", items, (item) => callHost("copy", { path: item.path, targetDir }, item.view ?? viewRoot), targetDir)
						: runBatch("移动", items, (item) => callHost("move", { path: item.path, targetDir }, item.view ?? viewRoot), targetDir)
			});
		}

		/**
		 * 重命名（决策 D4a=B+C：动作条里选中恰好一项时可用）。
		 */
		function openRename() {
			const items = [...selected.values()];
			if (items.length !== 1) return;
			const item = items[0];
			const current = fileNameOf(item.path);
			openManager({
				kind: "name",
				title: "重命名",
				clearSelection: true,
				hint: `把「${current}」改成：`,
				initial: current,
				note: item.directory === true ? "只改这个文件夹的名字，里面的内容不受影响" : undefined,
				label: "新名字",
				run: (name) => callHost("rename", { path: item.path, name }, item.view),
				done: (name) => `已改名为「${name}」。`
			});
		}

		/**
		 * 新建文件夹：选中单个目录就建在它里面，否则建在第一个允许根下。
		 */
		function openMkdir() {
			const items = [...selected.values()];
			const roots = (state.config?.roots ?? []).map((entry) => entry.declared ?? entry.root).filter((value) => typeof value === "string" && value !== "");
			if (items.length === 0) {
				// 没有选中任何东西：弹一个「选路径 + 填名字」的窗口（和移动同一种浏览体验）。
				const startDir = selection.view !== undefined && selection.view !== "" ? selection.view : roots[0];
				if (typeof startDir !== "string" || startDir === "") {
					showToast("配置里没有可管理的文件夹，建不了目录。", "warn");
					return;
				}
				openManager({
					kind: "mkdir",
					title: "新建文件夹",
					items: [],
					sessionId: sidebarSessionId(),
					viewRoot: selection.view,
					startDir,
					roots,
					initial: "新建文件夹",
					run: async (targetDir, name) => {
						await callHost("mkdir", { parent: targetDir, name }, selection.view);
						showToast(`已在 ${targetDir} 下新建「${name}」。`, "success");
						reloadTree();
					}
				});
				return;
			}
			// 选中了单个文件夹：直接建在它下面（不用再选路径）。
			const parent = items.length === 1 && items[0].directory === true ? items[0].path : roots[0];
			if (typeof parent !== "string" || parent === "") {
				showToast("配置里没有可管理的文件夹，建不了目录。", "warn");
				return;
			}
			openManager({
				kind: "name",
				title: "新建文件夹",
				hint: items.length === 1 && items[0].directory === true ? `在选中的文件夹 ${parent} 下新建：` : `在 ${parent} 下新建：`,
				initial: "新建文件夹",
				label: "文件夹名",
				run: (name) => callHost("mkdir", { parent, name }, selection.view),
				done: (name) => `已新建文件夹「${name}」。`
			});
		}

		/**
		 * 清空回收站（真删，二次确认）。
		 */
		async function openEmptyTrash() {
			// 数量**问宿主**（dryRun）：口径与真删完全一致（按视图收窄、不含 .meta.json）。
			// 以前这里是数树里的行，既把 .meta.json 数进去、又不按视图收窄，
			// 于是"确认框说 N 项、删完提示 M 项"对不上（用户 2026-10-04）。
			selection.busy = true;
			notify();
			let count = 0;
			let scoped = false;
			let failure = "";
			try {
				const data = await callHost("empty-trash", { view: selection.view, dryRun: true }, selection.view);
				count = Number(data.removed) || 0;
				scoped = data.scope === "view";
			} catch (error) {
				failure = String(error?.message ?? error);
			}
			selection.busy = false;
			notify();
			const detail = failure === "" ? `（将删除 ${count} 项${scoped ? "，只清当前工作区范围内的" : ""}）` : `（数量暂时读不出来：${failure}）`;
			openManager({
				kind: "confirm",
				title: "清空回收站？",
				description: `回收站里的所有条目会被永久删除，无法恢复${detail}。回收站目录与它的元数据也会一并删掉。`,
				confirmLabel: "清空回收站",
				acknowledge: true,
				items: [],
				run: async () => {
					const data = await callHost("empty-trash", { view: selection.view }, selection.view);
					showToast(`已清空回收站：删除 ${data.removed ?? 0} 项。`, "success");
				}
			});
		}

		// ── 管理器弹窗（重命名 / 新建文件夹 / 移动 / 批量确认）────────────────────

		/**
		 * 管理器弹窗（重命名 / 新建文件夹 / 移动 / 批量确认）。
		 *
		 * 三种形态共用一个组件：hooks 必须**无条件**按同一顺序声明，
		 * 所以状态都在这里，按 kind 分支只影响渲染。
		 * @returns React 节点。
		 */
		function ManagerDialog() {
			useUi();
			const [value, setValue] = React.useState("");
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState("");
			const [acknowledged, setAcknowledged] = React.useState(false);
			const [dir, setDir] = React.useState("");
			const [entries, setEntries] = React.useState([]);
			const [fresh, setFresh] = React.useState("");
			/** 同一个入口里的动作：move（默认）| copy。 */
			const [verb, setVerb] = React.useState("move");
			/** 当前目录的 parent 与可跳转的允许根（都由 /pick 回）。 */
			const [listing, setListing] = React.useState({ parent: null, roots: [] });
			const current = manager;
			React.useEffect(() => {
				setValue(current?.initial ?? "");
				setBusy(false);
				setError("");
				setAcknowledged(false);
				setFresh("");
				setDir(current?.startDir ?? "");
				setFresh(current?.initial ?? "");
				setEntries([]);
				setVerb("move");
				setListing({ parent: null, roots: [] });
			}, [current]);
			React.useEffect(() => {
				if ((current?.kind !== "move" && current?.kind !== "mkdir") || dir === "") return undefined;
				let alive = true;
				const controller = new AbortController();
				void (async () => {
					try {
						const found = await browseDirectory(dir, current.viewRoot, controller.signal);
						if (!alive) return;
						setEntries(found.dirs.filter((entry) => entry.name !== currentTrashDirname()));
						setListing({ parent: found.parent, roots: found.roots });
						setError("");
					} catch (cause) {
						if (alive) {
							// 只清列表，**不动 roots**：一次列举失败不该让「跳转工作区」那一行也消失
							// （用户 2026-10-04 反馈的现象就是这么来的）。
							setEntries([]);
							setListing((previous) => ({ parent: previous.parent, roots: previous.roots }));
							setError(String(cause?.message ?? cause));
						}
					}
				})();
				return () => {
					alive = false;
					controller.abort();
				};
			}, [current, dir]);
			if (current === null) return null;

			/**
			 * 提交名字类动作（重命名 / 新建文件夹）。
			 */
			const submitName = async () => {
				const name = value.trim();
				if (name === "" || name === "." || name === ".." || name.includes("/")) {
					setError("名字不合法：不能为空、不能含 /，也不能是 . 或 ..");
					return;
				}
				setBusy(true);
				setError("");
				try {
					await current.run(name);
					closeManager();
					if (current.clearSelection === true) setMultiMode(false);
					reloadTree();
					showToast(current.done?.(name) ?? "完成。", "success");
				} catch (cause) {
					setBusy(false);
					setError(String(cause?.message ?? cause));
				}
			};

			/**
			 * 执行最后的动作（批量确认 / 移动）。
			 */
			const confirm = async () => {
				setBusy(true);
				setError("");
				try {
					if (current.kind === "move") {
						const result = await current.run(dir, verb);
						// 一条都没成 → 留在弹窗里就地说明原因，别关掉让人去右下角找 toast（决策 D3）。
						if (result !== undefined && result.done === 0 && Array.isArray(result.failures) && result.failures.length > 0) {
							setBusy(false);
							setError(`没有一项成功：${result.failures.slice(0, 3).join("；")}`);
							return;
						}
						closeManager();
					} else if (current.kind === "mkdir") {
						await current.run(dir, fresh.trim());
						setBusy(false);
						// 不关窗：用同一个窗口重新挂一次（startDir 保持当前目录）——
						// 列表会刷新（新文件夹立刻出现），名字框复位，方便连着建好几个。
						openManager({ ...current, startDir: dir });
					} else {
						await current.run(value);
						closeManager();
					}
				} catch (cause) {
					setBusy(false);
					setError(String(cause?.message ?? cause));
				}
			};

			/**
			 * 在移动弹窗里新建一个子目录并进去。
			 */
			const createDir = async () => {
				const name = fresh.trim();
				if (name === "") return;
				setBusy(true);
				setError("");
				try {
					const data = await callHost("mkdir", { parent: dir, name });
					setFresh("");
					setDir(data.created ?? dir);
					reloadTree();
				} catch (cause) {
					setError(String(cause?.message ?? cause));
				} finally {
					setBusy(false);
				}
			};

			const names = (current.items ?? []).map((item) => fileNameOf(item.path));
			const summary = names.length === 0 ? "" : `${names.slice(0, 5).join("、")}${names.length > 5 ? ` 等 ${names.length} 项` : ""}`;

			// 名字输入类：重命名 / 新建文件夹
			if (current.kind === "name") {
				return h(
					Modal,
					{
						open: true,
						onClose: busy ? undefined : closeManager,
						title: current.title,
						closeLabel: "关闭",
						footer: h(
							React.Fragment,
							null,
							h(Button, { variant: "outline", onClick: closeManager, disabled: busy, children: "取消" }),
							h(Button, { variant: "primary", onClick: () => void submitName(), disabled: busy, children: busy ? "处理中…" : "确定" })
						)
					},
					h(
						"div",
						{ style: { display: "flex", flexDirection: "column", gap: "8px" } },
						h("p", { style: { margin: 0 } }, current.hint),
						current.note === undefined ? null : h("p", { className: "dsh-file-manager-muted", style: { margin: 0 } }, current.note),
						h("input", {
							className: "dsh-file-manager-input",
							value,
							"aria-label": current.label ?? "名字",
							disabled: busy,
							onChange: (event) => setValue(event.target.value),
							onKeyDown: (event) => {
								if (event.key === "Enter") void submitName();
							}
						}),
						error === "" ? null : h("p", { className: "dsh-file-manager-error", style: { margin: 0 } }, error)
					)
				);
			}

			// 目录选择类：移动 / 新建文件夹（选路径 + 填名字）
			if (current.kind === "move" || current.kind === "mkdir") {
				const copying = current.kind === "move" && verb === "copy";
				return h(
					Modal,
					{
						open: true,
						onClose: busy ? undefined : closeManager,
						title: current.switchable === true ? (copying ? `复制 ${(current.items ?? []).length} 项` : `移动 ${(current.items ?? []).length} 项`) : current.title,
						closeLabel: "关闭",
						footer: h(
							React.Fragment,
							null,
							h(Button, { variant: "outline", onClick: closeManager, disabled: busy, children: current.kind === "mkdir" ? "关闭" : "取消" }),
							h(Button, {
								variant: "primary",
								onClick: () => void confirm(),
								disabled: busy || dir === "" || (current.kind === "mkdir" && fresh.trim() === ""),
								children: busy
									? current.kind === "mkdir"
										? "新建中…"
										: copying
											? "复制中…"
											: "移动中…"
									: current.kind === "mkdir"
										? "在这里新建"
										: copying
											? "复制到这里"
											: "移动到这里"
							})
						)
					},
					h(
						"div",
						{ className: "dsh-file-manager-move" },
						// 同一个入口里的动作切换（回收站来源不给复制，所以只有可切换时才画）。
						current.switchable === true
							? h(SegmentedControl, {
									id: "dsh-file-manager-place",
									value: verb,
									label: "动作",
									disabled: busy,
									options: [
										{ value: "move", label: "移动" },
										{ value: "copy", label: "复制" }
									],
									onChange: (next) => setVerb(next)
								})
							: null,
						h("p", { className: "dsh-file-manager-path", style: { margin: 0 } }, dir === "" ? "（取不到目录）" : dir),
						current.kind === "mkdir"
							? h("input", {
									className: "dsh-file-manager-input",
									value: fresh,
									placeholder: "新文件夹名字",
									"aria-label": "新文件夹名字",
									disabled: busy,
									onChange: (event) => setFresh(event.target.value),
									onKeyDown: (event) => {
										if (event.key === "Enter") void confirm();
									}
								})
							: null,
						(current.items ?? []).some((item) => item.directory === true)
							? h("p", { className: "dsh-file-manager-muted", style: { margin: 0 } }, copying ? "文件夹会连同里面的内容一起复制" : "文件夹会连同里面的内容一起移动")
							: null,
						// 可跳转的允许根（跨工作区开着时才会有多个；跨工作区关掉时只剩当前这一个）。
						listing.roots.length > 0
							? h(
									"div",
									{ className: "dsh-file-manager-rowlist", style: { maxHeight: "none" } },
									h("span", { className: "dsh-file-manager-muted" }, "跳转工作区："),
									...listing.roots.map((root) =>
										h(
											"button",
											{
												key: root.path,
												type: "button",
												className: "dsh-file-manager-tool",
												disabled: busy,
												title: root.path,
												onClick: () => setDir(root.path)
											},
											`${root.current === true ? "★ " : "📁 "}${root.title ?? root.path}`
										)
									)
								)
							: null,
						h("span", { className: "dsh-file-manager-muted" }, "文件夹"),
						h(
							"div",
							{ className: "dsh-file-manager-rowlist" },
							h(
								"button",
								{
									type: "button",
									className: "dsh-file-manager-tool",
									// 已经到顶层（没有上一层）就禁用，别跳到一个空目录里去。
									disabled: busy || listing.parent === null,
									onClick: () => setDir(listing.parent ?? parentOf(dir))
								},
								".. 上一层"
							),
							...entries.map((entry) =>
								h("button", { key: entry.path, type: "button", className: "dsh-file-manager-tool", disabled: busy, onClick: () => setDir(entry.path) }, `📁 ${entry.name}`)
							),
							entries.length === 0 && dir !== "" ? h("span", { className: "dsh-file-manager-muted" }, "（没有子目录）") : null
						),
						// 「新建子目录并进入」只在移动/复制时用；mkdir 窗口里那个名字框就是新文件夹的名字，别叠两个。
						current.kind === "move"
							? h(
									"div",
									{ style: { display: "flex", gap: "6px", alignItems: "center" } },
									h("input", {
										className: "dsh-file-manager-input",
										value: fresh,
										placeholder: "新建文件夹的名字",
										"aria-label": "新建文件夹的名字",
										disabled: busy,
										onChange: (event) => setFresh(event.target.value)
									}),
									h("button", { type: "button", className: "dsh-file-manager-tool", disabled: busy || fresh.trim() === "", onClick: () => void createDir() }, "新建并进入")
								)
							: null,
						error === "" ? null : h("p", { className: "dsh-file-manager-error", style: { margin: 0 } }, error)
					)
				);
			}

			// 确认类：批量删除 / 恢复 / 彻底删除 / 清空回收站
			if (current.acknowledge === true) {
				return h(RiskConfirmation, {
					open: true,
					title: current.title,
					description: `${current.description}${summary === "" ? "" : `\n${summary}`}`,
					acknowledgeLabel: "我明白此操作不可恢复",
					cancelLabel: "取消",
					closeLabel: "关闭",
					confirmLabel: busy ? "处理中…" : current.confirmLabel,
					acknowledged,
					disabled: busy,
					onAcknowledgedChange: setAcknowledged,
					onCancel: closeManager,
					onConfirm: () => void confirm()
				});
			}
			return h(
				Modal,
				{
					open: true,
					onClose: busy ? undefined : closeManager,
					title: current.title,
					closeLabel: "关闭",
					footer: h(
						React.Fragment,
						null,
						h(Button, { variant: "outline", onClick: closeManager, disabled: busy, children: "取消" }),
						h(Button, { variant: "primary", onClick: () => void confirm(), disabled: busy, children: busy ? "处理中…" : current.confirmLabel })
					)
				},
				h(
					"div",
					null,
					h("p", { style: { margin: 0 } }, current.description),
					typeof current.hint === "string" && current.hint !== ""
						? h("p", { className: "dsh-file-manager-warn", style: { margin: "6px 0 0" } }, current.hint)
						: null,
					summary === "" ? null : h("p", { className: "dsh-file-manager-muted", style: { margin: "6px 0 0" } }, summary),
					error === "" ? null : h("p", { className: "dsh-file-manager-error", style: { margin: "6px 0 0" } }, error)
				)
			);
		}

		/**
		 * Files 工具栏：多选开关 + 选中后的批量动作 + 新建文件夹 / 打包根目录 / 清空回收站。
		 * @param props - `{absolutePath}`（槽位只给这个）。
		 * @returns React 节点。
		 */
		/**
		 * 插件配置页 —— 注册进侧栏「插件」→ dsh-file-manager 卡片里的 plugins.bundle.config
		 * （键 = 本包包名，page 形态）。
		 *
		 * 数据面是本插件自己的 /api/file-manager/settings（决策 D2，不走 dsh 的 Loader 配置）：
		 * 进页面读一次 → 本地编辑 → 点「保存」才写盘（宿主严格校验 + 留备份 + 原子替换；
		 * 文件 mtime 一变即热生效，不需要重启）。没保存就离开页面 = 丢弃草稿。
		 * @param props - slot owner props（view 为 "page"；"summary" 什么都不画）。
		 * @returns React 节点。
		 */
		function ConfigPanel(props) {
			const view = props?.view ?? "page";
			const [phase, setPhase] = React.useState("loading");
			const [error, setError] = React.useState("");
			const [note, setNote] = React.useState("");
			const [meta, setMeta] = React.useState({ path: "", mtimeMs: 0 });
			const [effective, setEffective] = React.useState(null);
			const [suggests, setSuggests] = React.useState([]);
			const [draft, setDraft] = React.useState(null);
			const [baseline, setBaseline] = React.useState("");
			const [busy, setBusy] = React.useState(false);
			const [browse, setBrowse] = React.useState(null);
			const [chip, setChip] = React.useState("");

			/** 读一次配置（进页面时、保存成功后各一次）。 */
			const reload = React.useCallback(async () => {
				setPhase("loading");
				setError("");
				try {
					const response = await fetch(SETTINGS_URL, { headers: { accept: "application/json" } });
					const data = await response.json().catch(() => ({}));
					if (!response.ok || data.ok === false) throw new Error(data?.error ?? `读取配置失败（HTTP ${response.status}）`);
					setMeta({ path: String(data.path ?? ""), mtimeMs: Number(data.mtimeMs) || 0 });
					setEffective(data.effective ?? null);
					setSuggests(Array.isArray(data.suggests) ? data.suggests : []);
					setNote(typeof data.parseError === "string" ? data.parseError : "");
					setDraft(data.draft ?? null);
					setBaseline(JSON.stringify(data.draft ?? null));
					setChip("");
					setPhase("ready");
				} catch (cause) {
					setError(String(cause?.message ?? cause));
					setPhase("failed");
				}
			}, []);
			React.useEffect(() => {
				void reload();
			}, [reload]);

			/**
			 * 走进某个目录（浏览弹窗内部用）。
			 * @param target - 要进入的绝对路径。
			 * @param remember - 记住这次浏览是为哪一项服务的（不传则沿用当前）。
			 */
			const walk = async (target, remember) => {
				const purpose = remember ?? browse?.remember;
				setBrowse((current) => (current === null ? current : { ...current, busy: true, error: "", input: target, remember: purpose }));
				try {
					const response = await fetch(`${BROWSE_URL}?path=${encodeURIComponent(target)}`, { headers: { accept: "application/json" } });
					const data = await response.json().catch(() => ({}));
					if (!response.ok || data.ok === false) throw new Error(data?.error ?? `读目录失败（HTTP ${response.status}）`);
					setBrowse((current) =>
						current === null
							? current
							: {
									...current,
									busy: false,
									path: String(data.path ?? ""),
									input: String(data.path ?? ""),
									parent: data.parent ?? null,
									dirs: Array.isArray(data.dirs) ? data.dirs : [],
									error: ""
								}
					);
				} catch (cause) {
					setBrowse((current) => (current === null ? current : { ...current, busy: false, error: String(cause?.message ?? cause) }));
				}
			};

			if (view !== "page") return null;
			if (phase === "loading") return h("p", { className: "dsh-file-manager-muted" }, "正在读取配置…");
			if (phase === "failed") {
				return h(
					"div",
					{ className: "dsh-file-manager-config" },
					h("p", { className: "dsh-file-manager-error" }, error),
					h(Button, { variant: "outline", size: "sm", onClick: () => void reload(), children: "重试" })
				);
			}
			if (draft === null) return null;

			const dirty = JSON.stringify(draft) !== baseline;
			const edit = (patch) => setDraft((current) => ({ ...current, ...patch }));
			const editManage = (index, patch) => setDraft((current) => ({ ...current, manage: (current.manage ?? []).map((item, at) => (at === index ? { ...item, ...patch } : item)) }));
			const removeManage = (index) => setDraft((current) => ({ ...current, manage: (current.manage ?? []).filter((item, at) => at !== index) }));
			const editWorkspace = (patch) => setDraft((current) => ({ ...current, workspace: { scope: "all", ...(current.workspace ?? {}), ...patch } }));

			/**
			 * 打开「选目录」弹窗。
			 * @param start - 起始路径（空串则用建议起点）。
			 * @param remember - {kind:"manage", index} 或 {kind:"new"}。
			 */
			const openBrowse = (start, remember) => {
				const initial = typeof start === "string" && start !== "" ? start : suggests[0] ?? "";
				setBrowse({ remember, path: "", input: initial, parent: null, dirs: [], busy: initial !== "", error: "" });
				if (initial !== "") void walk(initial, remember);
			};

			/**
			 * 选定当前目录。
			 * @param path - 目录绝对路径。
			 */
			const pick = (path) => {
				const remember = browse?.remember;
				if (remember?.kind === "manage" && typeof remember.index === "number") editManage(remember.index, { path });
				else setDraft((current) => ({ ...current, manage: [...(current.manage ?? []), { path, recursive: false }] }));
				setBrowse(null);
			};

			/** 把输入框里的相对路径加进 disable 清单。 */
			const addChip = () => {
				const value = chip.trim().replace(/^\.\//, "");
				if (value === "") return;
				editWorkspace({ disable: [...new Set([...(draft.workspace?.disable ?? []), value])] });
				setChip("");
			};

			/** 保存：本地先挡一次数字格式，其余交给宿主严格校验。 */
			const save = async () => {
				setError("");
				const days = Number(draft.retention_days);
				if (!Number.isInteger(days) || days < 1 || days > 3650) {
					setError("保留天数必须是 1~3650 的整数。");
					return;
				}
				const hours = Number(draft.cleanup_interval_hours);
				if (!Number.isFinite(hours) || hours <= 0 || hours > 8760) {
					setError("清理检查间隔必须是大于 0 且不超过 8760 的小时数。");
					return;
				}
				const config = {
					mode: draft.mode,
					retention_days: days,
					cleanup_interval_hours: hours,
					auto_cleanup: draft.auto_cleanup === true,
					trash_dirname: String(draft.trash_dirname ?? ""),
					cross_workspace: draft.cross_workspace !== false,
					row_show: Array.isArray(draft.row_show) ? draft.row_show : []
				};
				// 只有宿主认识这个键（GET /settings 回来的草稿里有它）才提交，免得老宿主 400。
				if (Array.isArray(draft.toolbar_show)) config.toolbar_show = draft.toolbar_show;
				if (draft.mode === "paths") config.manage = (draft.manage ?? []).map((item) => ({ path: String(item.path ?? ""), recursive: item.recursive === true }));
				else config.workspace = { scope: "all", recursive: draft.workspace?.recursive === true, disable: draft.workspace?.disable ?? [] };
				setBusy(true);
				try {
					const response = await fetch(SETTINGS_URL, {
						method: "POST",
						headers: { "content-type": "application/json", accept: "application/json" },
						body: JSON.stringify({ config, mtimeMs: meta.mtimeMs })
					});
					const data = await response.json().catch(() => ({}));
					if (!response.ok || data.ok === false) throw new Error(data?.error ?? `保存失败（HTTP ${response.status}）`);
					await reload();
					showToast("配置已保存并生效，不需要重启。", "success");
				} catch (cause) {
					setError(String(cause?.message ?? cause));
				} finally {
					setBusy(false);
				}
			};

			/**
			 * 一行「标签 + 控件 + 说明」。
			 * @param label - 标签。
			 * @param control - 控件。
			 * @param hint - 说明文字。
			 * @returns React 节点。
			 */
			const field = (label, control, hint) =>
				h(
					"div",
					{ className: "dsh-file-manager-config-field" },
					h("span", { className: "dsh-file-manager-config-label" }, label),
					control,
					hint === undefined || hint === "" ? null : h("span", { className: "dsh-file-manager-config-hint" }, hint)
				);

			const modeField = field(
				"管理范围",
				h(SegmentedControl, {
					id: "dsh-file-manager-mode",
					value: draft.mode,
					label: "管理范围",
					disabled: busy,
					options: [
						{ value: "paths", label: "按目录" },
						{ value: "workspace", label: "按工作区" }
					],
					onChange: (next) => edit(next === "workspace" ? { mode: "workspace", workspace: draft.workspace ?? { scope: "all", recursive: true, disable: [] } } : { mode: "paths", manage: draft.manage ?? [] })
				}),
				draft.mode === "workspace" ? "自动覆盖 dsh 里注册过的每个工作区（嵌套工作区各归各的回收站）。" : "只管理下面点名的那些目录。"
			);

			const manageField =
				draft.mode !== "paths"
					? null
					: field(
							"允许管理的目录",
							h(
								"div",
								{ className: "dsh-file-manager-config-list" },
								(draft.manage ?? []).map((item, index) =>
									h(
										"div",
										{ key: `${index}:${item.path}`, className: "dsh-file-manager-config-row" },
										h("span", { className: "dsh-file-manager-path", title: item.path }, item.path === "" ? "（还没选目录）" : item.path),
										h(
											"span",
											{ className: "dsh-file-manager-config-side" },
											h(Checkbox, {
												checked: item.recursive === true,
												label: "含子目录",
												disabled: busy,
												title: "勾上＝任意深度都能操作；不勾＝只直接子项",
												onChange: (next) => editManage(index, { recursive: next })
											}),
											h(Button, { size: "sm", variant: "outline", disabled: busy, onClick: () => openBrowse(item.path, { kind: "manage", index }), children: "选目录" }),
											h(Button, { size: "sm", variant: "ghost", disabled: busy, onClick: () => removeManage(index), children: "移除" })
										)
									)
								),
								h(Button, { size: "sm", variant: "outline", disabled: busy, onClick: () => openBrowse("", { kind: "new" }), children: "添加目录" })
							),
							"必须是绝对路径，保存时目录要真实存在；至少要留一个。"
						);

			const workspaceField =
				draft.mode !== "workspace"
					? null
					: field(
							"工作区设置",
							h(
								"div",
								{ className: "dsh-file-manager-config-list" },
								h(Checkbox, {
									checked: draft.workspace?.recursive === true,
									label: "含子目录",
									disabled: busy,
									title: "勾上＝任意深度都能操作；不勾＝只直接子项",
									onChange: (next) => editWorkspace({ recursive: next })
								}),
								h(
									"div",
									{ className: "dsh-file-manager-rowlist" },
									(draft.workspace?.disable ?? []).length === 0
										? h("span", { className: "dsh-file-manager-muted" }, "没有排除项。")
										: (draft.workspace?.disable ?? []).map((item, index) =>
												h(
													"span",
													{ key: `${index}:${item}`, className: "dsh-file-manager-chip" },
													item,
													h(
														"button",
														{
															type: "button",
															disabled: busy,
															title: `移除 ${item}`,
															onClick: () => editWorkspace({ disable: (draft.workspace?.disable ?? []).filter((_, at) => at !== index) })
														},
														"×"
													)
												)
											)
								),
								h(
									"div",
									{ className: "dsh-file-manager-config-actions" },
									h(Input, {
										value: chip,
										placeholder: "相对工作区根的路径，例如 node_modules",
										disabled: busy,
										onChange: (event) => setChip(event.target.value),
										onKeyDown: (event) => {
											if (event.key !== "Enter") return;
											event.preventDefault();
											addChip();
										}
									}),
									h(Button, { size: "sm", variant: "outline", disabled: busy, onClick: () => addChip(), children: "添加" })
								)
							),
							"不含 / 的名字（如 .git、node_modules）挡任意深度的同名目录；含 / 的（如 docs/tmp）从工作区根算起，只挡那一个位置。"
						);

			const rowShowField = field(
				"行上显示",
				h(
					"div",
					{ className: "dsh-file-manager-config-actions" },
					[
						["download", "下载 / 打包"],
						["trash", "删除"],
						["mtime", "修改时间"],
						["size", "大小"]
					].map(([token, label]) =>
						h(Checkbox, {
							key: token,
							checked: (draft.row_show ?? []).includes(token),
							label,
							disabled: busy,
							onChange: (next) =>
								edit({
									row_show: next ? [...new Set([...(draft.row_show ?? []), token])] : (draft.row_show ?? []).filter((item) => item !== token)
								})
						})
					)
				),
				"默认只显示「下载 / 打包」。目录不显示大小（上游没有目录大小）；回收站里的「恢复 / 彻底删除 / 移动到…」不受「删除」这一项影响。"
			);

			// 工具栏显示项：**只有宿主认识这个键（draft 里有）时才画** —— 客户端先更新、宿主还没重启时，
			// 既不显示一个存不下去的勾选框，也不会让"保存"被宿主以"不认识的配置项"400 拒掉。
			const toolbarField = Array.isArray(draft.toolbar_show)
				? field(
						"工具栏显示",
						h(
							"div",
							{ className: "dsh-file-manager-config-actions" },
							[
								["multi", "多选"],
								["mkdir", "新建文件夹"],
								["zip_root", "打包根目录"],
								["empty_trash", "清空回收站"],
								["download", "下载"],
								["delete", "删除"],
								["rename", "重命名"],
								["restore", "恢复"],
								["purge", "彻底删除"],
								["move", "复制移动"],
								["clear", "清空选择"]
							].map(([token, label]) =>
								h(Checkbox, {
									key: token,
									checked: (draft.toolbar_show ?? []).includes(token),
									label,
									disabled: busy,
									onChange: (next) =>
										edit({
											toolbar_show: next ? [...new Set([...(draft.toolbar_show ?? []), token])] : (draft.toolbar_show ?? []).filter((item) => item !== token)
										})
								})
							)
						),
						"不勾的项就不出现在工具栏上；全不勾＝工具栏空着（Esc 仍能退出多选）。默认全显示。"
					)
				: null;

			const crossField = field(
				"跨工作区",
				h(Checkbox, {
					checked: draft.cross_workspace !== false,
					label: "移动 / 复制可以选到其它工作区",
					disabled: busy,
					onChange: (next) => edit({ cross_workspace: next })
				}),
				"开着（默认）：选目录时能跳到其它允许根（别的已注册工作区）；关掉：只能在你当前打开的这个工作区里操作，宿主也会拒绝越界的目标。"
			);

			const policyFields = h(
				React.Fragment,
				null,
				field(
					"自动清理",
					h(Checkbox, { checked: draft.auto_cleanup === true, label: "到期自动彻底删除", disabled: busy, onChange: (next) => edit({ auto_cleanup: next }) }),
					"关掉以后回收站只增不减，只能人工「彻底删除」或「清空回收站」。"
				),
				field(
					"保留天数",
					h(Input, {
						type: "number",
						min: 1,
						max: 3650,
						value: String(draft.retention_days ?? ""),
						disabled: busy || draft.auto_cleanup !== true,
						onChange: (event) => edit({ retention_days: event.target.value })
					}),
					draft.auto_cleanup === true ? "移入回收站后多少天自动彻底删除。" : "自动清理已关闭，这一项当前不生效。"
				),
				field(
					"清理检查间隔（小时）",
					h(Input, {
						type: "number",
						min: 0.1,
						step: 0.5,
						value: String(draft.cleanup_interval_hours ?? ""),
						disabled: busy || draft.auto_cleanup !== true,
						onChange: (event) => edit({ cleanup_interval_hours: event.target.value })
					}),
					"宿主每隔这么久扫一次；到期判定按天，不看这个间隔。"
				),
				field(
					"回收站目录名",
					h(Input, { value: String(draft.trash_dirname ?? ""), disabled: busy, onChange: (event) => edit({ trash_dirname: event.target.value }) }),
					"每个受管理目录下用这个名字存回收站。改名会让已有回收站失联（里面的条目会被当成普通目录）。"
				)
			);

			const roots = Array.isArray(effective?.roots) ? effective.roots : [];
			const summary = field(
				"当前生效",
				h(
					"div",
					{ className: "dsh-file-manager-config-list" },
					h(
						"span",
						{ className: "dsh-file-manager-config-hint" },
						`模式：${effective?.mode === "workspace" ? "按工作区" : "按目录"} · 保留 ${effective?.retentionDays ?? "-"} 天 · 自动清理${effective?.autoCleanup === false ? "已关闭" : "开启"} · 回收站 ${effective?.trashDirname ?? "-"}`
					),
					h(
						"div",
						{ className: "dsh-file-manager-config-roots" },
						roots.length === 0
							? h("span", { className: "dsh-file-manager-muted" }, "当前没有任何可管理的目录。")
							: roots.map((entry, index) =>
									h(
										"span",
										{ key: `${index}:${entry.root}`, className: "dsh-file-manager-muted" },
										`${entry.root}（${entry.recursive === true ? "含子目录" : "仅直接子项"}${entry.workspace === true ? " · 工作区" : ""}）`
									)
								)
					)
				)
			);

			const browseModal =
				browse === null
					? null
					: h(
							Modal,
							{
								open: true,
								onClose: busy ? undefined : () => setBrowse(null),
								title: "选择目录",
								closeLabel: "关闭",
								footer: h(
									React.Fragment,
									null,
									h(Button, { variant: "outline", onClick: () => setBrowse(null), children: "取消" }),
									h(Button, { variant: "primary", disabled: browse.busy || browse.path === "", onClick: () => pick(browse.path), children: "选这个目录" })
								)
							},
							h(
								"div",
								{ className: "dsh-file-manager-config-browse" },
								h(
									"div",
									{ className: "dsh-file-manager-config-actions" },
									h(Input, {
										value: browse.input ?? "",
										placeholder: "输入绝对路径后回车",
										disabled: browse.busy,
										onChange: (event) => setBrowse((current) => (current === null ? current : { ...current, input: event.target.value })),
										onKeyDown: (event) => {
											if (event.key !== "Enter") return;
											event.preventDefault();
											void walk(String(browse.input ?? ""));
										}
									}),
									h(Button, { size: "sm", variant: "outline", disabled: browse.busy, onClick: () => void walk(String(browse.input ?? "")), children: "前往" }),
									browse.parent === null ? null : h(Button, { size: "sm", variant: "ghost", disabled: browse.busy, onClick: () => void walk(String(browse.parent)), children: "上一级" })
								),
								h("span", { className: "dsh-file-manager-path", title: browse.path ?? "" }, browse.path === "" ? "（还没进入任何目录）" : browse.path),
								browse.error === "" ? null : h("span", { className: "dsh-file-manager-error" }, browse.error),
								h(
									"div",
									{ className: "dsh-file-manager-rowlist" },
									browse.dirs.length === 0
										? h("span", { className: "dsh-file-manager-muted" }, browse.busy ? "正在读取…" : "这个目录下没有子目录。")
										: browse.dirs.map((entry) =>
												h(
													"button",
													{ key: entry.path, type: "button", "data-dsh-browse-dir": "", disabled: browse.busy, onClick: () => void walk(entry.path) },
													`${entry.name}/`
												)
											)
								)
							)
						);

			return h(
				"div",
				{ className: "dsh-file-manager-config", "data-dsh-file-manager-config": "" },
				h("p", { className: "dsh-file-manager-muted" }, `配置文件：${meta.path}（点「保存」才写盘，保存即生效）`),
				note === "" ? null : h("p", { className: "dsh-file-manager-warn" }, note),
				modeField,
				manageField,
				workspaceField,
				rowShowField,
				toolbarField,
				crossField,
				policyFields,
				summary,
				error === "" ? null : h("p", { className: "dsh-file-manager-error" }, error),
				h(
					"div",
					{ className: "dsh-file-manager-config-actions" },
					h(Button, { variant: "primary", size: "sm", disabled: busy || !dirty, onClick: () => void save(), children: busy ? "保存中…" : "保存" }),
					h(Button, {
						variant: "ghost",
						size: "sm",
						disabled: busy || !dirty,
						onClick: () => {
							setDraft(JSON.parse(baseline));
							setChip("");
							setError("");
						},
						children: "放弃修改"
					}),
					dirty ? h("span", { className: "dsh-file-manager-config-hint" }, "有未保存的修改") : null
				),
				browseModal
			);
		}

		function FilesActions(props) {
			useUi();
			const root = typeof props?.absolutePath === "string" ? props.absolutePath : "";
			// 工具栏所在的树根 = 当前视图：行内与批量请求都带上它（宿主按视图保护回收站）。
			if (root !== "") selection.view = root;
			const items = [...selected.values()];
			const count = items.length;
			const busy = selection.busy;
			const manage = (item) => selectableOf(item.path, item.view ?? root)?.actions.includes("trash") === true;
			const trashed = (item) => selectableOf(item.path, item.view ?? root)?.actions.includes("restore") === true;
			const allManage = count > 0 && items.every(manage);
			const allTrashed = count > 0 && items.every(trashed);
			/**
			 * 造一个工具栏按钮。
			 * @param key - React key 与 data 名。
			 * @param label - 文字。
			 * @param onClick - 处理器。
			 * @param extra - 额外 props。
			 * @returns React 节点。
			 */
			const tool = (key, label, onClick, extra = {}) =>
				h("button", { key, type: "button", className: "dsh-file-manager-tool", "data-dsh-file-manager-tool": key, disabled: busy, onClick, ...extra }, label);
			const children = [];
			if (showsToolbar("multi")) {
				children.push(
					tool("multi", selection.mode ? "退出多选" : "多选", () => setMultiMode(!selection.mode), {
						"aria-pressed": selection.mode,
						title: selection.mode
							? "退出多选（Esc）· 多选中：勾每行左侧的方框选条目（文件夹也能选），单击文件夹仍可展开，Shift 连选"
							: "多选：进入后每行左侧出现勾选框，勾选即可；单击文件夹仍能展开，Shift 连选，Esc 退出"
					})
				);
			}
			if (count === 0) {
				if (showsToolbar("mkdir")) children.push(tool("mkdir", "新建文件夹", () => openMkdir(), { title: "在允许管理的文件夹里新建目录" }));
				if (showsToolbar("zip_root")) {
					children.push(
						tool("zip-root", "打包根目录", () => openZipRoot(root), { title: root === "" ? "当前没有可打包的根目录" : `打包下载 ${root}（会先确认）`, disabled: busy || root === "" })
					);
				}
				if (showsToolbar("empty_trash")) children.push(tool("empty-trash", "清空回收站", () => openEmptyTrash(), { title: "永久删除回收站里的所有条目" }));
			} else {
				children.push(h("span", { key: "count", className: "dsh-file-manager-count" }, `已选 ${count} 项`));
				if (showsToolbar("download")) {
					children.push(tool("download-selection", "下载", () => downloadSelection(null), { title: count === 1 && items[0].directory === false ? "下载这个文件" : "把选中项打成一个 ZIP" }));
				}
				if (allManage) {
					// row_show 里的 trash 也必须管住**批量**删除：原来只管行内按钮，
					// 于是「默认只显示下载」挡不住"进多选→勾→工具栏删除"（用户 2026-10-04 盘点里发现）。
					if (shows("trash") && showsToolbar("delete")) children.push(tool("trash-selection", "删除", () => confirmBatch("trash")));
					if (count === 1 && showsToolbar("rename")) children.push(tool("rename-selection", "重命名", () => openRename()));
					// 选中单个可管理的文件夹时，直接在这个文件夹**下面**新建（openMkdir 本来就是这么选 parent 的）。
					if (count === 1 && items[0].directory === true && showsToolbar("mkdir")) {
						children.push(tool("mkdir-selection", "新建文件夹", () => openMkdir(), { title: `在选中的文件夹下新建目录：${items[0].path}` }));
					}
				}
				if (allTrashed) {
					if (showsToolbar("restore")) children.push(tool("restore-selection", "恢复", () => confirmBatch("restore")));
					if (showsToolbar("purge")) children.push(tool("purge-selection", "彻底删除", () => confirmBatch("purge")));
				}
				// 一个入口两个动作（弹窗里再选移动/复制）。标签按用户 2026-10-04 的要求写「复制移动」，
				// 否则复制这个入口很难被发现。
				if ((allManage || allTrashed) && showsToolbar("move")) {
					children.push(tool("move-selection", "复制移动", () => openMove(), { title: "移动或复制到指定目录（弹窗里选）" }));
				}
				if (showsToolbar("clear")) children.push(tool("clear-selection", "清空选择", () => clearSelected()));
			}
			return h("span", { className: "dsh-file-manager-toolbar" }, children);
		}

		/**
		 * 列出目录（移动 / 复制 / 新建文件夹弹窗 + 配置页「浏览…」共用）：走宿主自己的 `/browse`。
		 * 为什么不用 `remote.workspaceFiles.list`：上游那个 API 被 confine 在**当前会话工作区**之内，
		 * 跨不了工作区（它的目录浏览被 confine 在会话工作区内）。
		 * **浏览不设限**（只要求是个真目录）；允许根 / disable / 跨工作区都是**写入时**才校验。
		 * @param dir - 目标目录绝对路径（空串 = 还没选起点）。
		 * @param view - 当前视图根（只用来在根清单里标出"★ 当前"）。
		 * @param signal - 取消信号。
		 * @returns `{path, parent, dirs, roots}`。
		 */
		async function browseDirectory(dir, view, signal) {
			const query = `?path=${encodeURIComponent(typeof dir === "string" ? dir : "")}${typeof view === "string" && view !== "" ? `&view=${encodeURIComponent(view)}` : ""}`;
			const response = await fetch(`${BROWSE_URL}${query}`, { headers: { accept: "application/json" }, signal });
			const data = await response.json().catch(() => ({}));
			if (!response.ok || data.ok === false) throw new Error(data?.error ?? `读目录失败（HTTP ${response.status}）`);
			return {
				path: String(data.path ?? ""),
				parent: typeof data.parent === "string" ? data.parent : null,
				dirs: Array.isArray(data.dirs) ? data.dirs.filter((entry) => typeof entry?.path === "string" && typeof entry?.name === "string") : [],
				roots: Array.isArray(data.roots) ? data.roots.filter((entry) => typeof entry?.path === "string") : []
			};
		}

		/**
		 * 「打包根目录」先确认再开跑：整棵打包**可能很久**（大目录几分钟），
		 * 以前点一下就直接开始，用户拿不到"要不要现在打包"的机会（2026-10-04 反馈）。
		 * @param root - 根目录绝对路径。
		 */
		function openZipRoot(root) {
			if (typeof root !== "string" || root === "") {
				showToast("当前没有可打包的根目录。", "warn");
				return;
			}
			openManager({
				kind: "confirm",
				title: "打包并下载这个根目录？",
				description: `会把「${root}」整棵打成 ZIP 再下载。目录大（多文件 / 大文件）时**会很慢**，下载开始后可以在进度提示上再点一次取消。`,
				confirmLabel: "开始打包",
				items: [],
				run: async () => {
					downloadZipOfRoot(root);
				}
			});
		}

		/**
		 * 打包下载某个根目录。
		 * @param root - 根目录绝对路径。
		 */
		function downloadZipOfRoot(root) {
			const sessionId = sidebarSessionId();
			if (state.remote === undefined || sessionId === undefined || root === "") {
				showToast("取不到会话信息或根目录，刷新页面再试。", "warn");
				return;
			}
			void downloadZip(state.remote, sessionId, [{ path: root, directory: true }], archiveNameOf(root), "zip-root");
		}

		/** 确认弹窗 + 提示组件（注册进 shell.overlay，常驻）。 */
		function Dialog() {
			const [, force] = React.useReducer((count) => count + 1, 0);
			const [busy, setBusy] = React.useState(false);
			const [acknowledged, setAcknowledged] = React.useState(false);
			const current = pending;
			const currentToast = toastState;
			React.useEffect(() => {
				const listener = () => force();
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			}, []);
			React.useEffect(() => {
				setBusy(false);
				setAcknowledged(false);
			}, [current]);

			/** 确认后调宿主，成功后刷新文件树并给提示。 */
			const confirm = async () => {
				setBusy(true);
				try {
					const data = await callHost(current.action, current.path, current.view);
					closeDialog();
					// 条目已经被搬走/删掉了，旧路径不再成立；顺带退出多选，让文件树恢复正常语义。
					setMultiMode(false);
					reloadTree();
					if (current.action === "trash") showToast(`已移入 ${current.trashDirname}，${current.retentionDays} 天后自动清理。`, "success");
					else if (current.action === "restore") showToast(`已恢复到 ${data.restoredTo ?? "原位置"}。`, "success");
					else showToast("已彻底删除。", "success");
				} catch (error) {
					setBusy(false);
					showToast(String(error?.message ?? error));
				}
			};

			let dialog = null;
			if (current !== null) {
				if (current.action === "trash" || current.action === "restore") {
					const isTrash = current.action === "trash";
					dialog = h(
						Modal,
						{
							open: true,
							onClose: busy ? undefined : closeDialog,
							title: isTrash ? `移入 ${current.trashDirname}？` : "恢复到原位置？",
							closeLabel: "关闭",
							footer: h(
								React.Fragment,
								null,
								h(Button, { variant: "outline", onClick: closeDialog, disabled: busy, children: "取消" }),
								h(Button, {
									variant: "primary",
									onClick: () => void confirm(),
									disabled: busy,
									children: busy ? "处理中…" : isTrash ? `移入 ${current.trashDirname}` : "恢复"
								})
							)
						},
						h(
							"p",
							{ style: { margin: 0 } },
							isTrash
								? `「${current.name}」${current.directory === true ? "及其中的全部内容" : ""}会移入 ${current.trashDirname}，${current.retentionDays} 天后自动清理；期间可以在 ${current.trashDirname} 里恢复。`
								: `「${current.name}」${current.directory === true ? "及其中的全部内容" : ""}会移回原来的位置；如果那里已经有同名的**文件夹**，就直接**合并**进去（同名条目自动加时间戳后缀），不会覆盖任何现有文件。`
						)
					);
				} else {
					dialog = h(RiskConfirmation, {
						open: true,
						title: "彻底删除？",
						description: `「${current.name}」${current.directory === true ? "及其中的全部内容" : ""}将被永久删除，无法恢复。`,
						acknowledgeLabel: "我明白此操作不可恢复",
						cancelLabel: "取消",
						closeLabel: "关闭",
						confirmLabel: busy ? "删除中…" : "彻底删除",
						acknowledged,
						disabled: busy,
						onAcknowledgedChange: setAcknowledged,
						onCancel: closeDialog,
						onConfirm: () => void confirm()
					});
				}
			}

			return h(
				React.Fragment,
				null,
				dialog,
				currentToast === null
					? null
					: h(Toast, {
							key: currentToast.key,
							text: currentToast.text,
							tone: currentToast.tone,
							onDone: () => clearToast(currentToast.key)
						})
			);
		}

		/**
		 * 列出某个根可能的两种拼写：配置里声明的路径（文件树用的就是它）与宿主 realpath。
		 * 两者在软链或多挂载点下可能不一致，都拿来匹配，避免「按钮不出现」。
		 * @param root - 宿主下发的根。
		 * @returns 去掉尾部斜杠的候选基准列表。
		 */
		function basesOf(root) {
			const list = [];
			for (const candidate of [root.declared, root.root]) {
				if (typeof candidate !== "string" || candidate === "") continue;
				const base = candidate.replace(/\/+$/, "");
				if (!list.includes(base)) list.push(base);
			}
			return list;
		}

		/**
		 * 判断某个路径该挂哪些按钮。
		 * @param path - 行上的绝对路径。
		 * @returns 挂载描述，或 null 表示不挂。
		 */
		/**
		 * 取一行所属文件树的根（请求里的 view；宿主用它做"按视图保护回收站"）。
		 * @param node - 行或任意子节点。
		 * @returns 视图根的绝对路径（拿不到就是空串）。
		 */
		function viewOfRow(node) {
			try {
				const holder = typeof node?.closest === "function" ? node.closest("[data-files-root]") : null;
				const value = holder?.getAttribute?.("data-files-root");
				if (typeof value === "string" && value !== "") return value;
			} catch {
				/* 拿不到就用兜底 */
			}
			return selection.view ?? "";
		}

		/**
		 * 该路径是否被配置的 disable 规则排除（规则是相对某个根的相对路径）。
		 * @param path - 绝对路径。
		 * @returns 是否排除。
		 */
		function isDisabled(path) {
			const config = state.config;
			const rules = Array.isArray(config?.disable) ? config.disable : [];
			if (rules.length === 0 || typeof path !== "string") return false;
			for (const root of config.roots ?? []) {
				for (const base of basesOf(root)) {
					if (!path.startsWith(`${base}/`)) continue;
					const rel = path.slice(base.length + 1);
					const segments = rel.split("/");
					for (const rule of rules) {
						// 与宿主 disabledBy / disableHit 同语义（改一边必须改另一边）：
						// 含 `/` = 锚定在根的多级路径；不含 `/` = 任意深度的同名段。
						if (rule.includes("/")) {
							if (rel === rule || rel.startsWith(`${rule}/`)) return true;
						} else if (segments.includes(rule)) return true;
					}
				}
			}
			return false;
		}

		/**
		 * 数一下树里已经加载出来的、某个回收站第一层的条目数（拿不到就是 0）。
		 * @param trashDir - 回收站绝对路径。
		 * @returns 条目数。
		 */
		function countTrashTopLevel(trashDir) {
			try {
				const prefix = `${trashDir}/`;
				const paths = new Set();
				for (const node of document.querySelectorAll("[data-files-path]")) {
					const candidate = node.getAttribute("data-files-path");
					if (typeof candidate !== "string" || !candidate.startsWith(prefix)) continue;
					const rest = candidate.slice(prefix.length);
					if (rest === "" || rest.includes("/")) continue;
					paths.add(candidate);
				}
				return paths.size;
			} catch {
				return 0;
			}
		}

		/**
		 * 给「涉及另一个工作区 / 回收站」的操作加一句额外说明（决策 D10）。
		 * @param path - 目标绝对路径。
		 * @returns 提示文案（没有就是空串）。
		 */
		function hintFor(path) {
			const config = state.config;
			if (config === undefined || typeof path !== "string" || path === "") return "";
			const roots = config.roots ?? [];
			const trashName = config.trashDirname;
			for (const root of roots) {
				for (const base of basesOf(root)) {
					if (path !== `${base}/${trashName}`) continue;
					const owner = root.title ?? base;
					const count = countTrashTopLevel(path);
					return `这是工作区「${owner}」的回收站${count === 0 ? "" : `，里面有 ${count} 项`}；搬走或删除后，那些条目将无法再「恢复」，只能等过期清理。`;
				}
			}
			for (const root of roots) {
				if (root.workspace !== true) continue;
				const label = root.title ?? root.declared ?? root.root;
				for (const base of basesOf(root)) {
					if (path === base) return `这是工作区「${label}」本身，会连同它里面的全部内容（含它的回收站）一起处理。`;
					if (base.startsWith(`${path}/`)) return `这里包含工作区「${label}」，会连同它一起处理（含它的回收站）。`;
				}
			}
			return "";
		}

		/**
		 * 判断一个路径在界面上该给哪些操作（与宿主半规则一一对应）。
		 * @param path - 行对应的绝对路径。
		 * @param view - 当前视图根（可选，用于回收站自身的保护判定）。
		 * @returns 操作描述；不该给按钮则 null。
		 */
		function classify(path, view) {
			const config = state.config;
			if (config === undefined || !Array.isArray(config.roots)) return null;
			// 第一遍：回收站相关（含任意深度）优先判定 —— 否则外层普通根会抢先匹配，
			// 把内层工作区回收站里的条目当成普通条目（这个顺序陷阱踩过一次）。
			for (const root of config.roots) {
				for (const base of basesOf(root)) {
					const trashDir = `${base}/${config.trashDirname}`;
					if (path === trashDir) {
						// 实时回收站目录本身：视图自己的那个不给按钮（宿主 D11 会 403）；
						// 视图之内、更内层工作区的回收站可以删（它在外层视图里就是普通目录）。
						if (typeof view !== "string" || view === "" || view === base) return null;
						if (isDisabled(path)) return null;
						return { actions: ["trash"], name: config.trashDirname, trashDirname: config.trashDirname, retentionDays: config.retentionDays, trashDir };
					}
					if (path.startsWith(`${trashDir}/`)) {
						const rest = path.slice(trashDir.length + 1);
						if (rest === "" || rest.split("/").includes(META_FILE)) return null;
						if (isDisabled(path)) return null;
						// 回收站里任意深度都给「恢复 / 彻底删除 / 移动到…」（决策 L2 + L3 的统一按钮）。
						return {
							actions: ["restore", "purge", "move"],
							name: rest.split("/").pop(),
							trashDirname: config.trashDirname,
							retentionDays: config.retentionDays,
							trashDir
						};
					}
				}
			}
			// 第二遍：允许根里的普通条目。
			for (const root of config.roots) {
				for (const base of basesOf(root)) {
					if (!path.startsWith(`${base}/`)) continue;
					const rest = path.slice(base.length + 1);
					if (!root.recursive && rest.includes("/")) continue; // 非递归只管直接子项（换下一个根再判）
					if (isDisabled(path)) return null;
					return {
						actions: ["trash"],
						name: rest.split("/").pop(),
						trashDirname: config.trashDirname,
						retentionDays: config.retentionDays
					};
				}
			}
			return null;
		}

		/** 造一个按钮（原生图标 + 行内几何，避免和下载插件的样式打架）。 */
		function makeButton(action) {
			const button = document.createElement("button");
			button.type = "button";
			button.dataset.dshFileManager = action;
			button.title = TITLES[action] ?? action;
			button.setAttribute("aria-label", button.title);
			// 必须在 layout() 写 inset-inline-end 之前设，cssText 会清掉已有行内样式。
			button.style.cssText = BUTTON_GEOMETRY;
			button.append(makeIcon(action));
			button.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				const path = button.dataset.dshFilePath;
				if (action === "download" || action === "zip") {
					startRowDownload(button);
					return;
				}
				const view = viewOfRow(button);
				const info = classify(path, view);
				if (info === null) return;
				openDialog({
					action,
					path,
					name: info.name,
					trashDirname: info.trashDirname,
					retentionDays: info.retentionDays,
					directory: button.dataset.dshFileEntry === "directory",
					view,
					hint: hintFor(path)
				});
			});
			return button;
		}

		/**
		 * 重排一行里的图标按钮与元信息：下载按钮固定在最右 6px，本插件的按钮依次往左排，
		 * 元信息再接在按钮簇左边（先「修改时间」再「大小」，即大小在最左）；
		 * 同时给行内文字留够内边距，避免文字钻到按钮/元信息底下。
		 * @param row - 行元素。
		 */
		function layout(row) {
			const children = [...row.children].filter((child) => typeof child.matches === "function");
			const icons = children.filter((child) => child.matches(MINE));
			let offset = 6 + icons.filter((child) => child.matches(RIGHTMOST)).length * ICON_STEP;
			for (const icon of icons) {
				if (icon.matches(RIGHTMOST)) {
					icon.style.insetInlineEnd = "6px";
					continue;
				}
				icon.style.insetInlineEnd = `${offset}px`;
				offset += ICON_STEP;
			}
			// 元信息：固定宽度，接在按钮簇左边（右→左：修改时间、大小）。
			let textPad = 0;
			for (const token of ["meta-mtime", "meta-size"]) {
				const node = children.find((child) => child.dataset?.dshFileManager === token);
				if (node === undefined) continue;
				const width = token === "meta-mtime" ? META_WIDTH.mtime : META_WIDTH.size;
				node.style.insetInlineEnd = `${offset}px`;
				offset += width + 4;
				textPad += width + 4;
			}
			const padding = `${8 + icons.length * ICON_STEP + textPad}px`;
			const box = children.find((child) => child.dataset?.dshFileManager === "select" || child.dataset?.dshFileManager === "select-placeholder");
			for (const child of children) {
				if (child.tagName !== "BUTTON" || child.matches(MINE)) continue;
				child.style.paddingInlineEnd = padding;
				child.style.paddingInlineStart = box === undefined ? "" : "26px";
			}
		}

		/** 目录 → 该目录子项的元信息（Map<名字, {type,size?,mtimeMs}>）；加载中存 "loading"，失败存 "error"。 */
		const metaCache = new Map();

		/**
		 * 当前配置要不要在行上显示某一项（配置缺字段时按「只显示下载」兜底，与宿主默认值一致）。
		 * @param token - download | trash | mtime | size。
		 * @returns 是否显示。
		 */
		function shows(token) {
			const list = state.config?.rowShow;
			if (Array.isArray(list)) return list.includes(token);
			return token === "download";
		}

		/**
		 * 工具栏上这一项要不要显示。
		 * 配置缺 `toolbarShow`（宿主还没升级、或改了配置还没重启）时**默认全显示** —— 保持现状，绝不因为
		 * 客户端先更新就把按钮藏没了。
		 * @param token - 见 TOOLBAR_TOKENS。
		 * @returns 是否显示。
		 */
		function showsToolbar(token) {
			const list = state.config?.toolbarShow;
			if (Array.isArray(list)) return list.includes(token);
			return true;
		}

		/**
		 * 取路径的父目录（行路径一律 `/` 分隔，纯字符串处理，不碰宿主）。
		 * @param path - 绝对路径。
		 * @returns 父目录；算不出来则空串。
		 */
		function parentOfPath(path) {
			if (typeof path !== "string") return "";
			const trimmed = path.replace(/[/\\]+$/, "");
			const cut = trimmed.lastIndexOf("/");
			return cut <= 0 ? "" : trimmed.slice(0, cut);
		}

		/**
		 * 绝对时间 `YYYY-MM-DD HH:mm`（浏览器本地时区）。
		 * @param ms - epoch 毫秒。
		 * @returns 文本。
		 */
		function absoluteTime(ms) {
			const date = new Date(ms);
			const pad = (value) => String(value).padStart(2, "0");
			return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
		}

		/** 丢掉全部元信息缓存（写操作之后、点树自带「重新读取」时）。 */
		function clearMeta() {
			metaCache.clear();
		}

		/**
		 * 取一个目录的元信息：每个目录只发一次请求；失败只记一次，不反复重试。
		 * @param dir - 目录绝对路径。
		 */
		function ensureMeta(dir) {
			if (dir === "" || metaCache.has(dir)) return;
			metaCache.set(dir, "loading");
			void (async () => {
				try {
					const response = await fetch(`${INFO_URL}?dir=${encodeURIComponent(dir)}`, { headers: { accept: "application/json" } });
					const data = await response.json().catch(() => ({}));
					if (!response.ok || data.ok === false) throw new Error(data?.error ?? `HTTP ${response.status}`);
					const byName = new Map();
					for (const entry of data.entries ?? []) byName.set(entry.name, entry);
					metaCache.set(dir, byName);
				} catch {
					metaCache.set(dir, "error");
				}
				// 数据到了，重扫一帧把文字画上。
				schedule();
			})();
		}

		/**
		 * 文件树自带的「重新读取」：点了就丢掉元信息缓存，让下一帧重取（用户定的刷新口径）。
		 * @param event - 点击事件。
		 */
		function onTreeReload(event) {
			const target = event.target;
			if (typeof target?.closest !== "function") return;
			if (target.closest("[data-files-reload]") === null) return;
			clearMeta();
			schedule();
		}

		/**
		 * 造一个元信息元素（大小 / 修改时间）。
		 * @param token - meta-size | meta-mtime。
		 * @returns 元素。
		 */
		function makeMeta(token) {
			const node = document.createElement("span");
			node.dataset.dshFileManager = token;
			node.className = "dsh-file-manager-meta";
			node.style.cssText = `${META_GEOMETRY};width:${token === "meta-size" ? META_WIDTH.size : META_WIDTH.mtime}px`;
			return node;
		}

		/**
		 * 按当前配置把一行装饰到位；幂等，可以反复调用。
		 * @param row - 行元素。
		 */
		function attach(row) {
			const path = row.getAttribute("data-files-path");
			const view = viewOfRow(row);
			const info = path === null || path === "" ? null : classify(path, view);
			const entry = row.getAttribute("data-files-entry");
			// 下载/打包与允许清单无关：跟上游一样，任何文件行都能下载，目录行能打包（FOLDER_ZIP 开关）。
			// 两者都受配置 row_show 控制（默认只有它们）。
			const downloadAction = !shows("download") ? undefined : entry === "file" ? "download" : FOLDER_ZIP && entry === "directory" ? "zip" : undefined;
			// row_show 里的 trash 只管「删除」；回收站行的「恢复 / 彻底删除 / 移动到…」不在那四项里，永远显示。
			const wanted = (info?.actions ?? []).filter((action) => action !== "trash" || shows("trash"));
			if (downloadAction !== undefined && path !== null && path !== "") wanted.unshift(downloadAction);
			const existing = [...row.children].filter((child) => typeof child.matches === "function" && child.matches(MINE));
			for (const button of existing) {
				if (!wanted.includes(button.dataset.dshFileManager)) button.remove();
			}
			for (const action of wanted) {
				const found = existing.find((candidate) => candidate.dataset.dshFileManager === action);
				let button = found !== undefined && found.isConnected ? found : undefined;
				if (button === undefined) {
					button = makeButton(action);
					row.append(button);
				}
				button.dataset.dshFilePath = path;
				button.dataset.dshFileEntry = entry ?? "";
				button.dataset.dshFileSession = sessionOf(row) ?? "";
				if (action === "zip") button.title = `打包下载 ${archiveNameOf(path)}`;
				else if (action === "download") button.title = `下载 ${fileNameOf(path)}`;
				if (action === "zip" || action === "download") button.setAttribute("aria-label", button.title);
			}
			// 行元信息（大小 / 修改时间）：只挂在「可管理」的行上（与按钮同一套判定），
			// 数据按目录缓存、取到才画（取不到就什么都不占位）。
			const dir = path === null || path === "" ? "" : parentOfPath(path);
			if (dir !== "" && info !== null && (shows("mtime") || shows("size"))) ensureMeta(dir);
			const cached = dir === "" ? undefined : metaCache.get(dir);
			const record = cached instanceof Map && path !== null ? cached.get(fileNameOf(path)) : undefined;
			const wantedMeta = new Map();
			if (info !== null && record !== undefined) {
				if (shows("mtime") && Number.isFinite(record.mtimeMs)) wantedMeta.set("meta-mtime", absoluteTime(record.mtimeMs));
				// 目录没有 size（上游也不给目录大小），只显示修改时间。
				if (shows("size") && entry === "file" && Number.isFinite(record.size)) wantedMeta.set("meta-size", fileSizeText(record.size));
			}
			const existingMeta = [...row.children].filter((child) => typeof child.matches === "function" && child.matches(META));
			// 同一 token 只留一个（优先留连着 DOM 的）：既清掉不再需要的，也顺手清掉历史遗留的重复注入。
			const kept = new Map();
			for (const node of [...existingMeta.filter((child) => child.isConnected), ...existingMeta.filter((child) => !child.isConnected)]) {
				const token = node.dataset.dshFileManager;
				if (!wantedMeta.has(token) || kept.has(token)) {
					node.remove();
					continue;
				}
				kept.set(token, node);
			}
			for (const [token, text] of wantedMeta) {
				let node = kept.get(token);
				if (node === undefined) {
					node = makeMeta(token);
					row.append(node);
				}
				if (node.textContent !== text) node.textContent = text;
			}
			const selectable = path !== null && path !== "" && selectableOf(path, view) !== null;
			// 多选模式下**每一行**都要有框：可选的给真框，不可选的给灰色占位框（只为对齐，避免看着像从属关系变了）。
			const wantBox = selection.mode ? (selectable ? "select" : "select-placeholder") : undefined;
			const box = [...row.children].find((child) => typeof child.matches === "function" && child.matches('input[data-dsh-file-manager="select"], input[data-dsh-file-manager="select-placeholder"]'));
			if (wantBox === undefined) {
				if (box !== undefined) box.remove();
			} else if (box === undefined || box.dataset.dshFileManager !== wantBox) {
				if (box !== undefined) box.remove();
				const created = makeCheckbox(path ?? "", entry === "directory", wantBox === "select");
				if (wantBox === "select") created.dataset.dshFilePath = path;
				row.append(created);
			}
			if (selectable || wanted.length > 0 || wantedMeta.size > 0) row.classList.add("dsh-file-manager-row");
			else row.classList.remove("dsh-file-manager-row");
			layout(row);
		}

		/** 全量重扫：树很小，重扫最省心，也不会漏掉别的插件后加的按钮。 */
		function rescan() {
			for (const row of document.querySelectorAll(ROW)) attach(row);
			paintSelection();
		}

		let scheduled = false;
		/** 把重扫合并到下一帧，避免连续 DOM 变更时反复全扫。 */
		function schedule() {
			if (scheduled) return;
			scheduled = true;
			requestAnimationFrame(() => {
				scheduled = false;
				rescan();
			});
		}

		/** 拉一次宿主配置；改了配置刷新页面就生效（删除权限不该在会话中途悄悄变化）。 */
		async function loadConfig() {
			try {
				const response = await fetch(CONFIG_URL, { headers: { accept: "application/json" } });
				const data = await response.json().catch(() => ({}));
				if (!response.ok || data?.ok === false) throw new Error(data?.error ?? `HTTP ${response.status}`);
				state.config = data;
				if (data.error !== undefined) console.warn(`[dsh-file-manager] ${data.error}`);
				for (const warning of data.warnings ?? []) console.warn(`[dsh-file-manager] ${warning}`);
			} catch (error) {
				state.config = undefined;
				console.warn(`[dsh-file-manager] 读取配置失败：${String(error?.message ?? error)}`);
			}
			schedule();
		}

		/**
		 * 客户端插件入口。
		 * @param ctx - 客户端上下文。
		 */
		function apply(ctx) {
			state.remote = ctx.remote?.workspaceFiles;
			const disposeSlot = ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register({ name: "shell.overlay", id: "dsh-file-manager.dialog", order: 100 }, Dialog)
			);
			const disposeFilesSlot = ctx.slots.inject("sidebar.right.tab.files.actions", () =>
				ctx.slots.register({ name: "sidebar.right.tab.files.actions", id: "dsh-file-manager.files", order: 100 }, FilesActions)
			);
			const disposePreviewSlot = ctx.slots.inject("sidebar.right.tab.document.actions", () =>
				ctx.slots.register({ name: "sidebar.right.tab.document.actions", id: "dsh-file-manager.download", order: 100 }, PreviewDownload)
			);
			const disposeManagerSlot = ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register({ name: "shell.overlay", id: "dsh-file-manager.manager", order: 110 }, ManagerDialog)
			);
			// 插件自己的配置页：侧栏「插件」→ dsh-file-manager 卡片里（平台正典位置）。
			// keyed slot，键 = 本包名；只需 inject 等它被声明，不必依赖插件页那个包。
			const disposeConfigSlot = ctx.slots.inject("plugins.bundle.config", () =>
				ctx.slots.register({ name: "plugins.bundle.config", key: "dsh-file-manager" }, ConfigPanel)
			);
			// 捕获阶段拦截：多选模式或按住修饰键时，单击行 = 勾选（不展开、不预览）。
			document.addEventListener("mousedown", onSelectionDown, true);
			document.addEventListener("click", onSelectionClick, true);
			document.addEventListener("keydown", onSelectionKey, true);
			// 文件树自带的「重新读取」被点击 → 元信息缓存作废、重新取一次。
			document.addEventListener("click", onTreeReload, true);
			const style = document.createElement("style");
			style.dataset.dshFileManagerStyle = "";
			style.textContent = CSS;
			document.head.append(style);

			const observer = new MutationObserver(schedule);
			observer.observe(document.body, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ["data-files-path", "data-files-entry", "data-sidebar-right-session"]
			});
			schedule();
			void loadConfig();

			return () => {
				observer.disconnect();
				for (const transfer of transfers.values()) transfer.controller.abort();
				transfers.clear();
				if (typeof disposeSlot === "function") disposeSlot();
				if (typeof disposeFilesSlot === "function") disposeFilesSlot();
				if (typeof disposePreviewSlot === "function") disposePreviewSlot();
				if (typeof disposeManagerSlot === "function") disposeManagerSlot();
				if (typeof disposeConfigSlot === "function") disposeConfigSlot();
				document.removeEventListener("mousedown", onSelectionDown, true);
				document.removeEventListener("click", onSelectionClick, true);
				document.removeEventListener("keydown", onSelectionKey, true);
				document.removeEventListener("click", onTreeReload, true);
				clearMeta();
				manager = null;
				selected.clear();
				style.remove();
				for (const button of document.querySelectorAll(MINE)) button.remove();
				for (const row of document.querySelectorAll(".dsh-file-manager-row")) row.classList.remove("dsh-file-manager-row");
			};
		}

		// __internals 只给本地测试用（生产不使用这些名字）。
		module.exports = {
			apply,
			inject: ["slots", "remote", "remote.workspaceFiles"],
			__internals: { crc32, zipEntryOf, zipBudget, planZip, writeZip, bufferedWriter }
		};
		return module.exports;
	}
});
