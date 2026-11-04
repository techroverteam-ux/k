import { Controller, Get, NotFoundException, Res } from '@nestjs/common';
import type { Response } from 'express';
import { env } from '../config/env';

/**
 * API console at "/": GraphiQL (every query and mutation, with docs and autocomplete) plus a sign-in bar, so real
 * flows can be tried against this server: password, authenticator code, "sign out other device", step-up for
 * sensitive actions. Tokens live only in this page's memory and are sent only to this API's /graphql.
 *
 * On unless NODE_ENV=production; there, set API_CONSOLE=true to turn it on. Every operation still goes through the
 * normal authentication, roles, step-up, rate limits and audit log, so the console grants nothing by itself.
 */
const CDN = 'https://cdn.jsdelivr.net/npm';

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>The K · API console</title>
<link rel="stylesheet" href="${CDN}/graphiql@3.7.1/graphiql.min.css">
<style>
  html, body { margin: 0; height: 100%; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  body { display: flex; flex-direction: column; }
  #bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 12px; background: #0b3d2e; color: #fff; }
  #bar b { font-size: 15px; margin-right: 8px; }
  #bar input { height: 30px; border-radius: 6px; border: 0; padding: 0 8px; font-size: 14px; }
  #bar button { height: 30px; border-radius: 6px; border: 0; padding: 0 12px; font-weight: 600; cursor: pointer; background: #08a77b; color: #fff; }
  #bar button.ghost { background: transparent; border: 1px solid #ffffff66; }
  #who { margin-left: auto; font-size: 13px; opacity: .9; }
  #msg { font-size: 13px; color: #ffd27a; }
  #graphiql { flex: 1; min-height: 0; }
  .hide { display: none !important; }
</style>
</head>
<body>
<div id="bar">
  <b>The K · API console</b>
  <span id="out">
    <input id="u" placeholder="Username" autocomplete="username">
    <input id="p" type="password" placeholder="Password" autocomplete="current-password">
    <button id="login">Sign in</button>
  </span>
  <span id="mfa" class="hide"><input id="code" inputmode="numeric" maxlength="6" placeholder="6-digit code"><button id="mfaGo">Verify</button></span>
  <span id="conf" class="hide">Signed in on another device. <button id="force">Sign that device out and continue</button></span>
  <span id="in" class="hide">
    <button id="step" title="Sensitive actions (approvals, payments, deletes) need this; valid for 5 minutes">Step-up</button>
    <button id="logout" class="ghost">Sign out</button>
  </span>
  <span id="msg"></span>
  <span id="who">Not signed in</span>
</div>
<div id="graphiql"></div>
<script crossorigin src="${CDN}/react@18.3.1/umd/react.production.min.js"></script>
<script crossorigin src="${CDN}/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
<script src="${CDN}/graphiql@3.7.1/graphiql.min.js"></script>
<script>
(function () {
  var token = null, stepUp = null, stepUpUntil = 0, mfaToken = null, conflictToken = null, me = null;
  var $ = function (id) { return document.getElementById(id); };
  var DEVICE = 'API console';
  function post(query, variables) {
    var h = { 'content-type': 'application/json', 'apollo-require-preflight': 'true' };
    if (token) h.authorization = 'Bearer ' + token;
    if (stepUp && Date.now() < stepUpUntil) h['x-step-up'] = stepUp;
    return fetch('/graphql', { method: 'POST', headers: h, credentials: 'same-origin', body: JSON.stringify({ query: query, variables: variables || {} }) })
      .then(function (r) { return r.json(); });
  }
  function msg(t) { $('msg').textContent = t || ''; }
  function show(state) {
    $('out').classList.toggle('hide', state !== 'out');
    $('mfa').classList.toggle('hide', state !== 'mfa');
    $('conf').classList.toggle('hide', state !== 'conf');
    $('in').classList.toggle('hide', state !== 'in');
    $('who').textContent = me ? (me.username + ' · ' + me.role + (stepUp && Date.now() < stepUpUntil ? ' · step-up on' : '')) : 'Not signed in';
  }
  var FIELDS = 'accessToken mfaRequired mfaToken sessionConflict conflictToken user { username role }';
  function handle(d) {
    var e = d.errors && d.errors[0];
    if (e) { msg(e.message); return; }
    var r = d.data[Object.keys(d.data)[0]];
    if (r.sessionConflict) { conflictToken = r.conflictToken; show('conf'); msg(''); return; }
    if (r.mfaRequired) { mfaToken = r.mfaToken; show('mfa'); $('code').focus(); msg(''); return; }
    token = r.accessToken; me = r.user; $('p').value = ''; show('in');
    msg(me.role === 'SUPER_ADMIN' ? 'Signed in. Super Admins without an authenticator must set one up first (beginMfaEnrollment).' : 'Signed in.');
  }
  $('login').onclick = function () {
    msg('Signing in…');
    post('mutation($u:String!,$p:String!,$d:String){ login(username:$u,password:$p,deviceName:$d){ ' + FIELDS + ' } }', { u: $('u').value, p: $('p').value, d: DEVICE }).then(handle);
  };
  $('p').onkeydown = function (e) { if (e.key === 'Enter') $('login').click(); };
  $('mfaGo').onclick = function () {
    post('mutation($t:String!,$c:String!,$d:String){ completeMfaLogin(mfaToken:$t, code:$c, deviceName:$d){ ' + FIELDS + ' } }', { t: mfaToken, c: $('code').value, d: DEVICE }).then(function (d) { $('code').value = ''; handle(d); });
  };
  $('code').onkeydown = function (e) { if (e.key === 'Enter') $('mfaGo').click(); };
  $('force').onclick = function () {
    post('mutation($t:String!,$d:String){ forceLogin(conflictToken:$t, deviceName:$d){ ' + FIELDS + ' } }', { t: conflictToken, d: DEVICE }).then(handle);
  };
  $('step').onclick = function () {
    var v = prompt('Authenticator code (or your password if 2-step verification is off):');
    if (!v) return;
    var mfa = /^\\d{6}$/.test(v.trim());
    post('mutation($p:String,$t:String){ stepUp(password:$p, totp:$t){ token } }', mfa ? { t: v.trim() } : { p: v }).then(function (d) {
      if (d.errors) { msg(d.errors[0].message); return; }
      stepUp = d.data.stepUp.token; stepUpUntil = Date.now() + 4.5 * 60 * 1000; show('in'); msg('Step-up on for 5 minutes.');
    });
  };
  $('logout').onclick = function () {
    post('mutation{ logout }').finally(function () { token = null; me = null; stepUp = null; show('out'); msg('Signed out.'); });
  };
  var fetcher = function (params) { return post(params.query, params.variables); };
  var start = '# The K API console\\n#\\n# 1. Sign in with the bar above (authenticator code if asked).\\n# 2. Press the Docs button (top-left) to browse every query and mutation.\\n# 3. Approvals, payments and deletes need "Step-up" first.\\n#\\n# Example: your account and balance\\nquery Me {\\n  me { id username displayName role mfaEnabled }\\n}\\n';
  ReactDOM.createRoot($('graphiql')).render(React.createElement(GraphiQL, { fetcher: fetcher, defaultQuery: start, defaultEditorToolsVisibility: true }));
  show('out');
})();
</script>
</body>
</html>`;

@Controller()
export class ConsoleController {
  @Get()
  page(@Res() res: Response) {
    const e = env();
    const on = e.API_CONSOLE ?? e.NODE_ENV !== 'production';
    if (!on) throw new NotFoundException();
    // The page loads React and GraphiQL from jsDelivr; everything else stays same-origin.
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net`,
      `style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net`,
      "img-src 'self' data: https://cdn.jsdelivr.net",
      "font-src 'self' data: https://cdn.jsdelivr.net",
      "connect-src 'self'",
      "worker-src 'self' blob:",
      "frame-ancestors 'none'",
    ].join('; '));
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(PAGE);
  }
}
