/* 🐾 Task スマホ版：アーティファクトの道具（window.claude）の差し替え（GitHub を直接読み書きする版）
 *
 * Mac の shim.js と同じ形の道具を、Mac を通さずに GitHub の非公開の置き場所（nekosan222/mirum-tasks）へつなぐ。
 * Mac が閉じていても、外出先でもスマホから見られる（げんた 2026-10-13「Wi-Fiじゃないときもみたい」）
 *   - 鍵（GitHub のトークン）と「だれのスマホか」は、最初に1回だけ入れる。このスマホのブラウザの中だけに置く
 *   - 読む：置き場所の一覧（git の tree）を10秒ごとに見て、変わったファイルだけ読み直す。読んだ中身と一覧はスマホに控え、
 *           次に開いたときは、まず控えで表示してから新しいものに入れ替える（電波が弱くてもすぐ出る）
 *   - 書く：Mac の task_server.py と同じ形のファイルを書く（キーの順番・__savedAt・消すときは _消したもの/ に移す）
 *            書いたら Mac は30秒ごとの同期で取り込む。ぶつかったときは Mac 側が __savedAt の新しいほうを残す
 *   - 開き直したいとき：アドレスの後ろに ?setup を付けると、鍵の入れ直し画面が出る
 */
(function () {
  "use strict";
  var OWNER = "nekosan222", REPO = "mirum-tasks", BRANCH = "main";
  var API = "https://api.github.com/repos/" + OWNER + "/" + REPO;
  var LS = {token: "taskPhoneToken", who: "taskPhoneWho", tags: "taskPhoneBaseTags", tagsAt: "taskPhoneBaseTagsAt",
            blobs: "taskPhoneBlobs", tree: "taskPhoneTree"};
  var POLL_MS = 10000, RECENT_MS = 90000, BLOB_PARALLEL = 12;
  var META = "__savedAt", DELETED = "_消したもの";
  var KEY_ORDER = ["id", "owner", "no", "title", "status", "workDate", "workDateEnd", "dueDate", "schedule", "summary",
                   "tags", "priority", "min", "updatedAt", "updatedBy"];
  var NAMES = {S: ["saori", "さおり"], G: ["genta", "げんた"]};
  var SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;

  function ls(k, v) {
    try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); }
    catch (e) { return null; }
  }
  var TOKEN = ls(LS.token), WHO = ls(LS.who);
  var needSetup = !TOKEN || !NAMES[WHO] || /[?&]setup\b/.test(location.search);

  function dbErr(code, message) { var e = new Error(message || code); e.code = code; return e; }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function segs(path, kind) {
    if (typeof path !== "string" || !path) throw new TypeError("path must be a non-empty string");
    var s = path.split("/");
    if (s.length > 16) throw new TypeError("path has more than 16 segments");
    s.forEach(function (x) { if (!SEG.test(x) || x.charAt(0) === ".") throw new TypeError("bad path segment: " + x); });
    if (kind === "doc" && s.length % 2) throw new TypeError("document path needs an even number of segments (" + s.length + ")");
    if (kind === "col" && !(s.length % 2)) throw new TypeError("collection path needs an odd number of segments (" + s.length + ")");
    return s;
  }
  function deepMerge(base, patch) {
    Object.keys(patch).forEach(function (k) {
      var v = patch[k];
      if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) deepMerge(base[k], v);
      else base[k] = clone(v);
    });
    return base;
  }
  function newId() {
    var a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", s = "", r = new Uint8Array(20);
    crypto.getRandomValues(r);
    for (var i = 0; i < 20; i++) s += a[r[i] % a.length];
    return s;
  }
  function pad(n, w) { n = String(n); while (n.length < (w || 2)) n = "0" + n; return n; }
  function nowIso() { // Mac と同じ形：2026-10-13T09:12:34.567+09:00
    var d = new Date(), o = -d.getTimezoneOffset(), sg = o >= 0 ? "+" : "-"; o = Math.abs(o);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" +
      pad(d.getSeconds()) + "." + pad(d.getMilliseconds(), 3) + sg + pad(Math.floor(o / 60)) + ":" + pad(o % 60);
  }
  function dumpDoc(doc) { // Mac の dump_doc と同じ（決まった順番のキー → 残りは名前順、字下げ1）
    var out = {};
    KEY_ORDER.forEach(function (k) { if (k in doc) out[k] = doc[k]; });
    Object.keys(doc).sort().forEach(function (k) { if (!(k in out)) out[k] = doc[k]; });
    return JSON.stringify(out, null, 1) + "\n";
  }
  function pub(doc) { var o = {}; Object.keys(doc || {}).forEach(function (k) { if (k !== META) o[k] = doc[k]; }); return o; }
  function b64enc(text) { var b = new TextEncoder().encode(text), s = ""; for (var i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); }
  function b64dec(b64) { var s = atob(String(b64).replace(/\s/g, "")), b = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return new TextDecoder().decode(b); }
  function enc(path) { return path.split("/").map(encodeURIComponent).join("/"); }

  // ---------------------------------------------------------------- お知らせの帯（つながらないときだけ出す）
  var bar = null;
  function say(text) {
    if (!document.body) return;
    if (!bar) {
      bar = document.createElement("div");
      bar.style.cssText = "position:fixed;left:12px;right:12px;bottom:12px;z-index:99999;padding:10px 14px;border-radius:12px;" +
        "background:#3b3036;color:#fff;font:14px/1.5 sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25);display:none";
      document.body.appendChild(bar);
    }
    bar.textContent = text || ""; bar.style.display = text ? "block" : "none";
  }

  // ---------------------------------------------------------------- GitHub とのやりとり
  function gh(method, path, body, headers) {
    var h = {"Authorization": "Bearer " + TOKEN, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"};
    Object.keys(headers || {}).forEach(function (k) { h[k] = headers[k]; });
    var opt = {method: method, headers: h, cache: "no-store"};
    if (body) { h["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
    return fetch(API + path, opt).then(function (r) {
      if (r.status === 304) return {status: 304, etag: r.headers.get("ETag")};
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.ok) { say(""); return {status: r.status, etag: r.headers.get("ETag"), json: j}; }
        if (r.status === 401) say("鍵が使えなくなっています。アドレスの最後に ?setup を付けて開き、鍵を入れ直してください");
        var e = dbErr(r.status === 409 || r.status === 422 ? "conflict" : r.status >= 500 ? "unavailable" : "invalid_argument",
                      (j && j.message) || ("HTTP " + r.status));
        e.status = r.status; throw e;
      });
    }, function () { say("GitHubにつながりません（電波を確かめてください）。つながったら自動で読み直します"); throw dbErr("unavailable", "GitHubにつながりません"); });
  }

  // ---------------------------------------------------------------- 置き場所の写し
  var tree = {};        // ファイルの場所 → 中身の印（sha）
  var treeEtag = null, treeLoaded = false, treeBusy = null;
  var blobs = {};       // 中身の印 → 中身（{…}）。スマホに控えて、次に開いたときは読まずに済ませる
  var recent = {};      // 自分が書いた直後のファイル → {sha, until}（GitHub の一覧が古いあいだ、書いた中身を見せ続ける）
  try { blobs = JSON.parse(ls(LS.blobs) || "{}") || {}; } catch (e) { blobs = {}; }
  try { var savedTree = JSON.parse(ls(LS.tree) || "null"); if (savedTree && typeof savedTree === "object") { tree = savedTree; treeLoaded = true; } } catch (e) { /* 控えが無ければ読みに行く */ }
  var saveBlobsTimer = null;
  function saveBlobs() { // 読んだそばから1秒おきに控える（途中で閉じても、そこまでは残る）
    if (saveBlobsTimer) return;
    saveBlobsTimer = setTimeout(function () {
      saveBlobsTimer = null;
      var keep = {}; Object.keys(tree).forEach(function (p) { var s = tree[p]; if (blobs[s]) keep[s] = blobs[s]; });
      Object.keys(blobs).forEach(function (s) { if (!keep[s] && blobs[s]) keep[s] = blobs[s]; });
      ls(LS.blobs, JSON.stringify(keep)); ls(LS.tree, JSON.stringify(tree));
    }, 1000);
  }
  function pruneBlobs() { // 一覧に無くなった中身は控えから外す（一覧を新しくしたときだけ）
    var keep = {}; Object.keys(tree).forEach(function (p) { var s = tree[p]; if (blobs[s]) keep[s] = blobs[s]; });
    blobs = keep; saveBlobs();
  }

  function loadTree(force) {
    if (treeBusy) return treeBusy;
    treeBusy = gh("GET", "/git/trees/" + BRANCH + "?recursive=1", null, (treeEtag && !force) ? {"If-None-Match": treeEtag} : {})
      .then(function (r) {
        if (r.status === 304) return false;
        var m = {}, now = Date.now();
        (r.json.tree || []).forEach(function (t) { if (t.type === "blob" && /\.json$/.test(t.path) && !/(^|\/)\./.test(t.path)) m[t.path] = t.sha; });
        Object.keys(recent).forEach(function (p) {
          var w = recent[p];
          if (w.until < now) { delete recent[p]; return; }
          if (w.sha) m[p] = w.sha; else delete m[p];
        });
        tree = m; treeEtag = r.etag; treeLoaded = true; pruneBlobs();
        return true;
      })
      .finally(function () { treeBusy = null; });
    return treeBusy;
  }
  function fetchBlobs(shas) {
    var todo = shas.filter(function (s, i) { return !blobs[s] && shas.indexOf(s) === i; });
    if (!todo.length) return Promise.resolve();
    var i = 0;
    function worker() {
      if (i >= todo.length) return Promise.resolve();
      var s = todo[i++];
      return gh("GET", "/git/blobs/" + s).then(function (r) {
        try { var d = JSON.parse(b64dec(r.json.content)); if (d && typeof d === "object" && !Array.isArray(d)) blobs[s] = d; } catch (e) { /* 読めないファイルは飛ばす（Mac と同じ） */ }
        saveBlobs();
      }).then(worker);
    }
    var ws = []; for (var k = 0; k < Math.min(BLOB_PARALLEL, todo.length); k++) ws.push(worker());
    return Promise.all(ws).then(saveBlobs);
  }
  function filesOf(col) { // 棚の真下の文書だけ（_ で始まるフォルダは見ない）
    var pre = col + "/", out = {};
    Object.keys(tree).forEach(function (p) {
      if (p.indexOf(pre) !== 0) return;
      var rest = p.slice(pre.length);
      if (rest.indexOf("/") >= 0) return;
      out[rest.slice(0, -5)] = tree[p];
    });
    return out;
  }

  // ---------------------------------------------------------------- 棚ごとの見え方（Mac の shim.js と同じ）
  var cols = {};      // 棚の名前 → {loaded, listeners: []}
  var pend = {};      // 文書の名前 → [{op, data}]
  function colOf(docPath) { var s = docPath.split("/"); return {col: s.slice(0, -1).join("/"), id: s[s.length - 1]}; }
  function C(name) { return cols[name] || (cols[name] = {loaded: false, listeners: []}); }
  function serverView(name) {
    var out = {}, f = filesOf(name);
    Object.keys(f).forEach(function (id) { var d = blobs[f[id]]; if (d) out[id] = pub(d); });
    return out;
  }
  function view(name) {
    var out = serverView(name);
    Object.keys(pend).forEach(function (p) {
      var w = colOf(p); if (w.col !== name) return;
      pend[p].forEach(function (e) {
        if (e.op === "set") out[w.id] = clone(e.data);
        else if (e.op === "update") { if (out[w.id]) out[w.id] = deepMerge(clone(out[w.id]), e.data); }
        else if (e.op === "delete") delete out[w.id];
      });
    });
    return out;
  }
  function hasPending(name) { return Object.keys(pend).some(function (p) { return colOf(p).col === name && pend[p].length; }); }
  function docSnap(id, data, pw) {
    var json = JSON.stringify(data);
    return {id: id, exists: data !== undefined && data !== null,
            data: function () { return data == null ? undefined : JSON.parse(json); },
            metadata: {fromCache: false, hasPendingWrites: !!pw}};
  }
  function querySnap(list, prevIds, pw) {
    var docs = list.map(function (x) { return docSnap(x.id, x.data, pw); });
    return {
      docs: docs, size: docs.length, empty: docs.length === 0, metadata: {fromCache: false, hasPendingWrites: !!pw},
      docChanges: function () {
        var out = [], now = {};
        docs.forEach(function (d, i) {
          now[d.id] = 1;
          var old = prevIds ? prevIds.indexOf(d.id) : -1;
          out.push(old < 0 ? {type: "added", doc: d, oldIndex: -1, newIndex: i} : {type: "modified", doc: d, oldIndex: old, newIndex: i});
        });
        (prevIds || []).forEach(function (id, i) { if (!now[id]) out.push({type: "removed", doc: docSnap(id, {}, false), oldIndex: i, newIndex: -1}); });
        return out;
      }
    };
  }
  function applyQuery(q, all) {
    if (q.only) return all[q.only] !== undefined ? [{id: q.only, data: all[q.only]}] : [];
    var list = Object.keys(all).sort().map(function (id) { return {id: id, data: all[id]}; });
    q.filters.forEach(function (f) {
      list = list.filter(function (x) {
        var v = x.data[f.field], w = f.value;
        switch (f.op) {
          case "==": return JSON.stringify(v) === JSON.stringify(w);
          case "!=": return v !== undefined && JSON.stringify(v) !== JSON.stringify(w);
          case "<": return v < w; case "<=": return v <= w; case ">": return v > w; case ">=": return v >= w;
          case "in": return (w || []).some(function (y) { return JSON.stringify(y) === JSON.stringify(v); });
          case "not-in": return v !== undefined && !(w || []).some(function (y) { return JSON.stringify(y) === JSON.stringify(v); });
          case "array-contains": return Array.isArray(v) && v.some(function (y) { return JSON.stringify(y) === JSON.stringify(w); });
        }
        return true;
      });
    });
    if (q.order) {
      var k = q.order.field, d = q.order.dir === "desc" ? -1 : 1;
      list.sort(function (a, b) {
        var x = a.data[k], y = b.data[k];
        if (x === undefined && y === undefined) return 0; if (x === undefined) return 1; if (y === undefined) return -1;
        return x < y ? -d : x > y ? d : 0;
      });
    }
    if (q.lim) list = list.slice(0, q.lim);
    return list;
  }
  function notify(name) {
    var c = C(name); if (!c.loaded) return;
    var all = view(name), pw = hasPending(name);
    c.listeners.slice().forEach(function (L) {
      var list = applyQuery(L.q, all), key = JSON.stringify(list);
      if (key === L.lastKey) return;
      var prev = L.lastIds; L.lastKey = key; L.lastIds = list.map(function (x) { return x.id; });
      try { L.next(L.docPath ? docSnap(L.docId, (list[0] || {}).data, pw) : querySnap(list, prev, pw)); }
      catch (e) { setTimeout(function () { throw e; }); }
    });
  }
  function notifyAll() { Object.keys(cols).forEach(notify); }

  function refresh(name, force) { // 一覧を見て、その棚で足りない中身だけ読む
    return loadTree(force).then(function () {
      var f = filesOf(name);
      return fetchBlobs(Object.keys(f).map(function (id) { return f[id]; }));
    }).then(function () { C(name).loaded = true; notify(name); });
  }
  var pollTimer = null;
  function poll() {
    clearTimeout(pollTimer);
    var names = Object.keys(cols).filter(function (n) { return cols[n].listeners.length; });
    if (!names.length || document.hidden) return;
    pollTimer = setTimeout(function () {
      loadTree().then(function (changed) {
        if (!changed) return;
        return Promise.all(names.map(function (n) { return refresh(n); }));
      }).catch(function () {}).then(poll);
    }, POLL_MS);
  }
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) { clearTimeout(pollTimer); return; }
    var names = Object.keys(cols).filter(function (n) { return cols[n].listeners.length; });
    Promise.all(names.map(function (n) { return refresh(n); })).catch(function () {}).then(poll);
  });
  function subscribe(name, q, next, error, docPath, docId) {
    var c = C(name), L = {q: q, next: next, error: error, lastKey: null, lastIds: null, docPath: docPath, docId: docId};
    c.listeners.push(L);
    Promise.resolve().then(function () {
      if (c.listeners.indexOf(L) < 0) return;
      if (!c.loaded && treeLoaded) { var f = filesOf(name); if (Object.keys(f).every(function (id) { return blobs[f[id]]; })) c.loaded = true; } // 控えだけで出せるなら先に出す
      if (c.loaded) notify(name);
      refresh(name).catch(function () {}).then(poll);
    });
    return function () { var i = c.listeners.indexOf(L); if (i >= 0) c.listeners.splice(i, 1); };
  }

  // ---------------------------------------------------------------- 書く（全部を1本の列に並べて、1つずつ GitHub に送る）
  var queue = Promise.resolve();
  function commitMsg(verb, path) { return "スマホ: " + verb + " " + path + " (" + WHO + ")"; }
  function putFile(file, text, sha, msg) {
    var body = {message: msg, content: b64enc(text), branch: BRANCH};
    if (sha) body.sha = sha;
    return gh("PUT", "/contents/" + enc(file), body).then(function (r) {
      var s = r.json.content.sha;
      tree[file] = s; recent[file] = {sha: s, until: Date.now() + RECENT_MS};
      return s;
    });
  }
  function delFile(file, sha, msg) {
    return gh("DELETE", "/contents/" + enc(file), {message: msg, sha: sha, branch: BRANCH}).then(function () {
      delete tree[file]; recent[file] = {sha: null, until: Date.now() + RECENT_MS};
    });
  }
  function current(file) { // いまの中身（無ければ null）
    var s = tree[file];
    if (!s) return Promise.resolve(null);
    return fetchBlobs([s]).then(function () { return blobs[s] ? {sha: s, doc: clone(blobs[s])} : null; });
  }
  function once(path, op, data) {
    var file = path + ".json";
    return current(file).then(function (cur) {
      if (op === "set" || op === "update") {
        var doc;
        if (op === "set") doc = clone(data);
        else { if (!cur) throw dbErr("invalid_argument", "その文書はありません"); doc = deepMerge(cur.doc, clone(data)); }
        delete doc[META]; doc[META] = nowIso();
        var text = dumpDoc(doc);
        if (text.length > 256 * 1024) throw dbErr("invalid_argument", "文書が大きすぎます（256KBまで）");
        return putFile(file, text, cur && cur.sha, commitMsg("更新", path)).then(function (s) { blobs[s] = JSON.parse(text); saveBlobs(); });
      }
      if (!cur) return; // もともと無ければ何もしない（Mac と同じ）
      var w = colOf(path), stamp = nowIso().replace(/[^0-9]/g, "").slice(0, 17);
      var dest = w.col + "/" + DELETED + "/" + w.id + "_" + stamp + ".json";
      return putFile(dest, dumpDoc(cur.doc), null, commitMsg("消した（控えに移した）", path))
        .then(function () { return delFile(file, cur.sha, commitMsg("消した", path)); })
        .then(saveBlobs);
    });
  }
  function withRetry(path, op, data, n) { // Mac と同時に書いてぶつかったら、一覧を読み直してやり直す
    return once(path, op, data).catch(function (e) {
      if (e.code !== "conflict" || n >= 3) throw e;
      return loadTree(true).then(function () { return withRetry(path, op, data, n + 1); });
    });
  }
  function write(path, op, data) {
    var w = colOf(path), e = {op: op, data: clone(data)};
    (pend[path] = pend[path] || []).push(e);
    notify(w.col);
    var run = queue.catch(function () {}).then(function () { return withRetry(path, op, data, 0); });
    queue = run;
    var drop = function () { var a = pend[path] || [], i = a.indexOf(e); if (i >= 0) a.splice(i, 1); if (!a.length) delete pend[path]; };
    return run.then(function () { drop(); notify(w.col); },
                    function (err) { drop(); notify(w.col); say("保存できませんでした：" + err.message); throw err; });
  }

  // ---------------------------------------------------------------- db の形（アーティファクトと同じ）
  function makeQuery(name, q) {
    return {
      where: function (field, op, value) { return makeQuery(name, {filters: q.filters.concat([{field: field, op: op, value: value}]), order: q.order, lim: q.lim}); },
      orderBy: function (field, dir) { return makeQuery(name, {filters: q.filters, order: {field: field, dir: dir || "asc"}, lim: q.lim}); },
      limit: function (n) { return makeQuery(name, {filters: q.filters, order: q.order, lim: n}); },
      get: function () { return refresh(name).then(function () { return querySnap(applyQuery(q, view(name)), null, hasPending(name)); }); },
      onSnapshot: function (next, error) { return subscribe(name, q, next, error); }
    };
  }
  function docRef(path) {
    var s = segs(path, "doc"), w = colOf(path);
    return {
      id: s[s.length - 1], path: path,
      get: function () { return refresh(w.col).then(function () { return docSnap(w.id, view(w.col)[w.id], !!(pend[path] || []).length); }); },
      set: function (data) { if (!data || typeof data !== "object" || Array.isArray(data)) return Promise.reject(dbErr("invalid_argument", "body must be an object")); return write(path, "set", data); },
      update: function (data) { if (!data || typeof data !== "object" || Array.isArray(data)) return Promise.reject(dbErr("invalid_argument", "body must be an object")); return write(path, "update", data); },
      delete: function () { return write(path, "delete"); },
      acquire: function () { return Promise.resolve({acquired: true, holder: "local"}); },
      onSnapshot: function (next, error) { return subscribe(w.col, {filters: [], order: null, lim: 0, only: w.id}, next, error, path, w.id); },
      collection: function (sub) { return colRef(path + "/" + sub); }
    };
  }
  function colRef(path) {
    segs(path, "col");
    var q = makeQuery(path, {filters: [], order: null, lim: 0});
    q.path = path;
    q.doc = function (id) { return docRef(path + "/" + (id || newId())); };
    q.add = function (data) { var r = docRef(path + "/" + newId()); return r.set(data).then(function () { return r; }); };
    return q;
  }
  var db = Object.freeze({doc: function (p) { return docRef(p); }, collection: function (p) { return colRef(p); }});

  // ---------------------------------------------------------------- user（「だれのスマホか」で決める）
  var COLORS = {genta: "#3d8fd9", saori: "#e7798f"};
  var ME = NAMES[WHO] || [null, ""];
  var user = Object.freeze({
    id: function () { return Promise.resolve(ME[0]); },
    me: function () { return Promise.resolve({id: ME[0], name: ME[1], avatarUrl: "", color: COLORS[ME[0]] || "#78909c", email: null, isOwner: true, canEdit: true}); },
    name: function () { return Promise.resolve(ME[1]); },
    avatarUrl: function () { return Promise.resolve(null); },
    email: function () { return Promise.resolve(null); },
    isOwner: function () { return Promise.resolve(true); },
    canEdit: function () { return Promise.resolve(true); },
    can: function () { return Promise.resolve(true); },
    profiles: function (ids) {
      var N = {genta: "げんた", saori: "さおり"}, out = {};
      (ids || []).forEach(function (id) { out[id] = {id: id, name: N[id] || "", avatarUrl: "", color: COLORS[id] || "#78909c", guest: false}; });
      return Promise.resolve(out);
    },
    search: function () { return Promise.resolve([]); }
  });

  // ---------------------------------------------------------------- タグの最初の一覧（ネットに置くページには書かず、非公開の置き場所から読む）
  function fetchBaseTags() {
    return gh("GET", "/contents/app/index.html?ref=" + BRANCH).then(function (r) {
      var m = /const BASE_TAGS = (\[[^\]]*\]);/.exec(b64dec(r.json.content));
      if (!m) return null;
      var tags = JSON.parse(m[1]);
      ls(LS.tags, JSON.stringify(tags)); ls(LS.tagsAt, String(Date.now()));
      return tags;
    });
  }

  // ---------------------------------------------------------------- 最初の設定の画面
  function setupScreen() {
    var style = "font:16px/1.6 'Zen Maru Gothic',sans-serif;color:#3b3036";
    var box = document.createElement("div");
    box.style.cssText = "position:fixed;inset:0;z-index:100000;background:#fff7f9;overflow:auto;padding:24px 16px;" + style;
    box.innerHTML =
      '<div style="max-width:440px;margin:0 auto">' +
      '<h1 style="font-size:22px;margin:0 0 8px">🐾 Task スマホ版の準備</h1>' +
      '<p style="margin:0 0 20px;font-size:14px">最初の1回だけです。ここで入れたものは、このスマホの中だけに置かれます。</p>' +
      '<p style="margin:0 0 6px;font-weight:700">1. だれのスマホですか？</p>' +
      '<label style="display:block;padding:10px 12px;border:1px solid #e3c6cf;border-radius:10px;margin-bottom:8px;background:#fff">' +
      '<input type="radio" name="who" value="S"> さおり</label>' +
      '<label style="display:block;padding:10px 12px;border:1px solid #e3c6cf;border-radius:10px;margin-bottom:20px;background:#fff">' +
      '<input type="radio" name="who" value="G"> げんた</label>' +
      '<p style="margin:0 0 6px;font-weight:700">2. 鍵（GitHubのトークン）を貼ってください</p>' +
      '<input id="tok" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="github_pat_…" ' +
      'style="width:100%;box-sizing:border-box;padding:12px;border:1px solid #e3c6cf;border-radius:10px;font-size:16px;margin-bottom:20px">' +
      '<button id="go" style="width:100%;padding:14px;border:0;border-radius:12px;background:#e7798f;color:#fff;font-size:17px;font-weight:700">はじめる</button>' +
      '<p id="msg" style="margin:16px 0 0;font-size:14px;color:#c2185b;min-height:1.6em"></p>' +
      '</div>';
    document.body.appendChild(box);
    if (NAMES[WHO]) box.querySelector('input[value="' + WHO + '"]').checked = true;
    box.querySelector("#go").onclick = function () {
      var who = (box.querySelector('input[name="who"]:checked') || {}).value, tok = box.querySelector("#tok").value.trim(), msg = box.querySelector("#msg");
      if (!who) { msg.textContent = "1. だれのスマホかを選んでください"; return; }
      if (!tok) { msg.textContent = "2. 鍵を貼ってください"; return; }
      msg.style.color = "#3b3036"; msg.textContent = "確かめています…";
      TOKEN = tok;
      gh("GET", "/git/trees/" + BRANCH).then(function () { return fetchBaseTags(); }).then(function () {
        ls(LS.token, tok); ls(LS.who, who);
        location.replace(location.pathname);
      }).catch(function (e) {
        msg.style.color = "#c2185b";
        msg.textContent = e.status === 401 ? "この鍵は使えません。貼り間違いがないか、期限が切れていないかを確かめてください"
          : e.status === 404 || e.status === 403 ? "この鍵では、タスクの置き場所が見られません。鍵を作るときに mirum-tasks を選んだかを確かめてください"
          : "GitHubにつながりません。電波を確かめてから、もう一度押してください";
      });
    };
  }

  // ---------------------------------------------------------------- window.claude
  var caps = {db: db, user: user};
  var memo = {};
  window.claude = Object.freeze({
    use: function (name) {
      if (needSetup) return new Promise(function () {}); // 準備が終わるまでページは待つ
      if (!memo[name]) memo[name] = new Promise(function (res) { setTimeout(function () { res(caps[name] || null); }, 0); });
      return memo[name];
    }
  });
  document.addEventListener("DOMContentLoaded", function () {
    if (needSetup) { setupScreen(); return; }
    var at = Number(ls(LS.tagsAt) || 0);
    if (Date.now() - at > 24 * 3600 * 1000) fetchBaseTags().catch(function () {});
  });
})();
