const $ = id => document.getElementById(id);
const views = [...document.querySelectorAll('.view')];
let currentJob = null;
let editingIndex = -1;
let pendingPhotos = { label: '', equipment: ['', '', '', ''] };
let currentPhotoType = '';
let photoRecordPhotos = ['', ''];
let photoRecordsCache = [];
let selectedPhotoRecord = null;
let deferredInstall;

const CHATGPT_IMPORT_PROMPT = `Convierte todos los extintores que te he dictado en un JSON válido para mi aplicación. Devuelve exclusivamente el JSON, sin explicaciones y sin bloques Markdown. Debe ser una lista con este formato exacto:
[
  {
    "syco": "579",
    "placa": "6788080",
    "modelo": "6 K",
    "fabricacion": "12-23",
    "retimbrado": "-",
    "senal": "25",
    "defectos": ["Extintor descargado", "Hay un obstáculo"],
    "otraObservacion": "Texto adicional si existe"
  }
]
Usa una entrada por extintor. No inventes datos. Si un dato no fue indicado, déjalo como cadena vacía. Modelos admitidos: 1 K, 2 K, 3 K, 4 K, 5 K, 6 K, 9 K, 2 CO2 y 5 CO2. Para señal usa S, C, 18, 19, 20, 21, 22, 23, 24, 25 o 26. Defectos admitidos: Extintor caducado, Hay un obstáculo, Extintor descargado, Extintor sin presión, Extintor en el suelo y Cristal del extintor ausente o roto.`;

const DEFECTS = [
  'Extintor caducado.', 'Hay un obstáculo.', 'Extintor descargado.',
  'Extintor sin presión.', 'Extintor en el suelo.', 'Cristal del extintor ausente o roto.'
];
const PHOTO_DEFECTS = {
  extinguisher: [...DEFECTS, 'Sin señal.', 'Señal caducada.'],
  bie: ['Manguera rota.', 'Hay un obstáculo.', 'Cristal roto.', 'Manómetro mal.', 'Válvula mal.', 'Lanza mal.', 'Devanadera mal.', 'Sin presión.', 'Sin señal.', 'Señal caducada.']
};
const MONTH_NAMES = {enero:'01',febrero:'02',marzo:'03',abril:'04',mayo:'05',junio:'06',julio:'07',agosto:'08',septiembre:'09',setiembre:'09',octubre:'10',noviembre:'11',diciembre:'12'};

const dbPromise = new Promise((resolve, reject) => {
  const request = indexedDB.open('extintores-db', 2);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains('jobs')) request.result.createObjectStore('jobs', { keyPath: 'id' });
    if (!request.result.objectStoreNames.contains('photoRecords')) request.result.createObjectStore('photoRecords', { keyPath: 'id' });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function dbAction(mode, action, storeName = 'jobs') {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const req = action(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const saveJob = job => dbAction('readwrite', store => store.put(job));
const getJob = id => dbAction('readonly', store => store.get(id));
const getJobs = () => dbAction('readonly', store => store.getAll());
const deleteJob = id => dbAction('readwrite', store => store.delete(id));
const savePhotoRecord = record => dbAction('readwrite', store => store.put(record), 'photoRecords');
const getPhotoRecords = () => dbAction('readonly', store => store.getAll(), 'photoRecords');
const removePhotoRecord = id => dbAction('readwrite', store => store.delete(id), 'photoRecords');
const createId = () => globalThis.crypto?.randomUUID?.() || `trabajo-${Date.now()}-${Math.random().toString(16).slice(2)}`;

function initializeDateSelectors() {
  const monthOptions = Array.from({length:12}, (_, index) => String(index + 1).padStart(2, '0'));
  $('manufactureMonth').innerHTML = '<option value="">Mes</option>' + monthOptions.map(month => `<option>${month}</option>`).join('');
  $('retestMonth').innerHTML = '<option value="-">Sin retimbrado</option>' + monthOptions.map(month => `<option>${month}</option>`).join('');
  const years = Array.from({length:26}, (_, index) => 2001 + index);
  $('manufactureYear').innerHTML = '<option value="">Año</option>' + years.map(year => `<option>${year}</option>`).join('');
  $('retestYear').innerHTML = '<option value="">Año</option>' + years.map(year => `<option>${year}</option>`).join('');
  syncDateFields();
}

function syncDateFields() {
  $('manufacture').value = $('manufactureMonth').value && $('manufactureYear').value ? `${$('manufactureMonth').value}-${$('manufactureYear').value}` : '';
  const noRetest = $('retestMonth').value === '-';
  $('retestYear').disabled = noRetest;
  $('retest').value = noRetest ? '-' : ($('retestMonth').value && $('retestYear').value ? `${$('retestMonth').value}-${$('retestYear').value}` : '');
  updateExpiry();
}

function setDateSelectors(prefix, value) {
  const normalized = normalizeDate(value || '');
  if (prefix === 'retest' && (!normalized || normalized === '-')) {
    $('retestMonth').value = '-'; $('retestYear').value = ''; syncDateFields(); return;
  }
  const match = normalized.match(/^(\d{2})-(\d{4})$/);
  $(`${prefix}Month`).value = match?.[1] || '';
  $(`${prefix}Year`).value = match?.[2] || '';
  syncDateFields();
}

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

function normalizeKey(value) {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function fieldFrom(record, ...aliases) {
  const fields = new Map(Object.entries(record || {}).map(([key, value]) => [normalizeKey(key), value]));
  for (const alias of aliases) if (fields.has(normalizeKey(alias))) return fields.get(normalizeKey(alias));
  return '';
}

function normalizeImportedModel(value) {
  const raw = String(value || '').toUpperCase().replace(/,/g, '.').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  if (/^(ABC\s*)?\d+\s*K(G)?$/.test(raw)) return `ABC ${raw.match(/\d+/)[0]} KG`;
  if (/^(CO2\s*)?\d+\s*CO2(\s*KG)?$/.test(raw)) return `CO2 ${raw.match(/\d+/)[0]} KG`;
  if (/^CO2\s*\d+\s*KG$/.test(raw) || /^ABC\s*\d+\s*KG$/.test(raw)) return raw.replace(/\s+/g, ' ');
  return raw;
}

function normalizeImportedSignal(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 's' || raw.includes('sin señal') || raw.includes('sin senal')) return 'S';
  if (raw === 'c' || raw.includes('caducada')) return 'C';
  const year = raw.match(/20(18|19|20|21|22|23|24|25|26)|\b(18|19|20|21|22|23|24|25|26)\b/);
  return year ? (year[0].length === 2 ? `20${year[0]}` : year[0]) : 'S';
}

function matchDefect(value) {
  const key = normalizeKey(value);
  if (key.includes('caducad')) return DEFECTS[0];
  if (key.includes('obstaculo')) return DEFECTS[1];
  if (key.includes('descargad')) return DEFECTS[2];
  if (key.includes('sinpresion')) return DEFECTS[3];
  if (key.includes('suelo')) return DEFECTS[4];
  if (key.includes('cristal') && (key.includes('roto') || key.includes('ausente') || key.includes('sincristal'))) return DEFECTS[5];
  return '';
}

function importedEquipment(record) {
  const manufacture = normalizeDate(fieldFrom(record, 'fabricacion', 'fabrica', 'fecha fabricacion'));
  const defectValue = fieldFrom(record, 'defectos');
  const rawDefects = Array.isArray(defectValue) ? defectValue : defectValue ? [defectValue] : [];
  const observationValue = fieldFrom(record, 'otraObservacion', 'observacion', 'observaciones');
  const observationItems = Array.isArray(observationValue) ? observationValue : observationValue ? [observationValue] : [];
  const defects = [...new Set([...rawDefects, ...observationItems].map(matchDefect).filter(Boolean))];
  const otherObservation = Array.isArray(observationValue) ? observationValue.filter(value => !matchDefect(value)).join(' ') : String(observationValue || '').trim();
  return {
    syco: String(fieldFrom(record, 'syco', 'numero syco', 'num') || '').replace(/^syco\s*/i, '').trim(),
    plate: String(fieldFrom(record, 'placa', 'numero placa', 'n placa') || '').trim(),
    model: normalizeImportedModel(fieldFrom(record, 'modelo', 'model')),
    manufacture,
    retest: normalizeDate(fieldFrom(record, 'retimbrado', 'retimbre') || '-'),
    signal: normalizeImportedSignal(fieldFrom(record, 'senal', 'señal')),
    expiry: expiryFrom(manufacture), operation: 'Revisión', efficiency: '', defects, otherObservation,
    observations: otherObservation ? [otherObservation] : [],
    photos: { label: '', equipment: ['', '', '', ''] }
  };
}

function parseChatGPTImport(text) {
  const clean = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (!clean) throw new Error('Pega primero el resultado de ChatGPT');
  const parsed = JSON.parse(clean);
  const records = Array.isArray(parsed) ? parsed : Array.isArray(parsed.extintores) ? parsed.extintores : [parsed];
  if (!records.length) throw new Error('No hay extintores en el texto');
  return records.map(importedEquipment);
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
    const incomplete = !item.syco || !item.plate || !item.model || !item.expiry;
    card.innerHTML = `<div><strong>SYCo ${escapeHtml(item.syco || 'sin número')}</strong><p>${escapeHtml(item.model || 'Modelo pendiente')} · Placa ${escapeHtml(item.plate || 'pendiente')}${incomplete ? ' · Revisar datos' : ''}</p></div><span class="arrow">›</span>`;
    card.onclick = () => openForm(index);
    list.append(card);
  });
}

function openForm(index = -1) {
  editingIndex = index;
  const item = index >= 0 ? currentJob.equipment[index] : null;
  pendingPhotos = item ? JSON.parse(JSON.stringify(item.photos || { label:'', equipment:[] })) : { label: '', equipment: ['', '', '', ''] };
  pendingPhotos.equipment = [...(pendingPhotos.equipment || []), '', '', '', ''].slice(0, 4);
  $('formTitle').textContent = item ? `SYCo ${item.syco}` : 'Nuevo extintor';
  $('syco').value = item?.syco || '';
  $('plate').value = item?.plate || '';
  $('model').value = item?.model || '';
  setDateSelectors('manufacture', item?.manufacture || '');
  setDateSelectors('retest', item?.retest || '-');
  $('signal').value = item?.signal || 'S';
  const savedDefects = item?.defects || (item?.observations || []).map(matchDefect).filter(Boolean);
  document.querySelectorAll('input[name="defect"]').forEach(input => input.checked = savedDefects.includes(input.value));
  $('otherObservation').value = item?.otherObservation || (item?.observations || []).filter(value => !matchDefect(value)).join(' ') || '';
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

function openPhotoForm(type) {
  currentPhotoType = type;
  photoRecordPhotos = ['', ''];
  $('photoFormTitle').textContent = type === 'bie' ? 'BIE' : 'Extintor';
  $('photoRecordForm').reset();
  $('photoDefectList').innerHTML = PHOTO_DEFECTS[type].map(defect => `<label><input type="checkbox" name="photoDefect" value="${escapeHtml(defect)}"><span>${escapeHtml(defect.replace(/\.$/, ''))}</span></label>`).join('');
  document.querySelectorAll('.record-photo-input').forEach(input => { input.value = ''; });
  refreshRecordPhotoPreviews();
  showView('photoFormView');
}

async function openPhotoRecords() {
  $('photoRecordsTitle').textContent = currentPhotoType === 'bie' ? 'BIE' : 'Extintores';
  $('photoNumberFilter').value = '';
  try {
    photoRecordsCache = (await getPhotoRecords())
      .filter(record => record.type === currentPhotoType)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    renderPhotoRecords();
    showView('photoRecordsView');
  } catch { toast('No se pudieron leer los registros guardados'); }
}

function renderPhotoRecords() {
  const query = $('photoNumberFilter').value.trim().toLowerCase();
  const records = photoRecordsCache.filter(record => String(record.number || '').toLowerCase().includes(query));
  $('photoRecordsCount').textContent = `${records.length} registro${records.length === 1 ? '' : 's'}`;
  $('photoRecordsEmpty').classList.toggle('hidden', records.length > 0);
  $('photoRecordsBody').innerHTML = records.map(record => {
    const defects = (record.defects || []).map(escapeHtml).join('<br>') || '—';
    const photos = (record.photos || []).filter(Boolean).length;
    const date = record.createdAt ? new Date(record.createdAt).toLocaleDateString('es-ES') : '—';
    return `<tr><td>${escapeHtml(record.building)}</td><td><strong>${escapeHtml(record.number)}</strong></td><td>${escapeHtml(record.other1 || '—')}</td><td>${escapeHtml(record.other2 || '—')}</td><td>${defects}</td><td>${photos}</td><td>${date}</td><td><button type="button" class="view-record" data-record-id="${escapeHtml(record.id)}">Ver</button></td></tr>`;
  }).join('');
}

function openPhotoRecordDetail(id) {
  const record = photoRecordsCache.find(item => item.id === id);
  if (!record) return toast('No se ha encontrado este registro');
  selectedPhotoRecord = record;
  $('photoDetailType').textContent = record.type === 'bie' ? 'REGISTRO BIE' : 'REGISTRO EXTINTOR';
  $('photoDetailTitle').textContent = `${record.type === 'bie' ? 'BIE' : 'Extintor'} ${record.number}`;
  $('photoDetailBuilding').textContent = record.building || '—';
  $('photoDetailNumber').textContent = record.number || '—';
  $('photoDetailOther1').textContent = record.other1 || '—';
  $('photoDetailOther2').textContent = record.other2 || '—';
  $('photoDetailDate').textContent = record.createdAt ? new Date(record.createdAt).toLocaleString('es-ES') : '—';
  $('photoDetailDefects').innerHTML = (record.defects || []).length ? record.defects.map(defect => `<li>${escapeHtml(defect)}</li>`).join('') : '<li>Sin defectos marcados</li>';
  renderDetailPhotos();
  showView('photoRecordDetailView');
}

function renderDetailPhotos() {
  const container = $('photoDetailImages');
  container.innerHTML = '';
  const photos = [...(selectedPhotoRecord?.photos || []), '', ''].slice(0, 2);
  photos.forEach((photo, index) => {
    const slot = document.createElement('div');
    slot.className = 'detail-photo-slot';
    if (photo) {
      const image = document.createElement('img');
      image.src = photo; image.alt = `Foto ${index + 1} del registro`;
      slot.append(image);
    } else {
      const empty = document.createElement('div');
      empty.className = 'empty-photo'; empty.textContent = `Foto ${index + 1} sin cargar`;
      slot.append(empty);
    }
    const changeLabel = document.createElement('label');
    changeLabel.className = 'replace-photo';
    changeLabel.textContent = photo ? 'Cambiar foto' : 'Añadir foto';
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*'; input.setAttribute('capture', 'environment');
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try { await updateDetailPhoto(index, await compressImage(file)); toast(`Foto ${index + 1} guardada`); }
      catch { toast('No se pudo guardar esta fotografía'); }
    };
    changeLabel.append(input); slot.append(changeLabel);
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'delete-photo'; remove.textContent = 'Eliminar foto'; remove.disabled = !photo;
    remove.onclick = async () => {
      if (!confirm(`¿Eliminar la foto ${index + 1} de este registro?`)) return;
      try { await updateDetailPhoto(index, ''); toast(`Foto ${index + 1} eliminada`); }
      catch { toast('No se pudo eliminar esta fotografía'); }
    };
    slot.append(remove); container.append(slot);
  });
}

async function updateDetailPhoto(index, value) {
  if (!selectedPhotoRecord) throw new Error('Registro no seleccionado');
  const previous = [...(selectedPhotoRecord.photos || [])];
  const updated = [...previous, '', ''].slice(0, 2);
  updated[index] = value;
  selectedPhotoRecord.photos = updated;
  try {
    await savePhotoRecord(selectedPhotoRecord);
    photoRecordsCache = photoRecordsCache.map(record => record.id === selectedPhotoRecord.id ? selectedPhotoRecord : record);
    renderPhotoRecords();
    renderDetailPhotos();
  } catch (error) { selectedPhotoRecord.photos = previous; throw error; }
}

function refreshRecordPhotoPreviews() {
  photoRecordPhotos.forEach((photo, index) => {
    setPreview($(`photoRecordPreview${index}`), photo);
    $(`deleteRecordPhoto${index}`).disabled = !photo;
  });
}

async function readRecordPhoto(input) {
  const file = input.files?.[0];
  if (!file) return;
  try {
    photoRecordPhotos[Number(input.dataset.index)] = await compressImage(file);
    refreshRecordPhotoPreviews();
  } catch { toast('No se pudo procesar esta fotografía'); }
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
  const defects = [...document.querySelectorAll('input[name="defect"]:checked')].map(input => input.value);
  const otherObservation = $('otherObservation').value.trim();
  return {
    syco: $('syco').value.trim(), plate: $('plate').value.trim(), model: $('model').value,
    manufacture: normalizeDate($('manufacture').value), retest: normalizeDate($('retest').value || '-'),
    signal: $('signal').value, expiry: expiryFrom($('manufacture').value),
    operation: 'Revisión', efficiency: '', defects, otherObservation,
    observations: otherObservation ? [otherObservation] : [],
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

function spokenDate(text, label) {
  const numeric = text.match(new RegExp(`${label}\\s*(\\d{1,2})[\\s/.-]+(\\d{2,4})`, 'i'));
  if (numeric) return normalizeDate(`${numeric[1]}-${numeric[2]}`);
  const names = Object.keys(MONTH_NAMES).join('|');
  const named = text.toLowerCase().match(new RegExp(`${label}\\s*(?:en\\s+)?(${names})(?:\\s+de)?\\s+(20\\d{2})`, 'i'));
  return named ? `${MONTH_NAMES[named[1].toLowerCase()]}-${named[2]}` : '';
}

function parseDictation(text) {
  const clean = text.replace(/número/gi, '').replace(/guion/gi, '-');
  const take = regex => clean.match(regex)?.[1]?.trim() || '';
  const syco = take(/(?:syco|sico|cico)\s*([\d ]+)/i).replace(/\s/g, '');
  const plate = take(/placa\s*([\d ]+)/i).replace(/\s/g, '');
  const modelRaw = take(/modelo\s*(\d+\s*(?:kilos?|kg|k|co2))/i).toUpperCase().replace(/\s+/g, ' ');
  const date = spokenDate(clean, 'fabricaci[oó]n');
  const retest = spokenDate(clean, 'retimbrado');
  const noRetest = /(?:sin|ning[uú]n)\s+retimbrado|retimbrado\s+(?:sin|ninguno)/i.test(clean);
  const signal = take(/señal\s*(sin|caducada|20(?:18|19|20|21|22|23|24|25|26)|18|19|20|21|22|23|24|25|26)/i);
  if (syco) $('syco').value = syco;
  if (plate) $('plate').value = plate;
  if (modelRaw) {
    const number = modelRaw.match(/\d+/)?.[0];
    const model = /CO2/.test(modelRaw) ? `CO2 ${number} KG` : `ABC ${number} KG`;
    if ([...$('model').options].some(o => o.value === model)) $('model').value = model;
  }
  if (date) setDateSelectors('manufacture', date);
  if (noRetest) setDateSelectors('retest', '-'); else if (retest) setDateSelectors('retest', retest);
  if (signal) $('signal').value = /sin/i.test(signal) ? 'S' : /caducada/i.test(signal) ? 'C' : signal.length === 2 ? `20${signal}` : signal;
  if (/caducad/i.test(clean)) document.querySelector('input[name="defect"][value="Extintor caducado."]').checked = true;
  if (/obst[aá]culo/i.test(clean)) document.querySelector('input[name="defect"][value="Hay un obstáculo."]').checked = true;
  if (/descargad/i.test(clean)) document.querySelector('input[name="defect"][value="Extintor descargado."]').checked = true;
  if (/sin presi[oó]n/i.test(clean)) document.querySelector('input[name="defect"][value="Extintor sin presión."]').checked = true;
  if (/en el suelo/i.test(clean)) document.querySelector('input[name="defect"][value="Extintor en el suelo."]').checked = true;
  if (/(?:sin cristal|cristal.*roto|cristal.*ausente)/i.test(clean)) document.querySelector('input[name="defect"][value="Cristal del extintor ausente o roto."]').checked = true;
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

function excelColumn(index) {
  let result = '', value = index + 1;
  while (value > 0) { value--; result = String.fromCharCode(65 + (value % 26)) + result; value = Math.floor(value / 26); }
  return result;
}

function xlsxInlineCell(ref, value, style, prefix = '') {
  return `<${prefix}c r="${ref}"${style ? ` s="${style}"` : ''} t="inlineStr"><${prefix}is><${prefix}t xml:space="preserve">${escapeXml(value)}</${prefix}t></${prefix}is></${prefix}c>`;
}

async function generatePhotoRecordsExcel() {
  if (!photoRecordsCache.length) return toast('No hay registros para descargar');
  try {
    const { unzipSync, zipSync, strFromU8, strToU8 } = await import('./vendor/fflate.js');
    const response = await fetch('./Plantilla_Registros_Fotos.xlsx');
    if (!response.ok) throw new Error('No se encontró la plantilla Excel');
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
    const sheetPath = 'xl/worksheets/sheet1.xml';
    let xml = strFromU8(files[sheetPath]);
    const prefix = xml.includes('<x:worksheet') ? 'x:' : '';
    const cellTag = ref => xml.match(new RegExp(`<(?:x:)?c\\b[^>]*\\br="${ref}"[^>]*>`))?.[0] || '';
    const styleOf = ref => cellTag(ref).match(/\bs="([^"]+)"/)?.[1] || '';
    const headerStyle = styleOf('A1'), dataStyle = styleOf('A2');
    const defects = PHOTO_DEFECTS[currentPhotoType];
    const headers = ['Fecha', 'Edificio', 'Número', 'Otro 1', 'Otro 2', ...defects.map(defect => defect.replace(/\.$/, '')), 'Foto 1', 'Foto 2'];
    const rows = [headers, ...photoRecordsCache.map(record => [
      record.createdAt ? new Date(record.createdAt).toLocaleString('es-ES') : '',
      record.building || '', record.number || '', record.other1 || '', record.other2 || '',
      ...defects.map(defect => (record.defects || []).includes(defect) ? 'X' : ''),
      record.photos?.[0] ? 'Sí' : 'No', record.photos?.[1] ? 'Sí' : 'No'
    ])];
    const sheetData = rows.map((row, rowIndex) => {
      const rowNumber = rowIndex + 1, style = rowIndex === 0 ? headerStyle : dataStyle;
      const cells = row.map((value, columnIndex) => xlsxInlineCell(`${excelColumn(columnIndex)}${rowNumber}`, value, style, prefix)).join('');
      return `<${prefix}row r="${rowNumber}"${rowIndex === 0 ? ' ht="34" customHeight="1"' : ''}>${cells}</${prefix}row>`;
    }).join('');
    xml = xml.replace(/<(?:x:)?sheetData>[\s\S]*?<\/(?:x:)?sheetData>/, `<${prefix}sheetData>${sheetData}</${prefix}sheetData>`);
    const lastColumn = excelColumn(headers.length - 1), lastRow = rows.length;
    xml = xml.replace(/<(?:x:)?dimension ref="[^"]+"\s*\/>/, `<${prefix}dimension ref="A1:${lastColumn}${lastRow}"/>`);
    xml = xml.replace(/<(?:x:)?autoFilter ref="[^"]+"\s*\/>/g, '');
    xml = xml.replace(`</${prefix}worksheet>`, `<${prefix}autoFilter ref="A1:${lastColumn}${lastRow}"/></${prefix}worksheet>`);
    files[sheetPath] = strToU8(xml);
    const blob = new Blob([zipSync(files, { level: 6 })], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const typeName = currentPhotoType === 'bie' ? 'BIE' : 'Extintores';
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `Registros_${typeName}_${new Date().toISOString().slice(0,10)}.xlsx`;
    link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 2000);
    toast(`Excel de ${typeName} generado`);
  } catch (error) { toast(error.message || 'No se pudo generar el Excel'); }
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
    const observations = [...new Set([...(item.defects || []), item.otherObservation || '', ...(item.observations || []).filter(value => !matchDefect(value))].filter(Boolean))].join('\n');
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
$('photosBtn').onclick = () => showView('photoTypesView');
$('photoExtinguisherBtn').onclick = () => openPhotoForm('extinguisher');
$('photoBieBtn').onclick = () => openPhotoForm('bie');
$('viewPhotoRecords').onclick = openPhotoRecords;
$('photoNumberFilter').addEventListener('input', renderPhotoRecords);
$('downloadPhotoRecordsExcel').onclick = generatePhotoRecordsExcel;
$('photoRecordsBody').onclick = event => {
  const button = event.target.closest('.view-record');
  if (button) openPhotoRecordDetail(button.dataset.recordId);
};
$('deletePhotoRecord').onclick = async () => {
  if (!selectedPhotoRecord) return;
  const label = `${selectedPhotoRecord.type === 'bie' ? 'BIE' : 'extintor'} ${selectedPhotoRecord.number}`;
  if (!confirm(`¿Eliminar definitivamente el registro de ${label}? También se borrarán sus fotografías.`)) return;
  try {
    await removePhotoRecord(selectedPhotoRecord.id);
    photoRecordsCache = photoRecordsCache.filter(record => record.id !== selectedPhotoRecord.id);
    selectedPhotoRecord = null;
    renderPhotoRecords(); showView('photoRecordsView');
    toast('Registro eliminado');
  } catch { toast('No se pudo eliminar el registro'); }
};
document.querySelectorAll('.record-photo-input').forEach(input => input.onchange = event => readRecordPhoto(event.target));
[0, 1].forEach(index => {
  $(`deleteRecordPhoto${index}`).onclick = () => {
    photoRecordPhotos[index] = '';
    $(`photoRecordFile${index}`).value = '';
    refreshRecordPhotoPreviews();
    toast(`Foto ${index + 1} eliminada`);
  };
});
$('photoRecordForm').onsubmit = async event => {
  event.preventDefault();
  const record = {
    id: createId(), type: currentPhotoType,
    building: $('photoBuilding').value.trim(), number: $('photoNumber').value.trim(),
    other1: $('photoOther1').value.trim(), other2: $('photoOther2').value.trim(),
    defects: [...document.querySelectorAll('input[name="photoDefect"]:checked')].map(input => input.value),
    photos: [...photoRecordPhotos], createdAt: new Date().toISOString()
  };
  try {
    await savePhotoRecord(record);
    showView('photoTypesView');
    toast(`Ficha de ${currentPhotoType === 'bie' ? 'BIE' : 'extintor'} guardada en el móvil`);
  } catch { toast('No se pudo guardar la ficha en este dispositivo'); }
};
$('addBtn').onclick = () => openForm();
$('importBtn').onclick = () => { $('importText').value = ''; showView('importView'); };
$('copyImportPrompt').onclick = async () => {
  try { await navigator.clipboard.writeText(CHATGPT_IMPORT_PROMPT); toast('Instrucciones copiadas. Pégalas en ChatGPT.'); }
  catch { $('importText').value = CHATGPT_IMPORT_PROMPT; $('importText').select(); toast('Copia el texto seleccionado y pégalo en ChatGPT'); }
};
$('processImport').onclick = async () => {
  try {
    const imported = parseChatGPTImport($('importText').value);
    const available = Math.max(0, 46 - currentJob.equipment.length);
    if (!available) return toast('La plantilla ya tiene el máximo de 46 extintores');
    const accepted = imported.slice(0, available);
    currentJob.equipment.push(...accepted);
    currentJob.updatedAt = new Date().toISOString();
    try { await saveJob(currentJob); } catch {}
    renderWork(); showView('workView');
    toast(`${accepted.length} extintor${accepted.length === 1 ? '' : 'es'} importado${accepted.length === 1 ? '' : 's'}. Revisa los datos.`);
  } catch (error) { toast(error instanceof SyntaxError ? 'El formato no es válido. Pide a ChatGPT que devuelva solamente el JSON.' : error.message); }
};
['manufactureMonth','manufactureYear','retestMonth','retestYear'].forEach(id => $(id).addEventListener('change', syncDateFields));
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
$('dictatePlate').onclick = () => startRecognition($('dictatePlate'), text => {
  const digits = text.replace(/\D/g, '');
  if (!digits) return toast('No he entendido el número de placa');
  $('plate').value = digits; toast('Número de placa recibido');
});
document.querySelectorAll('.observation .mic').forEach(button => button.onclick = () => startRecognition(button, text => { const target=$(button.dataset.target); target.value = target.value ? `${target.value} ${text}` : text; }));
$('downloadBtn').onclick = () => generateExcel(currentJob);
$('finishBtn').onclick = async () => { currentJob.updatedAt = new Date().toISOString(); await saveJob(currentJob); await renderHistory(); showView('homeView'); toast('Trabajo guardado en el historial'); };
$('historyBtn').onclick = () => showView('historyView');
document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => { if (button.dataset.view === 'workView' && currentJob) renderWork(); showView(button.dataset.view); });

window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); deferredInstall = event; $('installBtn').classList.remove('hidden'); });
$('installBtn').onclick = async () => { if (!deferredInstall) return; deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; $('installBtn').classList.add('hidden'); };
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');
initializeDateSelectors();
renderHistory().catch(() => { $('historyCount').textContent = '—'; });
