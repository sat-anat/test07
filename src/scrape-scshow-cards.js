// src/scrape-scshow-cards.js
// ESM対応（package.json に "type":"module" を想定）
// 目的: https://asmape0104.github.io/scshow-calculator/ からカード一覧を堅牢に抽出し、cards.csv を出力
// 特徴:
//  - Playwright (CLIでブラウザ＋依存を導入済み前提)
//  - UIの遅延/モーダル非表示に強いリトライ＆“任意モーダル”扱い
//  - 複数のDOM構造（table, li, role=option, button/a群）に対応したフォールバック抽出
//  - 何も取れなくてもヘッダーのみの CSV を出力（ワークフローを安定させる）
//
// 実行: `node src/scrape-scshow-cards.js`
// 環境変数:
//   BASE_URL   : 既定 'https://asmape0104.github.io/scshow-calculator/'
//   OUT_FILE   : 既定 'cards.csv'
//   HEADLESS   : 'true'|'false' 既定 'true'
//   TIMEOUT_MS : 既定 '30000' (各操作のデフォルト)
//   NAV_TIMEOUT_MS : 既定 '60000' (ナビゲーション)

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

// ------------------------- 設定 -------------------------
const BASE_URL = process.env.BASE_URL || 'https://asmape0104.github.io/scshow-calculator/';
const OUT_FILE = process.env.OUT_FILE || 'cards.csv';
const HEADLESS = (process.env.HEADLESS ?? 'true').toLowerCase() !== 'false';
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 30_000);
const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS ?? 60_000);

// ------------------------- 便利関数 -------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForOptionalVisible(locator, timeout = 3000) {
  try {
    await locator.waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

function toCsvField(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[,"\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

async function writeCsv(filePath, rows, headers) {
  const lines = [];
  lines.push(headers.map(toCsvField).join(','));
  for (const row of rows) {
    lines.push(headers.map((h) => toCsvField(row[h])).join(','));
  }
  await fs.writeFile(filePath, lines.join('\n'), 'utf8');
}

// ------------------------- DOM抽出（ブラウザ内） -------------------------
/**
 * ダイアログ/モーダル内、もしくはページ全体からカード候補を抽出
 * 多様な構造に対応するため複数の手法で網羅的に拾う
 */
async function extractCards(page) {
  // 可能ならモーダル/ダイアログを優先的に探索
  const modalSel = '[role="dialog"], .modal, .modal-dialog, .MuiDialog-root, .ant-modal-root';
  const modal = page.locator(modalSel).first();
  const hasModal = await waitForOptionalVisible(modal, 2000);

  // 抽出ロジック（共通）
  async function scrapeRoot(rootHandle) {
    return await rootHandle.evaluate((root) => {
      const uniq = new Map();

      const norm = (s) =>
        (s || '')
          .replace(/\u00A0/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

      const push = (obj) => {
        // name をキーとして重複排除（なければ raw）
        const key = obj.name || obj.raw || obj.id || JSON.stringify(obj);
        const k = norm(key);
        if (k && !uniq.has(k)) uniq.set(k, obj);
      };

      // 1) table 形式
      const tables = root.querySelectorAll('table');
      tables.forEach((tbl) => {
        const rows = tbl.querySelectorAll('tbody tr');
        rows.forEach((tr) => {
          const cells = Array.from(tr.querySelectorAll('th,td')).map((td) => norm(td.innerText));
          if (cells.length > 0) {
            const [name, ...rest] = cells;
            if (name) {
              push({
                id: tr.getAttribute('data-id') || '',
                name,
                extra: rest.join(' | ') || '',
                source: 'table',
                raw: cells.join(' / '),
              });
            }
          }
        });
      });

      // 2) list item 形式（role=option, li, 各種 UI ライブラリ）
      const listItems = root.querySelectorAll(
        '[role="option"], li, .list-group-item, .MuiMenuItem-root, .MuiListItem-root, .ant-select-item'
      );
      listItems.forEach((li) => {
        const txt = norm(li.innerText);
        if (txt) {
          push({
            id:
              li.getAttribute('data-card-id') ||
              li.getAttribute('data-id') ||
              li.getAttribute('data-key') ||
              '',
            name: txt,
            extra: '',
            source: 'list',
            raw: txt,
          });
        }
      });

      // 3) ボタン/アンカー集合（カード名をボタン/リンクで並べるタイプ）
      const btns = root.querySelectorAll('button, a');
      btns.forEach((el) => {
        const txt = norm(el.innerText || el.getAttribute('aria-label'));
        if (txt) {
          const cls = el.className || '';
          // “選択して入力”など操作ボタンは除外っぽいヒューリスティック
          if (!/選択して入力|検索|閉じる|OK|キャンセル/i.test(txt)) {
            push({
              id:
                el.getAttribute('data-card-id') ||
                el.getAttribute('data-id') ||
                el.getAttribute('href') ||
                '',
              name: txt,
              extra: cls ? `class:${cls}` : '',
              source: 'buttons',
              raw: txt,
            });
          }
        }
      });

      // 4) select/option 形式
      const selects = root.querySelectorAll('select');
      selects.forEach((sel) => {
        sel.querySelectorAll('option').forEach((op) => {
          const txt = norm(op.textContent || '');
          const val = norm(op.value || '');
          if (txt || val) {
            push({
              id: val || '',
              name: txt || val,
              extra: '',
              source: 'select',
              raw: txt || val,
            });
          }
        });
      });

      return Array.from(uniq.values());
    });
  }

  // モーダルがあればモーダル優先で抽出
  if (hasModal) {
    try {
      const handle = await modal.elementHandle();
      if (handle) {
        const fromModal = await scrapeRoot(handle);
        if (fromModal?.length) return fromModal;
      }
    } catch {
      // ignore
    }
  }

  // フォールバック: ページ全体から抽出
  const doc = await page.evaluateHandle(() => document.documentElement);
  const fromPage = await scrapeRoot(doc);
  return fromPage ?? [];
}

// ------------------------- メイン -------------------------
async function main() {
  console.log('[INFO] Launching browser...');
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

  try {
    console.log(`[INFO] Navigating to: ${BASE_URL}`);
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

    // 「カードを選択して入力」ボタンを押す（あれば）
    const chooseBtn = page.getByRole('button', { name: /カードを選択して入力/ });
    const hasChooseBtn = await waitForOptionalVisible(chooseBtn, 3000);
    if (hasChooseBtn) {
      console.log('[INFO] Clicking 「カードを選択して入力」...');
      await chooseBtn.click({ timeout: 10_000 }).catch(() => {});
    } else {
      console.log('[WARN] 「カードを選択して入力」ボタンが見つからず。ページ全体から抽出を試みます。');
    }

    // 任意モーダル扱い：出たら閉じる前に中身を抽出、出なければそのまま抽出
    const modalSel = '[role="dialog"], .modal, .modal-dialog, .MuiDialog-root, .ant-modal-root';
    const modal = page.locator(modalSel).first();
    const appeared = await waitForOptionalVisible(modal, 3000);
    if (appeared) {
      console.log('[INFO] モーダルを検出。内容を抽出します。');
    } else {
      console.log('[INFO] モーダルは表示されていません。ページから直接抽出します。');
    }

    // カード抽出（モーダル優先 → ページ）
    const items = await extractCards(page);

    // モーダルが出ていた場合は閉じる試行（次操作の邪魔にならないように）
    if (appeared) {
      const close = modal.locator(
        'button:has-text("OK"), button:has-text("閉じる"), [aria-label="Close"], .close, .modal-close, [data-test="close"]'
      ).first();
      if (await close.isVisible().catch(() => false)) {
        await close.click({ timeout: 5000 }).catch(() => {});
        await modal.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
      }
    }

    // 抽出後の整形＆CSV出力
    const cleaned = dedupeAndNormalize(items);
    const headers = ['id', 'name', 'extra', 'source'];
    if (!cleaned.length) {
      console.warn('[WARN] カード項目を検出できませんでした。ヘッダーのみの CSV を出力します。');
    } else {
      console.log(`[INFO] 抽出件数: ${cleaned.length} 件`);
    }
    await writeCsv(path.resolve(OUT_FILE), cleaned, headers);
    console.log(`[INFO] CSV written: ${OUT_FILE}`);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/** 二重化・余白掃除・最低限の正規化 */
function dedupeAndNormalize(items) {
  const out = [];
  const seen = new Set();
  for (const it of items || []) {
    const rec = {
      id: clean(it.id),
      name: clean(it.name),
      extra: clean(it.extra),
      source: clean(it.source || 'unknown'),
    };
    // name が主キー。なければ raw/id で代替
    const key = rec.name || rec.id;
    if (!key) continue;
    const k = key.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(rec);
  }
  // 名前順で安定化
  out.sort((a, b) => (a.name > b.name ? 1 : a.name < b.name ? -1 : 0));
  return out;

  function clean(s) {
    if (s == null) return '';
    return String(s).replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

// ------------------------- 実行 -------------------------
main()
  .then(() => {
    // 取得0件でも成功終了（ワークフロー安定化）。件数はログで判断。
    process.exit(0);
  })
  .catch((e) => {
    console.error('[ERROR]', e?.stack || e);
    // 失敗時でも CSV が無いとワークフロー後段で失敗するため、ヘッダのみ出力してから異常終了
    const headers = ['id', 'name', 'extra', 'source'];
    fs.writeFile(OUT_FILE, `${headers.join(',')}\n`, 'utf8')
      .catch(() => {})
      .finally(() => process.exit(1));
