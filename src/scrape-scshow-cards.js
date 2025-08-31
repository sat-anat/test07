// src/scrape-scshow-cards.js
import { chromium } from '@playwright/test';
import fs from 'fs';
import { format, writeToStream } from 'fast-csv';

const BASE_URL = 'https://asmape0104.github.io/scshow-calculator/'; // Nuxt baseURLは /scshow-calculator/ [1](https://github.com/asmape0104/scshow-calculator/blob/main/index.html)
const OUTPUT_CSV = 'cards.csv';

// ユーティリティ: ラベル文字列から、直後/同階層の入力要素を探して値を抜くヘルパ
async function getInputValueByLabel(section, labelText, { type = 'input', nth = 0 } = {}) {
  const label = section.getByText(labelText, { exact: true });
  const labelEl = await label.elementHandle();
  if (!labelEl) return null;

  // ラベルの近傍のフォーム要素を探索（兄弟や祖先->子 など）
  const candidateSelectors = [
    'following-sibling::input|following-sibling::textarea|following-sibling::select',
    'ancestor::div[1]//input|ancestor::div[1]//textarea|ancestor::div[1]//select',
    'ancestor::div[2]//input|ancestor::div[2]//textarea|ancestor::div[2]//select'
  ];
  for (const xpath of candidateSelectors) {
    const els = await section.page().locator(`xpath=(.//label[normalize-space(text())="${labelText}"]/${xpath})`).all();
    if (els.length > 0) {
      const el = els[nth] || els[0];
      const tag = await el.evaluate((e) => e.tagName.toLowerCase());
      if (tag === 'select') {
        return await el.evaluate((e) => e.value);
      } else {
        return await el.evaluate((e) => e.value ?? e.textContent?.trim() ?? '');
      }
    }
  }
  return null;
}

async function getTextareaAndDesc(section, labelText) {
  // ラベル → その行の textarea と 右側の .alert.alert-secondary を取る
  const label = section.getByText(labelText, { exact: true });
  const row = await label.locator('xpath=ancestor::div[contains(@class,"my-2") or contains(@class,"row")][1]').elementHandle();
  if (!row) return { code: '', desc: '' };

  // textarea（左カラム）
  const textarea = section.locator('xpath=.//textarea').filter({ has: label }).first();
  let code = '';
  try { code = await textarea.inputValue(); } catch {}

  // 右カラムの説明（.alert-secondary）
  let desc = '';
  const alert = await section.locator('xpath=.//div[contains(@class,"alert-secondary")]').filter({ has: label }).first().elementHandle();
  if (alert) {
    desc = await alert.evaluate((e) => e.textContent?.trim() ?? '');
  } else {
    // 代替: ラベルの近傍で alert-secondary を探索
    const near = section.locator('xpath=(.//label[normalize-space(text())="'+labelText+'"]/ancestor::div[1]//div[contains(@class,"alert-secondary")])[1]');
    try { desc = await near.textContent() ?? ''; desc = desc.trim(); } catch {}
  }

  return { code, desc };
}

async function extractFromFirstCardSection(page, cardDisplayName) {
  // 「1人目」のカードセクション: “カードを選択して入力” を含む最初の .card を基準にする
  const firstCard = page.locator('div.card:has(button:has-text("カードを選択して入力"))').first();

  // 基本項目
  const member = await getInputValueByLabel(firstCard, ' メンバー： ');
  const ap = await getInputValueByLabel(firstCard, ' 消費AP： ');
  // ステータスは4つの input が並ぶので、ラベル「ステータス：」の近傍から順序で拾う
  const statusBlock = firstCard.getByText(' ステータス： ');
  const statusInputs = await statusBlock.locator('xpath=ancestor::div[1]//input').all();
  const [smile, pure, cool, mental] = await Promise.all(statusInputs.slice(0, 4).map(async el => el.evaluate(e => e.value)));

  // スキル欄
  const { code: skill_code, desc: skill_desc } = await getTextareaAndDesc(firstCard, ' スキル： ');
  // センタースキル
  const center_timing = await getInputValueByLabel(firstCard, ' センタースキル： ', { type: 'select', nth: 0 });
  const { code: center_skill_code, desc: center_skill_desc } = await getTextareaAndDesc(firstCard, ' センタースキル： ');
  // センター特性
  const { code: center_trait_code, desc: center_trait_desc } = await getTextareaAndDesc(firstCard, ' センター特性： ');

  return {
    card_display_name: cardDisplayName,
    member,
    ap_cost: ap,
    smile, pure, cool, mental,
    skill_code, skill_desc,
    center_timing,
    center_skill_code, center_skill_desc,
    center_trait_code, center_trait_desc
  };
}

async function collectAllCardItemsInModal(modal) {
  // モーダル内のクリック可能アイテムを全部拾う
  let seen = 0;
  let items = [];
  const scrollContainer = modal.locator('[class*="modal"], [role="dialog"], .card-body, .list-group').first();

  while (true) {
    const candidates = await modal.locator('button, a, li, [role="option"]').all();
    // テキストがあり、かつ visible なものに限定
    const filtered = [];
    for (const c of candidates) {
      if (!(await c.isVisible())) continue;
      const txt = (await c.textContent())?.trim() ?? '';
      if (txt.length === 0) continue;
      filtered.push({ handle: c, text: txt });
    }
    items = filtered; // 常時最新
    // スクロールで増えるなら下端へ
    const count = items.length;
    if (count === 0) break;
    if (count === seen) {
      // もう増えない
      break;
    }
    seen = count;
    try {
      await scrollContainer.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await modal.page().waitForTimeout(500);
    } catch {
      break;
    }
  }
  return items;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 }
  });

  // ネットワーク監視（デバッグ用: 何かJSONを取得しているなら保存）
  const responses = [];
  page.on('response', async (res) => {
    try {
      const url = res.url();
      if (/\.(json)$/.test(url) || url.includes('_nuxt/')) {
        const text = await res.text();
        responses.push({ url, text });
      }
    } catch {}
  });

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  // Nuxt/SPAなので UI安定まで少し待つ
  await page.waitForLoadState('networkidle');

  // 1人目セクションの「カードを選択して入力」ボタン
  const pickBtn = page.getByRole('button', { name: 'カードを選択して入力' }).first();
  await pickBtn.waitFor({ state: 'visible' });

  // モーダルを開いて全アイテムを列挙
  await pickBtn.click();
  // モーダル要素を特定
  const modal = page.locator('[role="dialog"], .modal').first();
  await modal.waitFor({ state: 'visible', timeout: 5000 });

  const items = await collectAllCardItemsInModal(modal);
  if (items.length === 0) {
    console.error('カード一覧が取得できませんでした。UIの構造が変わった可能性があります。');
    await browser.close();
    process.exit(1);
  }

  console.log(`発見したカード候補: ${items.length} 件`);

  // CSV準備
  const csvStream = format({ headers: true });
  const ws = fs.createWriteStream(OUTPUT_CSV);
  csvStream.pipe(ws);

  // 全カードを順番に選択→抽出
  for (let i = 0; i < items.length; i++) {
    // モーダルが閉じてしまっていれば開き直す
    if (!(await modal.isVisible())) {
      await pickBtn.click();
      await modal.waitFor({ state: 'visible', timeout: 5000 });
    }

    // アイテムを再取得（DOMが作り直される場合に備える）
    const currentItems = await collectAllCardItemsInModal(modal);
    if (i >= currentItems.length) break;

    const item = currentItems[i];
    const cardName = item.text.replace(/\s+/g, ' ').trim();

    // クリック → モーダルが閉じ、フォームに反映される想定
    await item.handle.click();
    // 反映待ち
    await page.waitForTimeout(300);

    // 抽出
    const row = await extractFromFirstCardSection(page, cardName);
    csvStream.write(row);

    // 軽いクールダウン（優しさ＆安定性）
    await page.waitForTimeout(150);
  }

  csvStream.end();
  await new Promise((r) => ws.on('finish', r));

  // デバッグ用に _nuxt の応答を保存しておきたい場合はアンコメント
  // fs.writeFileSync('debug-nuxt-captures.json', JSON.stringify(responses, null, 2), 'utf-8');

  console.log(`完了: ${OUTPUT_CSV}`);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
