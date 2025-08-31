// src/scrape-scshow-cards.js
// ESM対応（package.json に "type":"module" を想定）
//
// 目的:
//   「1人目」エリアの「カードを選択して 入力」→ ダイアログでカードを選択 → 「選択」押下後に
//   「1人目」エリアへ動的表示される全項目（例：メンバー/シリーズ/消費AP など）を抽出し CSV 出力します。
//
// 仕様:
//  - ダイアログの全カード候補を順に選択（上限は MAX_CARDS で制御）。
//  - 「1人目」エリア内の表示データを汎用的に収集（dl/dt+dd, table, label+input/select, strong+テキスト など）
//  - 取得キーはレコードごとにばらつく可能性があるため、最後に全キーを統合してヘッダを作成。
//  - 失敗時でもヘッダのみの CSV を出力して異常終了（CIの後段が参照可能）。
//
// 実行:
//   node src/scrape-scshow-cards.js
//
// 環境変数（任意）:
//   BASE_URL        : 既定 'https://asmape0104.github.io/scshow-calculator/'
//   OUT_FILE        : 既定 'cards.csv'
//   HEADLESS        : 'true'|'false' 既定 'true'
//   TIMEOUT_MS      : 既定 30000
//   NAV_TIMEOUT_MS  : 既定 60000
//   MAX_CARDS       : 既定 999999（実質すべて）
//   ONLY_FIRST_N    : 既定 未設定（デバッグ用途。先頭N件だけ選びたい時に整数で設定）

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

// ------------------------- 設定 -------------------------
const BASE_URL = process.env.BASE_URL || 'https://asmape0104.github.io/scshow-calculator/';
const OUT_FILE = process.env.OUT_FILE || 'cards.csv';
const HEADLESS = (process.env.HEADLESS ?? 'true').toLowerCase() !== 'false';
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 30_000);
const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS ?? 60_000);
const MAX_CARDS = Number(process.env.MAX_CARDS ?? 999_999);
const ONLY_FIRST_N = process.env.ONLY_FIRST_N ? Number(process.env.ONLY_FIRST_N) : null;

// ------------------------- 小道具 -------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => (s ?? '').toString().replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();

function toCsvField(v) {
  if (v == null) return '';
  const s = String(v);
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function writeCsv(filePath, rows) {
  // 1) 全キー集合
  const prefer = [
    'index',
    'カード名',
    'メンバー',
    'シリーズ',
    '消費AP',
    'タイプ',
    '属性',
    'スキル',
    'スキル効果',
    '効果時間',
    '効果値',
    '条件',
    'レアリティ',
    'レベル',
    '覚醒',
  ];
  const keySet = new Set();
  for (const r of rows) Object.keys(r).forEach((k) => keySet.add(k));
  // index/カード名/メンバー/シリーズ/消費AP をできるだけ先頭に
  const rest = [...keySet].filter((k) => !prefer.includes(k)).sort((a, b) => a.localeCompare(b, 'ja'));
  const headers = [...prefer.filter((k) => keySet.has(k)), ...rest];

  // 2) 出力
  const lines = [];
  lines.push(headers.map(toCsvField).join(','));
  for (const r of rows) {
    lines.push(headers.map((h) => toCsvField(r[h])).join(','));
  }
  await fs.writeFile(filePath, lines.join('\n'), 'utf8');
}

// ------------------------- 「1人目」エリアの特定 -------------------------
/**
 * 「1人目」エリアを表すコンテナを推定します。
 * ヒューリスティック: 「カードを選択して 入力」ボタンを内包する最小のセクション/カード/行コンテナを採用。
 */
async function resolveFirstArea(page) {
  // ボタン名のゆらぎ（全角/半角スペース）に対応
  const chooseBtn = page
    .getByRole('button', { name: /カードを選択して\s*入力/ })
    .or(page.getByRole('button', { name: /カードを選択して入力/ }));
  await chooseBtn.first().waitFor({ state: 'visible', timeout: 10_000 });

  // ボタンの最近傍のコンテナを ancestor から抽出
  const first = chooseBtn.first();
  const handle = await first.elementHandle();
  const area = await handle.evaluateHandle((btn) => {
    // 近傍の「section/div/card系」まで遡る
    let el = btn;
    for (let depth = 0; depth < 8 && el && el.parentElement; depth++) {
      el = el.parentElement;
      const cls = (el.getAttribute('class') || '').toLowerCase();
      if (
        el.tagName === 'SECTION' ||
        /card|panel|container|row|col-|member|area|block/.test(cls)
      ) {
        return el;
      }
    }
    // 最悪 body
    return document.body;
  });
  return area.asElement();
}

// ------------------------- 「1人目」エリアからキー/値を抽出 -------------------------
async function extractKeyValuesFromArea(areaHandle) {
  return await areaHandle.evaluate((root) => {
    const norm = (s) => (s ?? '').toString().replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
    const kv = {};

    const set = (k, v) => {
      const key = norm(k);
      const val = norm(v);
      if (!key) return;
      // 既にキーがある場合は上書きせず（最初の値を優先）。空文字なら更新。
      if (!(key in kv) || kv[key] === '') kv[key] = val;
    };

    // 1) <dl><dt>ラベル</dt><dd>値</dd></dl>
    root.querySelectorAll('dl').forEach((dl) => {
      let dt = dl.querySelectorAll('dt');
      dt.forEach((dtEl) => {
        let dd = dtEl.nextElementSibling;
        if (!dd) return;
        if (dd.tagName !== 'DD') return;
        set(dtEl.innerText, dd.innerText);
      });
    });

    // 2) table: tr 内の 1列目をキー、残りを値として結合
    root.querySelectorAll('table').forEach((tbl) => {
      tbl.querySelectorAll('tr').forEach((tr) => {
        const cells = Array.from(tr.querySelectorAll('th,td'));
        if (cells.length >= 2) {
          const key = cells[0].innerText;
          const val = cells.slice(1).map((c) => c.innerText).join(' | ');
          set(key, val);
        }
      });
    });

    // 3) label + input/select/textarea
    root.querySelectorAll('label').forEach((lab) => {
      const key = lab.innerText || lab.getAttribute('aria-label') || lab.getAttribute('title') || '';
      if (!key) return;
      let field = null;
      const forId = lab.getAttribute('for');
      if (forId) {
        field = root.querySelector('#' + CSS.escape(forId));
      } else {
        // label の次要素や同じ親の入力など
        let sib = lab.nextElementSibling;
        if (sib && /input|select|textarea/.test((sib.tagName || '').toLowerCase())) {
          field = sib;
        } else {
          const cand = lab.parentElement?.querySelector('input,select,textarea');
          if (cand) field = cand;
        }
      }
      if (field) {
        const tag = field.tagName.toLowerCase();
        let val = '';
        if (tag === 'select') {
          val = field.selectedOptions?.length ? field.selectedOptions[0].textContent : field.value;
        } else if (tag === 'input' || tag === 'textarea') {
          val = field.value ?? field.textContent;
        } else {
          val = field.textContent ?? '';
        }
        set(key, val);
      }
    });

    // 4) <strong>ラベル：</strong> 値 / <b>ラベル:</b> 値
    root.querySelectorAll('strong,b').forEach((s) => {
      const txt = norm(s.innerText || '');
      if (!txt) return;
      // コロン終端のラベルを想定
      if (/[:：]\s*$/.test(txt)) {
        // 兄弟ノードのテキストを値とみなす
        let val = '';
        let n = s.nextSibling;
        while (n) {
          if (n.nodeType === Node.TEXT_NODE) val += n.nodeValue;
          if (n.nodeType === Node.ELEMENT_NODE) val += ' ' + (n.textContent || '');
          n = n.nextSibling;
        }
        set(txt.replace(/\s*[:：]\s*$/, ''), val);
      }
    });

    // よく使う和名キーの軽い正規化（末尾のコロン除去等）
    for (const k of Object.keys(kv)) {
      const nk = k.replace(/\s*[:：]\s*$/, '');
      if (nk !== k) {
        if (!(nk in kv)) kv[nk] = kv[k];
        delete kv[k];
      }
    }

    return kv;
  });
}

// ------------------------- カード選択ダイアログ操作 -------------------------
async function openCardDialog(page, firstAreaLocator) {
  const btn = page
    .getByRole('button', { name: /カードを選択して\s*入力/ })
    .or(page.getByRole('button', { name: /カードを選択して入力/ }));
  // firstArea 内のボタンを優先
  const inArea = firstAreaLocator.locator('button', { hasText: /カードを選択して/ });
  const target = (await inArea.count()) ? inArea.first() : btn.first();
  await target.click({ timeout: 10_000 }).catch(() => {});
  const modal = page.locator('[role="dialog"], .modal, .modal-dialog, .MuiDialog-root, .ant-modal-root').first();
  await modal.waitFor({ state: 'visible', timeout: 10_000 });
  return modal;
}

async function closeDialogIfAny(page) {
  const modal = page.locator('[role="dialog"], .modal, .modal-dialog, .MuiDialog-root, .ant-modal-root').first();
  if (await modal.isVisible().catch(() => false)) {
    // 閉じるボタン候補
    const closeBtn = modal.locator(
      'button:has-text("閉じる"), button:has-text("キャンセル"), [aria-label="Close"], .modal-close, .close'
    );
    if (await closeBtn.first().isVisible().catch(() => false)) {
      await closeBtn.first().click({ timeout: 5_000 }).catch(() => {});
      await modal.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
    } else {
      // 外側クリックで閉じるタイプ
      await page.mouse.click(10, 10).catch(() => {});
      await modal.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
    }
  }
}

async function enumerateCardCount(modal) {
  // 「選択」ボタンの数＝カード件数の目安
  const selects = modal.locator('button:has-text("選択")');
  let n = await selects.count();
  if (n === 0) {
    // 代替: 「選ぶ」「決定」などの表記ゆれ
    const alt = modal.locator('button:has-text("決定"), button:has-text("選ぶ")');
    n = await alt.count();
  }
  return n;
}

async function clickNthCard(modal, index) {
  const btns = modal.locator('button:has-text("選択")');
  const total = await btns.count();
  if (index >= total) throw new Error(`index ${index} out of range ${total}`);
  const btn = btns.nth(index);
  await btn.scrollIntoViewIfNeeded().catch(() => {});
  await btn.click({ timeout: 10_000 });
  // モーダルが閉じるのを待つ（UI側仕様で閉じない場合もあるのでタイムアウトしても継続）
  await modal.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
}

// ------------------------- メイン -------------------------
async function main() {
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({ locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

  const rows = [];
  try {
    console.log(`[INFO] GoTo: ${BASE_URL}`);
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

    // 「1人目」エリアのコンテナ特定
    const areaHandle = await resolveFirstArea(page);
    const firstArea = areaHandle ? page.locator('xpath=//*').filter({ has: page.locator(':scope') }) : null; // ダミー

    // カード選択ダイアログを開いて件数を把握
    const modal = await openCardDialog(page, page.locator(await areaHandle.evaluate((n) => n.tagName.toLowerCase())));
    let count = await enumerateCardCount(modal);
    // デバッグ: 件数が極端に少ない場合に備え軽く待つ
    if (count === 0) {
      await sleep(500);
      count = await enumerateCardCount(modal);
    }
    console.log(`[INFO] カード候補件数（推定）: ${count}`);
    await closeDialogIfAny(page);

    const limit = Math.min(count, ONLY_FIRST_N ?? MAX_CARDS);
    for (let i = 0; i < limit; i++) {
      console.log(`[INFO] 処理中: ${i + 1}/${limit}`);
      const dlg = await openCardDialog(page, page.locator(await areaHandle.evaluate((n) => n.tagName.toLowerCase())));
      await clickNthCard(dlg, i);
      // 「1人目」エリアからキー/値抽出
      const kv = await extractKeyValuesFromArea(areaHandle);
      // 補助: カード名（「シリーズ」+「メンバー」から合成）を用意
      const series = kv['シリーズ'] || '';
      const member = kv['メンバー'] || '';
      const cardName = [series && `[${series}]`, member].filter(Boolean).join(' ');
      const rec = { index: i + 1, 'カード名': cardName, ...kv };
      rows.push(rec);
      // 次ループへ
    }

    // CSV 出力
    await writeCsv(path.resolve(OUT_FILE), rows);
    console.log(`[INFO] CSV written: ${OUT_FILE} (records: ${rows.length})`);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// ------------------------- 実行 -------------------------
main()
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error('[ERROR]', e?.stack || e);
    // 失敗時でもヘッダだけ出力
    const headers = ['index', 'カード名', 'メンバー', 'シリーズ', '消費AP'];
    try {
      await fs.writeFile(OUT_FILE, `${headers.join(',')}\n`, 'utf8');
    } catch {}
    process.exit(1);
  });
