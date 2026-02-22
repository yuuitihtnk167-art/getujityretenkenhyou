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
    uid: "anon",
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

  function currentMonthKey() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  }

  function parseMonthFromDateText(value) {
    const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(value || "").trim());
    if (!match) return "";
    return `${match[1]}-${match[2]}`;
  }

  function normalizeText(value) {
    return String(value ?? "").trim();
  }

  function hashText(value) {
    // FNV-1a 32-bit hash (deterministic, compact id key)
    let hash = 0x811c9dc5;
    const text = String(value ?? "");
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function extractInspectionMonth(entry) {
    const inspectionDate = entry
      && entry.payload
      && entry.payload.current
      && entry.payload.current.inspectionDate;
    return parseMonthFromDateText(inspectionDate) || currentMonthKey();
  }

  function extractBasicInfo(entry) {
    const current = entry && entry.payload && entry.payload.current ? entry.payload.current : {};
    return {
      inspectionDate: normalizeText(current.inspectionDate),
      driverName: normalizeText(current.driverName),
      vehicleNumber: normalizeText(current.vehicleNumber),
      truckType: normalizeText(current.truckType)
    };
  }

  function buildBasicSignature(entry) {
    const basic = extractBasicInfo(entry);
    const inspectionMonth = extractInspectionMonth(entry);
    // Use month-level identity so day changes update the same document.
    const raw = [inspectionMonth, basic.driverName, basic.vehicleNumber, basic.truckType].join("|");
    return hashText(raw);
  }

  function buildDocId(monthKey, basicSignature) {
    const prefix = sanitizeId(state.options.documentPrefix, "monthly_tire");
    const company = sanitizeId(state.options.companyCode, "company");
    const month = sanitizeId(monthKey, currentMonthKey());
    const basic = sanitizeId(basicSignature, "basic");
    // Doc identity is month + basic fields only.
    // UID/device are stored as metadata, not as identity keys.
    return `${prefix}_${company}_${month}_${basic}`.slice(0, 200);
  }

  function getDocInfoForEntry(entry) {
    const month = extractInspectionMonth(entry);
    const uid = state.uid || "anon";
    const deviceId = state.deviceId || getOrCreateDeviceId();
    const basicInfo = extractBasicInfo(entry);
    const basicSignature = buildBasicSignature(entry);
    const docId = buildDocId(month, basicSignature);
    return { month, uid, deviceId, basicInfo, basicSignature, docId };
  }

  function getDocRefForEntry(entry) {
    if (!state.db) return null;
    const docInfo = getDocInfoForEntry(entry);
    return state.db.collection(state.options.collection).doc(docInfo.docId);
  }

  async function ensureFirebaseReady() {
    if (!state.initialized || !state.options || !state.options.enabled) return false;
    if (state.db && state.deviceId) return true;
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

      state.uid = (state.auth.currentUser && state.auth.currentUser.uid) || "anon";
      log("Firebase cloud sync enabled");
      return true;
    })().finally(() => {
      state.readyPromise = null;
    });

    return state.readyPromise;
  }

  function toDocData(entry) {
    const inspectionMonth = extractInspectionMonth(entry);
    const basicInfo = extractBasicInfo(entry);
    const basicSignature = buildBasicSignature(entry);
    return {
      companyCode: state.options.companyCode,
      deviceId: state.deviceId,
      inspectionMonth,
      basicInfo,
      basicSignature,
      lastSource: entry.source,
      clientUpdatedAt: entry.clientUpdatedAt,
      updatedAt: state.firebase.firestore.FieldValue.serverTimestamp(),
      state: entry.payload
    };
  }

  async function writeEntry(entry) {
    const ready = await ensureFirebaseReady();
    const docRef = getDocRefForEntry(entry);
    if (!ready || !docRef) {
      pushPending(entry);
      return { ok: false, reason: "firebase_unready", queued: true };
    }
    try {
      log("Saving document", getDocInfoForEntry(entry));
      await docRef.set(toDocData(entry), { merge: true });
      return { ok: true, reason: "ok", queued: false };
    } catch (error) {
      warn("Firestore write failed, queued locally for retry", error);
      pushPending(entry);
      const offline = typeof navigator !== "undefined" && navigator.onLine === false;
      return { ok: false, reason: offline ? "offline" : "write_failed", queued: true };
    }
  }

  async function flushPending() {
    if (state.flushing) return;
    state.flushing = true;
    try {
      const ready = await ensureFirebaseReady();
      if (!ready) return;
      const queue = getPendingQueue();
      if (!queue.length) return;
      const remain = [];
      for (const item of queue) {
        try {
          const docRef = getDocRefForEntry(item);
          if (!docRef) {
            remain.push(item);
            continue;
          }
          await docRef.set(toDocData(item), { merge: true });
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
    const result = await saveNowDetailed(source);
    return result.ok;
  }

  async function saveNowDetailed(source) {
    if (!state.initialized || !state.options || !state.options.enabled) {
      return { ok: false, reason: "disabled", queued: false };
    }
    if (typeof state.getPayload !== "function") {
      return { ok: false, reason: "payload_missing", queued: false };
    }
    const payload = deepClone(state.getPayload());
    const entry = {
      source: source || "manual",
      clientUpdatedAt: new Date().toISOString(),
      payload
    };
    const result = await writeEntry(entry);
    if (result.ok) void flushPending();
    return result;
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
    saveNowDetailed,
    previewDocInfo: () => {
      if (typeof state.getPayload !== "function") return null;
      const payload = deepClone(state.getPayload());
      const entry = {
        source: "preview",
        clientUpdatedAt: new Date().toISOString(),
        payload
      };
      return getDocInfoForEntry(entry);
    },
    flushNow: () => flushPending(),
    isEnabled: () => Boolean(state.options && state.options.enabled)
  };
})();
