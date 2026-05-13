/**
 * app.js — Bridge JS pour liturgical-calendar-wasm v5.
 *
 * Pattern de lecture v5 (2 appels au lieu de 1) :
 *   kal_wasm_read_day(year, doy)         → TimelineEntry dans ENTRY_BUF
 *   kal_wasm_read_feast(primaryIndex)    → FeastEntry dans FEAST_BUF (O(1))
 *
 * Les flags (couleur, nature, précédence) viennent de FeastEntry.flags.
 * Les bits d'occurrence (vesperae_i, vigilia) viennent de TimelineEntry.occurrence_flags.
 *
 * Routes :
 *   /YYYY         → vue annuelle (tableau 366 jours)
 *   /YYYY/MM/DD   → vue journalière (détail complet)
 *   /             → vue journalière, date du jour
 *
 * Compatibilité GitHub Pages : le path est restauré par index.html
 * (sessionStorage redirect depuis 404.html) avant l'exécution de ce module.
 */

const WASM_URL = 'liturgical_calendar_wasm.wasm'
const KALD_URL = 'calendar.kald'
const LITS_URL = 'calendar.lits'

const KAL_ENGINE_OK = 0
const KAL_ERR_BUILD_ID_MISMATCH = -22

// Base path résolu depuis <base href> — patché par index.html sur GitHub Pages projet.
// Vaut '/' dans tous les autres environnements.
const BASE_PATH = `/app/liturgical-calendar/`

// ── Lookup tables (miroir de types.rs) ───────────────────────────────────────

const PRECEDENCE = [
  'Triduum Sacrum',
  'Sollemnitates Maiores',
  'Sollemnitates Generales',
  'Sollemnitates Propria',
  'Festa Domini',
  'Dominicae per Annum',
  'Festa BMV et Sanctorum Generales',
  'Festa Propria',
  'Feriae Privilegiatae',
  'Memoriae Obligatoriae Generales',
  'Memoriae Obligatoriae Propria',
  'Memoriae ad Libitum',
  'Feriae per Annum',
]
const COLOR = ['Albus', 'Rubeus', 'Viridis', 'Violaceus', 'Rosaceus', 'Niger']
const COLOR_CSS = ['albus', 'rubeus', 'viridis', 'violaceus', 'rosaceus', 'niger']
const NATURE = ['Sollemnitas', 'Festum', 'Dominica', 'Memoria', 'Commemoratio', 'Feria']
const PERIOD = [
  'Tempus Ordinarium',
  'Tempus Adventus',
  'Tempus Nativitatis',
  'Tempus Quadragesimae',
  'Triduum Paschale',
  'Tempus Paschale',
  'Dies Sancti',
]

// ── Layout 366 slots/an (Forge) ───────────────────────────────────────────────

const MONTH_OFFSETS = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335]

function dateToDoy(_year, month, day) {
  return MONTH_OFFSETS[month - 1] + (day - 1)
}
function doyToMonthDay(doy) {
  for (let m = 11; m >= 0; m--) {
    if (doy >= MONTH_OFFSETS[m]) return { month: m + 1, day: doy - MONTH_OFFSETS[m] + 1 }
  }
  return { month: 1, day: 1 }
}
function zeroPad(n) {
  return String(n).padStart(2, '0')
}
function formatDateLong(year, month, day) {
  return new Date(year, month - 1, day).toLocaleDateString('fr-FR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
}

// ── Routage ───────────────────────────────────────────────────────────────────

/** Vérifie qu'une date grégorienne existe (gère les années bissextiles). */
function isValidDate(year, month, day) {
  const d = new Date(year, month - 1, day)
  return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day
}

function detectRoute() {
  let raw = window.location.pathname
  if (raw.startsWith(BASE_PATH)) raw = raw.slice(BASE_PATH.length)
  raw = raw.replace(/\/$/, '')

  // Racine → date du jour
  if (raw === '') {
    const now = new Date()
    return { type: 'day', year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() }
  }

  const mYear = raw.match(/^(\d{4})$/)
  if (mYear) {
    const year = parseInt(mYear[1])
    if (year < 1970 || year > 2399) return { type: 'not-found' }
    return { type: 'year', year }
  }

  const mDay = raw.match(/^(\d{4})\/(\d{2})\/(\d{2})$/)
  if (mDay) {
    const year = parseInt(mDay[1])
    const month = parseInt(mDay[2])
    const day = parseInt(mDay[3])
    if (!isValidDate(year, month, day)) return { type: 'not-found' }
    return { type: 'day', year, month, day }
  }

  return { type: 'not-found' }
}

// ── Utilitaires WASM ──────────────────────────────────────────────────────────

function copyToWasm(memory, ptr, buffer) {
  new Uint8Array(memory.buffer, ptr, buffer.byteLength).set(new Uint8Array(buffer))
}
const decoder = new TextDecoder('utf-8')
function wasmStr(memory, ptr, len) {
  return decoder.decode(new Uint8Array(memory.buffer, ptr, len))
}

/**
 * Décode FeastEntry.flags (u16 LE à l'offset 2 de FEAST_BUF).
 *
 * Bits [3:0]   → Precedence
 * Bits [7:4]   → Color
 * Bits [10:8]  → LiturgicalPeriod
 * Bits [13:11] → Nature
 * Bit  [14]    → has_vigil_mass (invariant corpus)
 */
function decodeFeastFlags(flags) {
  return {
    precedence: flags & 0x000f,
    color: (flags >> 4) & 0x000f,
    period: (flags >> 8) & 0x0007,
    nature: (flags >> 11) & 0x0007,
    hasVigil: !!(flags & (1 << 14)),
  }
}

/**
 * Décode TimelineEntry.occurrence_flags (u8 à l'offset 4 de ENTRY_BUF).
 *
 * Bit 0 → has_vesperae_i (Premières Vêpres ce soir)
 * Bit 1 → has_vigilia    (Messe de Vigile ce soir)
 */
function decodeOccurrenceFlags(occFlags) {
  return {
    hasVesperaeI: !!(occFlags & 0b01),
    hasVigilia: !!(occFlags & 0b10),
  }
}

/** Rendu minimal Markdown inline : *texte* → <em>texte</em>. */
function renderMarkdown(text) {
  return text.replace(/\*([^*]+)\*/g, '<em>$1</em>')
}

/**
 * Résout label + annotation pour un feast_id.
 * Retourne { label, annotation } ou null.
 */
function resolveById(exports, memory, feastId, year) {
  if (exports.kal_wasm_get_label_by_id(feastId, year) !== 1) return null
  const label = wasmStr(memory, exports.kal_wasm_label_ptr(), exports.kal_wasm_label_len())
  const annLen = exports.kal_wasm_annotation_len()
  const annotation = annLen > 0 ? wasmStr(memory, exports.kal_wasm_annotation_ptr(), annLen) : null
  return { label, annotation }
}

/**
 * Résout label, annotation ET flags d'un feast secondaire via son registry_index.
 *
 * Pattern v5 O(1) : registry_index → kal_wasm_read_feast → FeastEntry.feast_id
 * → kal_wasm_get_label_by_id. Remplace le scan linéaire O(366) de la v4.
 *
 * Retourne { label, annotation, feastFlags } ou null.
 */
function resolveSecondary(exports, memory, registryIndex, year) {
  if (exports.kal_wasm_read_feast(registryIndex) !== KAL_ENGINE_OK) return null

  const fv = new DataView(memory.buffer, exports.kal_wasm_feast_ptr(), 4)
  const feastId = fv.getUint16(0, true)
  const feastFlags = fv.getUint16(2, true)

  const res = resolveById(exports, memory, feastId, year)
  if (!res) return null

  return { ...res, feastFlags }
}

// ── Vue annuelle ──────────────────────────────────────────────────────────────

function renderYear(year, exports, memory) {
  document.title = `Calendarium ${year}`
  document.getElementById('h1').innerHTML = `Calendarium Romanum Generale <span>. pro ${year}</span>`

  const tbody = document.getElementById('cal-body')
  const entryPtr = exports.kal_wasm_entry_ptr()
  const feastPtr = exports.kal_wasm_feast_ptr()

  for (let doy = 0; doy < 366; doy++) {
    if (exports.kal_wasm_read_day(year, doy) !== KAL_ENGINE_OK) continue

    // TimelineEntry layout : [0..2] primary_index, [2..4] secondary_offset,
    //                        [4] occurrence_flags, [5] secondary_count
    const ev = new DataView(memory.buffer, entryPtr, 8)
    const primaryIndex = ev.getUint16(0, true)
    const secOffset = ev.getUint16(2, true)
    const secCount = ev.getUint8(5)

    if (primaryIndex === 0) continue // Padding Entry

    // Couleur depuis FeastEntry (O(1))
    let colorCss = ''
    if (exports.kal_wasm_read_feast(primaryIndex) === KAL_ENGINE_OK) {
      const fv = new DataView(memory.buffer, feastPtr, 4)
      const color = (fv.getUint16(2, true) >> 4) & 0x000f
      colorCss = COLOR_CSS[color] ?? ''
    }

    const { month, day } = doyToMonthDay(doy)
    const href = `${year}/${zeroPad(month)}/${zeroPad(day)}`
    let featsHtml = ''

    // Fête principale — label
    if (exports.kal_wasm_get_label(year, doy) === 1) {
      const label = wasmStr(memory, exports.kal_wasm_label_ptr(), exports.kal_wasm_label_len())
      featsHtml += `<p class="color-${colorCss}">${label}</p>`
    }

    // Fêtes secondaires
    if (secCount > 0 && exports.kal_wasm_read_secondary(secOffset, secCount) === KAL_ENGINE_OK) {
      const sv = new DataView(memory.buffer, exports.kal_wasm_secondary_ptr(), secCount * 2)
      for (let i = 0; i < secCount; i++) {
        const ridx = sv.getUint16(i * 2, true)
        if (ridx === 0) continue
        const res = resolveSecondary(exports, memory, ridx, year)
        if (!res) continue
        const secColor = COLOR_CSS[decodeFeastFlags(res.feastFlags).color] ?? ''
        featsHtml += `<p class="secondary color-${secColor}">${res.label}</p>`
      }
    }

    const tr = document.createElement('tr')
    tr.innerHTML = `
            <td class="doy">${doy}</td>
            <td class="date"><a href="${href}">${zeroPad(day)}/${zeroPad(month)}</a></td>
            <td class="feasts">${featsHtml}</td>`
    tbody.appendChild(tr)
  }

  document.getElementById('cal-table').hidden = false
}

// ── Vue journalière ───────────────────────────────────────────────────────────

function renderDay(year, month, day, exports, memory) {
  const doy = dateToDoy(year, month, day)
  document.title = `${zeroPad(day)}/${zeroPad(month)}/${year}`
  document.getElementById('h1').innerHTML = `Calendarium Romanum Generale <span>. ${formatDateLong(year, month, day)}</span>`

  const entryPtr = exports.kal_wasm_entry_ptr()
  const feastPtr = exports.kal_wasm_feast_ptr()
  const container = document.getElementById('day-content')

  if (exports.kal_wasm_read_day(year, doy) !== KAL_ENGINE_OK) {
    container.textContent = 'Erreur lecture entrée'
    container.hidden = false
    return
  }

  // TimelineEntry
  const ev = new DataView(memory.buffer, entryPtr, 8)
  const primaryIndex = ev.getUint16(0, true)
  const secOffset = ev.getUint16(2, true)
  const occFlags = ev.getUint8(4)
  const secCount = ev.getUint8(5)

  if (primaryIndex === 0) {
    container.textContent = '(aucune fête)'
    container.hidden = false
    return
  }

  // FeastEntry — flags invariants
  let feastFlags = 0,
    feastId = 0
  if (exports.kal_wasm_read_feast(primaryIndex) === KAL_ENGINE_OK) {
    const fv = new DataView(memory.buffer, feastPtr, 4)
    feastId = fv.getUint16(0, true)
    feastFlags = fv.getUint16(2, true)
  }

  const { precedence, color, period, nature, hasVigil } = decodeFeastFlags(feastFlags)
  const { hasVesperaeI, hasVigilia } = decodeOccurrenceFlags(occFlags)

  // Label + annotation fête principale
  exports.kal_wasm_get_label(year, doy)
  const label = wasmStr(memory, exports.kal_wasm_label_ptr(), exports.kal_wasm_label_len())
  const annLen = exports.kal_wasm_annotation_len()
  const annotation = annLen > 0 ? wasmStr(memory, exports.kal_wasm_annotation_ptr(), annLen) : null

  // Rendu fête principale
  let html = `<section class="feast primary color-${COLOR_CSS[color] ?? ''}">
        <h2>${label}</h2>`
  if (annotation) html += `<p class="annotation">${renderMarkdown(annotation)}</p>`
  html += `<ul>
        <li>Feast ID: 0x${feastId.toString(16).toUpperCase().padStart(4, '0')}</li>
        <li>Précédence: ${PRECEDENCE[precedence] ?? precedence} (${precedence})</li>
        <li>Couleur: ${COLOR[color] ?? color}</li>
        <li>Période: ${PERIOD[period] ?? period}</li>
        <li>Nature: ${NATURE[nature] ?? nature}</li>`
  if (annotation) html += `<li>Annotation: ${renderMarkdown(annotation)}</li>`
  if (hasVigil) html += `<li>Vigile propre: oui (invariant)</li>`
  if (hasVesperaeI) html += `<li>Vêpres I: ce soir</li>`
  if (hasVigilia) html += `<li>Vigile: ce soir</li>`
  html += `</ul></section>`

  // Fêtes secondaires
  if (secCount > 0 && exports.kal_wasm_read_secondary(secOffset, secCount) === KAL_ENGINE_OK) {
    const sv = new DataView(memory.buffer, exports.kal_wasm_secondary_ptr(), secCount * 2)
    html += `<section class="secondaries"><h2 class="sr-only">Commémorations</h2>`
    for (let i = 0; i < secCount; i++) {
      const ridx = sv.getUint16(i * 2, true)
      if (ridx === 0) continue
      const res = resolveSecondary(exports, memory, ridx, year)
      if (!res) continue
      const sf = decodeFeastFlags(res.feastFlags)
      const fv2 = new DataView(memory.buffer, feastPtr, 4) // FEAST_BUF still set from resolveSecondary
      const secFeastId = fv2.getUint16(0, true)
      html += `<div class="feast secondary color-${COLOR_CSS[sf.color] ?? ''}">
                <h3>${res.label}</h3>`
      if (res.annotation) html += `<p class="annotation">${renderMarkdown(res.annotation)}</p>`
      html += `<ul>
                <li>Feast ID: 0x${secFeastId.toString(16).toUpperCase().padStart(4, '0')}</li>
                <li>Précédence: ${PRECEDENCE[sf.precedence] ?? sf.precedence} (${sf.precedence})</li>
                <li>Couleur: ${COLOR[sf.color] ?? sf.color}</li>
                <li>Nature: ${NATURE[sf.nature] ?? sf.nature}</li>
            </ul></div>`
    }
    html += `</section>`
  }

  // Navigation
  const prev = doyToMonthDay(Math.max(0, doy - 1))
  const next = doyToMonthDay(Math.min(365, doy + 1))
  html += `<nav class="day-nav">
        <a href="${year}/${zeroPad(prev.month)}/${zeroPad(prev.day)}">← Jour précédent</a>
        <a href="${year}">Année ${year}</a>
        <a href="${year}/${zeroPad(next.month)}/${zeroPad(next.day)}">Jour suivant →</a>
    </nav>`

  container.innerHTML = html
  container.hidden = false
}

// ── Vue 404 ───────────────────────────────────────────────────────────────────

function renderNotFound() {
  document.title = '404 — Page non trouvée'
  document.getElementById('h1').innerHTML = 'Calendarium Romanum Generale <span>. 404</span>'
  const container = document.getElementById('day-content')
  container.innerHTML = `<section class="not-found">
    <p>La ressource demandée n'existe pas.</p>
    <p>Routes valides :</p>
    <ul>
      <li><a href="${BASE_PATH}">Date du jour</a></li>
      <li><code>YYYY</code> — vue annuelle (ex. <a href="${BASE_PATH}2026">2026</a>)</li>
      <li><code>YYYY/MM/DD</code> — vue journalière (ex. <a href="${BASE_PATH}2026/12/25">2026/12/25</a>)</li>
    </ul>
  </section>`
  container.hidden = false
}

// ── Initialisation ────────────────────────────────────────────────────────────

async function init() {
  const status = document.getElementById('status')
  try {
    const [wasmResp, kaldBuf, litsBuf] = await Promise.all([
      fetch(WASM_URL),
      fetch(KALD_URL).then(r => r.arrayBuffer()),
      fetch(LITS_URL).then(r => r.arrayBuffer()),
    ])

    const { instance } = await WebAssembly.instantiateStreaming(wasmResp, {})
    const { exports } = instance
    const memory = exports.memory

    const kaldPtr = exports.kal_wasm_alloc_kald(kaldBuf.byteLength)
    if (kaldPtr === 0) throw new Error('kald : capacité statique insuffisante')
    copyToWasm(memory, kaldPtr, kaldBuf)
    const rcKald = exports.kal_wasm_commit_kald()
    if (rcKald !== KAL_ENGINE_OK) throw new Error(`kal_wasm_commit_kald → ${rcKald}`)

    const litsPtr = exports.kal_wasm_alloc_lits(litsBuf.byteLength)
    if (litsPtr === 0) throw new Error('lits : capacité statique insuffisante')
    copyToWasm(memory, litsPtr, litsBuf)
    const rcLits = exports.kal_wasm_commit_lits()
    if (rcLits === KAL_ERR_BUILD_ID_MISMATCH) throw new Error('build_id mismatch : .kald et .lits issus de builds différents')
    if (rcLits !== KAL_ENGINE_OK) throw new Error(`kal_wasm_commit_lits → ${rcLits}`)

    status.hidden = true
    const route = detectRoute()
    if (route.type === 'not-found') {
      renderNotFound()
    } else if (route.type === 'year') {
      renderYear(route.year, exports, memory)
    } else {
      renderDay(route.year, route.month, route.day, exports, memory)
    }
  } catch (err) {
    status.textContent = `Erreur : ${err.message}`
    status.hidden = false
    console.error(err)
  }
}

init()
