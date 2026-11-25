#!/usr/bin/env node
// Attrappe der Bitwarden-CLI für die Tests. Zustand in $BITWARDENCLI_APPDATA_DIR/fake.json.
const fs = require('node:fs')
const path = require('node:path')

const dir = process.env.BITWARDENCLI_APPDATA_DIR
fs.mkdirSync(dir, { recursive: true })
const file = path.join(dir, 'fake.json')
const st = fs.existsSync(file)
  ? JSON.parse(fs.readFileSync(file, 'utf8'))
  : { server: null, email: null, status: 'unauthenticated', items: require('./items.json'), calls: [] }
const args = process.argv.slice(2).filter(a => a !== '--nointeraction')
st.calls.push(args.join(' '))
const save = () => fs.writeFileSync(file, JSON.stringify(st))
const out = s => { save(); process.stdout.write(typeof s === 'string' ? s : JSON.stringify(s)); process.exit(0) }
const fail = s => { save(); process.stderr.write(s + '\n'); process.exit(1) }
const SESSION = 'sess-123'
const needSession = () => { if (st.status !== 'unlocked' || process.env.BW_SESSION !== SESSION) fail('Vault is locked.') }
const [cmd, a1, a2, a3] = args

switch (cmd) {
  case 'status':
    out({ serverUrl: st.server, userEmail: st.email, status: st.status === 'unlocked' && process.env.BW_SESSION !== SESSION ? 'locked' : st.status })
    break
  case 'config':
    if (st.status !== 'unauthenticated') fail('Logout required before server config update.')
    st.server = a2
    out('Saved setting `config`.')
    break
  case 'login':
    if (a1 === '--apikey') {
      if (process.env.BW_CLIENTSECRET !== 'geheim') fail('client_id or client_secret is incorrect.')
      st.email = 'stefan@example.com'
      st.status = 'locked'
      out('You are logged in!')
    }
    if (process.env.BW_PASSWORD !== 'master') fail('Username or password is incorrect. Try again.')
    if (!args.includes('--code')) fail('Two-step login is required.')
    st.email = a1
    st.status = 'unlocked'
    out(SESSION)
    break
  case 'unlock':
    if (process.env.BW_PASSWORD !== 'master') fail('Invalid master password.')
    st.status = 'unlocked'
    out(SESSION)
    break
  case 'lock':
    st.status = 'locked'
    out('Your vault is locked.')
    break
  case 'logout':
    st.status = 'unauthenticated'
    out('You have logged out.')
    break
  case 'sync':
    needSession()
    out('Syncing complete.')
    break
  case 'list':
    needSession()
    out(st.items)
    break
  case 'get': {
    needSession()
    const it = st.items.find(i => i.id === a2)
    if (!it) fail('Not found.')
    out(it)
    break
  }
  case 'create': {
    needSession()
    const it = { ...JSON.parse(Buffer.from(a2, 'base64').toString('utf8')), id: 'new-' + st.items.length }
    st.items.push(it)
    out(it)
    break
  }
  case 'edit': {
    needSession()
    const i = st.items.findIndex(x => x.id === a2)
    if (i < 0) fail('Not found.')
    st.items[i] = JSON.parse(Buffer.from(a3, 'base64').toString('utf8'))
    out(st.items[i])
    break
  }
  default:
    fail('unknown command ' + cmd)
}
