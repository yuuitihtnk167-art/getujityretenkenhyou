// Firestore cloud autosave (additive patch, no UI changes)
(function () {
  "use strict";

  const PENDING_KEY = "tire.monthly.cloud.pending.v1";
  const DEVICE_ID_KEY = "tire.monthly.cloud.device.v1";
  const MAX_PENDING = 200;

  const state = {
    options: null,
    getPayload: null,
    initialized: false,
    firebase: null,
    auth: null,
    db: null,
    docRef: null,
    deviceId: null,
    readyPromise: null,
    flushTimer: null,
    saveTimer: null,
    flushing: false
  };

  function log(message, extra) {
    if (extra === undefined) {
      console.info("[FirebaseCloudSync]", message);
      return;
    }
    console.info("[FirebaseCloudSync]", message, extra);
  }

  function warn(message, extra) {
    if (extra === undefined) {
      console.warn("[FirebaseCloudSync]", message);
      return;
    }
    console.warn("[FirebaseCloudSync]", message, extra);
  }

  function safeReadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function safeWriteJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      warn("Failed to persist local retry queue", error);
    }
  }

  function deepClone(value) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return value;
    }
  }

  function sanitizeId(value, fallback) {
    const text = String(value ?? "").trim();
    const safe = text.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!safe) return fallback;
    return safe.slice(0, 120);
  }

  function getOrCreateDeviceId() {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    const created = (crypto && typeof crypto.randomUUID === "function")
      ? crypto.randomUUID()
      : `dev_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    localStorage.setItem(DEVICE_ID_KEY, created);
    return created;
  }

  function getPendingQueue() {
    const rows = safeReadJson(PENDING_KEY, []);
    return Array.isArray(rows) ? rows : [];
  }

  function setPendingQueue(rows) {
    const normalized = Array.isArray(rows) ? rows.slice(0, MAX_PENDING) : [];
    safeWriteJson(PENDING_KEY, normalized);
  }

  function pushPending(entry) {
    const queue = getPendingQueue();
    queue.push(entry);
    if (queue.length > MAX_PENDING) queue.splice(0, queue.length - MAX_PENDING);
    setPendingQueue(queue);
  }

  function createScript(src) {
    return new Promise((resolve, reject) => {
      const existing = Array.from(document.getElementsByTagName("script"))
        .find((node) => node.src === src);
      if (existing) {
        if (existing.dataset.loaded === "true") {
          resolve();
          return;
        }
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener("error", () => reject(new Error(`Script load failed: ${src}`)), { once: true });
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.defer = true;
      script.addEventListener("load", () => {
        script.dataset.loaded = "true";
        resolve();
      }, { once: true });
      script.addEventListener("error", () => reject(new Error(`Script load failed: ${src}`)), { once: true });
      document.head.appendChild(script);
    });
  }

  async function ensureFirebaseSdk() {
    if (window.firebase && window.firebase.apps) return window.firebase;
    await createScript("https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js");
    await createScript("https://www.gstatic.com/firebasejs/10.12.5/firebase-auth-compat.js");
    await createScript("https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore-compat.js");
    if (!window.firebase || !window.firebase.apps) {
      throw new Error("Failed to load Firebase SDK");
    }
    return window.firebase;
  }

  function buildDocId(uid) {
    const prefix = sanitizeId(state.options.documentPrefix, "monthly_tire");
    const company = sanitizeId(state.options.companyCode, "company");
    const user = sanitizeId(uid, "anon");
    const device = sanitizeId(state.deviceId, "device");
    return `${prefix}_${company}_${user}_${device}`.slice(0, 200);
  }

  async function ensureFirebaseReady() {
    if (!state.initialized || !state.options || !state.options.enabled) return false;
    if (state.docRef) return true;
    if (state.readyPromise) return state.readyPromise;

    state.readyPromise = (async () => {
      const config = window.APP_FIREBASE_CONFIG || {};
      const required = ["apiKey", "authDomain", "projectId", "appId"];
      const missing = required.filter((key) => !String(config[key] || "").trim());
      if (missing.length > 0) {
        warn("Firebase config is missing. Update firebase/firebase-config.js", missing);
        return false;
      }

      state.firebase = await ensureFirebaseSdk();
      if (!state.firebase.apps.length) {
        state.firebase.initializeApp(config);
      }

      state.auth = state.firebase.auth();
      state.db = state.firebase.firestore();
      state.deviceId = getOrCreateDeviceId();

      if (state.options.useAnonymousAuth !== false) {
        try {
          if (!state.auth.currentUser) await state.auth.signInAnonymously();
        } catch (error) {
          warn("Anonymous auth failed. Check Firestore/Auth rules.", error);
        }
      }

      const uid = (state.auth.currentUser && state.auth.currentUser.uid) || "anon";
      const docId = buildDocId(uid);
      state.docRef = state.db.collection(state.options.collection).doc(docId);
      log("Firebase cloud sync enabled");
      return true;
    })().finally(() => {
      state.readyPromise = null;
    });

    return state.readyPromise;
  }

  function toDocData(entry) {
    return {
      companyCode: state.options.companyCode,
      deviceId: state.deviceId,
      lastSource: entry.source,
      clientUpdatedAt: entry.clientUpdatedAt,
      updatedAt: state.firebase.firestore.FieldValue.serverTimestamp(),
      state: entry.payload
    };
  }

  async function writeEntry(entry) {
    const ready = await ensureFirebaseReady();
    if (!ready || !state.docRef) {
      pushPending(entry);
      return false;
    }
    try {
      await state.docRef.set(toDocData(entry), { merge: true });
      return true;
    } catch (error) {
      warn("Firestore write failed, queued locally for retry", error);
      pushPending(entry);
      return false;
    }
  }

  async function flushPending() {
    if (state.flushing) return;
    state.flushing = true;
    try {
      const ready = await ensureFirebaseReady();
      if (!ready || !state.docRef) return;
      const queue = getPendingQueue();
      if (!queue.length) return;
      const remain = [];
      for (const item of queue) {
        try {
          await state.docRef.set(toDocData(item), { merge: true });
        } catch (error) {
          warn("Retry sync failed, entry kept in local queue", error);
          remain.push(item);
        }
      }
      setPendingQueue(remain);
    } finally {
      state.flushing = false;
    }
  }

  function schedule(source) {
    if (!state.initialized || !state.options || !state.options.enabled) return;
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      void saveNow(source || "input");
    }, 700);
  }

  async function saveNow(source) {
    if (!state.initialized || !state.options || !state.options.enabled) return false;
    if (typeof state.getPayload !== "function") return false;
    const payload = deepClone(state.getPayload());
    const entry = {
      source: source || "manual",
      clientUpdatedAt: new Date().toISOString(),
      payload
    };
    const ok = await writeEntry(entry);
    if (ok) void flushPending();
    return ok;
  }

  function bindRetryEvents() {
    window.addEventListener("online", () => {
      void flushPending();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      void flushPending();
    });
  }

  async function init(params) {
    state.options = Object.assign({
      enabled: false,
      collection: "monthly_tire_autosave",
      documentPrefix: "monthly_tire",
      companyCode: "company",
      useAnonymousAuth: true,
      autoFlushIntervalMs: 15000
    }, window.APP_FIREBASE_SYNC_OPTIONS || {});

    state.getPayload = params && typeof params.getPayload === "function" ? params.getPayload : null;
    state.initialized = true;

    if (!state.options.enabled) {
      log("Firebase cloud sync disabled (enabled=false in firebase-config.js)");
      return false;
    }
    if (typeof state.getPayload !== "function") {
      warn("Cloud sync not started: getPayload callback is missing");
      return false;
    }

    bindRetryEvents();
    clearInterval(state.flushTimer);
    state.flushTimer = setInterval(() => {
      void flushPending();
    }, Math.max(5000, Number(state.options.autoFlushIntervalMs) || 15000));

    await ensureFirebaseReady();
    void flushPending();
    return true;
  }

  window.FirebaseCloudSync = {
    init,
    schedule,
    saveNow,
    flushNow: () => flushPending(),
    isEnabled: () => Boolean(state.options && state.options.enabled)
  };
})();
