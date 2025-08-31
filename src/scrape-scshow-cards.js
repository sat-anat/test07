// src/scrape-scshow-cards.js
// ESM対応（package.json に "type":"module" を想定）
// 目的: https://asmape0104.github.io/scshow-calculator/ からカード候補を堅牢に抽出し、cards.csv を出力
// 特徴:
//  - Playwright（CLIでブラウザ＋依存を導入済み前提）
//  - UI遅延やモーダル非表示に強い“任意モーダル”扱い＆フォールバック抽出
//  - 何も取れなくてもヘッダーのみ CSV を出力してワークフローを安定化
//
// 実行: `node src/scrape-scshow-cards.js`
// 環境変数（任意）:
//   BASE_URL        : 既定 'https://asmape0104.github.io/scshow-calculator/'
//   OUT_FILE        : 既定 'cards.csv'
//   HEADLESS        : 'true'|'false' 既定 'true'
//   TIMEOUT_MS      : 既定 30000  （操作デフォルト）
//   NAV_TIMEOUT_MS  : 既定 60000  （ナビゲーション）

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

// ------------------------- 正規化 -------------------------
function dedupeAndNormalize(items) {
  function clean(s) {
    if (s == null) return '';
    return String(s).replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  const out = [];
  const seen = new Set();

  for (const it of items || []) {
    const rec = {
      id: clean(it.id),
      name: clean(it.name),
      extra: clean(it.extra),
      source: clean(it.source || 'unknown'),
    };
    const key = rec.name || rec.id;
    if (!key) continue;
    const k = key.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(rec);
  }

  out.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  return out;
}

// ------------------------- DOM抽出（ブラウザ内評価） -------------------------
async function extractCards(page) {
  const modalSel = '[role="dialog"], .modal, .modal-dialog, .MuiDialog-root, .ant-modal-root';
  const modal = page.locator(modalSel).first();
  const hasModal = await waitForOptionalVisible(modal, 2000);

  async function scrapeRoot(rootHandle) {
    return await rootHandle.evaluate((root) => {
      const uniq = new Map();

      const norm = (s) => (s || '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
      const push = (obj) => {
        const key = norm(obj.name || obj.raw || obj.id || '');
        if (key && !uniq.has(key)) uniq.set(key, obj);
      };

      // 1) table 形式
      root.querySelectorAll('table').forEach((tbl) => {
        tbl.querySelectorAll('tbody tr').forEach((tr) => {
          const cells = Array.from(tr.querySelectorAll('th,td')).map((td) => norm(td.innerText));
          if (cells.length) {
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

      // 2) list item / role=option 系
      root
        .querySelectorAll(
          '[role="option"], li, .list-group-item, .MuiMenuItem-root, .MuiListItem-root, .ant-select-item'
        )
        .forEach((li) => {
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

      // 3) ボタン/リンクの集合
      root.querySelectorAll('button, a').forEach((el) => {
        const txt = norm(el.innerText || el.getAttribute('aria-label'));
        if (!txt) return;
        if (/選択して入力|検索|閉じる|OK|キャンセル/i.test(txt)) return; // 操作ボタンは除外
        push({
          id:
            el.getAttribute('data-card-id') ||
            el.getAttribute('data-id') ||
            el.getAttribute('href') ||
            '',
          name: txt,
          extra: el.className ? `class:${el.className}` : '',
          source: 'buttons',
          raw: txt,
        });
      });

      // 4) select/option 形式
      root.querySelectorAll('select option').forEach((op) => {
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

      return Array.from(uniq.values());
    });
  }

  // モーダル優先
  if (hasModal) {
    try {
      const handle = await modal.elementHandle();
      if (handle) {
        const fromModal = await scrapeRoot(handle);
        if (fromModal && fromModal.length) return fromModal;
      }
    } catch {
      // ignore
    }
  }

  // フォールバック: ページ全体
  const doc = await page.evaluateHandle(() => document.documentElement);
  try {
    const fromPage = await scrapeRoot(doc);
    return fromPage || [];
  } finally {
    await doc.dispose();
  }
}

// ------------------------- メイン処理 -------------------------
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

    // 「カードを選択して入力」ボタンがあればクリック
    const chooseBtn = page.getByRole('button', { name: /カードを選択して入力/ });
    if (await waitForOptionalVisible(chooseBtn, 3000)) {
      console.log('[INFO] Clicking 「カードを選択して入力」...');
      await chooseBtn.click({ timeout: 10_000 }).catch(() => {});
    } else {
      console.log('[WARN] 「カードを選択して入力」ボタンが見つからず。ページ全体から抽出します。');
    }

    // 任意モーダル検出（出れば抽出を優先）
    const modalSel = '[role="dialog"], .modal, .modal-dialog, .MuiDialog-root, .ant-modal-root';
    const modal = page.locator(modalSel).first();
    const appeared = await waitForOptionalVisible(modal, 3000);
    if (appeared) {
      console.log('[INFO] モーダルを検出。内容を優先的に抽出します。');
    } else {
      console.log('[INFO] モーダルは表示されていません。ページから直接抽出します。');
    }

    // 抽出
    const items = await extractCards(page);

    // モーダルが出ていた場合は閉じる（後続の邪魔をしないよう）
    if (appeared) {
      const close = modal
        .locator(
          'button:has-text("OK"), button:has-text("閉じる"), [aria-label="Close"], .close, .modal-close, [data-test="close"]'
        )
        .first();
      if (await close.isVisible().catch(() => false)) {
        await close.click({ timeout: 5000 }).catch(() => {});
        await modal.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
      }
    }

    // CSV 出力
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

// ------------------------- 起動 -------------------------
main()
  .then(() => {
    // 取得0件でも成功終了（件数はログで判断）
    process.exit(0);
  })
  .catch(async (e) => {
    console.error('[ERROR]', e?.stack || e);
    // 異常時でも後続が動けるようヘッダーのみ出力してから失敗終了
    const headers = ['id', 'name', 'extra', 'source'];
    try {
      await fs.writeFile(OUT_FILE, `${headers.join(',')}\n`, 'utf8');
    } catch {}
    process.exit(1);
  });
