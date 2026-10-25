"""
genie-safe-delete — Python 运行时安全删除 shim

通过 PYTHONPATH 中的 sitecustomize.py 自动加载，
拦截 os.remove / os.rmdir / shutil.rmtree / pathlib 的删除 API，
把文件移入操作系统的回收站而不是真删。

实现：优先调用 genie-trash native binary；不可用时回退到平台内联实现
（macOS: ctypes FSMoveObjectToTrashSync，Windows: ctypes SHFileOperationW，
 Linux: freedesktop Trash spec 纯 Python 实现）。

设计要点见 apps/workbuddy-desktop/docs/safe-delete-runtime-trash.md
"""

import atexit
import errno
import builtins
import hashlib
import io
import json
import os
import socket
import stat
import sys
import tempfile
import time

# ---------------------------------------------------------------------------
# 触发条件
# ---------------------------------------------------------------------------

_SESSION_ID = (
    os.environ.get("CODEBUDDY_SESSION_ID")
    or os.environ.get("CLAUDE_SESSION_ID")
)
_IN_SANDBOX = False  # Phase 3 brokered-sandbox removed
_SAFE_DELETE_ENABLED = os.environ.get("CODEBUDDY_SAFE_DELETE_ENABLED") != "0"
_BROKERED_FS_HOOK_ENABLED = False  # Phase 3 brokered-sandbox removed

# ---------------------------------------------------------------------------
# Execution context liveness gate + lazy identity resolution.
#
# Semantics live in packages/safe-delete/src/context-liveness.ts (single source of
# truth); this is the Python replica, pinned by SAFE_DELETE_LIVENESS_VECTORS.
#
# The terminal env is inherited by every child of an Agent terminal, including
# long-lived daemons that build tools fork themselves. Those daemons outlive the
# tool call (and CodeBuddy itself) and get reused by other IDEs, so:
#   1. identity (toolCallId) is resolved per delete and never written back into
#      os.environ — freezing a finished tool call's identity into a daemon made the
#      bulk guard accumulate counts under a zombie requestId until it blocked
#      unrelated builds with a confirmation nobody could approve;
#   2. when the owning context is dead, every hook passes through to the native
#      os/shutil implementation: no trash, no bulk guard, no blocking.
#
# Both gates are "unknown -> treat as live" so hosts that inject neither keep the
# pre-fix behaviour.
# ---------------------------------------------------------------------------

_CONTEXT_CACHE_TTL_MS = 1000
_HOST_HEARTBEAT_STALE_FACTOR = 3
_DEFAULT_HOST_HEARTBEAT_INTERVAL_MS = 30000
_MIN_HOST_HEARTBEAT_INTERVAL_MS = 1000
_MAX_HOST_HEARTBEAT_INTERVAL_MS = 300000

# {"at": ms, "live": bool, "tool_call_id": str|None, "request_id": str|None}
_context_cache = None


def _read_json_with_mtime(file_path):
    """-> (parsed_or_None, mtime_ms) ; None when the file is unreadable."""
    try:
        with open(file_path, "r") as f:
            raw = f.read()
        mtime_ms = os.stat(file_path).st_mtime * 1000
    except Exception:
        return None
    try:
        return (json.loads(raw), mtime_ms)
    except Exception:
        # Truncated write (atomic rename caught mid-flight).
        return (None, mtime_ms)


def _normalize_heartbeat_interval_ms(value):
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return _DEFAULT_HOST_HEARTBEAT_INTERVAL_MS
    return min(
        _MAX_HOST_HEARTBEAT_INTERVAL_MS,
        max(_MIN_HOST_HEARTBEAT_INTERVAL_MS, int(value)),
    )


def _check_host_heartbeat_liveness(now_ms):
    """-> "live" | "dead" | "unknown" """
    heartbeat_path = os.environ.get("CODEBUDDY_SAFE_DELETE_HOST_HEARTBEAT")
    if not heartbeat_path:
        return "unknown"
    file = _read_json_with_mtime(heartbeat_path)
    if file is None:
        # The heartbeat lives in the host's own state dir; its absence means the
        # host that injected this env is gone.
        return "dead"
    parsed, mtime_ms = file
    if not parsed or parsed.get("version") != 1:
        # Corrupt / mid-write snapshot: fall back to mtime instead of declaring the
        # host dead (which would silently disable protection).
        age = now_ms - mtime_ms
        limit = _DEFAULT_HOST_HEARTBEAT_INTERVAL_MS * _HOST_HEARTBEAT_STALE_FACTOR
        return "live" if age <= 0 or age <= limit else "dead"
    refreshed_at = parsed.get("refreshedAt")
    if not isinstance(refreshed_at, (int, float)) or isinstance(refreshed_at, bool):
        refreshed_at = mtime_ms
    age = now_ms - refreshed_at
    if age <= 0:
        return "live"  # Clock skew / NTP correction — keep protection on.
    limit = _normalize_heartbeat_interval_ms(parsed.get("intervalMs")) * _HOST_HEARTBEAT_STALE_FACTOR
    return "live" if age <= limit else "dead"


def _resolve_terminal_state_file():
    state_dir = os.environ.get("CODEBUDDY_SAFE_DELETE_STATE_DIR")
    terminal_key = os.environ.get("CODEBUDDY_SAFE_DELETE_TERMINAL_KEY")
    if not state_dir or not terminal_key:
        return None
    root = os.path.abspath(state_dir)
    state_file = os.path.abspath(os.path.join(root, terminal_key + ".json"))
    # Prevent symlink/path-escape attacks: must stay inside the state root.
    if state_file != root and not state_file.startswith(root + os.sep):
        return None
    return state_file


def _check_terminal_context(now_ms):
    """-> ("live"|"dead"|"unknown", tool_call_id|None, request_id|None)"""
    state_file = _resolve_terminal_state_file()
    if not state_file:
        return ("unknown", None, None)
    file = _read_json_with_mtime(state_file)
    if file is None:
        return ("dead", None, None)
    ctx = file[0]
    if not ctx or ctx.get("version") != 1 or ctx.get("active") is not True:
        return ("dead", None, None)
    expires_at = ctx.get("expiresAt", 0)
    if not isinstance(expires_at, (int, float)) or isinstance(expires_at, bool):
        expires_at = 0
    if now_ms > expires_at:
        return ("dead", None, None)
    tool_call_id = str(ctx["toolCallId"]) if ctx.get("toolCallId") else None
    request_id = str(ctx["conversationRequestId"]) if ctx.get("conversationRequestId") else None
    return ("live", tool_call_id, request_id)


def _resolve_execution_context():
    """Liveness + identity, memoized for _CONTEXT_CACHE_TTL_MS.

    The reported incident deleted 530+ paths in one call, so re-reading two files
    per path would add O(N) IO; memoizing keeps it O(1)/sec while closing the gate
    within a second of the tool call ending.
    """
    global _context_cache
    now_ms = time.time() * 1000
    cache = _context_cache
    if cache and now_ms >= cache["at"] and now_ms - cache["at"] < _CONTEXT_CACHE_TTL_MS:
        return cache
    host = _check_host_heartbeat_liveness(now_ms)
    if host == "dead":
        terminal = ("unknown", None, None)
    else:
        terminal = _check_terminal_context(now_ms)
    _context_cache = {
        "at": now_ms,
        "live": host != "dead" and terminal[0] != "dead",
        "tool_call_id": os.environ.get("CODEBUDDY_TOOL_CALL_ID") or terminal[1],
        "request_id": os.environ.get("CODEBUDDY_CONVERSATION_REQUEST_ID") or terminal[2],
    }
    return _context_cache


def _is_context_live():
    return _resolve_execution_context()["live"]

if _SESSION_ID:
    # __file__ 在 sitecustomize 加载时指向本文件路径，dirname 即 vendor/shim/
    _SHIM_DIR = os.path.dirname(os.path.abspath(__file__))

    # sitecustomize 是 Python 保留文件名，Python 启动时会自动 import
    # sys.path 上第一个匹配的模块。把 shim 目录前置到 PYTHONPATH 后，
    # 用户环境原有的 sitecustomize（conda / virtualenv / 企业配置等）会被覆盖。
    # 因此在注入 shim 前，先临时从 sys.modules 和 sys.path 中移除自身，
    # 尝试加载原始的 sitecustomize，再恢复自身。
    _self = sys.modules.pop("sitecustomize", None)
    if _SHIM_DIR in sys.path:
        sys.path.remove(_SHIM_DIR)
    try:
        __import__("sitecustomize")
    except ImportError as e:
        # 只有模块本身不存在时才静默（e.name == "sitecustomize"）；
        # 若模块存在但内部导入失败（e.name 为其他名），输出 traceback 到 stderr
        if e.name is not None and e.name != "sitecustomize":
            import traceback
            traceback.print_exc(file=sys.stderr)
    if _SHIM_DIR not in sys.path:
        sys.path.insert(0, _SHIM_DIR)
    if _self is not None:
        sys.modules["sitecustomize"] = _self

    # -----------------------------------------------------------------------
    # 平台内联 trash 实现（genie-trash binary 不可用时的降级路径）
    # 仅使用标准库，无第三方依赖。
    # -----------------------------------------------------------------------

    if sys.platform == "darwin":
        # macOS: ctypes → CoreServices.FSMoveObjectToTrashSync
        # API 在 macOS 10.8 标记 deprecated，但至今仍可用；不依赖 Finder，headless 安全。
        from ctypes import cdll, byref, Structure, c_char, c_char_p
        from ctypes.util import find_library as _find_library

        _Foundation = cdll.LoadLibrary(_find_library("Foundation"))
        _CoreServices = cdll.LoadLibrary(_find_library("CoreServices"))
        _GetOSStatusComment = _Foundation.GetMacOSStatusCommentString
        _GetOSStatusComment.restype = c_char_p
        _FSPathMakeRefWithOptions = _CoreServices.FSPathMakeRefWithOptions
        _FSMoveObjectToTrashSync = _CoreServices.FSMoveObjectToTrashSync

        class _FSRef(Structure):
            _fields_ = [("hidden", c_char * 80)]

        def _platform_trash(abs_path):
            path_b = abs_path.encode("utf-8") if isinstance(abs_path, str) else abs_path
            fp = _FSRef()
            rc = _FSPathMakeRefWithOptions(path_b, 0x01, byref(fp), None)
            if rc:
                raise OSError(_GetOSStatusComment(rc).decode("utf-8", errors="replace"))
            rc = _FSMoveObjectToTrashSync(byref(fp), None, 0)
            if rc:
                raise OSError(_GetOSStatusComment(rc).decode("utf-8", errors="replace"))

    elif sys.platform == "win32":
        # Windows: ctypes → shell32.SHFileOperationW
        # API 在 Vista 后标记 deprecated（推荐 IFileOperation），但仍广泛可用。
        from ctypes import (
            windll, Structure, byref, c_uint,
            create_unicode_buffer, addressof,
            GetLastError, FormatError,
        )
        from ctypes.wintypes import HWND, UINT, BOOL, LPCWSTR

        _kernel32 = windll.kernel32
        _shell32 = windll.shell32
        _FO_DELETE = 3
        _FOF_FLAGS = 64 | 16 | 1024 | 4  # ALLOWUNDO | NOCONFIRMATION | NOERRORUI | SILENT

        class _SHFILEOPSTRUCTW(Structure):
            _fields_ = [
                ("hwnd", HWND), ("wFunc", UINT), ("pFrom", LPCWSTR),
                ("pTo", LPCWSTR), ("fFlags", c_uint), ("fAnyOperationsAborted", BOOL),
                ("hNameMappings", c_uint), ("lpszProgressTitle", LPCWSTR),
            ]

        def _get_short_path(path):
            """调用 GetShortPathNameW 处理超长路径和特殊字符。"""
            prefix = "\\\\?\\"
            long_path = (prefix + "UNC" + path[1:]) if path.startswith("\\\\") else (prefix + path)
            n = _kernel32.GetShortPathNameW(long_path, None, 0)
            if not n:
                err = GetLastError()
                raise OSError(err, FormatError(err), path)
            buf = create_unicode_buffer(n)
            _kernel32.GetShortPathNameW(long_path, buf, n)
            s = buf.value
            # 还原 UNC 前缀：\\?\UNC\server → \\server
            if s.startswith("\\\\?\\UNC"):
                return "\\" + s[7:]
            # 普通路径：去掉 \\?\
            return s[4:] if s.startswith(prefix) else s

        def _platform_trash(abs_path):
            path = _get_short_path(os.path.abspath(abs_path))
            # pFrom 需要双 null 终止的字符串（SHFileOperationW 规范）
            buf = create_unicode_buffer(path, len(path) + 2)
            fileop = _SHFILEOPSTRUCTW()
            fileop.wFunc = _FO_DELETE
            fileop.pFrom = LPCWSTR(addressof(buf))
            fileop.fFlags = _FOF_FLAGS
            result = _shell32.SHFileOperationW(byref(fileop))
            if result:
                raise OSError("SHFileOperationW 失败: 0x%x" % result)

    else:
        # Linux / 其他 POSIX: freedesktop Trash spec（XDG Base Directory）
        from datetime import datetime as _datetime
        import shutil as _shutil

        def _trashinfo_encode(s):
            """仅编码非 ASCII 和控制字符，与 Node.js/Bash 版本保持一致。"""
            parts = []
            for ch in s:
                if '\x20' <= ch <= '\x7e':
                    parts.append(ch)
                else:
                    parts.append(''.join('%{:02X}'.format(b) for b in ch.encode('utf-8')))
            return ''.join(parts)

        _uid = os.getuid()
        _xdg_data = os.fsencode(
            os.environ.get("XDG_DATA_HOME", os.path.expanduser("~/.local/share"))
        )
        _home_trash = os.path.join(_xdg_data, b"Trash")

        def _find_ext_volume_trash(volume_root):
            """freedesktop spec §1: 优先 .Trash/$uid（需 sticky bit），否则 .Trash-$uid。"""
            uid_b = str(_uid).encode()
            trash_base = os.path.join(volume_root, b".Trash")
            if (
                os.path.isdir(trash_base)
                and not os.path.islink(trash_base)
                and bool(os.lstat(trash_base).st_mode & 0o1000)  # sticky bit
            ):
                trash_dir = os.path.join(trash_base, uid_b)
                os.makedirs(trash_dir, 0o700, exist_ok=True)
                return trash_dir
            trash_dir = os.path.join(volume_root, b".Trash-" + uid_b)
            os.makedirs(trash_dir, 0o700, exist_ok=True)
            return trash_dir

        def _trash_move(path_b, dest_trash, topdir):
            """将文件移动到 dest_trash，并写入对应的 .trashinfo。"""
            files_dir = os.path.join(dest_trash, b"files")
            info_dir = os.path.join(dest_trash, b"info")
            os.makedirs(files_dir, 0o700, exist_ok=True)
            os.makedirs(info_dir, 0o700, exist_ok=True)

            filename = os.path.basename(path_b)
            base, ext = os.path.splitext(filename)
            dest_name = filename
            counter = 0
            while os.path.exists(os.path.join(files_dir, dest_name)) or \
                    os.path.exists(os.path.join(info_dir, dest_name + b".trashinfo")):
                counter += 1
                dest_name = base + b"." + str(counter).encode() + ext

            real_path = os.path.realpath(path_b)
            real_top = os.path.realpath(topdir)
            if real_path.startswith(real_top):
                info_path = _trashinfo_encode(os.fsdecode(os.path.relpath(path_b, topdir)))
            else:
                info_path = _trashinfo_encode(os.fsdecode(os.path.abspath(path_b)))

            info_content = "[Trash Info]\nPath=%s\nDeletionDate=%s\n" % (
                info_path, _datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
            )
            info_file = os.path.join(info_dir, dest_name + b".trashinfo")
            fd = os.open(info_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                with os.fdopen(fd, "w") as f:
                    f.write(info_content)
            except Exception:
                try:
                    _orig_unlink(info_file)
                except OSError:
                    pass
                raise

            dest_file = os.path.join(files_dir, dest_name)
            try:
                os.rename(path_b, dest_file)
            except OSError as e:
                if e.errno == errno.EXDEV:
                    # _shutil.move 内部调用 shutil.rmtree，后者已被补丁为
                    # _safe_shutil_rmtree —— 这会重入 _try_trash 形成循环。
                    # 临时将 shutil.rmtree 恢复为原始版本后再调用。
                    _saved_rmtree = shutil.rmtree
                    shutil.rmtree = _orig_shutil_rmtree
                    try:
                        _shutil.move(os.fsdecode(path_b), os.fsdecode(dest_file))
                    except Exception:
                        try:
                            _orig_unlink(info_file)
                        except OSError:
                            pass
                        raise
                    finally:
                        shutil.rmtree = _saved_rmtree
                else:
                    try:
                        _orig_unlink(info_file)
                    except OSError:
                        pass
                    raise

        def _platform_trash(abs_path):
            path_b = os.fsencode(abs_path)
            path_dev = os.lstat(path_b).st_dev
            home_dev = os.lstat(os.path.expanduser(b"~")).st_dev
            if path_dev == home_dev:
                _trash_move(path_b, _home_trash, _xdg_data)
            else:
                mount = os.path.realpath(path_b)
                while not os.path.ismount(mount):
                    mount = os.path.split(mount)[0]
                dest_trash = _find_ext_volume_trash(mount)
                try:
                    _trash_move(path_b, dest_trash, mount)
                except OSError as e:
                    if e.errno == errno.EXDEV:
                        _trash_move(path_b, _home_trash, _xdg_data)
                    else:
                        raise

    # -----------------------------------------------------------------------
    # 全局状态
    # -----------------------------------------------------------------------

    # 保存原始引用（patch 前）
    import shutil
    import subprocess
    import pathlib
    import platform

    _orig_builtin_open = builtins.open
    _orig_io_open = io.open
    _orig_os_open = os.open
    _orig_remove = os.remove
    _orig_unlink = os.unlink
    _orig_rmdir = os.rmdir
    _orig_mkdir = os.mkdir
    _orig_makedirs = os.makedirs
    _orig_rename = os.rename
    _orig_replace = os.replace
    _orig_chmod = os.chmod
    _orig_link = os.link
    _orig_symlink = os.symlink
    _orig_shutil_rmtree = shutil.rmtree
    _orig_shutil_copyfile = shutil.copyfile
    _orig_shutil_copy2 = shutil.copy2
    _orig_shutil_copytree = shutil.copytree
    _orig_path_unlink = pathlib.Path.unlink
    _orig_path_rmdir = pathlib.Path.rmdir
    _orig_path_mkdir = pathlib.Path.mkdir
    _orig_path_touch = pathlib.Path.touch
    _report_path = os.environ.get("CODEBUDDY_SAFE_DELETE_REPORT_PATH")

    # Windows 对每个符号链接调用一次 SHFileOperationW 仍有明显固定开销（数百个链接可
    # 累积到数分钟）。链接本体先通过同卷 rename 移入当前进程的隔离暂存目录，使原路径
    # 立即可被更新脚本重建；进程退出时再把整个暂存目录一次性送入回收站。
    #
    # 仅处理符号链接：普通文件继续逐个进入回收站，避免改变其独立恢复语义。暂存失败时
    # 返回 False，调用方回退现有 SHFileOperationW 路径；退出时回收失败也不会真删，
    # 文件仍安全留在 .codebuddy/safe-delete-staging 下。
    #
    # SIGKILL / 强制结束不会跑 atexit。遗留目录由后续进程按 TTL 再送回收站，永不真删。
    _WINDOWS_STAGING_TTL_SEC = 3600
    _windows_symlink_staging_dirs = {}
    _windows_symlink_staging_seq = 0

    def _windows_same_drive(left, right):
        return os.path.splitdrive(os.path.abspath(left))[0].lower() \
            == os.path.splitdrive(os.path.abspath(right))[0].lower()

    def _windows_recycle_staging_dir(staging_dir):
        # 与目录删除同一条路径：先 genie-trash（Windows 上是 IFileOperation），
        # 失败再 SHFileOperationW。atexit 阶段起一次短子进程与进程内目录删除相同；
        # 子进程不稳时 catch 后降级，不把暂存目录真删掉。
        if not os.path.isdir(staging_dir):
            return
        try:
            if _try_trash_via_binary(staging_dir):
                return
        except OSError:
            pass
        try:
            _platform_trash(staging_dir)
        except Exception:
            pass

    def _windows_cleanup_expired_staging(base_dir):
        try:
            names = os.listdir(base_dir)
        except OSError:
            return
        now = time.time()
        live = set(_windows_symlink_staging_dirs.values())
        for name in names:
            candidate = os.path.join(base_dir, name)
            if candidate in live:
                continue
            try:
                st = os.lstat(candidate)
            except OSError:
                continue
            if not stat.S_ISDIR(st.st_mode):
                continue
            if (now - st.st_mtime) < _WINDOWS_STAGING_TTL_SEC:
                continue
            _windows_recycle_staging_dir(candidate)

    def _windows_symlink_staging_dir(abs_path):
        drive = os.path.splitdrive(os.path.abspath(abs_path))[0].lower()
        existing = _windows_symlink_staging_dirs.get(drive)
        if existing:
            return existing

        cwd = os.path.abspath(os.getcwd())
        if _windows_same_drive(cwd, abs_path):
            base_dir = os.path.join(cwd, ".codebuddy", "safe-delete-staging")
        else:
            base_dir = os.path.join(os.path.dirname(abs_path), ".codebuddy-safe-delete-staging")
        _orig_makedirs(base_dir, exist_ok=True)
        _windows_cleanup_expired_staging(base_dir)

        session_key = hashlib.sha256(
            ("%s:%s:%s" % (_SESSION_ID or "", os.getpid(), time.time())).encode("utf-8")
        ).hexdigest()[:16]
        staging_dir = os.path.join(base_dir, session_key)
        _orig_makedirs(staging_dir, exist_ok=False)
        _windows_symlink_staging_dirs[drive] = staging_dir
        return staging_dir

    def _windows_stage_symlink(abs_path):
        global _windows_symlink_staging_seq
        if sys.platform != "win32" or not os.path.islink(abs_path):
            return False
        try:
            staging_dir = _windows_symlink_staging_dir(abs_path)
            _windows_symlink_staging_seq += 1
            digest = hashlib.sha256(abs_path.encode("utf-8", errors="surrogatepass")).hexdigest()[:16]
            destination = os.path.join(
                staging_dir,
                "%08d-%s-%s" % (_windows_symlink_staging_seq, digest, os.path.basename(abs_path)),
            )
            _orig_replace(abs_path, destination)
            return True
        except Exception:
            return False

    def _windows_symlink_staging_flush():
        if sys.platform != "win32":
            return
        for staging_dir in list(_windows_symlink_staging_dirs.values()):
            _windows_recycle_staging_dir(staging_dir)
        _windows_symlink_staging_dirs.clear()

    # -----------------------------------------------------------------------
    # Brokered sandbox file-token support.
    #
    # Mirrors the shell/toybox broker model, but the interception point is
    # Python's runtime file APIs. The host still owns policy and token issuing.
    # -----------------------------------------------------------------------

    _broker_socket_path = os.environ.get("CODEBUDDY_SANDBOX_BROKER_IPC_ADDRESS")
    _broker_session_id = os.environ.get("CODEBUDDY_SANDBOX_BROKER_SESSION_ID") or _SESSION_ID
    _broker_tool_call_id = (
        os.environ.get("CODEBUDDY_SANDBOX_BROKER_TOOL_CALL_ID")
        or os.environ.get("CODEBUDDY_TOOL_CALL_ID")
    )
    _broker_trace_id = os.environ.get("CODEBUDDY_SANDBOX_BROKER_TRACE_ID")
    _broker_file_token_command = (
        os.environ.get("CODEBUDDY_SANDBOX_FILE_TOKEN_OPERATION_COMMAND")
        or "FileTokenRequest"
    )
    _broker_host_operation_command = os.environ.get(
        "CODEBUDDY_SANDBOX_HOST_FILE_OPERATION_COMMAND"
    )
    _broker_request_seq = 0
    _broker_host_operation_depth = 0
    _COPYTREE_DEFAULT = object()

    def _broker_enabled():
        return bool(sys.platform == "darwin" and _BROKERED_FS_HOOK_ENABLED and _broker_socket_path and _broker_session_id and _broker_file_token_command)

    def _broker_write_completed_enabled():
        return bool(sys.platform == "darwin" and _BROKERED_FS_HOOK_ENABLED and _broker_socket_path and _broker_session_id)

    def _broker_host_ops_enabled():
        return bool(
            sys.platform == "darwin"
            and _BROKERED_FS_HOOK_ENABLED
            and _broker_socket_path
            and _broker_session_id
            and _broker_host_operation_command
            and _broker_host_operation_depth == 0
        )

    def _broker_abs_path(file_path, dir_fd=None):
        if isinstance(file_path, int):
            return None
        try:
            raw_path = os.fspath(file_path)
        except TypeError:
            return None
        if isinstance(raw_path, bytes):
            try:
                raw_path = os.fsdecode(raw_path)
            except UnicodeError:
                return None
        if not raw_path:
            return None
        if dir_fd is not None and not os.path.isabs(raw_path):
            return None
        return os.path.abspath(raw_path)

    def _broker_readline(sock):
        chunks = []
        while True:
            chunk = sock.recv(1)
            if not chunk:
                break
            if chunk == b"\n":
                break
            chunks.append(chunk)
        return b"".join(chunks).decode("utf-8", errors="replace")

    def _broker_consume_token(token):
        if sys.platform != "darwin":
            return
        import ctypes

        lib = ctypes.CDLL(None, use_errno=True)
        fn = lib.sandbox_extension_consume
        fn.argtypes = [ctypes.c_char_p]
        fn.restype = ctypes.c_int64
        handle = fn(token.encode("utf-8"))
        if handle <= 0:
            err = ctypes.get_errno() or errno.EINVAL
            raise OSError(err, os.strerror(err))

    def _broker_send_request(request):
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
                sock.settimeout(5)
                sock.connect(_broker_socket_path)
                sock.sendall((json.dumps(request, separators=(",", ":")) + "\n").encode("utf-8"))
                line = _broker_readline(sock)
        except Exception:
            return None

        try:
            response = json.loads(line)
        except Exception:
            return None
        return response if isinstance(response, dict) else None

    def _broker_request_file_token(abs_path, operation):
        global _broker_request_seq
        if not _broker_enabled():
            return

        _broker_request_seq += 1
        request = {
            "id": "python-%d" % _broker_request_seq,
            "command": _broker_file_token_command,
            "runtime": "python",
            "operation": operation,
            "path": abs_path,
            "sessionId": _broker_session_id,
        }
        if _broker_tool_call_id:
            request["toolCallId"] = _broker_tool_call_id
        if _broker_trace_id:
            request["brokerTraceId"] = _broker_trace_id

        response = _broker_send_request(request)
        if response is None:
            # Match toybox's fail-to-sandbox behavior: if IPC is unavailable,
            # do not grant anything here; let the native sandbox decide.
            return

        token = response.get("token") if response.get("ok") is True else None
        if isinstance(token, str) and token:
            _broker_consume_token(token)
            return
        if response.get("decision") == "sandbox":
            return

        raise PermissionError(
            response.get("error")
            or "Brokered sandbox denied %s access to %s" % (operation, abs_path)
        )

    def _broker_notify_file_write_completed(abs_path, existed_before):
        global _broker_request_seq
        if existed_before:
            return
        if not _broker_write_completed_enabled():
            return

        _broker_request_seq += 1
        request = {
            "id": "python-%d" % _broker_request_seq,
            "command": "FileWriteCompleted",
            "runtime": "python",
            "operation": "write",
            "path": abs_path,
            "sessionId": _broker_session_id,
        }
        if _broker_tool_call_id:
            request["toolCallId"] = _broker_tool_call_id
        if _broker_trace_id:
            request["brokerTraceId"] = _broker_trace_id
        _broker_send_request(request)

    def _broker_request_host_operation(operation, primary_path, **fields):
        global _broker_request_seq
        if not _broker_host_ops_enabled():
            return False

        _broker_request_seq += 1
        request = {
            "id": "python-%d" % _broker_request_seq,
            "command": _broker_host_operation_command,
            "runtime": "python",
            "operation": operation,
            "sessionId": _broker_session_id,
        }
        request.update(fields)
        if _broker_tool_call_id:
            request["toolCallId"] = _broker_tool_call_id
        if _broker_trace_id:
            request["brokerTraceId"] = _broker_trace_id

        response = _broker_send_request(request)
        if response is None:
            return False
        if response.get("ok") is True:
            return True
        if response.get("decision") == "sandbox":
            return False
        raise PermissionError(
            response.get("error")
            or "Brokered sandbox denied host %s for %s" % (operation, primary_path)
        )

    def _broker_call_native_host_operation(fn, *args, **kwargs):
        global _broker_host_operation_depth
        _broker_host_operation_depth += 1
        try:
            return fn(*args, **kwargs)
        finally:
            _broker_host_operation_depth -= 1

    def _broker_operation_for_mode(mode):
        mode = mode or "r"
        return "write" if any(ch in mode for ch in "wax+") else "read"

    def _broker_operation_for_flags(flags):
        write_flags = (
            os.O_WRONLY
            | os.O_RDWR
            | os.O_CREAT
            | os.O_TRUNC
            | os.O_APPEND
            | getattr(os, "O_TMPFILE", 0)
        )
        return "write" if flags & write_flags else "read"

    def _broker_gate(file_path, operation, dir_fd=None):
        abs_path = _broker_abs_path(file_path, dir_fd=dir_fd)
        if abs_path:
            _broker_request_file_token(abs_path, operation)

    def _brokered_open(
        open_fn,
        file,
        mode="r",
        buffering=-1,
        encoding=None,
        errors=None,
        newline=None,
        closefd=True,
        opener=None,
    ):
        operation = _broker_operation_for_mode(mode)
        abs_path = _broker_abs_path(file)
        existed_before = bool(abs_path and os.path.exists(abs_path))
        if abs_path:
            _broker_request_file_token(abs_path, operation)
        file_obj = open_fn(file, mode, buffering, encoding, errors, newline, closefd, opener)
        if operation == "write" and abs_path and os.path.exists(abs_path):
            _broker_notify_file_write_completed(abs_path, existed_before)
        return file_obj

    def _brokered_builtin_open(
        file,
        mode="r",
        buffering=-1,
        encoding=None,
        errors=None,
        newline=None,
        closefd=True,
        opener=None,
    ):
        return _brokered_open(
            _orig_builtin_open,
            file, mode, buffering, encoding, errors, newline, closefd, opener,
        )

    def _brokered_io_open(
        file,
        mode="r",
        buffering=-1,
        encoding=None,
        errors=None,
        newline=None,
        closefd=True,
        opener=None,
    ):
        return _brokered_open(
            _orig_io_open,
            file, mode, buffering, encoding, errors, newline, closefd, opener,
        )

    def _brokered_os_open(path, flags, mode=0o777, *, dir_fd=None):
        _broker_gate(path, _broker_operation_for_flags(flags), dir_fd=dir_fd)
        if dir_fd is not None:
            return _orig_os_open(path, flags, mode, dir_fd=dir_fd)
        return _orig_os_open(path, flags, mode)

    def _brokered_os_mkdir(path, mode=0o777, *, dir_fd=None):
        abs_path = _broker_abs_path(path, dir_fd=dir_fd)
        if abs_path and isinstance(mode, int) and _broker_request_host_operation(
            "mkdir", abs_path, path=abs_path, mode=mode
        ):
            return None
        if dir_fd is not None:
            return _broker_call_native_host_operation(_orig_mkdir, path, mode, dir_fd=dir_fd)
        return _broker_call_native_host_operation(_orig_mkdir, path, mode)

    def _brokered_os_makedirs(name, mode=0o777, exist_ok=False):
        abs_path = _broker_abs_path(name)
        if abs_path and isinstance(mode, int):
            if not exist_ok and os.path.exists(abs_path):
                return _broker_call_native_host_operation(
                    _orig_makedirs, name, mode=mode, exist_ok=exist_ok
                )
            if _broker_request_host_operation(
                "mkdir", abs_path, path=abs_path, recursive=True, mode=mode
            ):
                return None
        return _broker_call_native_host_operation(
            _orig_makedirs, name, mode=mode, exist_ok=exist_ok
        )

    def _brokered_os_rename(src, dst, *, src_dir_fd=None, dst_dir_fd=None):
        from_path = _broker_abs_path(src, dir_fd=src_dir_fd)
        to_path = _broker_abs_path(dst, dir_fd=dst_dir_fd)
        if from_path and to_path and _broker_request_host_operation(
            "rename", from_path, **{"from": from_path, "to": to_path}
        ):
            return None
        if src_dir_fd is not None or dst_dir_fd is not None:
            return _broker_call_native_host_operation(
                _orig_rename, src, dst, src_dir_fd=src_dir_fd, dst_dir_fd=dst_dir_fd
            )
        return _broker_call_native_host_operation(_orig_rename, src, dst)

    def _brokered_os_replace(src, dst, *, src_dir_fd=None, dst_dir_fd=None):
        from_path = _broker_abs_path(src, dir_fd=src_dir_fd)
        to_path = _broker_abs_path(dst, dir_fd=dst_dir_fd)
        if from_path and to_path and _broker_request_host_operation(
            "rename", from_path, **{"from": from_path, "to": to_path}
        ):
            return None
        if src_dir_fd is not None or dst_dir_fd is not None:
            return _broker_call_native_host_operation(
                _orig_replace, src, dst, src_dir_fd=src_dir_fd, dst_dir_fd=dst_dir_fd
            )
        return _broker_call_native_host_operation(_orig_replace, src, dst)

    def _brokered_os_chmod(path, mode, *, dir_fd=None, follow_symlinks=True):
        abs_path = _broker_abs_path(path, dir_fd=dir_fd)
        if abs_path and isinstance(mode, int) and follow_symlinks and _broker_request_host_operation(
            "chmod", abs_path, path=abs_path, mode=mode
        ):
            return None
        if dir_fd is not None:
            return _broker_call_native_host_operation(
                _orig_chmod, path, mode, dir_fd=dir_fd, follow_symlinks=follow_symlinks
            )
        return _broker_call_native_host_operation(
            _orig_chmod, path, mode, follow_symlinks=follow_symlinks
        )

    def _brokered_os_link(src, dst, *, src_dir_fd=None, dst_dir_fd=None, follow_symlinks=True):
        from_path = _broker_abs_path(src, dir_fd=src_dir_fd)
        to_path = _broker_abs_path(dst, dir_fd=dst_dir_fd)
        should_broker = follow_symlinks and from_path and to_path
        try:
            should_broker = should_broker and not os.path.islink(from_path)
        except Exception:
            should_broker = False
        if should_broker and _broker_request_host_operation(
            "link", from_path, **{"from": from_path, "to": to_path, "symbolic": False}
        ):
            return None
        if src_dir_fd is not None or dst_dir_fd is not None:
            return _broker_call_native_host_operation(
                _orig_link, src, dst, src_dir_fd=src_dir_fd, dst_dir_fd=dst_dir_fd,
                follow_symlinks=follow_symlinks
            )
        return _broker_call_native_host_operation(
            _orig_link, src, dst, follow_symlinks=follow_symlinks
        )

    def _brokered_os_symlink(src, dst, target_is_directory=False, *, dir_fd=None):
        source = None
        try:
            source = os.fspath(src)
            if isinstance(source, bytes):
                source = os.fsdecode(source)
        except (TypeError, UnicodeError):
            source = None
        to_path = _broker_abs_path(dst, dir_fd=dir_fd)
        if source and to_path and _broker_request_host_operation(
            "link", to_path, **{"from": source, "to": to_path, "symbolic": True}
        ):
            return None
        if dir_fd is not None:
            return _broker_call_native_host_operation(
                _orig_symlink, src, dst, target_is_directory, dir_fd=dir_fd
            )
        return _broker_call_native_host_operation(
            _orig_symlink, src, dst, target_is_directory
        )

    def _brokered_shutil_copyfile(src, dst, *, follow_symlinks=True):
        from_path = _broker_abs_path(src)
        to_path = _broker_abs_path(dst)
        if follow_symlinks and from_path and to_path and _broker_request_host_operation(
            "copy", from_path, **{"from": from_path, "to": to_path, "recursive": False}
        ):
            return dst
        return _broker_call_native_host_operation(
            _orig_shutil_copyfile, src, dst, follow_symlinks=follow_symlinks
        )

    def _brokered_shutil_copytree(
        src,
        dst,
        symlinks=False,
        ignore=None,
        copy_function=_COPYTREE_DEFAULT,
        ignore_dangling_symlinks=False,
        dirs_exist_ok=False,
    ):
        native_copy_function = (
            _orig_shutil_copy2
            if copy_function is _COPYTREE_DEFAULT
            else copy_function
        )
        can_broker = (
            symlinks is False
            and ignore is None
            and native_copy_function is _orig_shutil_copy2
            and ignore_dangling_symlinks is False
            and dirs_exist_ok is False
        )
        from_path = _broker_abs_path(src) if can_broker else None
        to_path = _broker_abs_path(dst) if can_broker else None
        if from_path and to_path and _broker_request_host_operation(
            "copy", from_path, **{"from": from_path, "to": to_path, "recursive": True}
        ):
            return dst
        return _broker_call_native_host_operation(
            _orig_shutil_copytree,
            src,
            dst,
            symlinks=symlinks,
            ignore=ignore,
            copy_function=native_copy_function,
            ignore_dangling_symlinks=ignore_dangling_symlinks,
            dirs_exist_ok=dirs_exist_ok,
        )

    def _brokered_path_mkdir(self, mode=0o777, parents=False, exist_ok=False):
        abs_path = _broker_abs_path(self)
        if abs_path and isinstance(mode, int):
            if not exist_ok and os.path.exists(abs_path):
                return _broker_call_native_host_operation(
                    _orig_path_mkdir, self, mode=mode, parents=parents, exist_ok=exist_ok
                )
            if _broker_request_host_operation(
                "mkdir", abs_path, path=abs_path, recursive=parents, mode=mode
            ):
                return None
        return _broker_call_native_host_operation(
            _orig_path_mkdir, self, mode=mode, parents=parents, exist_ok=exist_ok
        )

    def _brokered_path_touch(self, mode=0o666, exist_ok=True):
        abs_path = _broker_abs_path(self)
        can_broker = abs_path and mode == 0o666 and (exist_ok or not os.path.exists(abs_path))
        if can_broker and _broker_request_host_operation("touch", abs_path, path=abs_path):
            return None
        return _broker_call_native_host_operation(
            _orig_path_touch, self, mode=mode, exist_ok=exist_ok
        )

    def _path_for_compare(path):
        return os.path.normcase(os.path.realpath(os.path.abspath(path)))

    def _is_usable_temp_root(path):
        try:
            root = _path_for_compare(path)
            if os.path.dirname(root) == root:
                return False
            return os.path.isdir(root)
        except Exception:
            return False

    def _build_os_tmp_dirs():
        candidates = [
            tempfile.gettempdir(),
        ]
        if sys.platform != "win32":
            candidates.append("/tmp")
            candidates.append("/private/tmp")

        roots = []
        seen = set()
        for candidate in candidates:
            if not candidate or not _is_usable_temp_root(candidate):
                continue
            root = _path_for_compare(candidate)
            if root in seen:
                continue
            seen.add(root)
            roots.append(root)
        return roots

    _os_tmp_dirs = _build_os_tmp_dirs()

    def _record_trash(abs_path):
        if not _report_path:
            return
        try:
            with _orig_builtin_open(_report_path, "a", encoding="utf-8") as f:
                f.write(json.dumps({
                    "operation": "trash",
                    "runtime": "python",
                    "path": abs_path,
                    "timestamp": int(time.time() * 1000),
                }, ensure_ascii=False, separators=(",", ":")) + "\n")
        except Exception:
            pass

    def _exit_bulk_guard_control(message):
        try:
            sys.stderr.write(message)
            if not message.endswith("\n"):
                sys.stderr.write("\n")
            sys.stderr.flush()
        finally:
            raise SystemExit(1)

    # -----------------------------------------------------------------------
    # Bulk guard batching (issue #95509 follow-up, Python port of the PowerShell fix in
    # CodeBuddy.SafeDelete.psm1 / powershell-safe-delete.ts).
    #
    # Every os.remove/unlink/rmdir/rmtree used to spawn one node/node.exe to run the
    # guard. A script that removes a tree file by file -- lct-ai-update-kit deletes
    # 300-1000 files one at a time via os.remove() while rebuilding symlinks -- paid a
    # full Node startup per deletion: ~450ms on Windows (process-startup overhead plus
    # Defender scanning), minutes per run even after the recycle-bin move itself went
    # native.
    #
    # Deletions whose item count can be established locally are counted in-process and
    # submitted to the guard together. The guard still decides, because the batch is
    # flushed (and the deletion blocked by its verdict) whenever:
    #   - a target is a real directory: only the guard can count its contents,
    #   - the accumulated count could reach the threshold,
    #   - this request was already rejected,
    #   - the count cannot be established locally, or
    #   - the batch reaches the limit below.
    # The threshold test adds the deferred count to the guard's own total, so a run can
    # never cross the threshold without the guard seeing it. The only thing lost is at
    # most (limit - 1) deletions that never got submitted, when the *process* ends
    # mid-batch -- the atexit flush below closes most of that gap for the common case
    # (batch stayed under threshold), see _bulk_pending_atexit_flush.
    # -----------------------------------------------------------------------

    _BULK_DEFER_LIMIT = 32
    _DEFAULT_BULK_THRESHOLD = 500

    # {"request_id", "tool_call_id", "identity": {"tool_call_id", "request_id"},
    #  "targets": [...], "count": int} | None
    _bulk_pending = None

    def _count_bulk_target(abs_path):
        # Items the guard counts for this path: 0 when it does not exist, 1 for a file
        # or a symlink (lstat never follows symlinks, so no separate islink check is
        # needed), -1 for a real directory (only the guard can count its contents) or
        # any other stat error (fail-safe -- ask the guard rather than guess).
        st = _safe_lstat(abs_path)
        if st is None:
            return 0  # ENOENT
        if st is False:
            return -1  # other stat error -> fail-safe, ask guard
        if stat.S_ISDIR(st.st_mode):
            return -1  # real directory -> only guard can count contents
        return 1  # file or symlink

    def _bulk_state_path():
        # <CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR>/<sha256hex(CODEBUDDY_SESSION_ID)>/state.json
        # -- where safe-delete-bulk-guard.cjs keeps the per-request delete counter and
        # the approval/rejection verdicts. Reads CODEBUDDY_SESSION_ID directly (not the
        # _SESSION_ID module global, which also falls back to CLAUDE_SESSION_ID) to stay
        # consistent with what the guard subprocess itself sees in its inherited env.
        state_root = os.environ.get("CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR")
        session_id = os.environ.get("CODEBUDDY_SESSION_ID")
        if not state_root or not session_id:
            return None
        session_hash = hashlib.sha256(session_id.encode("utf-8")).hexdigest()
        return os.path.join(state_root, session_hash, "state.json")

    def _bulk_state_summary(request_id, tool_call_id):
        # The guard's counters, read in-process. "known" is False when the state file or
        # the env needed to address it is unavailable: an unknown count has to go to the
        # guard.
        unknown = {"known": False, "count": 0, "approved": False, "rejected": False, "threshold": 0}
        state_path = _bulk_state_path()
        if not state_path:
            return unknown
        raw_threshold = os.environ.get("CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD") or str(_DEFAULT_BULK_THRESHOLD)
        try:
            threshold = int(raw_threshold)
        except (TypeError, ValueError):
            return unknown
        if threshold <= 0:
            return unknown
        known_empty = {"known": True, "count": 0, "approved": False, "rejected": False, "threshold": threshold}
        file = _read_json_with_mtime(state_path)
        if file is None or file[0] is None:
            return known_empty  # missing file / corrupt JSON -> known-but-empty
        state = file[0]
        if not isinstance(state, dict):
            return known_empty
        requests = state.get("requests")
        requests = requests if isinstance(requests, dict) else {}
        tool_approvals = state.get("toolApprovals")
        tool_approvals = tool_approvals if isinstance(tool_approvals, dict) else {}
        request_rejections = state.get("requestRejections")
        request_rejections = request_rejections if isinstance(request_rejections, dict) else {}

        request = requests.get(request_id)
        count = 0
        if isinstance(request, dict):
            raw_count = request.get("count")
            if isinstance(raw_count, (int, float)) and not isinstance(raw_count, bool):
                count = int(raw_count)

        approval = tool_approvals.get(tool_call_id)
        approved = isinstance(approval, dict) and approval.get("approved") is True

        rejection = request_rejections.get(request_id)
        rejected = isinstance(rejection, dict) and rejection.get("rejected") is True

        return {"known": True, "count": count, "approved": approved, "rejected": rejected, "threshold": threshold}

    def _flush_bulk_pending(pending, guard_path, node_bin, best_effort=False):
        # Submit every deferred target to the guard in one process and reset the batch.
        # Unconditionally clears the module global at the top (mirrors PowerShell's
        # Invoke-SafeDeleteBulkGuardBatch always nulling its pending global regardless of
        # what was passed in), so this is safe to call with either the current pending
        # (normal flush) or an old pending captured before an identity change.
        #
        # best_effort=True (atexit path only): swallow subprocess failures and non-zero
        # exit codes instead of raising via _exit_bulk_guard_control. By the time the
        # atexit flush runs, every target here has already been deleted (deferring only
        # skips the subprocess call, never the deletion -- see _check_bulk_delete_guard),
        # so there is nothing left to protect and raising would only produce confusing
        # noise for zero benefit.
        global _bulk_pending
        if _bulk_pending is pending:
            _bulk_pending = None
        if not pending or not pending["targets"]:
            return
        identity = pending["identity"]
        env = dict(os.environ)
        env["NODE_OPTIONS"] = ""
        # Identity is scoped to this child process only. Keeping it in our own env is
        # what leaked a finished tool call's identity into long-lived daemons.
        env["CODEBUDDY_TOOL_CALL_ID"] = identity["tool_call_id"]
        if identity["request_id"]:
            env["CODEBUDDY_CONVERSATION_REQUEST_ID"] = identity["request_id"]
        # --deleted: targets already recycled by the time the batch flushes (files
        # deferred earlier in the loop have already been moved by _try_trash) must still
        # count as 1 each toward the threshold -- without the flag the guard would count
        # 0 for anything already gone and the threshold would never be reached.
        args = [node_bin, guard_path, "check", "--deleted"]
        for target in pending["targets"]:
            args += ["--target", target]
        try:
            result = subprocess.run(args, capture_output=True, text=True, timeout=10, env=env)
        except Exception as e:
            if best_effort:
                return
            _exit_bulk_guard_control("[safe-delete][SAFE_DELETE_BULK_GUARD_ERROR] %s" % e)
            return  # unreachable; _exit_bulk_guard_control always raises
        if result.returncode != 0:
            if best_effort:
                return
            _exit_bulk_guard_control(
                result.stderr.strip()
                or "[safe-delete][SAFE_DELETE_BULK_GUARD_ERROR] exit %d" % result.returncode
            )

    def _check_bulk_delete_guard(abs_path):
        global _bulk_pending
        guard_path = os.environ.get("CODEBUDDY_SAFE_DELETE_BULK_GUARD")
        node_bin = os.environ.get("CODEBUDDY_NODE_BIN")
        context = _resolve_execution_context()
        # Defense in depth: callers already bypass everything when the context is
        # dead, but a dead context must never accumulate bulk counts even if some
        # future call site forgets the gate. Must run before anything touches
        # _bulk_pending.
        if not context["live"] \
                or not os.environ.get("CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR") \
                or not context["tool_call_id"]:
            return
        if not guard_path or not node_bin or not os.path.isfile(guard_path):
            _exit_bulk_guard_control(
                "[safe-delete][SAFE_DELETE_BULK_GUARD_ERROR] msg=helper-unavailable guard=%s"
                % (guard_path or "unset")
            )

        tool_call_id = context["tool_call_id"]
        # State-key request id: defaults to tool_call_id when no conversation request id
        # is present (mirrors PowerShell's $requestId). Kept separate from the raw
        # context["request_id"] stored in pending["identity"], which is only used to
        # decide whether to inject CODEBUDDY_CONVERSATION_REQUEST_ID on flush.
        request_id = context["request_id"] or tool_call_id

        # Identity changed since the last deferred call: the pending batch belongs to
        # the previous identity and must be flushed under it before anything else
        # happens.
        if _bulk_pending is not None and (
            _bulk_pending["request_id"] != request_id
            or _bulk_pending["tool_call_id"] != tool_call_id
        ):
            old_pending = _bulk_pending
            _flush_bulk_pending(old_pending, guard_path, node_bin)  # may raise SystemExit
            # _bulk_pending is now None (cleared inside _flush_bulk_pending)

        if _bulk_pending is None:
            _bulk_pending = {
                "request_id": request_id,
                "tool_call_id": tool_call_id,
                "identity": {"tool_call_id": tool_call_id, "request_id": context["request_id"]},
                "targets": [],
                "count": 0,
            }

        # Count + append BEFORE deciding defer-vs-flush -- this ordering matters and
        # must match PowerShell exactly (Invoke-SafeDeleteBulkGuard's foreach-target
        # loop runs fully before the $countable branch is evaluated).
        count = _count_bulk_target(abs_path)
        countable = count >= 0
        if countable:
            _bulk_pending["count"] += count
        _bulk_pending["targets"].append(abs_path)

        if countable:
            summary = _bulk_state_summary(request_id, tool_call_id)
            under_threshold = summary["approved"] or (summary["count"] + _bulk_pending["count"]) < summary["threshold"]
            if summary["known"] and not summary["rejected"] and under_threshold \
                    and _bulk_pending["count"] < _BULK_DEFER_LIMIT:
                return  # defer: accumulate only, let the deletion proceed without asking

        # Not deferrable (directory / rejected / unknown-summary / at-limit /
        # could-cross): flush the whole accumulated batch (including this call's
        # target) now.
        pending = _bulk_pending
        _flush_bulk_pending(pending, guard_path, node_bin)

    def _bulk_pending_atexit_flush():
        # Best-effort bookkeeping only: every target still in _bulk_pending has already
        # been deleted (deferring only skips the subprocess call, never the deletion --
        # see _check_bulk_delete_guard above). This can't block anything retroactively;
        # it only persists the true count into state.json so a later process (same
        # requestId, e.g. a subsequent tool call in the same conversation turn) starts
        # its threshold math from an accurate baseline instead of silently losing this
        # process's tail-end count. Must never raise -- there's nothing left to protect
        # by the time this runs, and raising during atexit doesn't propagate as the
        # process's real exit code anyway (Python just prints noise and continues).
        pending = _bulk_pending
        if not pending or not pending["targets"]:
            return
        guard_path = os.environ.get("CODEBUDDY_SAFE_DELETE_BULK_GUARD")
        node_bin = os.environ.get("CODEBUDDY_NODE_BIN")
        if not guard_path or not node_bin or not os.path.isfile(guard_path):
            return
        try:
            _flush_bulk_pending(pending, guard_path, node_bin, best_effort=True)
        except Exception:
            pass


    # -----------------------------------------------------------------------
    # genie-trash native binary 支持（优先路径，不可用自动降级）
    # 优先使用 GENIE_TRASH_DIR 环境变量（由 buildSafeDeleteEnv() 注入），
    # 解决打包后 extraResources 与 shim 不共父目录的路径错位问题。
    # -----------------------------------------------------------------------

    def _get_trash_bin():
        system = "win32" if sys.platform == "win32" else platform.system().lower()
        machine = platform.machine().lower()
        if machine in ("arm64", "aarch64"):
            arch = "arm64"
        elif machine in ("x86_64", "amd64"):
            arch = "x64"
        else:
            arch = machine
        ext = ".exe" if sys.platform == "win32" else ""
        file_name = "%s-%s%s" % (system, arch, ext)
        trash_dir = os.environ.get("GENIE_TRASH_DIR")
        if trash_dir:
            return os.path.join(trash_dir, file_name)
        shim_dir = os.path.dirname(os.path.abspath(__file__))
        return os.path.join(shim_dir, "..", "genie-trash", file_name)

    _trash_bin_available = None  # None=未探测, True=可用, False=不可用

    def _try_trash_via_binary(abs_path):
        global _trash_bin_available
        if _trash_bin_available is False:
            return False
        try:
            result = subprocess.run(
                [_get_trash_bin(), abs_path],
                capture_output=True, text=True, timeout=5
            )
            if result.returncode == 0:
                _trash_bin_available = True
                return True
            # binary 已启动但对该路径失败：抛错，不降级真删
            raise OSError(
                "[safe-delete] 操作失败: %s"
                % (result.stderr.strip() or "exit %d" % result.returncode)
            )
        except FileNotFoundError:
            _trash_bin_available = False  # binary 不存在，进程生命周期内不会凭空出现
            return False
        except PermissionError:
            # 不缓存：权限问题可能是临时状态（如 chmod +x 后恢复）
            return False
        except subprocess.TimeoutExpired:
            return False  # 超时是临时问题，不永久禁用 native binary
        except OSError:
            raise
        except Exception:
            pass
        _trash_bin_available = False
        return False

    # -----------------------------------------------------------------------
    # 核心：移入回收站。
    # 返回 True=已移入回收站；抛错=fail-closed，调用方不得真删。
    # -----------------------------------------------------------------------

    def _try_broker_delete(abs_path, recursive=False, force=False):
        if not _broker_host_ops_enabled():
            return "unavailable"
        try:
            if _broker_request_host_operation(
                "delete",
                abs_path,
                path=abs_path,
                deleteMode="trash",
                recursive=bool(recursive),
                force=bool(force),
            ):
                return "ok"
            return "unavailable"
        except PermissionError:
            return "denied"
        except Exception:
            return "unavailable"

    def _try_trash(abs_path, recursive=False, force=False):
        if sys.platform == "win32" and _IN_SANDBOX:
            message = (
                "[safe-delete][SAFE_DELETE_FAIL_CLOSED] "
                + json.dumps({
                    "target": abs_path,
                    "reason": "windows-sandbox-recycle-bin-unavailable",
                }, ensure_ascii=False)
            )
            try:
                sys.stderr.write(message + "\n")
                sys.stderr.flush()
            except Exception:
                pass
            raise OSError(message)
        _check_bulk_delete_guard(abs_path)

        broker_result = _try_broker_delete(abs_path, recursive=recursive, force=force)
        if broker_result == "ok":
            return True
        if broker_result == "denied":
            raise PermissionError(
                "[safe-delete] broker denied delete: path=%s" % abs_path
            )

        if _windows_stage_symlink(abs_path):
            _record_trash(abs_path)
            return True

        # 单文件/符号链接直接走当前 Python 进程内已加载的平台 API。为每个文件启动一次
        # genie-trash 子进程会让批量重建符号链接退化到数百毫秒/文件；目录仍交给 helper，
        # 由它一次处理整棵目录并保留平台回收站语义。与 PowerShell shim 的策略一致。
        if recursive and _try_trash_via_binary(abs_path):
            _record_trash(abs_path)
            return True
        _platform_trash(abs_path)
        _record_trash(abs_path)
        return True

    def _safe_lstat(abs_path):
        try:
            return os.lstat(abs_path)
        except OSError as e:
            if e.errno == errno.ENOENT:
                return None
            # EACCES / ELOOP 等错误：让调用方回退原生
            return False  # 与 None 区分开

    def _is_dir_empty(abs_path):
        try:
            return len(os.listdir(abs_path)) == 0
        except OSError:
            return False

    def _is_under_root(root, abs_path):
        try:
            target = _path_for_compare(os.fsdecode(abs_path))
            root_path = _path_for_compare(root)
            rel = os.path.relpath(target, root_path)
        except (TypeError, UnicodeError, ValueError):
            return False
        return rel not in ("", ".") and rel != ".." and not rel.startswith(".." + os.sep) and not os.path.isabs(rel)

    def _is_under_os_tmp_dir(abs_path):
        for tmp_dir in _os_tmp_dirs:
            if _is_under_root(tmp_dir, abs_path):
                return True
        return False

    def _is_pip_site_packages_temp_dir(abs_path):
        try:
            target = _path_for_compare(os.fsdecode(abs_path))
        except (TypeError, UnicodeError):
            return False
        parts = target.split(os.sep)
        for index, part in enumerate(parts[:-1]):
            if part not in ("site-packages", "dist-packages"):
                continue
            backup_root = parts[index + 1]
            if backup_root.startswith("~") or backup_root.startswith("accesstest_deleteme"):
                return True
        return False

    def _should_bypass_safe_delete(abs_path):
        # Liveness first: it is path-independent and memoized, and a dead context must
        # degrade every hook to the native API. This is the single bypass funnel used
        # by os.remove / os.rmdir / shutil.rmtree / pathlib wrappers, so gating here
        # covers all of them without touching any fail-closed branch.
        if not _is_context_live():
            return True
        return _is_under_os_tmp_dir(abs_path) or _is_pip_site_packages_temp_dir(abs_path)

    # -----------------------------------------------------------------------
    # 包装：os.remove / os.unlink （文件，不能是目录）
    # -----------------------------------------------------------------------

    def _safe_remove(path, *, dir_fd=None):
        # dir_fd 不为 None → 走原生（无法解析到 abs_path）
        # Known limitation: deletions via dir_fd are NOT protected by safe-delete
        # because the absolute path cannot be resolved from a directory file
        # descriptor in pure Python. This is a rare API surface; full coverage
        # would require fd→path resolution via /proc/self/fd (Linux) which is
        # platform-specific and fragile.
        if dir_fd is not None:
            return _orig_remove(path, dir_fd=dir_fd)
        abs_path = os.path.abspath(os.fspath(path))
        if _should_bypass_safe_delete(abs_path):
            return _orig_remove(path)
        st = _safe_lstat(abs_path)
        if not st:
            return _orig_remove(path)  # ENOENT / stat 错误 → 让原生抛
        if stat.S_ISDIR(st.st_mode):
            return _orig_remove(path)  # 让原生抛 EISDIR / EPERM
        _try_trash(abs_path)

    # -----------------------------------------------------------------------
    # 包装：os.rmdir（必须是空目录）
    # -----------------------------------------------------------------------

    def _safe_rmdir(path, *, dir_fd=None):
        if dir_fd is not None:
            return _orig_rmdir(path, dir_fd=dir_fd)
        abs_path = os.path.abspath(os.fspath(path))
        if _should_bypass_safe_delete(abs_path):
            return _orig_rmdir(path)
        st = _safe_lstat(abs_path)
        if not st:
            return _orig_rmdir(path)  # ENOENT / stat 错误
        if not stat.S_ISDIR(st.st_mode):
            return _orig_rmdir(path)  # ENOTDIR
        if not _is_dir_empty(abs_path):
            return _orig_rmdir(path)  # ENOTEMPTY
        _try_trash(abs_path, recursive=True)

    # -----------------------------------------------------------------------
    # 包装：shutil.rmtree（递归删目录）
    # -----------------------------------------------------------------------

    def _safe_shutil_rmtree(path, ignore_errors=False, onerror=None, **kwargs):
        # Python 3.12+ 引入 onexc，3.14+ 还有 dir_fd——一并 forward 给原生
        try:
            abs_path = os.path.abspath(os.fspath(path))
        except TypeError:
            return _orig_shutil_rmtree(
                path, ignore_errors=ignore_errors, onerror=onerror, **kwargs
            )

        if _should_bypass_safe_delete(abs_path):
            return _orig_shutil_rmtree(
                path, ignore_errors=ignore_errors, onerror=onerror, **kwargs
            )

        st = _safe_lstat(abs_path)
        if not st:
            return _orig_shutil_rmtree(
                path, ignore_errors=ignore_errors, onerror=onerror, **kwargs
            )
        if not stat.S_ISDIR(st.st_mode):
            # 不是目录 → 让原生处理（rmtree 会抛 NotADirectoryError）
            return _orig_shutil_rmtree(
                path, ignore_errors=ignore_errors, onerror=onerror, **kwargs
            )

        try:
            _try_trash(abs_path, recursive=True)
        except Exception as e:
            if ignore_errors:
                return
            if onerror is not None:
                onerror(_safe_shutil_rmtree, path, sys.exc_info())
                return
            raise

    # -----------------------------------------------------------------------
    # 包装：pathlib.Path.unlink / rmdir
    # -----------------------------------------------------------------------

    def _safe_path_unlink(self, missing_ok=False):
        abs_path = os.path.abspath(str(self))
        if _should_bypass_safe_delete(abs_path):
            return _orig_path_unlink(self, missing_ok=missing_ok)
        st = _safe_lstat(abs_path)
        if not st:
            if st is None and missing_ok:
                return None
            return _orig_path_unlink(self, missing_ok=missing_ok)  # 让原生抛
        if stat.S_ISDIR(st.st_mode):
            return _orig_path_unlink(self, missing_ok=missing_ok)  # 抛 IsADirectoryError
        _try_trash(abs_path)

    def _safe_path_rmdir(self):
        abs_path = os.path.abspath(str(self))
        if _should_bypass_safe_delete(abs_path):
            return _orig_path_rmdir(self)
        st = _safe_lstat(abs_path)
        if not st:
            return _orig_path_rmdir(self)  # ENOENT / stat 错误 → 让原生抛
        if not stat.S_ISDIR(st.st_mode):
            return _orig_path_rmdir(self)  # 抛 NotADirectoryError
        if not _is_dir_empty(abs_path):
            return _orig_path_rmdir(self)  # 抛 OSError(ENOTEMPTY)
        _try_trash(abs_path, recursive=True)

    # -----------------------------------------------------------------------
    # 安装 patch
    # -----------------------------------------------------------------------

    if _broker_enabled():
        builtins.open = _brokered_builtin_open
        io.open = _brokered_io_open
        os.open = _brokered_os_open

    if _broker_host_ops_enabled():
        os.mkdir = _brokered_os_mkdir
        os.makedirs = _brokered_os_makedirs
        os.rename = _brokered_os_rename
        os.replace = _brokered_os_replace
        os.chmod = _brokered_os_chmod
        os.link = _brokered_os_link
        os.symlink = _brokered_os_symlink
        shutil.copyfile = _brokered_shutil_copyfile
        shutil.copytree = _brokered_shutil_copytree
        pathlib.Path.mkdir = _brokered_path_mkdir
        pathlib.Path.touch = _brokered_path_touch

    if _SAFE_DELETE_ENABLED:
        os.remove = _safe_remove
        os.unlink = _safe_remove  # CPython 里 os.unlink is os.remove，显式 patch 兼容其它实现
        os.rmdir = _safe_rmdir
        shutil.rmtree = _safe_shutil_rmtree
        pathlib.Path.unlink = _safe_path_unlink
        pathlib.Path.rmdir = _safe_path_rmdir
        atexit.register(_windows_symlink_staging_flush)
        atexit.register(_bulk_pending_atexit_flush)
        if sys.platform == "win32":
            try:
                _windows_cleanup_expired_staging(
                    os.path.join(os.path.abspath(os.getcwd()), ".codebuddy", "safe-delete-staging")
                )
            except Exception:
                pass
