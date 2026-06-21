const $ = id => document.getElementById(id);
const views = [...document.querySelectorAll('.view')];
let currentJob = null;
let editingIndex = -1;
let pendingPhotos = { label: '', equipment: ['', '', ''] };
let deferredInstall;

const dbPromise = new Promise((resolve, reject) => {
  const request = indexedDB.open('extintores-db', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('jobs', { keyPath: 'id' });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function dbAction(mode, action) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('jobs', mode);
    const store = tx.objectStore('jobs');
    const req = action(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const saveJob = job => dbAction('readwrite', store => store.put(job));
const getJob = id => dbAction('readonly', store => store.get(id));
const getJobs = () => dbAction('readonly', store => store.getAll());
const deleteJob = id => dbAction('readwrite', store => store.delete(id));
const createId = () => globalThis.crypto?.randomUUID?.() || `trabajo-${Date.now()}-${Math.random().toString(16).slice(2)}`;

function showView(id) {
  views.forEach(v => v.classList.toggle('active', v.id === id));
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (id === 'historyView') renderHistory();
}

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2600);
}

function normalizeDate(value) {
  const match = String(value).trim().match(/^(0?[1-9]|1[0-2])[-/. ](\d{2}|\d{4})$/);
  if (!match) return value.trim();
  const year = match[2].length === 2 ? `20${match[2]}` : match[2];
  return `${match[1].padStart(2, '0')}-${year}`;
}

function expiryFrom(value) {
  const match = normalizeDate(value).match(/(\d{4})$/);
  return match ? String(Number(match[1]) + 20) : '';
}

function renderWork() {
  $('workClient').textContent = `${currentJob.client} · ${currentJob.operator}`;
  $('equipmentCount').textContent = currentJob.equipment.length;
  const list = $('equipmentList');
  list.innerHTML = currentJob.equipment.length ? '' : '<div class="empty">Aún no hay extintores.<br>Pulsa “Añadir extintor” para comenzar.</div>';
  currentJob.equipment.forEach((item, index) => {
    const card = document.createElement('article');
    card.className = 'equipment-card';
    card.innerHTML = `<div><strong>SYCo ${escapeHtml(item.syco)}</strong><p>${escapeHtml(item.model)} · Placa ${escapeHtml(item.plate)}</p></div><span class="arrow">›</span>`;
    card.onclick = () => openForm(index);
    list.append(card);
  });
}

function openForm(index = -1) {
  editingIndex = index;
  const item = index >= 0 ? currentJob.equipment[index] : null;
  pendingPhotos = item ? JSON.parse(JSON.stringify(item.photos)) : { label: '', equipment: ['', '', ''] };
  $('formTitle').textContent = item ? `SYCo ${item.syco}` : 'Nuevo extintor';
  $('syco').value = item?.syco || '';
  $('plate').value = item?.plate || '';
  $('model').value = item?.model || '';
  $('manufacture').value = item?.manufacture || '';
  $('retest').value = item?.retest || '';
  $('signal').value = item?.signal || 'S';
  $('obs1').value = item?.observations?.[0] || '';
  $('obs2').value = item?.observations?.[1] || '';
  $('obs3').value = item?.observations?.[2] || '';
  $('deleteEquipment').classList.toggle('hidden', index < 0);
  updateExpiry();
  refreshPhotoPreviews();
  showView('formView');
}

function updateExpiry() {
  $('expiry').textContent = expiryFrom($('manufacture').value) || '—';
}

function refreshPhotoPreviews() {
  setPreview($('labelPhotoPreview'), pendingPhotos.label);
  document.querySelectorAll('.equipment-photo').forEach(input => setPreview(input.nextElementSibling, pendingPhotos.equipment[Number(input.dataset.index)]));
}

function setPreview(element, dataUrl) {
  element.classList.toggle('has-photo', Boolean(dataUrl));
  element.style.backgroundImage = dataUrl ? `url(${dataUrl})` : '';
}

async function compressImage(file) {
  const bitmap = await createImageBitmap(file);
  const max = 1280;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', .72);
}

async function readPhoto(input, setter) {
  const file = input.files?.[0];
  if (!file) return;
  try { setter(await compressImage(file)); refreshPhotoPreviews(); }
  catch { toast('No se pudo procesar esta fotografía'); }
}

function equipmentFromForm() {
  return {
    syco: $('syco').value.trim(), plate: $('plate').value.trim(), model: $('model').value,
    manufacture: normalizeDate($('manufacture').value), retest: normalizeDate($('retest').value || '-'),
    signal: $('signal').value, expiry: expiryFrom($('manufacture').value),
    operation: 'Revisión', efficiency: '',
    observations: [$('obs1').value.trim(), $('obs2').value.trim(), $('obs3').value.trim()],
    photos: pendingPhotos
  };
}

function startRecognition(button, onText) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return toast('El dictado no está disponible en este navegador');
  const recognition = new SpeechRecognition();
  recognition.lang = 'es-ES';
  recognition.interimResults = false;
  button.classList.add('listening');
  recognition.onresult = event => onText(event.results[0][0].transcript);
  recognition.onerror = () => toast('No he podido entender el dictado');
  recognition.onend = () => button.classList.remove('listening');
  recognition.start();
}

function parseDictation(text) {
  const clean = text.replace(/número/gi, '').replace(/guion/gi, '-');
  const take = regex => clean.match(regex)?.[1]?.trim() || '';
  const syco = take(/(?:syco|sico|cico)\s*([\d ]+)/i).replace(/\s/g, '');
  const plate = take(/placa\s*([\d ]+)/i).replace(/\s/g, '');
  const modelRaw = take(/modelo\s*(\d+\s*(?:k|kg|co2))/i).toUpperCase().replace(/\s+/g, ' ');
  const date = take(/fabricaci[oó]n\s*(\d{1,2}[\s/.-]+\d{2,4})/i).replace(/\s+/g, '-');
  const retest = take(/retimbrado\s*(\d{1,2}[\s/.-]+\d{2,4}|sin|ninguno)/i).replace(/\s+/g, '-');
  const signal = take(/señal\s*(sin|caducada|20(?:21|22|23|24|25)|21|22|23|24|25)/i);
  if (syco) $('syco').value = syco;
  if (plate) $('plate').value = plate;
  if (modelRaw) {
    const number = modelRaw.match(/\d+/)?.[0];
    const model = /CO2/.test(modelRaw) ? `CO2 ${number} KG` : `ABC ${number} KG`;
    if ([...$('model').options].some(o => o.value === model)) $('model').value = model;
  }
  if (date) $('manufacture').value = normalizeDate(date);
  if (retest) $('retest').value = /sin|ninguno/i.test(retest) ? '-' : normalizeDate(retest);
  if (signal) $('signal').value = /sin/i.test(signal) ? 'S' : /caducada/i.test(signal) ? 'C' : signal.length === 2 ? `20${signal}` : signal;
  updateExpiry();
  toast('Dictado recibido. Revisa los datos antes de guardar.');
}

function escapeHtml(value='') { return String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function escapeXml(value='') { return String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&apos;','"':'&quot;'}[c])); }

function setCell(xml, ref, value) {
  const cellPattern = new RegExp(`<c\\b([^>]*\\br="${ref}"[^>]*)\\s*\\/>|<c\\b([^>]*\\br="${ref}"[^>]*)>([\\s\\S]*?)<\\/c>`);
  const match = xml.match(cellPattern);
  const style = match ? (match[1] || match[2] || '').match(/\bs="([^"]+)"/)?.[1] : '';
  const cell = `<c r="${ref}"${style ? ` s="${style}"` : ''} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
  if (match) return xml.replace(cellPattern, cell);
  const rowNumber = ref.match(/\d+/)[0];
  const rowPattern = new RegExp(`(<row\\b[^>]*\\br="${rowNumber}"[^>]*>)([\\s\\S]*?)(<\\/row>)`);
  return xml.replace(rowPattern, `$1$2${cell}$3`);
}

async function generateExcel(job) {
  if (!job.equipment.length) return toast('Añade al menos un extintor');
  const { unzipSync, zipSync, strFromU8, strToU8 } = await import('./vendor/fflate.js');
  const response = await fetch('./15.006_I01_Extintores_2023_A4.xlsx');
  const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
  const sheetPath = 'xl/worksheets/sheet1.xml';
  let xml = strFromU8(files[sheetPath]);
  xml = setCell(xml, 'C2', job.client);
  job.equipment.slice(0, 46).forEach((item, index) => {
    const row = 8 + index;
    const observations = item.observations.filter(Boolean).map((x, i) => `${i + 1}. ${x}`).join(' | ');
    const values = { A:item.syco, B:item.plate, C:item.model, D:'', E:item.manufacture, F:item.retest || '-', G:'Revisión', H:item.expiry, AM:observations };
    Object.entries(values).forEach(([column, value]) => { xml = setCell(xml, `${column}${row}`, value); });
  });
  files[sheetPath] = strToU8(xml);
  const output = zipSync(files, { level: 6 });
  const blob = new Blob([output], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const safeClient = job.client.replace(/[^a-záéíóúñ0-9]+/gi, '_').replace(/^_|_$/g, '');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `Extintores_${safeClient || 'cliente'}_${new Date().toISOString().slice(0,10)}.xlsx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('Excel generado correctamente');
}

async function renderHistory() {
  const jobs = (await getJobs()).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
  $('historyCount').textContent = jobs.length;
  const list = $('historyList');
  list.innerHTML = jobs.length ? '' : '<div class="empty">Todavía no hay trabajos guardados.</div>';
  jobs.forEach(job => {
    const card = document.createElement('article');
    card.className = 'equipment-card';
    card.innerHTML = `<div><strong>${escapeHtml(job.client)}</strong><p>${job.equipment.length} extintores · ${new Date(job.updatedAt).toLocaleDateString('es-ES')}</p></div><span class="arrow">›</span>`;
    card.onclick = async () => { currentJob = await getJob(job.id); renderWork(); showView('workView'); };
    list.append(card);
  });
}

$('startBtn').onclick = async () => {
  const client = $('client').value.trim(), operator = $('operator').value.trim();
  if (!client || !operator) return toast('Escribe el cliente y el operario');
  currentJob = { id: createId(), client, operator, createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(), equipment:[] };
  renderWork(); showView('workView');
  try { await saveJob(currentJob); } catch { toast('La revisión ha comenzado, pero el historial no está disponible en este navegador'); }
};
$('addBtn').onclick = () => openForm();
$('manufacture').addEventListener('input', updateExpiry);
$('equipmentForm').onsubmit = async event => {
  event.preventDefault();
  const item = equipmentFromForm();
  if (!item.expiry) return toast('La fecha de fabricación debe ser MM-AAAA');
  if (editingIndex >= 0) currentJob.equipment[editingIndex] = item; else currentJob.equipment.push(item);
  currentJob.updatedAt = new Date().toISOString(); await saveJob(currentJob); renderWork(); showView('workView'); toast('Extintor guardado');
};
$('deleteEquipment').onclick = async () => {
  if (!confirm('¿Eliminar este extintor?')) return;
  currentJob.equipment.splice(editingIndex, 1); currentJob.updatedAt = new Date().toISOString(); await saveJob(currentJob); renderWork(); showView('workView');
};
$('labelPhoto').onchange = event => readPhoto(event.target, data => pendingPhotos.label = data);
document.querySelectorAll('.equipment-photo').forEach(input => input.onchange = event => readPhoto(event.target, data => pendingPhotos.equipment[Number(input.dataset.index)] = data));
$('dictateLabel').onclick = () => startRecognition($('dictateLabel'), parseDictation);
document.querySelectorAll('.observation .mic').forEach(button => button.onclick = () => startRecognition(button, text => { const target=$(button.dataset.target); target.value = target.value ? `${target.value} ${text}` : text; }));
$('downloadBtn').onclick = () => generateExcel(currentJob);
$('finishBtn').onclick = async () => { currentJob.updatedAt = new Date().toISOString(); await saveJob(currentJob); await renderHistory(); showView('homeView'); toast('Trabajo guardado en el historial'); };
$('historyBtn').onclick = () => showView('historyView');
document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => { if (button.dataset.view === 'workView' && currentJob) renderWork(); showView(button.dataset.view); });

window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); deferredInstall = event; $('installBtn').classList.remove('hidden'); });
$('installBtn').onclick = async () => { if (!deferredInstall) return; deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; $('installBtn').classList.add('hidden'); };
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');
renderHistory().catch(() => { $('historyCount').textContent = '—'; });
