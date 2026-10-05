# 第三方许可（Third-party notices）

本项目的部分代码**移植自**下列项目。按其许可要求，在此附带版权声明与许可全文
（MIT：「The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.」）。

---

## dsh-file-download

- 来源：<https://github.com/lorsabyan/dsh-file-download>（v0.2.0）
- 用到的部分：`lib/client.js` 里的**下载 / 打包 ZIP** 那一块 ——
  `crc32`、`zipBudget`、`zipEntryOf`、`zipRecord`、`zipLocalHeader`、`zipDescriptor`、
  `zipCentralHeader`、`zipEndRecord`、`planZip`、`writeZip`、`bufferedWriter`、`saveBlob`，
  以及配套的分块读取 / 传输进度流程。
- 本项目的改动：合并进单文件 bundle、改走 `ctx.remote.workspaceFiles`、
  把「文件下载 / 目录 ZIP / 打包根目录 / 多选打包」四个入口合成一套 `planZip`、
  状态提示改用本插件的 Toast（详见 `lib/client.js` 里那段移植声明）。
- 许可：MIT

```
MIT License

Copyright (c) 2026 Aghasi Lorsabyan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
