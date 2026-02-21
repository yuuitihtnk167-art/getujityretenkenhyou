// Firebase runtime config
// Fill production values and set enabled=true.
// Keep keys out of index.html by using this file.
(function () {
  "use strict";

  window.APP_FIREBASE_CONFIG = {
    apiKey: "AIzaSyAlpiGkwyoEW8U8X7HpK4XiqfwW8e_YOdQ",
    authDomain: "getujityretenkenhyou.firebaseapp.com",
    projectId: "getujityretenkenhyou",
    appId: "1:818371379903:web:421a1b390e41a48d2cfc0a",
    messagingSenderId: "818371379903",
    storageBucket: "getujityretenkenhyou.firebasestorage.app"
  };

  window.APP_FIREBASE_SYNC_OPTIONS = {
    enabled: true,
    // Firestore collection name
    collection: "monthly_tire_autosave",
    // Prefix for document id
    documentPrefix: "monthly_tire",
    // Company identifier for future access control
    companyCode: "company",
    // Use anonymous auth (no user login UI)
    useAnonymousAuth: true,
    // Retry flush interval (ms)
    autoFlushIntervalMs: 15000
  };
})();
