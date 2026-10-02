// 翻译引擎：调用免费翻译接口，自动检测语言，中英互译
// 双通道：① Electron net（Chromium 栈，默认首选）② Node https（备选）
const https = require('https');
const http = require('http');

const YOUDAO_ENDPOINT = 'https://aidemo.youdao.com/trans';

function isMostlyChinese(text) {
  const cn = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const letters = (text.match(/[A-Za-z\u4e00-\u9fff]/g) || []).length;
  if (letters === 0) return false;
  return cn / letters > 0.5;
}

// —— 通道 1：Node https ——
function viaNodeHttps(form, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(form).toString();
    const u = new URL(YOUDAO_ENDPOINT);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname,
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36',
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error('返回非 JSON: ' + text.slice(0, 120)));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// —— 通道 2：Electron net ——
let electronNet = null;
function getNet() {
  if (electronNet !== null) return electronNet;
  try {
    electronNet = require('electron').net || false;
  } catch {
    electronNet = false;
  }
  return electronNet;
}
function viaElectronNet(form, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const netMod = getNet();
    if (!netMod || !netMod.request) return reject(new Error('net 模块不可用'));
    const body = new URLSearchParams(form).toString();
    const req = netMod.request({ method: 'POST', url: YOUDAO_ENDPOINT });
    req.setHeader('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8');
    req.setHeader('Content-Length', String(Buffer.byteLength(body)));
    const timer = setTimeout(() => {
      try { req.abort(); } catch {}
      reject(new Error('请求超时'));
    }, timeoutMs);
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new Error('返回非 JSON: ' + text.slice(0, 120)));
        }
      });
    });
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.write(body);
    req.end();
  });
}

function extractDict(j) {
  try {
    const out = [];
    if (j.basic && Array.isArray(j.basic.explains)) out.push(...j.basic.explains);
    if (Array.isArray(j.dict) && j.dict.length) return out;
    return out;
  } catch {
    return [];
  }
}

/**
 * 翻译主函数
 * @param {string} text
 * @param {object} opts { prefer: 'net'|'node' }
 */
async function translate(text, opts = {}) {
  const t0 = Date.now();
  const raw = (text || '').trim();
  const finish = (o) => ({ ...o, ms: Date.now() - t0 });

  if (!raw) {
    return finish({ ok: false, src: '', dst: '', from: '', to: '', engine: 'youdao', error: '没有取到文本' });
  }
  if (raw.length > 5000) {
    return finish({
      ok: false, src: raw, dst: '', from: '', to: '', engine: 'youdao',
      error: `文本过长（${raw.length} 字符），请分段翻译`,
    });
  }

  const toZH = !isMostlyChinese(raw);
  const from = toZH ? 'auto' : 'zh-CHS';
  const to = toZH ? 'zh-CHS' : 'en';
  const form = { q: raw, from, to };

  // 通道顺序：默认先 Electron net，失败换 Node https
  const chain = opts.prefer === 'node'
    ? [['node', viaNodeHttps], ['net', viaElectronNet]]
    : [['net', viaElectronNet], ['node', viaNodeHttps]];

  const errs = [];
  for (const [name, fn] of chain) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const j = await fn(form);
        if (j.errorCode && j.errorCode !== '0') throw new Error(`接口错误码 ${j.errorCode}`);
        const lines = Array.isArray(j.translation) ? j.translation : [];
        const dst = lines.join('').trim();
        if (!dst) throw new Error('接口返回空译文');
        const lp = j.l || '';
        const [f, t] = lp.includes('2') ? lp.split('2') : ['', ''];
        return finish({
          ok: true, src: raw, dst,
          from: f || from, to: t || to,
          engine: 'youdao/' + name,
          dict: extractDict(j),
        });
      } catch (e) {
        errs.push(`${name}#${attempt + 1}: ${e.message}`);
        if (attempt === 0) await new Promise((r) => setTimeout(r, 350));
      }
    }
  }
  return finish({
    ok: false, src: raw, dst: '', from, to, engine: 'youdao',
    error: '翻译失败：' + (errs[errs.length - 1] || '未知错误'),
    tries: errs,
  });
}

module.exports = { translate, isMostlyChinese, viaElectronNet, viaNodeHttps };
