"use strict";
/**
 * zip 解压 worker 入口。
 *
 * 为什么必须独立成文件：`inflate + 逐条 writeFileSync` 全部是同步 CPU/IO，
 * 放在扩展宿主主线程里会把事件循环卡住十几到二十几秒（现场实测 17–25s/轮），
 * 期间 webview 心跳、RPC、工具调用全部停摆。
 *
 * 注意：本文件是**运行时按路径加载**的入口（`new Worker(join(__dirname, 'zip-extract.worker.js'))`），
 * 编译后必须与 `marketplace-io.js` 同目录；不要把它合并进其他模块或被 tree-shake 掉。
 *
 * 协议：
 *   workerData: { zipPath: string; targetDir: string }
 *   message:    { ok: true } | { ok: false, error: string }
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const adm_zip_1 = __importDefault(require("adm-zip"));
const fs_1 = require("fs");
const worker_threads_1 = require("worker_threads");
// 只依赖 zip-entry-guard（仅用 path）：worker 是运行时按路径加载的独立文件，
// 它的相对依赖必须能被一起拷到 bundle 输出目录 —— 不要把依赖链引回 marketplace-io
// （那会把 http/stream 等一并拖进来，且 bundle 目录里没有对应文件）。
const zip_entry_guard_1 = require("./zip-entry-guard");
function readWorkerData() {
    const data = worker_threads_1.workerData;
    if (!data || typeof data.zipPath !== 'string' || typeof data.targetDir !== 'string') {
        throw new Error('zip-extract worker started without valid workerData');
    }
    return { zipPath: data.zipPath, targetDir: data.targetDir };
}
async function run() {
    const { zipPath, targetDir } = readWorkerData();
    // worker 内同步解压不会影响主线程事件循环，这正是本次改造的目的。
    const zip = new adm_zip_1.default(zipPath);
    (0, zip_entry_guard_1.assertSafeArchive)(zip.getEntries(), targetDir);
    await fs_1.promises.mkdir(targetDir, { recursive: true });
    zip.extractAllTo(targetDir, true);
}
run().then(() => {
    worker_threads_1.parentPort === null || worker_threads_1.parentPort === void 0 ? void 0 : worker_threads_1.parentPort.postMessage({ ok: true });
    process.exit(0);
}, (error) => {
    worker_threads_1.parentPort === null || worker_threads_1.parentPort === void 0 ? void 0 : worker_threads_1.parentPort.postMessage({
        ok: false,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
    process.exit(0);
});
//# sourceMappingURL=zip-extract.worker.js.map