"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_EXTRACTED_BYTES = exports.MAX_ZIP_ENTRIES = void 0;
exports.checkZipEntry = checkZipEntry;
exports.assertSafeZipEntries = assertSafeZipEntries;
exports.assertSafeArchive = assertSafeArchive;
const path_1 = require("path");
/** Unix 文件类型掩码（S_IFMT）与符号链接类型值（S_IFLNK），取值于 16 位 mode。 */
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
/**
 * 判断条目的权限位是否声明为符号链接。
 *
 * zip 实现对此有两种约定，必须都覆盖：
 * - `attr` = 完整 32 位外部属性，mode 在高 16 位（adm-zip / Info-ZIP 的常见形态）；
 * - `attr` = 16 位 mode 本身（部分工具/测试构造）。
 */
function isSymlinkAttr(attr) {
    const highMode = (attr >>> 16) & 0xffff;
    return ((attr & S_IFMT) === S_IFLNK) || ((highMode & S_IFMT) === S_IFLNK);
}
/**
 * 是否包含控制字符（含 NUL）—— 历史上被用于绕过路径检查。
 *
 * 用字符码循环而不是正则：本规则场景就是"检测控制字符"，写成 `/[\u0000-\u001f]/`
 * 会命中 `no-control-regex`（且每次调用都要编译正则）。
 */
function hasControlCharacter(value) {
    for (let index = 0; index < value.length; index++) {
        if (value.charCodeAt(index) < 0x20) {
            return true;
        }
    }
    return false;
}
/** Windows 盘符前缀，如 `C:`、`c:`。 */
const DRIVE_LETTER_PATTERN = /^[a-zA-Z]:/;
/**
 * 校验单条条目是否可安全解压到 `targetDir`。
 *
 * @returns 合法时返回 `null`，否则返回拒绝原因。
 */
function checkZipEntry(entry, targetDir) {
    var _a;
    const rawName = (_a = entry.entryName) !== null && _a !== void 0 ? _a : '';
    if (rawName.length === 0) {
        return 'empty-name';
    }
    if (hasControlCharacter(rawName)) {
        return 'illegal-character';
    }
    // Windows 上 zip 里的分隔符可能是 `\`，统一成 `/` 后再判断，避免 `..\..\x` 漏判。
    const normalizedSeparators = rawName.replace(/\\/g, '/');
    if (normalizedSeparators.startsWith('/') || DRIVE_LETTER_PATTERN.test(normalizedSeparators)) {
        return 'absolute-path';
    }
    const segments = normalizedSeparators.split('/');
    // 不能用 `=== '..'` 精确匹配：Windows 解析路径时会剥掉每段结尾的点与空格，
    // 于是 `.. ` / `...` 这类段最终仍被解析成 `..`，而下面的 resolve() 兜底也不会规范化它们。
    // 统一的拒绝规则是"段以 .. 开头"（正常文件名极少以 .. 开头）。
    if (segments.some(segment => segment.startsWith('..'))) {
        return 'path-traversal';
    }
    const attr = entry.attr;
    if (typeof attr === 'number' && isSymlinkAttr(attr)) {
        return 'symlink';
    }
    // 兜底：规范化 + 边界前缀校验（防止上面没覆盖的平台差异）。目录条目以 `/` 结尾时，
    // resolve 会去掉尾部分隔符，故先去掉再比较。
    const trimmed = normalizedSeparators.endsWith('/') ? normalizedSeparators.slice(0, -1) : normalizedSeparators;
    if (trimmed.length === 0) {
        // 纯目录条目（`a/`）已在上面的段检查里通过，这里直接放行。
        return null;
    }
    const targetRoot = (0, path_1.resolve)(targetDir);
    const resolvedEntry = (0, path_1.resolve)((0, path_1.join)(targetRoot, trimmed));
    const rootWithSep = targetRoot.endsWith(path_1.sep) ? targetRoot : targetRoot + path_1.sep;
    if (resolvedEntry !== targetRoot && !resolvedEntry.startsWith(rootWithSep)) {
        return 'outside-target';
    }
    return null;
}
/**
 * 校验整包条目。任一条不合法即抛出，调用方不得继续解压。
 *
 * @throws Error 携带被拒绝的条目名与原因，便于现场定位是包的问题还是解析的问题。
 */
function assertSafeZipEntries(entries, targetDir) {
    const total = entries.length;
    // 条数上限：防御"解压炸弹"式的条目膨胀（目录项 + 文件项）。
    if (total > exports.MAX_ZIP_ENTRIES) {
        throw new Error(`Zip rejected: too many entries (${total} > ${exports.MAX_ZIP_ENTRIES})`);
    }
    for (const entry of entries) {
        const rejection = checkZipEntry(entry, targetDir);
        if (rejection !== null) {
            throw new Error(`Zip rejected: entry "${entry.entryName}" is unsafe (${rejection})`);
        }
    }
}
/**
 * 条目数上限。市场包是 skill 文档集合，正常规模在数百条以内；
 * 取 20000 既不会误伤大型市场，又能挡住 `a/a/a/...` 式的条目膨胀。
 */
exports.MAX_ZIP_ENTRIES = 20000;
/**
 * 解压前完整校验：Zip Slip / 符号链接 / 条目数 / 解压体积上限。
 * 任一不满足直接抛出，调用方不得继续解压。
 *
 * 放在本模块（只依赖 path）而不是 marketplace-io：这样 worker 入口文件只需要
 * 与本文件同目录即可运行，不必把整个 marketplace-io（含 http/stream 依赖）一起拷进
 * bundle 输出目录。详见 apps/extension/vscode/scripts/copy-marketplace-worker.js。
 */
function assertSafeArchive(entries, targetDir) {
    assertSafeZipEntries(entries, targetDir);
    let totalBytes = 0;
    for (const entry of entries) {
        const size = readEntrySize(entry);
        if (size !== undefined) {
            totalBytes += size;
            if (totalBytes > exports.MAX_EXTRACTED_BYTES) {
                throw new Error(`Zip rejected: uncompressed size exceeds limit ${exports.MAX_EXTRACTED_BYTES}`);
            }
        }
    }
}
function readEntrySize(entry) {
    const header = entry.header;
    const size = header === null || header === void 0 ? void 0 : header.size;
    return typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : undefined;
}
/**
 * 解压后允许的总字节数上限（1 GiB）。防御"高压缩比解压炸弹"把 EH 内存/磁盘打满。
 */
exports.MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024;
//# sourceMappingURL=zip-entry-guard.js.map