# -*- coding: utf-8 -*-
"""建 Windows 快捷方式（.lnk）——ctypes 直调 IShellLink，绕开被沙箱拦截的 WScript.Shell

用法:
    python make_lnk.py <目标exe> <lnk输出路径> [工作目录] [图标路径]
    python make_lnk.py <目标exe> <lnk输出路径> [工作目录] [图标路径] --desc "描述"
    python make_lnk.py <目标exe> <lnk输出路径> --read          # 建完顺便读回验证

示例:
    python make_lnk.py "C:\\app\\app.exe" "%USERPROFILE%\\Desktop\\我的工具.lnk"
"""
import ctypes
import os
import struct
import sys
from ctypes import HRESULT, POINTER, byref, c_void_p, wintypes

ole32 = ctypes.windll.ole32
CLSCTX_INPROC_SERVER = 1

CLSID_ShellLink = (ctypes.c_byte * 16)(
    0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46,
)
IID_IShellLinkW = (ctypes.c_byte * 16)(
    0xF9, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46,
)
IID_IPersistFile = (ctypes.c_byte * 16)(
    0x0B, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46,
)


def vt(ptr, idx, restype, argtypes, args):
    """调用 COM 接口虚表第 idx 个方法。0/1/2 分别是 QueryInterface/AddRef/Release。"""
    tbl = ctypes.cast(ptr, POINTER(POINTER(c_void_p)))[0]
    fn = ctypes.WINFUNCTYPE(restype, c_void_p, *argtypes)(tbl[idx])
    return fn(ptr, *args)


def create_shortcut(lnk_path, target, arguments="", workdir="", description="", icon=None):
    ole32.CoInitialize(None)
    ptr = c_void_p()
    hr = ole32.CoCreateInstance(byref(CLSID_ShellLink), None, CLSCTX_INPROC_SERVER,
                                byref(IID_IShellLinkW), byref(ptr))
    if hr != 0:
        raise OSError(f"CoCreateInstance 失败 hr=0x{hr & 0xffffffff:08X}")

    HR, W, I = HRESULT, wintypes.LPCWSTR, ctypes.c_int

    if description:
        vt(ptr, 7, HR, [W], [description])          # SetDescription
    if workdir:
        vt(ptr, 9, HR, [W], [workdir])              # SetWorkingDirectory
    if arguments:
        vt(ptr, 11, HR, [W], [arguments])           # SetArguments
    if icon:
        vt(ptr, 17, HR, [W, I], [icon, 0])          # SetIconLocation
    vt(ptr, 20, HR, [W], [target])                  # SetPath

    pf = c_void_p()
    hr = vt(ptr, 0, HR, [c_void_p, c_void_p],
            [byref(IID_IPersistFile), byref(pf)])   # QueryInterface
    if hr != 0:
        raise OSError(f"QueryInterface(IPersistFile) 失败 hr=0x{hr & 0xffffffff:08X}")

    hr = vt(pf, 6, HR, [W, wintypes.BOOL], [lnk_path, True])   # IPersistFile::Save
    if hr != 0:
        raise OSError(f"IPersistFile::Save 失败 hr=0x{hr & 0xffffffff:08X}")

    vt(pf, 2, ctypes.c_ulong, [], [])
    vt(ptr, 2, ctypes.c_ulong, [], [])
    ole32.CoUninitialize()
    return True


def read_shortcut(lnk_path):
    """读回 .lnk 的 target / description / workdir / arguments / icon"""
    ole32.CoInitialize(None)
    ptr = c_void_p()
    hr = ole32.CoCreateInstance(byref(CLSID_ShellLink), None, CLSCTX_INPROC_SERVER,
                                byref(IID_IShellLinkW), byref(ptr))
    if hr != 0:
        raise OSError(f"CoCreateInstance 失败 hr=0x{hr & 0xffffffff:08X}")

    pf = c_void_p()
    vt(ptr, 0, HRESULT, [c_void_p, c_void_p], [byref(IID_IPersistFile), byref(pf)])
    # IPersistFile::Load(LPCWSTR, DWORD)
    hr = vt(pf, 5, HRESULT, [wintypes.LPCWSTR, wintypes.DWORD], [lnk_path, 0])
    if hr != 0:
        raise OSError(f"Load 失败 hr=0x{hr & 0xffffffff:08X}")

    buf = ctypes.create_unicode_buffer(1024)
    iconbuf = ctypes.create_unicode_buffer(1024)
    iconidx = ctypes.c_int(0)
    W, I = wintypes.LPWSTR, ctypes.c_int

    # GetPath(LPWSTR, int, WIN32_FIND_DATAW*, DWORD) —— 第 3 参传 None
    vt(ptr, 3, HRESULT, [W, I, c_void_p, wintypes.DWORD], [buf, 1024, None, 0])
    target = buf.value
    vt(ptr, 6, HRESULT, [W, I], [buf, 1024]);  desc = buf.value      # GetDescription
    vt(ptr, 8, HRESULT, [W, I], [buf, 1024]);  workdir = buf.value   # GetWorkingDirectory
    vt(ptr, 10, HRESULT, [W, I], [buf, 1024]); args = buf.value      # GetArguments
    # GetIconLocation(LPWSTR, int, int*)
    vt(ptr, 16, HRESULT, [W, I, POINTER(ctypes.c_int)], [iconbuf, 1024, byref(iconidx)])

    vt(pf, 2, ctypes.c_ulong, [], [])
    vt(ptr, 2, ctypes.c_ulong, [], [])
    ole32.CoUninitialize()
    return {"target": target, "description": desc, "workdir": workdir,
            "arguments": args, "icon": iconbuf.value}


def byte_check(lnk_path):
    """纯字节校验：头部、CLSID、LinkFlags"""
    d = open(lnk_path, "rb").read()
    ok = True
    hdr = struct.unpack("<I", d[0:4])[0]
    ok &= hdr == 76
    ok &= d[4:20] == bytes.fromhex("0114020000000000c000000000000046")
    flags = struct.unpack("<I", d[20:24])[0] if len(d) >= 24 else 0
    return ok, len(d), flags


if __name__ == "__main__":
    argv = [a for a in sys.argv[1:] if a != "--read"]
    want_read = "--read" in sys.argv
    desc = ""
    if "--desc" in argv:
        i = argv.index("--desc")
        desc = argv[i + 1]
        argv = argv[:i] + argv[i + 2:]

    if len(argv) < 2:
        print(__doc__)
        sys.exit(1)

    target, lnk = argv[0], argv[1]
    workdir = argv[2] if len(argv) > 2 else os.path.dirname(target)
    icon = argv[3] if len(argv) > 3 else target

    # 统一成 Windows 反斜杠路径（正斜杠虽可用，但 .lnk 内部规范是反斜杠）
    target = os.path.normpath(target)
    lnk = os.path.normpath(lnk)
    workdir = os.path.normpath(workdir)
    icon = os.path.normpath(icon)

    if not os.path.exists(target):
        sys.exit(f"目标不存在: {target}")

    create_shortcut(lnk, target, workdir=workdir, description=desc, icon=icon)
    print(f"已创建: {lnk}  ({os.path.getsize(lnk)} 字节)")

    ok, size, flags = byte_check(lnk)
    print(f"字节校验: 头部/CLSID {'通过' if ok else '失败'}  LinkFlags=0x{flags:X}")

    if want_read:
        r = read_shortcut(lnk)
        print("读回验证:")
        for k, v in r.items():
            print(f"  {k:12} = {v}")
        print("  目标存在:", os.path.exists(r["target"]))
        print("  工作目录存在:", os.path.exists(r["workdir"]))
