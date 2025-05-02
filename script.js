// Import the functions you need from the SDKs you need
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-analytics.js";
import { getFirestore, collection, addDoc, serverTimestamp, query, orderBy, limit, getDocs } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyCi2vyqRx6pu_sc-7ZFMUEcVdOhJzru7zA",
  authDomain: "ungkap-in.firebaseapp.com",
  projectId: "ungkap-in",
  storageBucket: "ungkap-in.firebasestorage.app",
  messagingSenderId: "992280978949",
  appId: "1:992280978949:web:f761b02cf420aa68ba9e6c",
  measurementId: "G-7V969LYEXZ"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
const db = getFirestore(app);

const form = document.getElementById("submissionForm");
const submissionsContainer = document.getElementById("latestSubmissions");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("name").value || "Anonim";
  const message = document.getElementById("message").value;

  // Validasi panjang pesan
  if (message.length > 1500) {
    alert("Pesan terlalu panjang (maks 200 kata)");
    return;
  }

  try {
    // Menyimpan data ke Firestore
    await addDoc(collection(db, "submissions"), {
      name,
      message,
      timestamp: serverTimestamp()
    });

    // Menampilkan notifikasi berhasil
    const notif = document.getElementById("notif");
    notif.textContent = "Ungkapan berhasil dikirim!";
    notif.style.display = "block";

    // Menyembunyikan notifikasi setelah 3 detik
    setTimeout(() => {
      notif.style.display = "none";
    }, 3000);

    // Reset form setelah kirim
    form.reset();

    // Memuat ulang kiriman terbaru
    loadSubmissions();
  } catch (error) {
    // Menampilkan notifikasi gagal jika terjadi kesalahan
    const notif = document.getElementById("notif");
    notif.textContent = "Terjadi kesalahan, coba lagi nanti.";
    notif.style.display = "block";

    // Menyembunyikan notifikasi setelah 3 detik
    setTimeout(() => {
      notif.style.display = "none";
    }, 3000);
  }
});

async function loadSubmissions() {
  const q = query(collection(db, "submissions"), orderBy("timestamp", "desc"), limit(3));
  const snapshot = await getDocs(q);

  const submissionsContainer = document.getElementById("latestSubmissions");
  submissionsContainer.innerHTML = ""; // Reset kontainer sebelum menambah data baru

  snapshot.forEach(doc => {
    const data = doc.data();
    submissionsContainer.innerHTML += `
      <div class="feature-box">
        <strong>${data.name}</strong><br/>
        <p>${data.message}</p>
      </div>
    `;
  });
}

document.addEventListener("DOMContentLoaded", () => {
    const toggleBtn = document.getElementById("toggleTheme");
  
    toggleBtn.addEventListener("click", () => {
      document.body.classList.toggle("dark");
      toggleBtn.textContent = document.body.classList.contains("dark") ? "🌙" : "☀";
    });
  });

window.onload = loadSubmissions;
