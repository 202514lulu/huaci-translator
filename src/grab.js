// 取词模块：获取当前选中的文本
// 策略 A（首选）：模拟 Ctrl+C，然后读剪贴板 —— 全自动，用户只需按热键
// 策略 B（降级）：直接读剪贴板 —— 仅在「自动取词组件不可用」时才用
//
// 关键设计（2026-10-02 修复）：
//   旧实现在「Ctrl+C 没有真正改变剪贴板」时，会把热键按下前的旧剪贴板内容
//   当作刚取到的选中文本返回 —— 于是用户看到的是「别的句子的译文」。
//   现在改为：复制前先清空剪贴板 → 只要读到非空内容就一定是本次复制成功的；
//   全部重试仍失败则明确报「取词失败」，绝不回退成旧剪贴板内容。
//
//   另一个真凶：热键是 Alt+Shift+Z，回调触发时用户的 Alt/Shift 往往还没松开，
//   此时发出的 Ctrl+C 实际是 Ctrl+Alt+C / Ctrl+Shift+C，目标程序不执行复制。
//   所以发 Ctrl+C 前要主动松开残留修饰键，并留一小段"待用户松手"的缓冲。
const { clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

let nut = null; // 惰性加载，避免原生模块缺失时直接崩

function loadNut() {
  if (nut !== null) return nut;
  try {
    // 优先用预编译版本，无需 node-gyp
    const mod = require('@nut-tree-fork/nut-js');
    nut = mod;
    return nut;
  } catch (e) {
    try {
      nut = require('nut-js');
      return nut;
    } catch (e2) {
      nut = false; // 标记不可用
      return false;
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 模拟 Ctrl+C 把选中内容送进剪贴板。
 * 发键前先主动松开可能仍被按住的修饰键（热键的 Alt/Shift、Win 键等），
 * 否则 Ctrl+C 会被系统识别成 Ctrl+Alt+C / Ctrl+Shift+C，目标程序不复制。
 * @returns {Promise<boolean>} 是否成功发出按键
 */
async function sendCopy() {
  const n = loadNut();
  if (!n) return false;
  try {
    const { keyboard, Key } = n;
    // 1) 松开残留修饰键（逐个 try，避免某个键名缺失导致整组失败）
    const mods = ['LeftAlt', 'RightAlt', 'LeftShift', 'RightShift', 'LeftSuper', 'RightSuper'];
    for (const name of mods) {
      const k = Key[name];
      if (k === undefined) continue;
      try { await keyboard.releaseKey(k); } catch {}
    }
    await sleep(70); // 给系统/目标窗口一点时间消化「松手」事件
    // 2) 干净的 Ctrl+C
    await keyboard.pressKey(Key.LeftControl, Key.C);
    await sleep(40);
    await keyboard.releaseKey(Key.LeftControl, Key.C);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 取词：返回当前选中文本。
 * @param {object} opts
 *   - tries     重试次数（默认 3）
 *   - waitMs    单次轮询剪贴板的最长等待（默认 500ms）
 *   - guardMs   首次发键前的缓冲，等用户松开热键（默认 130ms）
 *   - allowClipboardFallback 自动取词彻底失败时，是否允许降级用剪贴板（默认 false）
 *     注意：原生取词可用时默认「不回退」。否则一旦模拟复制失败，就会把旧剪贴板
 *     内容当成选中文本翻译出去（这正是 2026-10-02 用户报告的故障），必须避免。
 * @returns {Promise<{text:string, mode:string, tries?:number}>}
 *   mode: 'auto'（来自模拟复制，可信）| 'clipboard'（降级用剪贴板，仅供参考）
 *         | 'failed'（自动取词失败，未取到）| 'empty'（剪贴板也空）
 */
async function grabSelection(opts = {}) {
  const tries = opts.tries || 3;
  const waitMs = opts.waitMs || 500;
  const guardMs = opts.guardMs == null ? 130 : opts.guardMs;
  const allowClipboardFallback = opts.allowClipboardFallback === true;

  // 备份用户原本的剪贴板，取词结束后还原，不污染用户的复制历史
  const original = clipboard.readText() || '';

  const native = loadNut();
  if (native) {
    await sleep(guardMs); // 等热键修饰键松开
    for (let attempt = 1; attempt <= tries; attempt++) {
      // 清空剪贴板：这样"读到内容"就必然是本次复制的结果，不可能误用旧内容
      try { clipboard.clear(); } catch {}
      const sent = await sendCopy();
      if (!sent) break;

      const deadline = Date.now() + waitMs + (attempt - 1) * 150;
      let got = '';
      while (Date.now() < deadline) {
        await sleep(30);
        got = clipboard.readText() || '';
        if (got.trim()) break;
      }
      if (got.trim()) {
        // 还原用户剪贴板
        try { clipboard.writeText(original); } catch {}
        return { text: got.trim(), mode: 'auto', tries: attempt };
      }
      // 这一轮没取到 → 稍等再试（常见于焦点切换/首个按键被吞）
      if (attempt < tries) await sleep(90);
    }
    // 自动取词彻底失败
    try { clipboard.writeText(original); } catch {}
    if (allowClipboardFallback && original.trim()) {
      return { text: original.trim(), mode: 'clipboard', tries };
    }
    return { text: '', mode: 'failed', tries };
  }

  // 原生取词组件不可用：降级为剪贴板内容
  if (original.trim()) {
    return { text: original.trim(), mode: 'clipboard' };
  }
  return { text: '', mode: 'empty' };
}

/**
 * 判断原生取词模块是否可用
 */
function hasNativeInput() {
  return !!loadNut();
}

module.exports = { grabSelection, hasNativeInput };
