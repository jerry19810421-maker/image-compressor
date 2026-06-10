/**
 * 圖片壓縮網站 — 前端壓縮邏輯
 *
 * 全程在瀏覽器本地以 Canvas 進行解碼、縮放與重新編碼，
 * 不會將任何圖片上傳到伺服器。
 */

"use strict";

/* =========================================================
   全域狀態與常數
   ========================================================= */

/**
 * 單張圖片的工作項目。
 * @typedef {Object} ImageItem
 * @property {string} id           唯一識別碼
 * @property {File} file           使用者上傳的原始檔案
 * @property {string} originalUrl  原始圖片的 Object URL（供預覽）
 * @property {number} originalSize 原始檔案大小（位元組）
 * @property {HTMLImageElement} image 已解碼的圖片元素
 * @property {Blob|null} blob       壓縮後的 Blob
 * @property {string|null} resultUrl 壓縮結果的 Object URL
 * @property {number} compressedSize 壓縮後大小（位元組）
 * @property {HTMLLIElement} el     對應的卡片 DOM 節點
 */

/** 接受的圖片 MIME 類型。 */
const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"];

/** 各輸出格式對應的副檔名。 */
const EXTENSION_BY_TYPE = {
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/png": "png",
};

/** @type {Map<string, ImageItem>} 目前所有圖片項目，以 id 為鍵。 */
const items = new Map();

/** 用於避免同一圖片同時觸發多次壓縮的版本控管。 */
const compressTokens = new Map();

/* =========================================================
   DOM 參照
   ========================================================= */

const dom = {
  dropzone: document.getElementById("dropzone"),
  fileInput: document.getElementById("fileInput"),
  workspace: document.getElementById("workspace"),
  cardList: document.getElementById("cardList"),
  cardTemplate: document.getElementById("cardTemplate"),
  quality: document.getElementById("quality"),
  qualityValue: document.getElementById("qualityValue"),
  scale: document.getElementById("scale"),
  scaleValue: document.getElementById("scaleValue"),
  format: document.getElementById("format"),
  targetSize: document.getElementById("targetSize"),
  downloadAllBtn: document.getElementById("downloadAllBtn"),
  resetBtn: document.getElementById("resetBtn"),
  addMoreBtn: document.getElementById("addMoreBtn"),
  summary: document.getElementById("summary"),
  sumOriginal: document.getElementById("sumOriginal"),
  sumCompressed: document.getElementById("sumCompressed"),
  sumSaved: document.getElementById("sumSaved"),
  seg: document.querySelector(".seg"),
  segButtons: document.querySelectorAll(".seg__btn"),
  modeManual: document.querySelector(".mode-manual"),
  modeTarget: document.querySelector(".mode-target"),
  // 對比彈窗
  compareModal: document.getElementById("compareModal"),
  compareName: document.getElementById("compareName"),
  compare: document.getElementById("compare"),
  compareBefore: document.getElementById("compareBefore"),
  compareAfter: document.getElementById("compareAfter"),
  compareBeforeWrap: document.getElementById("compareBeforeWrap"),
  compareHandle: document.getElementById("compareHandle"),
  compareRange: document.getElementById("compareRange"),
  compareSizeBefore: document.getElementById("compareSizeBefore"),
  compareSizeAfter: document.getElementById("compareSizeAfter"),
};

/** 目前的壓縮模式："manual"（手動品質）或 "target"（目標大小）。 */
let mode = "manual";

/* =========================================================
   工具函式
   ========================================================= */

/**
 * 將位元組數格式化為易讀字串。
 * @param {number} bytes 位元組數
 * @returns {string} 例如 "1.2 MB"
 */
function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  const decimals = value >= 100 || i === 0 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[i]}`;
}

/**
 * 產生簡短唯一識別碼。
 * @returns {string}
 */
function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * 將檔名替換為指定副檔名，並加上 -min 後綴。
 * @param {string} name 原始檔名
 * @param {string} ext  目標副檔名（不含點）
 * @returns {string}
 */
function buildDownloadName(name, ext) {
  const base = name.replace(/\.[^.]+$/, "");
  return `${base}-min.${ext}`;
}

/* =========================================================
   圖片載入與壓縮
   ========================================================= */

/**
 * 將 File 解碼為 HTMLImageElement。
 * @param {string} url Object URL
 * @returns {Promise<HTMLImageElement>}
 */
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("圖片載入失敗"));
    img.src = url;
  });
}

/**
 * 依目前設定壓縮單張圖片，並更新其卡片畫面。
 *
 * 使用版本 token 確保使用者快速拖動滑桿時，
 * 只有最後一次請求的結果會被套用，避免畫面閃爍或錯置。
 *
 * @param {ImageItem} item 要壓縮的圖片項目
 * @returns {Promise<void>}
 */
async function compressItem(item) {
  const settings = getSettings();
  const token = uid();
  compressTokens.set(item.id, token);

  setCardStatus(item, "pending");

  const baseScale = settings.scale / 100;
  let blob;
  if (settings.mode === "target") {
    blob = await compressToTarget(
      item.image,
      settings.format,
      baseScale,
      settings.targetBytes
    );
  } else {
    const quality = settings.format === "image/png" ? undefined : settings.quality / 100;
    blob = await encodeBlob(item.image, settings.format, baseScale, quality);
  }

  // 若期間又觸發了新的壓縮請求，放棄這次過期的結果。
  if (compressTokens.get(item.id) !== token) return;

  if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);

  item.blob = blob;
  item.compressedSize = blob.size;
  item.resultUrl = URL.createObjectURL(blob);

  updateCardResult(item, settings);
  setCardStatus(item, "done");
  updateSummary();
}

/**
 * 將圖片以指定的格式、縮放與品質編碼為 Blob。
 * @param {HTMLImageElement} image 來源圖片
 * @param {string} format 輸出 MIME 類型
 * @param {number} scaleRatio 縮放比例（0~1）
 * @param {number} [quality] 0~1 的品質（PNG 無效）
 * @returns {Promise<Blob>}
 */
function encodeBlob(image, format, scaleRatio, quality) {
  const targetW = Math.max(1, Math.round(image.naturalWidth * scaleRatio));
  const targetH = Math.max(1, Math.round(image.naturalHeight * scaleRatio));

  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  // JPEG 不支援透明，先填白底以免透明區域變黑。
  if (format === "image/jpeg") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, targetW, targetH);
  }
  ctx.drawImage(image, 0, 0, targetW, targetH);

  return canvasToBlob(canvas, format, format === "image/png" ? undefined : quality);
}

/**
 * 「目標大小」模式：自動尋找能壓到指定上限、且畫質最佳的設定。
 *
 * 有損格式（JPEG / WebP）先二分搜尋品質；若連最低品質都超標，
 * 再逐步縮小尺寸後重試。無損的 PNG 無法調品質，改以二分搜尋縮放比例。
 *
 * @param {HTMLImageElement} image 來源圖片
 * @param {string} format 輸出 MIME 類型
 * @param {number} baseScale 使用者設定的縮放上限（0~1）
 * @param {number} targetBytes 目標位元組數上限
 * @returns {Promise<Blob>}
 */
async function compressToTarget(image, format, baseScale, targetBytes) {
  if (format === "image/png") {
    return searchByScale(image, format, baseScale, targetBytes);
  }

  let best = await searchByQuality(image, format, baseScale, targetBytes);
  let scale = baseScale;
  // 最低品質仍超標時，逐步縮小尺寸換取更小體積。
  while (best.size > targetBytes && scale > 0.12) {
    scale = Math.max(0.1, scale - 0.15);
    best = await searchByQuality(image, format, scale, targetBytes);
  }
  return best;
}

/**
 * 在固定縮放下，二分搜尋「不超過上限、品質最高」的編碼結果。
 * 若連最低品質都超標，回傳最低品質的結果作為保底。
 * @param {HTMLImageElement} image 來源圖片
 * @param {string} format 輸出 MIME 類型
 * @param {number} scaleRatio 縮放比例（0~1）
 * @param {number} targetBytes 目標位元組數上限
 * @returns {Promise<Blob>}
 */
async function searchByQuality(image, format, scaleRatio, targetBytes) {
  let lo = 0.1;
  let hi = 1.0;
  let best = await encodeBlob(image, format, scaleRatio, lo);

  for (let i = 0; i < 7; i++) {
    const mid = (lo + hi) / 2;
    const blob = await encodeBlob(image, format, scaleRatio, mid);
    if (blob.size <= targetBytes) {
      best = blob; // 達標，嘗試提高品質
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return best;
}

/**
 * 針對無損格式，二分搜尋「不超過上限、尺寸最大」的縮放比例。
 * @param {HTMLImageElement} image 來源圖片
 * @param {string} format 輸出 MIME 類型
 * @param {number} maxScale 縮放上限（0~1）
 * @param {number} targetBytes 目標位元組數上限
 * @returns {Promise<Blob>}
 */
async function searchByScale(image, format, maxScale, targetBytes) {
  let lo = 0.05;
  let hi = maxScale;
  let best = await encodeBlob(image, format, lo, undefined);

  for (let i = 0; i < 7; i++) {
    const mid = (lo + hi) / 2;
    const blob = await encodeBlob(image, format, mid, undefined);
    if (blob.size <= targetBytes) {
      best = blob;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return best;
}

/**
 * Promise 化的 canvas.toBlob。
 * @param {HTMLCanvasElement} canvas 來源畫布
 * @param {string} type   輸出 MIME 類型
 * @param {number} [quality] 0~1 的品質（僅有損格式）
 * @returns {Promise<Blob>}
 */
function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("壓縮失敗"))),
      type,
      quality
    );
  });
}

/**
 * 讀取目前的壓縮設定。
 * @returns {{mode:string, quality:number, scale:number, format:string, targetBytes:number}}
 */
function getSettings() {
  return {
    mode,
    quality: Number(dom.quality.value),
    scale: Number(dom.scale.value),
    format: dom.format.value,
    targetBytes: Math.max(5, Number(dom.targetSize.value) || 200) * 1024,
  };
}

/* =========================================================
   卡片畫面操作
   ========================================================= */

/**
 * 為新項目建立卡片並插入清單。
 * @param {ImageItem} item 圖片項目
 */
function createCard(item) {
  const fragment = dom.cardTemplate.content.cloneNode(true);
  const li = fragment.querySelector(".card");

  li.querySelector(".card__img--before").src = item.originalUrl;
  const nameEl = li.querySelector(".card__name");
  nameEl.textContent = item.file.name;
  nameEl.title = item.file.name;
  li.querySelector(".size--before").textContent = formatBytes(item.originalSize);

  li.querySelector(".card__remove").addEventListener("click", () =>
    removeItem(item.id)
  );
  li.querySelector(".card__compare").addEventListener("click", () =>
    openCompare(item)
  );

  item.el = li;
  dom.cardList.appendChild(li);
}

/**
 * 設定卡片的處理狀態（控制 spinner 與下載鈕可用性）。
 * @param {ImageItem} item 圖片項目
 * @param {"pending"|"done"} status 狀態
 */
function setCardStatus(item, status) {
  if (item.el) item.el.dataset.status = status;
}

/**
 * 將壓縮結果寫入卡片：預覽、大小、節省比例、下載連結。
 * @param {ImageItem} item 圖片項目
 * @param {{format:string}} settings 目前設定
 */
function updateCardResult(item, settings) {
  const el = item.el;
  if (!el) return;

  el.querySelector(".card__img--after").src = item.resultUrl;
  el.querySelector(".size--after").textContent = formatBytes(item.compressedSize);

  const diff = item.originalSize - item.compressedSize;
  const ratio = (diff / item.originalSize) * 100;
  const saveEl = el.querySelector(".size__save");

  const isLarger = diff < 0;
  if (!isLarger) {
    saveEl.textContent = `↓ ${ratio.toFixed(0)}%`;
    saveEl.classList.remove("is-negative");
  } else {
    // 某些已高度壓縮的圖片重新編碼後可能變大，如實標示。
    saveEl.textContent = `↑ ${Math.abs(ratio).toFixed(0)}%`;
    saveEl.classList.add("is-negative");
  }

  // 輸出反而比原檔大時跳出提示，避免誤用無損格式（常見於把 JPG 轉成 PNG）。
  const warnEl = el.querySelector(".card__warn");
  warnEl.hidden = !isLarger;

  const ext = EXTENSION_BY_TYPE[settings.format];
  const link = el.querySelector(".card__download");
  link.href = item.resultUrl;
  link.download = buildDownloadName(item.file.name, ext);
}

/**
 * 更新左側總計面板。
 */
function updateSummary() {
  const list = [...items.values()].filter((it) => it.blob);
  if (list.length === 0) {
    dom.summary.hidden = true;
    dom.downloadAllBtn.disabled = true;
    return;
  }

  const original = list.reduce((sum, it) => sum + it.originalSize, 0);
  const compressed = list.reduce((sum, it) => sum + it.compressedSize, 0);
  const saved = original - compressed;
  const ratio = original > 0 ? (saved / original) * 100 : 0;

  dom.sumOriginal.textContent = formatBytes(original);
  dom.sumCompressed.textContent = formatBytes(compressed);
  dom.sumSaved.textContent = `${formatBytes(Math.abs(saved))}（${ratio.toFixed(0)}%）`;

  dom.summary.hidden = false;
  dom.downloadAllBtn.disabled = false;
}

/* =========================================================
   項目新增 / 移除 / 重設
   ========================================================= */

/**
 * 處理使用者選取或拖入的檔案清單。
 * @param {FileList|File[]} fileList 檔案集合
 */
async function handleFiles(fileList) {
  const files = [...fileList].filter((f) => ACCEPTED_TYPES.includes(f.type));
  if (files.length === 0) return;

  // 第一次加入圖片時切換到工作區畫面。
  if (items.size === 0) {
    dom.dropzone.hidden = true;
    dom.workspace.hidden = false;
  }

  for (const file of files) {
    const item = /** @type {ImageItem} */ ({
      id: uid(),
      file,
      originalUrl: URL.createObjectURL(file),
      originalSize: file.size,
      image: null,
      blob: null,
      resultUrl: null,
      compressedSize: 0,
      el: null,
    });
    items.set(item.id, item);
    createCard(item);

    try {
      item.image = await loadImage(item.originalUrl);
      await compressItem(item);
    } catch (err) {
      console.error(err);
      removeItem(item.id);
    }
  }
}

/**
 * 移除單一圖片項目並釋放資源。
 * @param {string} id 項目 id
 */
function removeItem(id) {
  const item = items.get(id);
  if (!item) return;

  if (item.originalUrl) URL.revokeObjectURL(item.originalUrl);
  if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);
  if (item.el) item.el.remove();

  items.delete(id);
  compressTokens.delete(id);

  if (items.size === 0) {
    dom.workspace.hidden = true;
    dom.dropzone.hidden = false;
  }
  updateSummary();
}

/**
 * 清除所有圖片並回到初始狀態。
 */
function resetAll() {
  for (const id of [...items.keys()]) removeItem(id);
  dom.fileInput.value = "";
}

/**
 * 重新壓縮所有現有圖片（設定變更時呼叫）。
 */
function recompressAll() {
  for (const item of items.values()) {
    if (item.image) compressItem(item);
  }
}

/**
 * 將所有壓縮完成的圖片打包成單一 ZIP 後下載。
 * @returns {Promise<void>}
 */
async function downloadAll() {
  const list = [...items.values()].filter((it) => it.blob);
  if (list.length === 0) return;

  dom.downloadAllBtn.disabled = true;
  const original = dom.downloadAllBtn.textContent;
  dom.downloadAllBtn.textContent = "打包中…";

  try {
    const ext = EXTENSION_BY_TYPE[getSettings().format];
    const entries = list.map((item) => ({
      name: buildDownloadName(item.file.name, ext),
      blob: item.blob,
    }));

    const zipBlob = await buildZip(entries);
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "compressed-images.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 延遲釋放，確保下載已開始讀取。
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (err) {
    console.error(err);
  } finally {
    dom.downloadAllBtn.textContent = original;
    dom.downloadAllBtn.disabled = false;
  }
}

/* =========================================================
   ZIP 打包（store 模式，無外部依賴）
   ========================================================= */

/** CRC-32 查表，建立一次後重複使用。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * 計算位元組陣列的 CRC-32 校驗值（ZIP 規格所需）。
 * @param {Uint8Array} buf 來源資料
 * @returns {number} 無號 32 位元 CRC 值
 */
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 以 store（不壓縮）方式打包多個檔案為 ZIP Blob。
 *
 * 圖片本身已是壓縮格式，再做 deflate 收益有限，
 * 故採用 store 以保持實作輕量且無第三方依賴。
 *
 * @param {{name:string, blob:Blob}[]} entries 檔案清單
 * @returns {Promise<Blob>} ZIP 檔的 Blob
 */
async function buildZip(entries) {
  const encoder = new TextEncoder();
  const parts = []; // 所有區段（本地檔頭 + 資料 + 中央目錄 + 結尾）
  const central = [];
  const usedNames = new Set();
  let offset = 0;

  for (const entry of entries) {
    const name = uniqueName(entry.name, usedNames);
    usedNames.add(name);

    const nameBytes = encoder.encode(name);
    const data = new Uint8Array(await entry.blob.arrayBuffer());
    const crc = crc32(data);
    const size = data.length;

    // 本地檔案標頭（30 bytes + 檔名）
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // 簽章
    lv.setUint16(4, 20, true); // 需求版本
    lv.setUint16(6, 0x0800, true); // 旗標：檔名為 UTF-8
    lv.setUint16(8, 0, true); // 壓縮方式：store
    lv.setUint16(10, 0, true); // 修改時間
    lv.setUint16(12, 0x21, true); // 修改日期（1980-01-01）
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true); // 壓縮後大小
    lv.setUint32(22, size, true); // 原始大小
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // 額外欄位長度
    local.set(nameBytes, 30);

    parts.push(local, data);

    // 中央目錄標頭（46 bytes + 檔名）
    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); // 簽章
    cv.setUint16(4, 20, true); // 製作版本
    cv.setUint16(6, 20, true); // 需求版本
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // 額外欄位
    cv.setUint16(32, 0, true); // 註解
    cv.setUint16(34, 0, true); // 起始磁碟
    cv.setUint16(36, 0, true); // 內部屬性
    cv.setUint32(38, 0, true); // 外部屬性
    cv.setUint32(42, offset, true); // 本地檔頭偏移
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + data.length;
  }

  const centralSize = central.reduce((sum, c) => sum + c.length, 0);
  const centralOffset = offset;

  // 中央目錄結尾紀錄（End of Central Directory）
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralOffset, true);
  ev.setUint16(20, 0, true);

  return new Blob([...parts, ...central, end], { type: "application/zip" });
}

/**
 * 確保 ZIP 內檔名唯一，重複者在副檔名前加上序號。
 * @param {string} name 原始檔名
 * @param {Set<string>} used 已使用的檔名集合
 * @returns {string} 不重複的檔名
 */
function uniqueName(name, used) {
  if (!used.has(name)) return name;
  let i = 1;
  let candidate;
  do {
    candidate = name.replace(/(\.[^.]+)?$/, `-${i}$1`);
    i++;
  } while (used.has(candidate));
  return candidate;
}

/* =========================================================
   壓縮前後滑動對比
   ========================================================= */

/**
 * 開啟對比彈窗並載入指定圖片的前後結果。
 * @param {ImageItem} item 圖片項目
 */
function openCompare(item) {
  if (!item.resultUrl) return;

  dom.compareName.textContent = item.file.name;
  dom.compareBefore.src = item.originalUrl;
  dom.compareAfter.src = item.resultUrl;
  dom.compareSizeBefore.textContent = formatBytes(item.originalSize);
  dom.compareSizeAfter.textContent = formatBytes(item.compressedSize);

  dom.compareModal.hidden = false;
  document.body.style.overflow = "hidden";

  // 等壓縮後圖片載入並完成排版後再校正內層寬度與初始位置。
  if (dom.compareAfter.complete) {
    syncCompareWidth();
  } else {
    dom.compareAfter.onload = syncCompareWidth;
  }
  setComparePosition(50);
  dom.compareRange.value = "50";
}

/**
 * 關閉對比彈窗並還原頁面捲動。
 */
function closeCompare() {
  dom.compareModal.hidden = true;
  document.body.style.overflow = "";
}

/**
 * 讓內層原始圖的寬度等於對比框寬度，避免裁切時被壓縮變形。
 */
function syncCompareWidth() {
  dom.compare.style.setProperty("--cw", `${dom.compare.clientWidth}px`);
}

/**
 * 設定對比分隔線位置。
 * @param {number} percent 0~100 的百分比（原始圖顯示寬度）
 */
function setComparePosition(percent) {
  const clamped = Math.min(100, Math.max(0, percent));
  dom.compareBeforeWrap.style.width = `${clamped}%`;
  dom.compareHandle.style.left = `${clamped}%`;
}

/* =========================================================
   設定滑桿即時回饋（含 debounce）
   ========================================================= */

/** debounce 計時器。 */
let recompressTimer = null;

/**
 * 延遲觸發整批重新壓縮，避免拖曳滑桿時過度運算。
 */
function scheduleRecompress() {
  clearTimeout(recompressTimer);
  recompressTimer = setTimeout(recompressAll, 180);
}

/* =========================================================
   事件綁定
   ========================================================= */

function bindEvents() {
  // 點擊上傳區開啟檔案選擇
  dom.dropzone.addEventListener("click", () => dom.fileInput.click());
  dom.dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      dom.fileInput.click();
    }
  });
  dom.addMoreBtn.addEventListener("click", () => dom.fileInput.click());

  dom.fileInput.addEventListener("change", (e) => {
    handleFiles(e.target.files);
    dom.fileInput.value = ""; // 允許重複選取同一檔案
  });

  // 拖放
  ["dragenter", "dragover"].forEach((evt) =>
    dom.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dom.dropzone.classList.add("is-dragover");
    })
  );
  ["dragleave", "dragend", "drop"].forEach((evt) =>
    dom.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dom.dropzone.classList.remove("is-dragover");
    })
  );
  dom.dropzone.addEventListener("drop", (e) => {
    // 阻止冒泡，避免下方的整頁拖放監聽器重複處理同一次拖放
    e.stopPropagation();
    if (e.dataTransfer?.files) handleFiles(e.dataTransfer.files);
  });

  // 即使在工作區，也支援整頁拖放加入更多圖片
  ["dragover", "drop"].forEach((evt) =>
    document.addEventListener(evt, (e) => {
      if (dom.workspace.hidden) return;
      e.preventDefault();
      if (evt === "drop" && e.dataTransfer?.files) handleFiles(e.dataTransfer.files);
    })
  );

  // 模式切換（手動品質 / 目標大小）
  dom.segButtons.forEach((btn) =>
    btn.addEventListener("click", () => setMode(btn.dataset.mode))
  );

  // 設定變更
  dom.quality.addEventListener("input", () => {
    dom.qualityValue.textContent = `${dom.quality.value}%`;
    scheduleRecompress();
  });
  dom.scale.addEventListener("input", () => {
    dom.scaleValue.textContent = `${dom.scale.value}%`;
    scheduleRecompress();
  });
  dom.targetSize.addEventListener("input", scheduleRecompress);
  dom.format.addEventListener("change", recompressAll);

  // 動作按鈕
  dom.downloadAllBtn.addEventListener("click", downloadAll);
  dom.resetBtn.addEventListener("click", resetAll);

  // 對比彈窗
  dom.compareRange.addEventListener("input", () =>
    setComparePosition(Number(dom.compareRange.value))
  );
  dom.compareModal.querySelectorAll("[data-close]").forEach((el) =>
    el.addEventListener("click", closeCompare)
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !dom.compareModal.hidden) closeCompare();
  });
  window.addEventListener("resize", () => {
    if (!dom.compareModal.hidden) syncCompareWidth();
  });
}

/**
 * 切換壓縮模式並更新對應控制項的顯示，然後重新壓縮全部圖片。
 * @param {string} next 目標模式："manual" 或 "target"
 */
function setMode(next) {
  if (next === mode) return;
  mode = next;

  dom.seg.dataset.mode = mode;
  dom.segButtons.forEach((btn) => {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", String(active));
  });

  dom.modeManual.hidden = mode !== "manual";
  dom.modeTarget.hidden = mode !== "target";

  recompressAll();
}

bindEvents();
