# -*- coding: utf-8 -*-
"""把文件送进 Windows 回收站（可恢复），而不是永久删除。

用 SHFileOperationW + FOF_ALLOWUNDO 实现。
用法: python recycle.py <文件或目录路径> [更多路径...]
"""
import ctypes
import os
import sys
from ctypes import wintypes

shell32 = ctypes.windll.shell32

FO_DELETE = 3
FOF_SILENT = 0x0004
FOF_NOCONFIRMATION = 0x0010
FOF_ALLOWUNDO = 0x0040          # ← 关键：进回收站而非永久删除
FOF_NOERRORUI = 0x0400
FOF_WANTNUKEWARNING = 0x4000


class SHFILEOPSTRUCTW(ctypes.Structure):
    _fields_ = [
        ("hwnd", wintypes.HWND),
        ("wFunc", wintypes.UINT),
        ("pFrom", ctypes.c_void_p),
        ("pTo", ctypes.c_void_p),
        ("fFlags", wintypes.WORD),
        ("fAnyOperationsAborted", wintypes.BOOL),
        ("hNameMappings", ctypes.c_void_p),
        ("lpszProgressTitle", wintypes.LPCWSTR),
    ]


def to_recycle_bin(paths):
    """paths: 绝对路径列表。返回 (ret_code, aborted)"""
    # pFrom 必须是「双 null 结尾」的多字符串
    joined = "\0".join(os.path.abspath(p) for p in paths) + "\0\0"
    buf = ctypes.create_unicode_buffer(joined)

    op = SHFILEOPSTRUCTW()
    op.hwnd = None
    op.wFunc = FO_DELETE
    op.pFrom = ctypes.cast(buf, ctypes.c_void_p)
    op.pTo = None
    op.fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI
    op.fAnyOperationsAborted = False
    op.hNameMappings = None
    op.lpszProgressTitle = None

    ret = shell32.SHFileOperationW(ctypes.byref(op))
    return ret, bool(op.fAnyOperationsAborted)


if __name__ == "__main__":
    targets = sys.argv[1:]
    if not targets:
        print(__doc__)
        sys.exit(1)

    # 先列清楚要动哪些
    print("将送入回收站（可恢复）：")
    ok_targets = []
    for t in targets:
        ap = os.path.abspath(t)
        if os.path.exists(ap):
            kind = "目录" if os.path.isdir(ap) else "文件"
            size = "" if os.path.isdir(ap) else f"  {os.path.getsize(ap)} 字节"
            print(f"  [{kind}] {ap}{size}")
            ok_targets.append(ap)
        else:
            print(f"  [不存在，跳过] {ap}")

    if not ok_targets:
        sys.exit("没有可处理的文件")

    ret, aborted = to_recycle_bin(ok_targets)
    print()
    # 注意：不要把 SHFileOperationW 的返回码当成功判据。
    # 实测同一个脚本，删 Temp 下文件返回 0，删 Desktop 下文件返回 2，
    # 但两种情况的文件都正确进了回收站（可用 $I/$R 复核）。
    # 唯一可靠的判断是「文件是否已消失」+ 回收站里能否找到 $R 内容文件。
    print(f"SHFileOperationW 返回码: {ret}（仅参考，不等于成败）  aborted={aborted}")
    print()
    print("复核（以下为可靠判据）：")
    gone = 0
    for p in ok_targets:
        exists = os.path.exists(p)
        if not exists:
            gone += 1
        print(f"  {'仍存在 ✗' if exists else '已移除 ✓'}  {p}")

    print()
    if gone == len(ok_targets):
        print(f"完成：{gone} 个对象已移入回收站（可用「还原」找回）")
    else:
        print(f"注意：{len(ok_targets) - gone} 个对象仍在原位，未处理成功")
