const CACHE='extintores-v10';
const ASSETS=['./','./index.html','./styles.css','./photos.css','./app.js','./icon.svg','./manifest.webmanifest','./vendor/fflate.js','./15.006_I01_Extintores_2023_A4.xlsx','./Plantilla_Registros_Fotos.xlsx'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request))));
