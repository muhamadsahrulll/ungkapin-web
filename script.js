import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-analytics.js";
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  serverTimestamp,
  query,
  orderBy,
  limit,
  getDocs,
  onSnapshot,
  writeBatch
} from "https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCi2vyqRx6pu_sc-7ZFMUEcVdOhJzru7zA",
  authDomain: "ungkap-in.firebaseapp.com",
  projectId: "ungkap-in",
  storageBucket: "ungkap-in.firebasestorage.app",
  messagingSenderId: "992280978949",
  appId: "1:992280978949:web:f761b02cf420aa68ba9e6c",
  measurementId: "G-7V969LYEXZ"
};

const MAX_SUBMISSIONS = 30;
const MAX_WORDS = 200;
const MAX_CHARS = 1500;
const SPAM_COOLDOWN_MS = 10_000;
const CLOCK_SKEW_TOLERANCE_MS = 2_000;
const COOLDOWN_STORAGE_KEY = "ungkapin_cooldown_until";
const SUBMISSIONS_COLLECTION = "submissions";
const CARD_ACCENTS = ["#FE90E8", "#C0F7FE", "#99E885", "#F7CB46", "#FFDC8B"];

const app = initializeApp(firebaseConfig);
try {
  getAnalytics(app);
} catch {
  // Abaikan jika analytics diblokir oleh ekstensi browser
}
const db = getFirestore(app);
const submissionsRef = collection(db, SUBMISSIONS_COLLECTION);

let isSubmitting = false;
let cooldownUntilMemory = 0;
let cooldownIntervalId = null;
let lastOwnSubmittedDocId = null;
const seenLatestDocIds = new Set();
let hasInitializedLatestListener = false;

function countWords(text) {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

function getTimestampMillis(docSnap, protectedDocId = null) {
  if ((protectedDocId && docSnap.id === protectedDocId) || docSnap.metadata?.hasPendingWrites) {
    return Number.MAX_SAFE_INTEGER;
  }
  const ts = docSnap.data()?.timestamp;
  if (ts && typeof ts.toMillis === "function") {
    return ts.toMillis();
  }
  if (ts instanceof Date) {
    return ts.getTime();
  }
  if (typeof ts === "number") {
    return ts;
  }
  return 0;
}

function sortDocsNewestFirst(docs, protectedDocId = null) {
  return [...docs].sort((a, b) => {
    const diff = getTimestampMillis(b, protectedDocId) - getTimestampMillis(a, protectedDocId);
    if (diff !== 0) return diff;
    return b.id.localeCompare(a.id);
  });
}

function readStoredCooldownUntil() {
  try {
    const raw = localStorage.getItem(COOLDOWN_STORAGE_KEY);
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return 0;
    if (parsed - Date.now() > SPAM_COOLDOWN_MS * 6) return 0;
    return parsed;
  } catch {
    return 0;
  }
}

function getCooldownUntil() {
  return Math.max(cooldownUntilMemory, readStoredCooldownUntil());
}

function getRemainingCooldownMs() {
  return Math.max(0, getCooldownUntil() - Date.now());
}

/**
 * Menghitung sisa cooldown global dari timestamp dokumen terbaru di Firestore.
 * Mengabaikan perbandingan jika jam perangkat terlambat > CLOCK_SKEW_TOLERANCE_MS dari server.
 */
function getGlobalCooldownRemainingMs(latestDocSnap) {
  if (!latestDocSnap || latestDocSnap.id === lastOwnSubmittedDocId) return 0;
  const ts = latestDocSnap.data()?.timestamp;
  if (!ts || typeof ts.toMillis !== "function") return 0;

  const elapsed = Date.now() - ts.toMillis();
  if (elapsed < -CLOCK_SKEW_TOLERANCE_MS || elapsed >= SPAM_COOLDOWN_MS) {
    return 0;
  }
  return SPAM_COOLDOWN_MS - Math.max(0, elapsed);
}

function updateCooldownUI() {
  const submitBtn = document.getElementById("submitBtn");
  const cooldownNotice = document.getElementById("cooldownNotice");
  if (!submitBtn) return;

  if (isSubmitting) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Mengirim...";
    return;
  }

  const remainingMs = getRemainingCooldownMs();
  if (remainingMs > 0) {
    const seconds = Math.ceil(remainingMs / 1000);
    submitBtn.disabled = true;
    submitBtn.textContent = `Tunggu ${seconds} detik...`;
    if (cooldownNotice) {
      cooldownNotice.textContent = `Anti-spam aktif — kirim lagi dalam ${seconds} detik.`;
      cooldownNotice.style.display = "block";
    }
    return;
  }

  submitBtn.disabled = false;
  submitBtn.textContent = "Kirim Ungkapan";
  if (cooldownNotice) {
    cooldownNotice.style.display = "none";
  }
}

function startCooldownTicker() {
  updateCooldownUI();
  if (cooldownIntervalId !== null) {
    clearInterval(cooldownIntervalId);
    cooldownIntervalId = null;
  }

  if (getRemainingCooldownMs() <= 0) return;

  cooldownIntervalId = setInterval(() => {
    updateCooldownUI();
    if (getRemainingCooldownMs() <= 0) {
      clearInterval(cooldownIntervalId);
      cooldownIntervalId = null;
    }
  }, 250);
}

function activateCooldown(durationMs = SPAM_COOLDOWN_MS) {
  const clamped = Math.min(SPAM_COOLDOWN_MS, Math.max(0, durationMs));
  if (clamped <= 0) return;

  const targetUntil = Date.now() + clamped;
  cooldownUntilMemory = Math.max(cooldownUntilMemory, targetUntil);

  try {
    localStorage.setItem(COOLDOWN_STORAGE_KEY, String(cooldownUntilMemory));
  } catch {
    // Abaikan jika localStorage diblokir
  }

  startCooldownTicker();
}

async function checkGlobalCooldownFromFirestore() {
  try {
    const q = query(submissionsRef, orderBy("timestamp", "desc"), limit(1));
    const snapshot = await getDocs(q);
    const latestDoc = snapshot.docs[0];
    return getGlobalCooldownRemainingMs(latestDoc);
  } catch {
    return 0;
  }
}

/**
 * Menjaga jumlah dokumen di Firestore maksimal MAX_SUBMISSIONS (30).
 * Entri paling lama (paling bawah pada urutan terbaru->terlama) langsung dihapus.
 */
async function trimExcessSubmissions(existingDocs = null, protectedDocId = null) {
  const docs = existingDocs ?? (await getDocs(submissionsRef)).docs;
  const sorted = sortDocsNewestFirst(docs, protectedDocId);

  if (sorted.length <= MAX_SUBMISSIONS) {
    return sorted;
  }

  const docsToDelete = sorted.slice(MAX_SUBMISSIONS);
  const BATCH_LIMIT = 450;

  try {
    for (let i = 0; i < docsToDelete.length; i += BATCH_LIMIT) {
      const chunk = docsToDelete.slice(i, i + BATCH_LIMIT);
      const batch = writeBatch(db);
      chunk.forEach((docSnap) => batch.delete(docSnap.ref));
      await batch.commit();
    }
  } catch (error) {
    console.warn("Gagal menghapus entri lama yang melewati batas 30:", error);
  }

  return sorted.slice(0, MAX_SUBMISSIONS);
}

function formatTimestamp(ts) {
  if (!ts || typeof ts.toDate !== "function") return "Baru saja";
  try {
    return new Intl.DateTimeFormat("id-ID", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit"
    }).format(ts.toDate());
  } catch {
    return "";
  }
}

function createSubmissionCard(data, index) {
  const card = document.createElement("article");
  card.className = "submission-card";

  const header = document.createElement("div");
  header.className = "submission-card-header";
  header.style.backgroundColor = CARD_ACCENTS[index % CARD_ACCENTS.length];

  const author = document.createElement("span");
  author.className = "submission-author";
  author.textContent = data.name || "Anonim";

  const time = document.createElement("span");
  time.className = "submission-time";
  time.textContent = formatTimestamp(data.timestamp);

  header.append(author, time);

  const body = document.createElement("p");
  body.className = "submission-message";
  body.textContent = data.message || "";

  card.append(header, body);
  return card;
}

function renderSubmissions(container, items, emptyMessage) {
  if (!container) return;
  container.innerHTML = "";

  if (!items.length) {
    const emptyCard = document.createElement("div");
    emptyCard.className = "status-card";
    emptyCard.textContent = emptyMessage;
    container.appendChild(emptyCard);
    return;
  }

  const fragment = document.createDocumentFragment();
  items.forEach((data, idx) => {
    fragment.appendChild(createSubmissionCard(data, idx));
  });
  container.appendChild(fragment);
}

let notifTimer = null;
function showNotif(message, type = "success") {
  const notif = document.getElementById("notif");
  if (!notif) return;

  notif.textContent = message;
  notif.className = `notif ${type}`;
  notif.style.display = "block";

  if (notifTimer) clearTimeout(notifTimer);
  notifTimer = setTimeout(() => {
    notif.style.display = "none";
  }, 3500);
}

function subscribeLatestSubmissions() {
  const container = document.getElementById("latestSubmissions");
  if (!container) return;

  const q = query(submissionsRef, orderBy("timestamp", "desc"), limit(3));
  onSnapshot(
    q,
    (snapshot) => {
      const newestDoc = snapshot.docs[0];
      if (!hasInitializedLatestListener) {
        hasInitializedLatestListener = true;
        snapshot.docs.forEach((docSnap) => seenLatestDocIds.add(docSnap.id));

        const remaining = getGlobalCooldownRemainingMs(newestDoc);
        if (remaining > 0) {
          activateCooldown(remaining);
        }
      } else {
        const addedTopRemoteDoc = snapshot.docChanges().some(
          (change) =>
            change.type === "added" &&
            !change.doc.metadata?.hasPendingWrites &&
            !seenLatestDocIds.has(change.doc.id) &&
            newestDoc?.id === change.doc.id &&
            change.doc.id !== lastOwnSubmittedDocId
        );

        snapshot.docs.forEach((docSnap) => seenLatestDocIds.add(docSnap.id));

        if (addedTopRemoteDoc) {
          activateCooldown(SPAM_COOLDOWN_MS);
        }
      }

      const items = snapshot.docs.map((docSnap) => docSnap.data());
      renderSubmissions(
        container,
        items,
        "Belum ada ungkapan. Jadilah yang pertama mengungkapkan isi hatimu!"
      );
    },
    (error) => {
      console.error("Gagal memuat ungkapan terbaru:", error);
      renderSubmissions(container, [], "Gagal memuat ungkapan. Coba muat ulang halaman.");
    }
  );
}

let cachedAllSubmissions = [];

function updateEntryCountBadge(count) {
  const badge = document.getElementById("entryCountBadge");
  if (!badge) return;
  badge.textContent = `${count} / ${MAX_SUBMISSIONS} entri tersimpan`;
}

async function loadAllSubmissions() {
  const container = document.getElementById("allSubmissions");
  if (!container) return;

  try {
    const snapshot = await getDocs(submissionsRef);
    const keptDocs = await trimExcessSubmissions(snapshot.docs);
    cachedAllSubmissions = keptDocs.map((docSnap) => docSnap.data());
    updateEntryCountBadge(cachedAllSubmissions.length);
    renderSubmissions(
      container,
      cachedAllSubmissions,
      "Belum ada ungkapan yang tersimpan."
    );
  } catch (error) {
    console.error("Gagal memuat semua ungkapan:", error);
    updateEntryCountBadge(0);
    renderSubmissions(container, [], "Gagal memuat ungkapan. Coba muat ulang halaman.");
  }
}

function setupForm() {
  const form = document.getElementById("submissionForm");
  if (!form) return;

  const nameInput = document.getElementById("name");
  const messageInput = document.getElementById("message");
  const wordCounter = document.getElementById("wordCounter");

  const updateWordCounter = () => {
    if (!wordCounter || !messageInput) return;
    const words = countWords(messageInput.value);
    wordCounter.textContent = `${words} / ${MAX_WORDS} kata`;
    wordCounter.classList.toggle("over-limit", words > MAX_WORDS);
  };

  messageInput?.addEventListener("input", updateWordCounter);
  updateWordCounter();

  // Sinkronkan cooldown jika user buka halaman/tab lagi dalam 10 detik
  startCooldownTicker();
  window.addEventListener("storage", (event) => {
    if (event.key === COOLDOWN_STORAGE_KEY) {
      startCooldownTicker();
    }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (isSubmitting) return;

    const localRemainingMs = getRemainingCooldownMs();
    if (localRemainingMs > 0) {
      const seconds = Math.ceil(localRemainingMs / 1000);
      showNotif(`Anti-spam aktif! Tunggu ${seconds} detik lagi sebelum mengirim.`, "error");
      startCooldownTicker();
      return;
    }

    const name = nameInput.value.trim() || "Anonim";
    const message = messageInput.value.trim();

    if (!message) {
      showNotif("Pesan tidak boleh kosong.", "error");
      return;
    }

    if (countWords(message) > MAX_WORDS) {
      showNotif(`Pesan terlalu panjang (maksimal ${MAX_WORDS} kata).`, "error");
      return;
    }

    if (message.length > MAX_CHARS) {
      showNotif(`Pesan terlalu panjang (maksimal ${MAX_CHARS} karakter).`, "error");
      return;
    }

    isSubmitting = true;
    updateCooldownUI();

    try {
      const globalRemainingMs = await checkGlobalCooldownFromFirestore();
      if (globalRemainingMs > 0) {
        const seconds = Math.ceil(globalRemainingMs / 1000);
        activateCooldown(globalRemainingMs);
        showNotif(`Anti-spam aktif! Tunggu ${seconds} detik lagi sebelum mengirim.`, "error");
        return;
      }

      const newDocRef = doc(submissionsRef);
      lastOwnSubmittedDocId = newDocRef.id;
      seenLatestDocIds.add(newDocRef.id);

      await setDoc(newDocRef, {
        name,
        message,
        timestamp: serverTimestamp()
      });

      activateCooldown(SPAM_COOLDOWN_MS);
      await trimExcessSubmissions(null, newDocRef.id);

      showNotif("Ungkapan berhasil dikirim!", "success");
      form.reset();
      updateWordCounter();
    } catch (error) {
      lastOwnSubmittedDocId = null;
      console.error("Gagal mengirim ungkapan:", error);
      showNotif("Terjadi kesalahan, coba lagi nanti.", "error");
    } finally {
      isSubmitting = false;
      updateCooldownUI();
    }
  });
}

function setupSearch() {
  const searchInput = document.getElementById("searchSubmissions");
  const allContainer = document.getElementById("allSubmissions");
  if (!searchInput || !allContainer) return;

  searchInput.addEventListener("input", () => {
    const keyword = searchInput.value.trim().toLowerCase();
    if (!keyword) {
      renderSubmissions(
        allContainer,
        cachedAllSubmissions,
        "Belum ada ungkapan yang tersimpan."
      );
      return;
    }

    const filtered = cachedAllSubmissions.filter((item) => {
      const n = (item.name || "").toLowerCase();
      const m = (item.message || "").toLowerCase();
      return n.includes(keyword) || m.includes(keyword);
    });

    renderSubmissions(
      allContainer,
      filtered,
      `Tidak ada ungkapan yang cocok dengan "${searchInput.value.trim()}".`
    );
  });
}

function setupNavbar() {
  const hamburger = document.getElementById("hamburger");
  const navMenu = document.getElementById("navMenu");
  if (!hamburger || !navMenu) return;

  const openIcon = hamburger.querySelector(".open");
  const closeIcon = hamburger.querySelector(".close");

  const setMenuOpen = (isOpen) => {
    navMenu.classList.toggle("show", isOpen);
    hamburger.setAttribute("aria-expanded", String(isOpen));
    if (openIcon) openIcon.style.display = isOpen ? "none" : "inline";
    if (closeIcon) closeIcon.style.display = isOpen ? "inline" : "none";
  };

  hamburger.addEventListener("click", () => {
    setMenuOpen(!navMenu.classList.contains("show"));
  });

  navMenu.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => setMenuOpen(false));
  });
}

document.addEventListener("DOMContentLoaded", () => {
  setupNavbar();
  setupForm();
  setupSearch();
  subscribeLatestSubmissions();
  loadAllSubmissions();
});
