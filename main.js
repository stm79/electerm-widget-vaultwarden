/**
 * electerm-Widget: Passwörter aus Vaultwarden (oder Bitwarden) über die Bitwarden-CLI `bw`.
 *
 * - Panel (`run`): anmelden/entsperren, suchen, Verbindungen öffnen, Passwort kopieren.
 * - Passwort-Manager für Lesezeichen (`getCredentials` / `saveCredentials`): electerm fragt
 *   beim Verbinden eines Lesezeichens mit „Passwort-Manager verwenden“ und ohne eigenes Passwort.
 *
 * Die CLI bekommt einen eigenen Datenordner (~/.electerm-vaultwarden/bw), damit sie einer
 * sonst benutzten bw-Anmeldung nicht in die Quere kommt (Rechte 0700). Das Master-Passwort geht
 * nur per Umgebungsvariable an `bw` und wird nirgends gespeichert; Einträge mit Passwort gehen
 * per stdin an `bw`, nie als Argument. Der Tresor sperrt sich nach Inaktivität, nach dem
 * Ruhezustand und beim Beenden. Im Speicher bleibt die Liste der
 * Einträge ohne Passwörter; ein Passwort wird erst geholt, wenn es gebraucht wird.
 */

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

let api = null
try {
  api = require('@electerm/widget-api')
} catch (e) {
  // außerhalb von electerm (Tests)
}

/** Einträge höchstens so alt, dann vor dem nächsten Nachschlagen mit dem Server abgleichen. */
const SYNC_MS = 10 * 60 * 1000
/** Kopiertes Passwort nach dieser Zeit aus der Zwischenablage entfernen. */
const CLIPBOARD_CLEAR_MS = 30 * 1000
const DEFAULT_PORTS = { ssh: 22, telnet: 23, ftp: 21, rdp: 3389, vnc: 5900, spice: 5900 }
/** Protokolle ohne Verschlüsselung: Passwort nur bei URI mit genau diesem Schema automatisch. */
const PLAIN = ['telnet', 'ftp']
/** Standard für die automatische Sperre nach Inaktivität (Minuten). */
const DEFAULT_AUTOLOCK_MIN = 30
const MAX_AUTOLOCK_MIN = 24 * 60
/** So oft prüfen, ob gesperrt werden muss. */
const TICK_MS = 60 * 1000
/** Lücke zwischen zwei Prüfungen, ab der der Rechner geschlafen hat → sperren. */
const SLEEP_GAP_MS = 3 * 60 * 1000
const BW_TIMEOUT_MS = 120000
const BW_MAX_OUTPUT = 256 * 1024 * 1024

const state = {
  session: '',
  /** [{ id, name, username, uris: [string], hasPassword }] */
  items: null,
  syncedAt: 0,
  server: '',
  email: '',
  refreshing: null,
  /** letzte Benutzung (Entsperren, Lesezeichen, Panel) für die automatische Sperre */
  lastUsed: 0,
  lastTick: 0,
  /** 0 = keine automatische Sperre */
  autoLockMs: null,
  /** warum zuletzt automatisch gesperrt wurde (für die Fehlermeldung) */
  lockReason: '',
  /** vom Widget kopiertes Passwort, solange es in der Zwischenablage stehen könnte */
  clipboardPw: '',
  watcher: null,
  /** `bw lock` beim Laden: Entsperren wartet darauf */
  startup: null
}

function appDir () {
  return process.env.ELECTERM_VW_DIR || path.join(os.homedir(), '.electerm-vaultwarden')
}

const settingsFile = () => path.join(appDir(), 'settings.json')
const sessionFile = () => path.join(appDir(), 'session.dat')

function readSettings () {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
  } catch (e) {
    return {}
  }
}

function writeSettings (s) {
  ensureAppDir()
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2), { mode: 0o600 })
}

/**
 * Datenordner nur für den eigenen Benutzer: darin liegt der verschlüsselte Tresor der CLI,
 * an dem sich sonst andere lokale Benutzer offline am Master-Passwort versuchen könnten.
 * Unter Windows schützt das Benutzerprofil den Ordner bereits.
 */
function ensureAppDir () {
  const dir = appDir()
  const bwDir = path.join(dir, 'bw')
  fs.mkdirSync(bwDir, { recursive: true, mode: 0o700 })
  if (process.platform === 'win32') return
  fs.chmodSync(dir, 0o700)
  fs.chmodSync(bwDir, 0o700)
  for (const d of [dir, bwDir]) {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      if (f.isFile()) fs.chmodSync(path.join(d, f.name), 0o600)
    }
  }
}

// ---------------------------------------------------------------- bw aufrufen

function bwFile () {
  return readSettings().bwPath || 'bw'
}

/** bw schreibt vor die eigentliche Meldung (letzte Zeile) oft Stacktraces und Fehlerobjekte. */
function cleanError (text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !/^(\(node:\d+\)|at |Use `node --trace|[{}]$|[a-zA-Z]+: '|Unable to fetch ServerConfig|Could not find)/.test(l))
  const last = lines[lines.length - 1] || ''
  if (/FetchError|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|certificate/i.test(last)) {
    return `Vaultwarden-Server nicht erreichbar: ${last.replace(/^.*reason:\s*/, '')}`
  }
  return last
}

/** Sitzungsschlüssel aus `--raw`: die letzte Zeile (davor kann ein Hinweis stehen). */
const lastLine = out => out.split(/\r?\n/).map(l => l.trim()).filter(Boolean).pop() || ''

const notFound = file => `Bitwarden-CLI nicht gefunden (${file}). Installieren (Windows: „winget install Bitwarden.CLI“) oder im Feld „Bitwarden-CLI“ den Pfad angeben.`

function bwEnv (session) {
  const env = { ...process.env, BITWARDENCLI_APPDATA_DIR: path.join(appDir(), 'bw'), BW_NOINTERACTION: 'true' }
  // Geheimnisse aus der Umgebung von electerm nicht ungefragt weiterreichen
  for (const k of ['BW_SESSION', 'BW_PASSWORD', 'BW_CLIENTID', 'BW_CLIENTSECRET']) delete env[k]
  if (session) env.BW_SESSION = session
  return env
}

/**
 * `bw` ausführen; liefert stdout. Geheimnisse nur über `env` oder stdin (`input`), nie als
 * Argument: die Befehlszeile eines Prozesses können andere Prozesse (unter Linux sogar andere
 * Benutzer) mitlesen. Fehlermeldungen enthalten deshalb auch nie die Argumente.
 * @param {string[]} args
 * @param {{ session?: string, env?: object, input?: string }} [opts]
 */
function bw (args, opts = {}) {
  const file = bwFile()
  // .cmd/.bat (npm-Installation unter Windows) lassen sich nur über die Shell starten
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)
  if (shell && args.some(a => !/^[\w@.:/+=%-]*$/.test(a))) {
    return Promise.reject(new Error('Ungültiges Zeichen für den Aufruf von bw.cmd. Besser bw.exe verwenden.'))
  }
  try {
    ensureAppDir()
  } catch (e) {
    return Promise.reject(new Error(`Datenordner ${appDir()} nicht nutzbar: ${e.code || e.message}`))
  }
  const env = { ...bwEnv(opts.session === undefined ? state.session : opts.session), ...opts.env }
  return new Promise((resolve, reject) => {
    let done = false
    let size = 0
    const out = []
    const err = []
    let child
    const finish = (e, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (e) reject(e)
      else resolve(value)
    }
    const timer = setTimeout(() => {
      if (child) child.kill()
      finish(new Error(`bw ${args[0]}: keine Antwort nach ${BW_TIMEOUT_MS / 1000} s.`))
    }, BW_TIMEOUT_MS)
    try {
      child = spawn(shell ? `"${file}"` : file, [...args, '--nointeraction'], { env, shell, windowsHide: true })
    } catch (e) {
      return finish(new Error(e.code === 'ENOENT' ? notFound(file) : `bw konnte nicht gestartet werden: ${e.code || e.message}`))
    }
    const collect = list => chunk => {
      size += chunk.length
      if (size > BW_MAX_OUTPUT) {
        child.kill()
        finish(new Error('Antwort von bw ist zu groß.'))
      } else {
        list.push(chunk)
      }
    }
    child.stdout.on('data', collect(out))
    child.stderr.on('data', collect(err))
    child.on('error', e => finish(new Error(e.code === 'ENOENT' ? notFound(file) : `bw konnte nicht gestartet werden: ${e.code || e.message}`)))
    child.on('close', code => {
      const stdout = Buffer.concat(out).toString('utf8')
      const stderr = Buffer.concat(err).toString('utf8')
      if (code === 0) return finish(null, stdout.trim())
      finish(new Error(cleanError(stderr) || cleanError(stdout) || `bw ${args[0]} ist fehlgeschlagen (Code ${code}).`))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(opts.input || '')
  })
}

function parseJson (out) {
  const i = out.search(/[[{]/)
  if (i < 0) throw new Error('Unerwartete Antwort von bw: ' + out.slice(0, 200))
  return JSON.parse(out.slice(i))
}

const b64 = obj => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64')

const normServer = u => String(u || '').trim().replace(/\/+$/, '').toLowerCase()

async function status (session) {
  return parseJson(await bw(['status'], { session }))
}

// ---------------------------------------------------------------- Sitzung

/** Rest der früheren Option „Entsperrt bleiben“ (bis 0.1.0): gespeicherten Sitzungsschlüssel löschen. */
function forgetStoredSession () {
  try {
    fs.unlinkSync(sessionFile())
  } catch (e) {}
}

/** Entsperrte Sitzung oder ein Fehler, den electerm einmal anzeigt (dann normale Passwortabfrage). */
async function ensureSession () {
  if (state.session) {
    touch()
    return
  }
  const why = state.lockReason ? ` (automatisch gesperrt: ${state.lockReason})` : ''
  throw new Error(`Vaultwarden ist gesperrt${why}. Im Widget „Vaultwarden“ wieder entsperren.`)
}

// ---------------------------------------------------------------- automatische Sperre

function autoLockMs () {
  if (state.autoLockMs === null) state.autoLockMs = parseAutoLock(readSettings().autoLockMinutes)
  return state.autoLockMs
}

/** Minuten aus dem Formular → ms. Leer/ungültig: Standard; 0: aus. */
function parseAutoLock (value) {
  if (value === undefined || value === null || value === '') return DEFAULT_AUTOLOCK_MIN * 60000
  const m = Number(value)
  if (!Number.isFinite(m) || m < 0) return DEFAULT_AUTOLOCK_MIN * 60000
  return Math.min(m, MAX_AUTOLOCK_MIN) * 60000
}

/** Benutzung merken und die Überwachung laufen lassen. */
function touch () {
  state.lastUsed = Date.now()
  if (!state.watcher) {
    state.lastTick = Date.now()
    state.watcher = setInterval(() => { tick().catch(() => {}) }, TICK_MS)
    if (state.watcher.unref) state.watcher.unref()
  }
}

function stopWatch () {
  if (state.watcher) clearInterval(state.watcher)
  state.watcher = null
}

/**
 * Sperrt nach Inaktivität und nach dem Ruhezustand. Den Ruhezustand erkennt das Widget an
 * einer Lücke zwischen zwei Prüfungen (Timer laufen im Schlaf nicht weiter); Electrons
 * powerMonitor steht Widgets nicht zur Verfügung.
 */
async function tick (now = Date.now()) {
  if (!state.session) return stopWatch()
  const gap = now - (state.lastTick || now)
  state.lastTick = now
  const limit = autoLockMs()
  let reason = ''
  if (gap > SLEEP_GAP_MS) reason = 'nach Ruhezustand oder Bildschirmsperre'
  else if (limit > 0 && now - state.lastUsed >= limit) reason = `nach ${Math.round(limit / 60000)} min ohne Benutzung`
  if (!reason) return
  await lock()
  state.lockReason = reason
  if (api) api.log('info', 'Vaultwarden automatisch gesperrt: ' + reason)
}

function hint (e) {
  const m = e.message
  if (/two.?step|two.?factor|2fa|verification code/i.test(m)) {
    return new Error(`${m} – Zwei-Faktor-Code eintragen und nochmal ausführen, oder den API-Schlüssel (client_id/client_secret) verwenden.`)
  }
  if (/new device|device verification|otp/i.test(m)) {
    return new Error(`${m} – Vaultwarden will ein neues Gerät bestätigen lassen. Mit dem API-Schlüssel (client_id/client_secret) anmelden, dann entfällt das.`)
  }
  if (/invalid master password|username or password is incorrect/i.test(m)) {
    return new Error('Master-Passwort oder E-Mail falsch.')
  }
  return e
}

/** Anmelden (falls nötig), entsperren, abgleichen. */
async function unlock (cfg) {
  const server = normServer(cfg.serverUrl)
  const email = String(cfg.email || '').trim().toLowerCase()
  if (!server || !email) throw new Error('Server und E-Mail angeben.')
  checkServer(server)
  if (state.startup) await state.startup

  if (state.session && state.server === server && state.email === email) {
    const st = await status().catch(() => ({}))
    if (st.status === 'unlocked') return false
    state.session = ''
  }
  state.session = ''
  const pw = String(cfg.masterPassword || '')
  let st = await status('')
  const sameAccount = normServer(st.serverUrl) === server && String(st.userEmail || '').toLowerCase() === email
  if (st.status !== 'unauthenticated' && !sameAccount) {
    await bw(['logout'], { session: '' }).catch(() => {})
    st = { status: 'unauthenticated', serverUrl: st.serverUrl }
  }
  if (!pw) throw new Error(st.status === 'unauthenticated' ? 'Zum Anmelden das Master-Passwort eingeben.' : 'Gesperrt: Master-Passwort eingeben.')
  const secretEnv = { BW_PASSWORD: pw }
  try {
    if (st.status === 'unauthenticated') {
      if (normServer(st.serverUrl) !== server) await bw(['config', 'server', server], { session: '' })
      if (cfg.clientId && cfg.clientSecret) {
        await bw(['login', '--apikey'], { session: '', env: { BW_CLIENTID: String(cfg.clientId).trim(), BW_CLIENTSECRET: String(cfg.clientSecret).trim() } })
      } else {
        const code = String(cfg.twoFactorCode || '').replace(/\s/g, '')
        const args = ['login', email, '--passwordenv', 'BW_PASSWORD', '--raw']
        if (code) args.push('--method', '0', '--code', code)
        const session = lastLine(await bw(args, { session: '', env: secretEnv }))
        if (session) state.session = session
      }
    }
    if (!state.session) {
      state.session = lastLine(await bw(['unlock', '--passwordenv', 'BW_PASSWORD', '--raw'], { session: '', env: secretEnv }))
    }
  } catch (e) {
    state.session = ''
    throw hint(e)
  }
  if (!state.session) throw new Error('bw hat keinen Sitzungsschlüssel geliefert.')
  state.server = server
  state.email = email
  state.lockReason = ''
  touch()
  await refresh(true)
  return true
}

/** Nur https://. Unverschlüsselt höchstens zu einem Server auf diesem Rechner. */
function checkServer (server) {
  let u
  try {
    u = new URL(server)
  } catch (e) {
    throw new Error('Server-Adresse ungültig.')
  }
  if (u.username || u.password) throw new Error('Server-Adresse bitte ohne Benutzer/Passwort angeben.')
  if (u.protocol === 'https:') return
  if (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return
  throw new Error('Server bitte mit https:// angeben. Unverschlüsseltes http:// ist nur für localhost erlaubt.')
}

async function lock () {
  const session = state.session
  Object.assign(state, { session: '', items: null, syncedAt: 0, lockReason: '' })
  stopWatch()
  await clearClipboard()
  await bw(['lock'], { session }).catch(() => {})
  forgetStoredSession()
}

/** Vom Widget kopiertes Passwort aus der Zwischenablage nehmen, falls es noch drin steht. */
async function clearClipboard () {
  const pw = state.clipboardPw
  state.clipboardPw = ''
  if (!pw || !api) return
  try {
    if (await api.clipboard.read() === pw) await api.clipboard.write('')
  } catch (e) {}
}

// ---------------------------------------------------------------- Einträge

function toMeta (it) {
  const login = it.login || {}
  return {
    id: it.id,
    name: it.name || '',
    username: login.username || '',
    uris: (login.uris || []).map(u => u && u.uri).filter(Boolean),
    hasPassword: !!login.password
  }
}

/** Mit dem Server abgleichen (wenn `force` oder zu alt) und die Liste neu einlesen. Offline: lokale Kopie. */
async function refresh (force = false) {
  if (state.refreshing) return state.refreshing
  if (!force && state.items && Date.now() - state.syncedAt < SYNC_MS) return
  state.refreshing = (async () => {
    try {
      await bw(['sync']).then(() => { state.syncedAt = Date.now() }, e => {
        if (!state.items) state.syncedAt = Date.now() - SYNC_MS + 60000 // offline: in 1 min nochmal
        if (api) api.log('warn', 'bw sync: ' + e.message)
      })
      const items = parseJson(await bw(['list', 'items']))
      state.items = items.filter(it => it.type === 1).map(toMeta)
    } finally {
      state.refreshing = null
    }
  })()
  return state.refreshing
}

async function getItem (id) {
  if (!/^[\w-]+$/.test(String(id))) throw new Error('Ungültige Eintrags-ID.')
  return parseJson(await bw(['get', 'item', id]))
}

/**
 * Adresse aus einer URI: `ssh://host:22`, `rdp://10.0.0.5`, `host:2222`, `https://host/…`.
 * @return {{ scheme: string, host: string, port: number }|null}
 */
function parseUri (value) {
  const s = String(value || '').trim()
  if (!s) return null
  const m = s.match(/^([a-z][a-z\d+.-]*):\/\//i)
  try {
    const u = new URL(m ? s : 'x://' + s)
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (!host) return null
    return { scheme: m ? m[1].toLowerCase() : '', host, port: Number(u.port) || 0 }
  } catch (e) {
    return null
  }
}

const WEB = ['http', 'https']

/**
 * Einträge zu einem Ziel: `entries` passen über die URI (Host, Port falls angegeben, Schema
 * gleich oder keins), `alternatives` nur über eine Web-URI auf denselben Host oder den Namen.
 */
function matchItems (items, target) {
  const host = String(target.host || '').trim().toLowerCase()
  const type = String(target.type || 'ssh').toLowerCase()
  const port = Number(target.port) || DEFAULT_PORTS[type] || 0
  const plain = PLAIN.includes(type)
  const title = String(target.title || '').trim().toLowerCase()
  const entries = []
  const alternatives = []
  for (const it of items || []) {
    let exact = false
    let near = false
    for (const raw of it.uris) {
      const u = parseUri(raw)
      if (!u || u.host !== host) continue
      const portOk = !u.port || u.port === port
      if (u.scheme === type || (u.scheme === '' && !plain)) {
        if (portOk) exact = true
      } else if (u.scheme === '' && portOk) {
        // unverschlüsseltes Protokoll, URI ohne Schema: nur zur Auswahl, nie automatisch
        near = true
      } else if (WEB.includes(u.scheme)) {
        near = true
      }
    }
    const name = it.name.trim().toLowerCase()
    if (!exact && name && (name === host || (title && name === title))) near = true
    if (exact) entries.push(it)
    else if (near) alternatives.push(it)
  }
  return { entries, alternatives }
}

/** Was electerm bekommt: genau ein passender Eintrag → direkt, mehrere → Auswahl, keiner → null. */
function decide (match, username) {
  const { entries, alternatives } = match
  const user = String(username || '').toLowerCase()
  const sameUser = user ? entries.filter(e => e.username.toLowerCase() === user) : []
  if (sameUser.length === 1) return { use: sameUser[0] }
  if (entries.length === 1 && (!user || !entries[0].username)) return { use: entries[0] }
  if (!entries.length && !alternatives.length) return { none: true }
  const order = list => user ? [...list].sort((a, b) => (b.username.toLowerCase() === user) - (a.username.toLowerCase() === user)) : list
  return { choose: { entries: order(entries), alternatives: order(alternatives) } }
}

const entryUrl = t => `${t.type || 'ssh'}://${t.host}${t.port ? ':' + t.port : ''}`
const asEntry = it => ({ uuid: it.id, name: it.name, login: it.username })

// ---------------------------------------------------------------- Passwort-Manager-Schnittstelle

/**
 * electerm.credentialProvider.get: `{ type, host, port, username, title, uuid? }`.
 */
async function getCredentials (target = {}) {
  await ensureSession()
  if (target.uuid) {
    const it = await getItem(target.uuid)
    return { pick: { login: (it.login && it.login.username) || '', password: (it.login && it.login.password) || '' } }
  }
  await refresh()
  const d = decide(matchItems(state.items, target), target.username)
  if (d.none) return { pick: null }
  if (d.use) {
    const it = await getItem(d.use.id)
    return { pick: { login: (it.login && it.login.username) || '', password: (it.login && it.login.password) || '' } }
  }
  return {
    pick: 'choose',
    url: entryUrl(target),
    entries: d.choose.entries.map(asEntry),
    alternatives: d.choose.alternatives.map(asEntry)
  }
}

/**
 * electerm.credentialProvider.save: Login, der funktioniert hat, speichern. Mit `uuid` wird
 * dieser Eintrag aktualisiert, sonst ein neuer angelegt (URI z. B. ssh://host:22).
 */
async function saveCredentials ({ target = {}, login = '', password = '', uuid = '' } = {}) {
  await ensureSession()
  const url = entryUrl(target)
  if (uuid) {
    const it = await getItem(uuid)
    it.login = { ...(it.login || {}), password }
    if (login) it.login.username = login
    await bw(['edit', 'item', uuid], { input: b64(it) })
  } else {
    await bw(['create', 'item'], { input: b64({
      type: 1,
      name: target.title || `${login ? login + '@' : ''}${target.host}`,
      notes: 'Angelegt von electerm',
      favorite: false,
      folderId: null,
      organizationId: null,
      reprompt: 0,
      fields: [],
      login: { username: login, password, totp: null, uris: [{ match: null, uri: url }] }
    }) })
  }
  state.syncedAt = 0
  await refresh(true).catch(() => {})
  return { ok: true, url }
}

// ---------------------------------------------------------------- Panel

function failure (e) {
  return { message: e.message || String(e), messageType: 'error' }
}

const actionButtons = () => [
  { label: 'Synchronisieren', action: 'syncNow' },
  { label: 'Sperren', action: 'lockAction', danger: true }
]

function statusResult (prefix = '') {
  const n = state.items ? state.items.length : 0
  const when = state.syncedAt ? new Date(state.syncedAt).toLocaleTimeString('de-DE') : 'noch nie'
  const ms = autoLockMs()
  const auto = ms > 0 ? `Sperrt sich nach ${Math.round(ms / 60000)} min ohne Benutzung.` : 'Automatische Sperre aus.'
  return {
    message: `${prefix}Entsperrt: ${state.email} auf ${state.server}. ${n} Logins, abgeglichen ${when}. ${auto} Das Feld „Master-Passwort“ kannst du jetzt leeren.`,
    messageType: 'success',
    buttons: actionButtons()
  }
}

function search (query) {
  const q = query.toLowerCase()
  const hits = state.items.filter(it =>
    it.name.toLowerCase().includes(q) ||
    it.username.toLowerCase().includes(q) ||
    it.uris.some(u => u.toLowerCase().includes(q))
  )
  const rows = hits.slice(0, 100).map(it => ({ id: it.id, name: it.name, username: it.username, address: it.uris[0] || '' }))
  return {
    message: hits.length ? `${hits.length} Treffer${hits.length > 100 ? ' (die ersten 100)' : ''}` : `Nichts gefunden für „${query}“.`,
    messageType: hits.length ? 'success' : 'warning',
    table: {
      columns: [
        { key: 'name', title: 'Name' },
        { key: 'username', title: 'Benutzer', copy: true },
        { key: 'address', title: 'Adresse', copy: true }
      ],
      rows,
      rowButtons: [
        { label: 'SSH', action: 'openSsh' },
        { label: 'RDP', action: 'openRdp' },
        { label: 'Passwort kopieren', action: 'copyPassword' },
        { label: 'Details', action: 'details' }
      ]
    },
    buttons: actionButtons()
  }
}

async function run (cfg = {}) {
  try {
    const s = readSettings()
    const { rememberSession, ...rest } = s
    state.autoLockMs = parseAutoLock(cfg.autoLockMinutes)
    writeSettings({ ...rest, bwPath: String(cfg.bwPath || '').trim(), autoLockMinutes: state.autoLockMs / 60000 })
    forgetStoredSession()
    const fresh = await unlock(cfg)
    if (!state.items) await refresh(true)
    const query = String(cfg.query || '').trim()
    if (query) return search(query)
    return statusResult(fresh ? 'Angemeldet. ' : '')
  } catch (e) {
    return failure(e)
  }
}

async function syncNow () {
  try {
    await ensureSession()
    await refresh(true)
    return statusResult()
  } catch (e) {
    return failure(e)
  }
}

async function lockAction () {
  await lock()
  return { message: 'Gesperrt. Sitzungsschlüssel und Eintragsliste sind gelöscht.', messageType: 'info' }
}

/** Verbindung aus einem Eintrag: Adresse aus der passenden URI, sonst der ersten brauchbaren. */
function buildTab (it, type) {
  const login = it.login || {}
  const uris = (login.uris || []).map(u => parseUri(u && u.uri)).filter(Boolean)
  const u = uris.find(x => x.scheme === type) || uris.find(x => x.scheme === '') || uris.find(x => !WEB.includes(x.scheme)) || uris[0]
  if (!u) throw new Error('Der Eintrag hat keine Adresse (URI).')
  const port = (u.scheme === type || u.scheme === '') && u.port ? u.port : DEFAULT_PORTS[type]
  const tab = { type, title: it.name || `${type.toUpperCase()} ${u.host}`, host: u.host, port, username: login.username || '', password: login.password || '' }
  if (type === 'ssh') Object.assign(tab, { authType: 'password', enableSsh: true, enableSftp: true })
  return tab
}

async function open (row, type) {
  try {
    await ensureSession()
    const tab = buildTab(await getItem(row.id), type)
    return { openTab: tab, message: `Öffne ${type.toUpperCase()} ${tab.username ? tab.username + '@' : ''}${tab.host}:${tab.port}`, messageType: 'success' }
  } catch (e) {
    return failure(e)
  }
}

async function copyPassword (row) {
  try {
    await ensureSession()
    const it = await getItem(row.id)
    const pw = (it.login && it.login.password) || ''
    if (!pw) return { message: 'Der Eintrag hat kein Passwort.', messageType: 'warning' }
    await api.clipboard.write(pw)
    state.clipboardPw = pw
    setTimeout(async () => {
      if (state.clipboardPw === pw) await clearClipboard()
    }, CLIPBOARD_CLEAR_MS).unref?.()
    return { message: `Passwort von „${it.name}“ kopiert, wird in 30 s aus der Zwischenablage entfernt.`, messageType: 'success' }
  } catch (e) {
    return failure(e)
  }
}

async function details (row) {
  try {
    await ensureSession()
    const it = await getItem(row.id)
    const login = it.login || {}
    return {
      details: [
        { label: 'Name', value: it.name || '', copy: true },
        { label: 'Benutzer', value: login.username || '', copy: true },
        // das Passwort selbst bleibt im Tresor; zum Kopieren gibt es den eigenen Knopf
        { label: 'Passwort', value: login.password ? 'gespeichert („Passwort kopieren“ benutzen)' : 'keins' },
        ...(login.uris || []).map((u, i) => ({ label: `URI ${i + 1}`, value: u.uri || '', copy: true }))
      ]
    }
  } catch (e) {
    return failure(e)
  }
}

// ---------------------------------------------------------------- Start und Ende

/**
 * Beim Laden: einen Tresor sperren, den eine frühere Sitzung offen gelassen hat (Absturz,
 * electerm hart beendet). Sonst bliebe der mit dem Sitzungsschlüssel geschützte Schlüssel
 * auf der Platte gültig.
 */
function lockStale () {
  if (!fs.existsSync(path.join(appDir(), 'bw'))) return Promise.resolve()
  state.startup = bw(['lock'], { session: '' }).catch(() => {}).finally(() => { state.startup = null })
  return state.startup
}

/** Beim Beenden: Zwischenablage leeren und `bw lock` im Hintergrund (läuft nach electerm weiter). */
function onExit () {
  if (state.clipboardPw && api) {
    try {
      if (api.clipboard.read() === state.clipboardPw) api.clipboard.write('')
    } catch (e) {}
  }
  if (!state.session) return
  try {
    const file = bwFile()
    const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)
    spawn(shell ? `"${file}"` : file, ['lock', '--nointeraction'], {
      env: bwEnv(state.session), shell, detached: true, stdio: 'ignore', windowsHide: true
    }).unref()
  } catch (e) {}
}

if (api) {
  lockStale()
  process.on('exit', onExit)
}

module.exports = {
  run,
  syncNow,
  lockAction,
  openSsh: row => open(row, 'ssh'),
  openRdp: row => open(row, 'rdp'),
  copyPassword,
  details,
  getCredentials,
  saveCredentials,
  // für Tests
  _test: { state, parseUri, matchItems, decide, buildTab, tick, lockStale, checkServer, parseAutoLock, setApi: a => { api = a } }
}
