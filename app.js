/* ============================================================
   名刺帳 - app.js
   IndexedDB保存 / オフラインOCR / 検索 / 編集 の全ロジック
   ============================================================ */

const DB_NAME = "meishi-db";
const DB_VERSION = 1;
const STORE = "cards";

let db = null;
let allCards = [];
let currentEditId = null; // null = 新規登録中

/* ---------------- IndexedDB ---------------- */

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const database = req.result;
      if (!database.objectStoreNames.contains(STORE)) {
        const store = database.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGetAll() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbPut(card) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(card);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function dbDelete(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ---------------- Utilities ---------------- */

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function fileToResizedDataURL(file, maxDim = 1100, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => {
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDim) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else if (height >= width && height > maxDim) {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ---------------- Field extraction (heuristic) ---------------- */

function extractFields(rawText) {
  const lines = rawText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const result = {
    name: "",
    company: "",
    title: "",
    phone: "",
    email: "",
    address: ""
  };

  const emailRe = /[\w.+-]+@[\w-]+\.[\w.-]+/;
  const phoneRe = /(0\d{1,4}[-‐−]\d{1,4}[-‐−]\d{3,4}|0\d{9,10})/;
  const postalRe = /〒?\s*\d{3}[-‐−]\d{4}/;
  const companyRe = /(株式会社|有限会社|合同会社|Co\.,?\s?Ltd\.?|Inc\.?|Corporation|Corp\.?)/i;
  const titleRe = /(代表取締役|取締役|部長|課長|係長|主任|マネージャー|マネジャー|支店長|所長|次長|本部長|社長|副社長|専務|常務|CEO|CTO|COO|Manager|Director|President)/i;
  const addressHintRe = /(都|道|府|県|市|区|町|村)/;
  const usedLines = new Set();

  for (const line of lines) {
    if (!result.email && emailRe.test(line)) {
      result.email = line.match(emailRe)[0];
      usedLines.add(line);
    }
  }
  for (const line of lines) {
    if (usedLines.has(line)) continue;
    if (!result.phone && phoneRe.test(line)) {
      result.phone = line.match(phoneRe)[0];
      usedLines.add(line);
    }
  }
  for (const line of lines) {
    if (usedLines.has(line)) continue;
    if (!result.company && companyRe.test(line)) {
      result.company = line;
      usedLines.add(line);
    }
  }
  for (const line of lines) {
    if (usedLines.has(line)) continue;
    if (!result.title && titleRe.test(line)) {
      result.title = line;
      usedLines.add(line);
    }
  }
  for (const line of lines) {
    if (usedLines.has(line)) continue;
    if (!result.address && (postalRe.test(line) || addressHintRe.test(line))) {
      result.address = line;
      usedLines.add(line);
    }
  }
  // Name guess: shortest remaining line without digits/symbols, 2〜12文字程度
  const nameCandidates = lines.filter((l) => {
    if (usedLines.has(l)) return false;
    if (/\d/.test(l)) return false;
    if (/https?:|www\./i.test(l)) return false;
    const len = l.replace(/\s/g, "").length;
    return len >= 2 && len <= 12;
  });
  if (nameCandidates.length > 0) {
    nameCandidates.sort((a, b) => a.length - b.length);
    result.name = nameCandidates[0];
    usedLines.add(result.name);
  }

  return result;
}

/* ---------------- Rendering ---------------- */

function escapeHtml(str) {
  return (str || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function renderList(filter = "") {
  const listEl = document.getElementById("cardList");
  const emptyEl = document.getElementById("emptyState");
  const countEl = document.getElementById("searchCount");

  const q = filter.trim().toLowerCase();
  const filtered = q
    ? allCards.filter((c) => {
        const hay = [c.name, c.company, c.title, c.phone, c.email, c.address, c.note, c.rawText]
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      })
    : allCards;

  const sorted = [...filtered].sort((a, b) => b.createdAt - a.createdAt);

  listEl.innerHTML = "";
  if (allCards.length === 0) {
    emptyEl.hidden = false;
    countEl.textContent = "";
    return;
  }
  emptyEl.hidden = true;

  countEl.textContent = q ? `${sorted.length}件ヒット / 全${allCards.length}件` : `全${allCards.length}件`;

  for (const card of sorted) {
    const el = document.createElement("button");
    el.className = "meishi-card";
    el.type = "button";
    el.dataset.id = card.id;
    el.innerHTML = `
      <img class="meishi-thumb" src="${card.image || ""}" alt="">
      <div class="meishi-info">
        <p class="meishi-name">${escapeHtml(card.name) || "(氏名未入力)"}</p>
        <p class="meishi-company">${escapeHtml(card.company)}${card.title ? " ・ " + escapeHtml(card.title) : ""}</p>
        <p class="meishi-meta">${escapeHtml(card.phone)}${card.phone && card.email ? " / " : ""}${escapeHtml(card.email)}</p>
      </div>
    `;
    el.style.cssText = "text-align:left;width:100%;border:none;font:inherit;cursor:pointer;padding:14px 16px;background:var(--paper-raised);";
    el.addEventListener("click", () => openDetail(card.id));
    listEl.appendChild(el);
  }
}

/* ---------------- Detail sheet ---------------- */

function fillForm(card) {
  document.getElementById("detailImage").src = card.image || "";
  document.getElementById("fieldName").value = card.name || "";
  document.getElementById("fieldCompany").value = card.company || "";
  document.getElementById("fieldTitle").value = card.title || "";
  document.getElementById("fieldPhone").value = card.phone || "";
  document.getElementById("fieldEmail").value = card.email || "";
  document.getElementById("fieldAddress").value = card.address || "";
  document.getElementById("fieldNote").value = card.note || "";
  document.getElementById("fieldRaw").textContent = card.rawText || "(読み取りテキストなし)";
}

function openDetail(id) {
  const card = allCards.find((c) => c.id === id);
  if (!card) return;
  currentEditId = id;
  fillForm(card);
  document.getElementById("deleteBtn").hidden = false;
  document.getElementById("detailSheet").hidden = false;
}

function openNewCardForm(card) {
  currentEditId = null;
  fillForm(card);
  document.getElementById("deleteBtn").hidden = true;
  document.getElementById("detailSheet").hidden = false;
  window.__pendingNewCard = card;
}

function closeDetail() {
  document.getElementById("detailSheet").hidden = true;
  currentEditId = null;
  window.__pendingNewCard = null;
}

async function handleFormSubmit(e) {
  e.preventDefault();
  const base = currentEditId
    ? allCards.find((c) => c.id === currentEditId)
    : window.__pendingNewCard;
  if (!base) return;

  const updated = {
    ...base,
    name: document.getElementById("fieldName").value.trim(),
    company: document.getElementById("fieldCompany").value.trim(),
    title: document.getElementById("fieldTitle").value.trim(),
    phone: document.getElementById("fieldPhone").value.trim(),
    email: document.getElementById("fieldEmail").value.trim(),
    address: document.getElementById("fieldAddress").value.trim(),
    note: document.getElementById("fieldNote").value.trim(),
    updatedAt: Date.now()
  };
  if (!currentEditId) {
    updated.id = uid();
    updated.createdAt = Date.now();
  }

  await dbPut(updated);
  allCards = await dbGetAll();
  closeDetail();
  renderList(document.getElementById("searchInput").value);
}

async function handleDelete() {
  if (!currentEditId) return;
  if (!confirm("この名刺を削除しますか?元に戻せません。")) return;
  await dbDelete(currentEditId);
  allCards = await dbGetAll();
  closeDetail();
  renderList(document.getElementById("searchInput").value);
}

/* ---------------- Capture + OCR flow ---------------- */

async function handleCameraCapture(e) {
  const file = e.target.files[0];
  e.target.value = ""; // 同じ写真を連続で撮れるようリセット
  if (!file) return;

  const overlay = document.getElementById("scanningOverlay");
  const label = document.getElementById("scanningLabel");
  overlay.hidden = false;
  label.textContent = "画像を準備中…";

  try {
    const dataUrl = await fileToResizedDataURL(file);

    label.textContent = "文字を読み取り中…";
    const { data } = await Tesseract.recognize(dataUrl, "jpn+eng", {
      logger: (m) => {
        if (m.status === "recognizing text") {
          const pct = Math.round((m.progress || 0) * 100);
          label.textContent = `文字を読み取り中… ${pct}%`;
        } else if (m.status) {
          label.textContent = statusLabel(m.status);
        }
      }
    });

    const rawText = (data && data.text) || "";
    const fields = extractFields(rawText);

    const newCard = {
      id: null,
      image: dataUrl,
      rawText,
      name: fields.name,
      company: fields.company,
      title: fields.title,
      phone: fields.phone,
      email: fields.email,
      address: fields.address,
      note: "",
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    overlay.hidden = true;
    openNewCardForm(newCard);
  } catch (err) {
    console.error(err);
    overlay.hidden = true;
    alert("読み取りに失敗しました。初回はOCRデータのダウンロードにネット接続が必要です。電波状況を確認して、もう一度お試しください。");
  }
}

function statusLabel(status) {
  const map = {
    "loading tesseract core": "OCRエンジンを準備中…",
    "initializing tesseract": "OCRエンジンを準備中…",
    "loading language traineddata": "日本語データを準備中…",
    "initializing api": "準備中…",
    "recognizing text": "文字を読み取り中…"
  };
  return map[status] || "読み取り中…";
}

/* ---------------- Backup: export / import ---------------- */

function exportData() {
  const blob = new Blob([JSON.stringify(allCards, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `meishi-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function importData(file) {
  try {
    const text = await file.text();
    const items = JSON.parse(text);
    if (!Array.isArray(items)) throw new Error("invalid format");
    let count = 0;
    for (const item of items) {
      if (!item.id) item.id = uid();
      await dbPut(item);
      count++;
    }
    allCards = await dbGetAll();
    renderList(document.getElementById("searchInput").value);
    updateMenuCount();
    alert(`${count}件のデータを読み込みました。`);
  } catch (err) {
    console.error(err);
    alert("読み込みに失敗しました。ファイル形式を確認してください。");
  }
}

function updateMenuCount() {
  document.getElementById("menuCount").textContent = `現在 ${allCards.length} 件を端末内に保存中`;
}

/* ---------------- Init ---------------- */

async function init() {
  db = await openDB();
  allCards = await dbGetAll();
  renderList();
  updateMenuCount();

  document.getElementById("captureBtn").addEventListener("click", (e) => {
    e.currentTarget.classList.add("stamping");
    setTimeout(() => e.currentTarget.classList.remove("stamping"), 400);
    document.getElementById("cameraInput").click();
  });
  document.getElementById("cameraInput").addEventListener("change", handleCameraCapture);

  document.getElementById("searchInput").addEventListener("input", (e) => {
    renderList(e.target.value);
  });

  document.getElementById("sheetClose").addEventListener("click", closeDetail);
  document.getElementById("detailForm").addEventListener("submit", handleFormSubmit);
  document.getElementById("deleteBtn").addEventListener("click", handleDelete);

  document.getElementById("menuBtn").addEventListener("click", () => {
    updateMenuCount();
    document.getElementById("menuSheet").hidden = false;
  });
  document.getElementById("menuClose").addEventListener("click", () => {
    document.getElementById("menuSheet").hidden = true;
  });
  document.getElementById("exportBtn").addEventListener("click", exportData);
  document.getElementById("importInput").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) importData(file);
    e.target.value = "";
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch((err) => console.error("SW登録失敗", err));
  }
}

document.addEventListener("DOMContentLoaded", init);
