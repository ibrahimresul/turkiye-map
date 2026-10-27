// Google ile giris + boyamalari Firebase (Firestore) ile hesaba kaydetme
// Yerel kayit (localStorage) tek kaynak olarak kalir; bu dosya onu hesapla esitler.
//   - giris yapinca: bulut + bu cihazdaki (misafir) boyamalar birlestirilir
//   - her degisiklikte: ilgili ulke buluta yazilir (kisa gecikmeyle)
//   - sekmeye donunce: bulut -> yerel guncellenir (baska cihazdaki degisiklikler)
//   - cikis yapinca: bu cihazdaki boyamalar silinir (bulutta kalir)
(function () {
  'use strict';

  const PREFIX = 'harita-boyama:v1:';
  const UID_KEY = PREFIX + 'hesap-uid';
  const SDK = ['app', 'auth', 'firestore'].map((n) => `vendor/firebase/firebase-${n}-compat.js`);
  const $ = (id) => document.getElementById(id);

  const cfg = window.FIREBASE_CONFIG || {};
  const configured = !!(cfg.apiKey && cfg.projectId && cfg.appId);

  const loginBtn = $('loginBtn');
  const logoutBtn = $('logoutBtn');
  const userBox = $('authUser');
  const nameEl = $('authName');
  const imgEl = $('authImg');
  const statusEl = $('syncStatus');
  const deleteBtn = $('deleteAccountBtn');
  if (!loginBtn) return;

  let fb = null, auth = null, db = null, user = null;
  let sdkPromise = null;
  const pending = new Set();
  let timer = null;
  let busy = Promise.resolve();

  // ---------- yerel kayit yardimcilari ----------
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* yoksay */ } };
  const lsDel = (k) => { try { localStorage.removeItem(k); } catch (e) { /* yoksay */ } };
  const slugs = () => (window.HARITA_ULKELER || []).map((c) => c.slug);

  function parse(s) {
    try {
      const o = JSON.parse(s || '{}');
      return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
    } catch (e) { return {}; }
  }
  const readLocal = (slug) => parse(lsGet(PREFIX + slug));
  function writeLocal(slug, obj) {
    if (Object.keys(obj).length) lsSet(PREFIX + slug, JSON.stringify(obj)); else lsDel(PREFIX + slug);
  }
  const same = (a, b) => {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
  };
  const notifyApp = () => window.dispatchEvent(new CustomEvent('harita:uzak-guncelleme'));

  // ---------- arayuz ----------
  let statusTimer = null;
  function setStatus(text, ms) {
    statusEl.textContent = text || '';
    clearTimeout(statusTimer);
    if (text && ms) statusTimer = setTimeout(() => { statusEl.textContent = ''; }, ms);
  }

  function render() {
    loginBtn.hidden = !!user;
    userBox.hidden = !user;
    deleteBtn.hidden = !user;
    if (!user) return;
    nameEl.textContent = user.displayName || user.email || 'Hesap';
    if (user.photoURL && /^https:\/\//.test(user.photoURL)) {
      imgEl.src = user.photoURL;
      imgEl.hidden = false;
    } else {
      imgEl.hidden = true;
    }
  }

  // ---------- SDK ----------
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Yüklenemedi: ' + src));
      document.head.appendChild(s);
    });
  }
  function ensureSdk() {
    if (!sdkPromise) {
      sdkPromise = (async () => {
        if (!window.firebase) for (const src of SDK) await loadScript(src);
        fb = window.firebase;
        if (!fb.apps.length) fb.initializeApp(cfg);
        auth = fb.auth();
        db = fb.firestore();
        auth.onAuthStateChanged(onUser);
      })().catch((e) => { sdkPromise = null; throw e; });
    }
    return sdkPromise;
  }

  // ---------- depolama servisi: Firebase'e yalnizca buradaki fonksiyonlar dokunur ----------
  const docRef = () => db.collection('users').doc(user.uid);
  const store = {
    async read() {
      const snap = await docRef().get();
      return snap.exists ? snap.data() || {} : {};
    },
    // boyama kayitlari: yalnizca verilen ulkeler guncellenir (merge)
    async writeMaps(maps) {
      await docRef().set({ maps, updatedAt: fb.firestore.FieldValue.serverTimestamp() }, { merge: true });
    },
    // profil: createdAt yalnizca daha once yazilmamissa; boyama alanlarina dokunulmaz (merge)
    async writeProfile(u, existing) {
      const ts = fb.firestore.FieldValue.serverTimestamp();
      const data = { email: u.email || null, displayName: u.displayName || null, photoURL: u.photoURL || null, lastLoginAt: ts };
      if (!existing.createdAt) data.createdAt = ts;
      await docRef().set(data, { merge: true });
    },
    async removeAll() {
      await docRef().delete();
    }
  };
  // islemleri sirala: esitleme, yazma ve cekme birbirinin ustune binmesin
  const queue = (fn) => (busy = busy.then(fn, fn));

  // ---------- esitleme ----------
  const mapsOf = (data) => {
    const maps = data.maps || {};
    const out = {};
    slugs().forEach((s) => { if (typeof maps[s] === 'string') out[s] = parse(maps[s]); });
    return out;
  };
  const fetchCloud = async () => mapsOf(await store.read());

  // Oturum basina en fazla bir kez profil yaz (e-posta, ad, foto, lastLoginAt; ilk seferde createdAt)
  let profileUid = null;
  async function saveProfileOnce(data) {
    if (profileUid === user.uid) return;
    await store.writeProfile(user, data);
    profileUid = user.uid;
  }

  // Giriste: bulut + yerel birlesir (cakismada bulut kazanir). Baska hesabin kalintisi atilir.
  async function firstSync() {
    setStatus('Eşitleniyor…');
    const data = await store.read();
    try { await saveProfileOnce(data); } catch (e) { console.error(e); } // profil yazilamazsa boyama esitlemesi yine calissin
    const cloud = mapsOf(data);
    const prev = lsGet(UID_KEY);
    const dropLocal = !!prev && prev !== user.uid;
    const toPush = {};
    let changedLocal = false;
    slugs().forEach((slug) => {
      const local = dropLocal ? {} : readLocal(slug);
      const c = cloud[slug] || {};
      const merged = { ...local, ...c };
      if (!same(merged, readLocal(slug))) { writeLocal(slug, merged); changedLocal = true; }
      if (!same(merged, c)) toPush[slug] = merged;
    });
    lsSet(UID_KEY, user.uid);
    await pushSlugs(Object.keys(toPush));
    if (changedLocal) notifyApp();
    setStatus('Hesaba kayıtlı', 2500);
  }

  async function pushSlugs(list) {
    if (!user || !list.length) return;
    const maps = {};
    list.forEach((slug) => { const o = readLocal(slug); maps[slug] = Object.keys(o).length ? JSON.stringify(o) : ''; });
    await store.writeMaps(maps);
  }

  function schedulePush(slug) {
    if (!user) return;
    pending.add(slug);
    setStatus('Kaydediliyor…');
    clearTimeout(timer);
    timer = setTimeout(flush, 700);
  }
  function flush() {
    clearTimeout(timer);
    if (!pending.size) return queue(() => {});
    const list = [...pending];
    pending.clear();
    return queue(async () => {
      try {
        await pushSlugs(list);
        setStatus('Hesaba kaydedildi', 2000);
      } catch (e) {
        list.forEach((s) => pending.add(s));
        console.error(e);
        setStatus('Kaydedilemedi, tekrar denenecek');
        timer = setTimeout(flush, 8000);
      }
    });
  }

  // Sekmeye donunce: baska cihazdaki degisiklikleri al (bulut kazanir)
  async function pull() {
    if (!user) return;
    await flush();
    await queue(async () => {
      try {
        const cloud = await fetchCloud();
        let changed = false;
        Object.entries(cloud).forEach(([slug, c]) => {
          if (!same(c, readLocal(slug))) { writeLocal(slug, c); changed = true; }
        });
        if (changed) notifyApp();
      } catch (e) { console.error(e); }
    });
  }

  async function onUser(u) {
    user = u || null;
    try { sessionStorage.removeItem('harita-giris'); } catch (e) { /* yoksay */ }
    render();
    if (!user) return;
    queue(async () => {
      try { await firstSync(); } catch (e) {
        console.error(e);
        setStatus('Eşitlenemedi: ' + (e.code === 'permission-denied' ? 'Firestore kuralları' : 'bağlantı'));
      }
    });
  }

  // ---------- giris / cikis ----------
  loginBtn.addEventListener('click', async () => {
    if (!configured) {
      alert('Firebase ayarı yapılmamış. firebase-config.js dosyasını Firebase konsolundaki bilgilerle doldur (adımlar README.md içinde).');
      return;
    }
    loginBtn.disabled = true;
    try {
      await ensureSdk();
      const provider = new fb.auth.GoogleAuthProvider();
      try {
        await auth.signInWithPopup(provider);
      } catch (e) {
        if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') {
          try { sessionStorage.setItem('harita-giris', '1'); } catch (x) { /* yoksay */ }
          await auth.signInWithRedirect(provider);
        } else if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') {
          throw e;
        }
      }
    } catch (e) {
      console.error(e);
      setStatus('');
      alert('Giriş yapılamadı: ' + (e.code || e.message));
    } finally {
      loginBtn.disabled = false;
    }
  });

  logoutBtn.addEventListener('click', async () => {
    await flush();
    await busy;
    try { await auth.signOut(); } catch (e) { console.error(e); return; }
    // ortak bilgisayarda baskasinin gormemesi icin yerel kopya silinir; bulutta durur
    slugs().forEach((s) => lsDel(PREFIX + s));
    lsDel(UID_KEY);
    pending.clear();
    profileUid = null;
    setStatus('');
    notifyApp();
  });

  // ---------- hesabi + verileri silme ----------
  deleteBtn.addEventListener('click', async () => {
    if (!user) return;
    if (!confirm('Hesabın ve buluttaki tüm boyamaların kalıcı olarak silinecek. Bu işlem geri alınamaz. Devam edilsin mi?')) return;
    deleteBtn.disabled = true;
    try {
      await flush();
      await busy;
      const u = auth.currentUser;
      // silme icin yakin zamanda giris gerekir: eskiyse once yeniden dogrula
      const last = Date.parse(u.metadata && u.metadata.lastSignInTime) || 0;
      if (Date.now() - last > 4 * 60 * 1000) await u.reauthenticateWithPopup(new fb.auth.GoogleAuthProvider());
      pending.clear();
      clearTimeout(timer);
      await store.removeAll();
      await u.delete();
      slugs().forEach((s) => lsDel(PREFIX + s));
      lsDel(UID_KEY);
      profileUid = null;
      setStatus('');
      notifyApp();
      alert('Hesabın ve verilerin silindi.');
    } catch (e) {
      console.error(e);
      if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') {
        alert('Hesap silinemedi: ' + (e.code || e.message));
      }
    } finally {
      deleteBtn.disabled = false;
    }
  });

  window.addEventListener('harita:kayit', (e) => schedulePush(e.detail.slug));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pull(); });
  window.addEventListener('pagehide', () => { if (pending.size) flush(); });

  // Daha once giris yapilmissa (veya yonlendirmeyle giris donusuyse) SDK'yi hemen yukle: oturum geri gelir
  const redirecting = () => { try { return sessionStorage.getItem('harita-giris') === '1'; } catch (e) { return false; } };
  if (configured && (lsGet(UID_KEY) || redirecting())) ensureSdk().catch((e) => console.error(e));
})();
