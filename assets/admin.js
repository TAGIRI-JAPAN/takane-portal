/* 管理ページ — ブラウザから GitHub Contents API へ直接コミットする */
(() => {
  'use strict';

  const OWNER = 'TAGIRI-JAPAN';
  const REPO = 'takane-portal';
  const BRANCH = 'main';
  const API = 'https://api.github.com';
  const VAULT_PATH = 'data/vault.json';
  const SITE_PATH = 'data/site.json';
  const MAX_PDF = 25 * 1024 * 1024;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const fmtSize = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  const today = () => new Date().toISOString().slice(0, 10);

  let token = sessionStorage.getItem('tp_token') || '';
  let site = null;
  let dirty = false;

  /* ---------- toast / status ---------- */
  let toastTimer;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }
  function setDirty(v) {
    dirty = v;
    $('saveBtn').disabled = !v;
    const s = $('status');
    s.textContent = v ? '未保存の変更があります' : '';
    s.classList.toggle('dirty', v);
  }
  window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  /* ---------- crypto ---------- */
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  async function deriveKey(pass, salt) {
    const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function sealToken(tok, pass) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(pass, salt);
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(tok));
    return { v: 1, salt: b64(salt), iv: b64(iv), data: b64(data) };
  }
  async function openVault(vault, pass) {
    const key = await deriveKey(pass, unb64(vault.salt));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(vault.iv) }, key, unb64(vault.data));
    return dec.decode(plain);
  }

  /* ---------- GitHub API ---------- */
  async function gh(method, path, body, tok = token) {
    const res = await fetch(API + path, {
      method,
      headers: { Authorization: 'Bearer ' + tok, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 204) return null;
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(json.message || ('HTTP ' + res.status)); e.status = res.status; throw e; }
    return json;
  }
  const contentsUrl = (p) => `/repos/${OWNER}/${REPO}/contents/${p.split('/').map(encodeURIComponent).join('/')}`;
  async function getSha(path) {
    try { const r = await gh('GET', contentsUrl(path) + '?ref=' + BRANCH); return r.sha; }
    catch (e) { if (e.status === 404) return null; throw e; }
  }
  async function putFile(path, base64, message) {
    const sha = await getSha(path);
    const r = await gh('PUT', contentsUrl(path), { message, content: base64, branch: BRANCH, ...(sha ? { sha } : {}) });
    return r.content.sha;
  }
  async function deleteFile(path, message) {
    const sha = await getSha(path);
    if (!sha) return;
    await gh('DELETE', contentsUrl(path), { message, sha, branch: BRANCH });
  }
  async function verifyToken(tok) {
    const r = await gh('GET', `/repos/${OWNER}/${REPO}`, null, tok);
    if (!r.permissions || !r.permissions.push) throw new Error('このトークンには書き込み権限がありません（Contents: Read and write が必要）');
  }
  const blobToBase64 = (blob) => new Promise((ok, ng) => { const fr = new FileReader(); fr.onload = () => ok(fr.result.split(',')[1]); fr.onerror = ng; fr.readAsDataURL(blob); });
  const siteJsonB64 = () => b64(enc.encode(JSON.stringify(site, null, 2) + '\n'));

  /* ---------- views ---------- */
  function show(view) {
    for (const v of ['viewLogin', 'viewSetup', 'viewDash']) $(v).hidden = v !== view;
    $('logoutBtn').hidden = view !== 'viewDash';
  }
  async function loadVault() {
    const r = await fetch(VAULT_PATH + '?v=' + Date.now(), { cache: 'no-store' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('vault の読み込みに失敗しました');
    return r.json();
  }
  async function boot() {
    $('actionsLink').href = `https://github.com/${OWNER}/${REPO}/actions`;
    if (token) {
      try { await verifyToken(token); return enter(); } catch (e) { token = ''; sessionStorage.removeItem('tp_token'); }
    }
    let vault = null;
    try { vault = await loadVault(); } catch (e) { $('loginErr').textContent = e.message; }
    if (!vault) {
      // 直後のデプロイ待ちで 404 の可能性もあるので、API 側も確認
      show('viewSetup');
    } else {
      show('viewLogin'); $('loginPass').focus();
    }
  }
  async function enter() {
    show('viewDash');
    $('status').textContent = '読み込み中…';
    try {
      const r = await gh('GET', contentsUrl(SITE_PATH) + '?ref=' + BRANCH);
      site = JSON.parse(dec.decode(unb64(r.content.replace(/\n/g, ''))));
    } catch (e) {
      site = { profile: {}, documents: [], links: [], images: [] };
    }
    site.documents ||= []; site.links ||= []; site.images ||= []; site.videos ||= []; site.profile ||= {};
    renderAll();
    setDirty(false);
  }

  /* ---------- login / setup ---------- */
  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button'); btn.disabled = true; $('loginErr').textContent = '';
    try {
      const vault = await loadVault();
      if (!vault) { show('viewSetup'); return; }
      const tok = await openVault(vault, $('loginPass').value).catch(() => { throw new Error('パスワードが違います'); });
      await verifyToken(tok);
      token = tok; sessionStorage.setItem('tp_token', tok);
      $('loginPass').value = '';
      enter();
    } catch (err) { $('loginErr').textContent = err.message; }
    finally { btn.disabled = false; }
  });

  $('setupForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button'); btn.disabled = true; $('setupErr').textContent = '';
    try {
      const tok = $('setupToken').value.trim(), p1 = $('setupPass').value, p2 = $('setupPass2').value;
      if (p1 !== p2) throw new Error('パスワードが一致しません');
      await verifyToken(tok);
      if (await getShaWith(tok, VAULT_PATH)) throw new Error('すでに設定済みです。ログイン画面からパスワードでログインしてください。');
      const vault = await sealToken(tok, p1);
      await gh('PUT', contentsUrl(VAULT_PATH), { message: '初回設定', content: b64(enc.encode(JSON.stringify(vault) + '\n')), branch: BRANCH }, tok);
      token = tok; sessionStorage.setItem('tp_token', tok);
      e.target.reset();
      toast('設定しました');
      enter();
    } catch (err) { $('setupErr').textContent = err.message; }
    finally { btn.disabled = false; }
  });
  async function getShaWith(tok, path) {
    try { const r = await gh('GET', contentsUrl(path) + '?ref=' + BRANCH, null, tok); return r.sha; }
    catch (e) { if (e.status === 404) return null; throw e; }
  }

  $('logoutBtn').addEventListener('click', () => {
    if (dirty && !confirm('未保存の変更があります。ログアウトしますか？')) return;
    token = ''; sessionStorage.removeItem('tp_token'); dirty = false; location.reload();
  });

  /* ---------- settings ---------- */
  $('passForm').addEventListener('submit', async e => {
    e.preventDefault(); $('passErr').textContent = '';
    try {
      const vault = await loadVault();
      const tok = await openVault(vault, $('chgOld').value).catch(() => { throw new Error('現在のパスワードが違います'); });
      const nv = await sealToken(tok, $('chgNew').value);
      await putFile(VAULT_PATH, b64(enc.encode(JSON.stringify(nv) + '\n')), 'パスワード変更');
      e.target.reset(); toast('パスワードを変更しました（反映まで1〜2分）');
    } catch (err) { $('passErr').textContent = err.message; }
  });
  $('tokenForm').addEventListener('submit', async e => {
    e.preventDefault(); $('tokenErr').textContent = '';
    try {
      const tok = $('newToken').value.trim();
      await verifyToken(tok);
      const vault = await loadVault();
      await openVault(vault, $('tokenPass').value).catch(() => { throw new Error('パスワードが違います'); });
      const nv = await sealToken(tok, $('tokenPass').value);
      await gh('PUT', contentsUrl(VAULT_PATH), { message: 'トークン更新', content: b64(enc.encode(JSON.stringify(nv) + '\n')), branch: BRANCH, sha: await getShaWith(tok, VAULT_PATH) }, tok);
      token = tok; sessionStorage.setItem('tp_token', tok);
      e.target.reset(); toast('トークンを入れ替えました');
    } catch (err) { $('tokenErr').textContent = err.message; }
  });

  /* ---------- tabs ---------- */
  $('tabs').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
    document.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.dataset.pane === b.dataset.tab));
  });

  /* ---------- save ---------- */
  $('saveBtn').addEventListener('click', async () => {
    readProfileForm();
    $('saveBtn').disabled = true; $('status').textContent = '保存中…';
    try {
      await putFile(SITE_PATH, siteJsonB64(), '内容を更新');
      setDirty(false);
      $('status').textContent = '保存しました。1〜2分で公開ページに反映されます';
      toast('保存しました');
    } catch (e) { $('status').textContent = ''; setDirty(true); toast('保存に失敗: ' + e.message); }
  });

  /* ---------- image helpers ---------- */
  function loadImage(file) {
    return new Promise((ok, ng) => { const url = URL.createObjectURL(file); const im = new Image(); im.onload = () => { URL.revokeObjectURL(url); ok(im); }; im.onerror = ng; im.src = url; });
  }
  async function shrinkImage(file, max) {
    if (/gif|svg/.test(file.type)) return { blob: file, ext: file.name.split('.').pop().toLowerCase() };
    const im = await loadImage(file);
    const scale = Math.min(1, max / Math.max(im.width, im.height));
    const c = document.createElement('canvas');
    c.width = Math.round(im.width * scale); c.height = Math.round(im.height * scale);
    c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    const keepPng = file.type === 'image/png' && file.size < 600 * 1024;
    const blob = await new Promise(ok => c.toBlob(ok, keepPng ? 'image/png' : 'image/jpeg', 0.86));
    return { blob, ext: keepPng ? 'png' : 'jpg' };
  }
  async function pdfThumb(file) {
    if (!window.pdfjsLib) return null;
    try {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
      const page = await pdf.getPage(1);
      const vp0 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: 360 / vp0.width });
      const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      return await new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.82));
    } catch (e) { return null; }
  }
  function bindDrop(dropEl, inputEl, pickBtn, handler) {
    pickBtn.addEventListener('click', () => inputEl.click());
    inputEl.addEventListener('change', () => { handler([...inputEl.files]); inputEl.value = ''; });
    ['dragenter', 'dragover'].forEach(ev => dropEl.addEventListener(ev, e => { e.preventDefault(); dropEl.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => dropEl.addEventListener(ev, e => { e.preventDefault(); dropEl.classList.remove('over'); }));
    dropEl.addEventListener('drop', e => handler([...e.dataTransfer.files]));
  }
  const safeName = (name) => name.replace(/\.[^.]+$/, '').replace(/[^\w\-一-龠ぁ-んァ-ン]/g, '-').slice(0, 40);

  /* ---------- list helpers ---------- */
  function move(arr, i, d) { const j = i + d; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; }
  const toolsHtml = (i, n, extra = '') =>
    `<div class="tools">${extra}<button class="icon" data-act="up" ${i === 0 ? 'disabled' : ''} title="上へ">↑</button><button class="icon" data-act="down" ${i === n - 1 ? 'disabled' : ''} title="下へ">↓</button><button class="icon danger" data-act="del">削除</button></div>`;

  /* ---------- documents ---------- */
  function renderDocs() {
    const list = site.documents;
    $('docItems').innerHTML = list.length ? list.map((d, i) => `
      <li class="item" data-i="${i}">
        <div class="thumb">${d.thumb ? `<img src="${esc(d.thumb)}" alt="">` : 'PDF'}</div>
        <div class="fields">
          <input data-f="title" value="${esc(d.title)}" placeholder="タイトル">
          <input data-f="description" value="${esc(d.description || '')}" placeholder="説明（任意）">
          <div class="file">${esc(d.file)}　${esc(d.size || '')}　${esc(d.date || '')}</div>
        </div>
        ${toolsHtml(i, list.length)}
      </li>`).join('') : '<li class="hint">まだ資料がありません。</li>';
  }
  async function addDocs(files) {
    for (const f of files) {
      if (!/pdf$/i.test(f.name) && f.type !== 'application/pdf') { toast(f.name + ' はPDFではありません'); continue; }
      if (f.size > MAX_PDF) { toast(f.name + ' は25MBを超えています'); continue; }
      const id = uid();
      const path = `uploads/docs/${id}-${safeName(f.name)}.pdf`;
      const li = document.createElement('li'); li.className = 'item uploading';
      li.innerHTML = `<div class="thumb">PDF</div><div class="fields"><strong>${esc(f.name)}</strong><span class="prog">アップロード中…</span></div><div></div>`;
      $('docItems').prepend(li);
      try {
        const thumbBlob = await pdfThumb(f);
        await putFile(path, await blobToBase64(f), '資料を追加: ' + f.name);
        let thumb = '';
        if (thumbBlob) { thumb = `uploads/thumbs/${id}.jpg`; await putFile(thumb, await blobToBase64(thumbBlob), 'サムネイル: ' + f.name); }
        site.documents.unshift({ id, title: f.name.replace(/\.pdf$/i, ''), description: '', file: path, thumb, size: fmtSize(f.size), date: today() });
        setDirty(true); renderDocs(); toast(f.name + ' を追加しました');
      } catch (e) { li.remove(); toast('失敗: ' + e.message); }
    }
  }
  bindDrop($('docDrop'), $('docFile'), $('docPick'), addDocs);
  $('docItems').addEventListener('input', e => {
    const li = e.target.closest('.item'); const f = e.target.dataset.f; if (!li || !f) return;
    site.documents[+li.dataset.i][f] = e.target.value; setDirty(true);
  });
  $('docItems').addEventListener('click', async e => {
    const b = e.target.closest('button[data-act]'); const li = e.target.closest('.item'); if (!b || !li) return;
    const i = +li.dataset.i, d = site.documents[i];
    if (b.dataset.act === 'del') {
      if (!confirm(`「${d.title}」を削除しますか？ファイルも消えます。`)) return;
      b.disabled = true;
      try { await deleteFile(d.file, '資料を削除: ' + d.title); if (d.thumb) await deleteFile(d.thumb, 'サムネイル削除'); }
      catch (err) { toast('削除に失敗: ' + err.message); b.disabled = false; return; }
      site.documents.splice(i, 1);
    } else move(site.documents, i, b.dataset.act === 'up' ? -1 : 1);
    setDirty(true); renderDocs();
  });

  /* ---------- videos ---------- */
  const MAX_VIDEO = 60 * 1024 * 1024;
  function fmtDur(sec) { sec = Math.round(sec); return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); }
  function videoPoster(file, at = 1.5) {
    return new Promise((ok) => {
      const url = URL.createObjectURL(file); const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
      let done = false;
      const finish = (blob, dur) => { if (done) return; done = true; URL.revokeObjectURL(url); ok({ blob, duration: dur }); };
      v.addEventListener('loadedmetadata', () => { v.currentTime = Math.min(at, Math.max(0, v.duration - 0.1)); });
      v.addEventListener('seeked', () => {
        try {
          const c = document.createElement('canvas'); const s = Math.min(1, 960 / v.videoWidth);
          c.width = Math.round(v.videoWidth * s); c.height = Math.round(v.videoHeight * s);
          c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
          c.toBlob(b => finish(b, v.duration), 'image/jpeg', 0.82);
        } catch (e) { finish(null, v.duration); }
      });
      v.addEventListener('error', () => finish(null, 0));
      setTimeout(() => finish(null, v.duration || 0), 15000);
    });
  }
  function renderVideos() {
    const list = site.videos;
    $('vidItems').innerHTML = list.length ? list.map((v, i) => `
      <li class="item l-wide" data-i="${i}">
        <div class="thumb wide">${v.poster ? `<img src="${esc(v.poster)}" alt="">` : '動画'}</div>
        <div class="fields">
          <input data-f="title" value="${esc(v.title)}" placeholder="タイトル">
          <input data-f="description" value="${esc(v.description || '')}" placeholder="説明（任意）">
          <div class="file">${esc(v.file)}　${esc(v.duration || '')}</div>
        </div>
        ${toolsHtml(i, list.length, '<button class="icon" data-act="poster" title="サムネイル画像を差し替え">サムネ</button>')}
      </li>`).join('') : '<li class="hint">まだ動画がありません。</li>';
  }
  async function addVideos(files) {
    for (const f of files) {
      if (!/\.(mp4|mov|m4v)$/i.test(f.name)) { toast(f.name + ' はmp4ではありません'); continue; }
      if (f.size > MAX_VIDEO) { toast(f.name + ' は60MBを超えています'); continue; }
      const id = uid();
      const path = `uploads/videos/${id}-${safeName(f.name)}.mp4`;
      const li = document.createElement('li'); li.className = 'item uploading';
      li.innerHTML = `<div class="thumb wide">動画</div><div class="fields"><strong>${esc(f.name)}</strong><span class="prog">サムネイル作成中…</span></div><div></div>`;
      $('vidItems').prepend(li);
      try {
        const { blob, duration } = await videoPoster(f);
        li.querySelector('.prog').textContent = 'アップロード中…（' + fmtSize(f.size) + '、数分かかることがあります）';
        await putFile(path, await blobToBase64(f), '動画を追加: ' + f.name);
        let poster = '';
        if (blob) { poster = `uploads/posters/${id}.jpg`; await putFile(poster, await blobToBase64(blob), 'サムネイル: ' + f.name); }
        site.videos.push({ id, title: f.name.replace(/\.[^.]+$/, ''), description: '', file: path, poster, duration: duration ? fmtDur(duration) : '' });
        setDirty(true); renderVideos(); toast(f.name + ' を追加しました');
      } catch (e) { li.remove(); toast('失敗: ' + e.message); }
    }
  }
  bindDrop($('vidDrop'), $('vidFile'), $('vidPick'), addVideos);
  $('vidItems').addEventListener('input', e => {
    const li = e.target.closest('.item'); const f = e.target.dataset.f; if (!li || !f) return;
    site.videos[+li.dataset.i][f] = e.target.value; setDirty(true);
  });
  $('vidItems').addEventListener('click', async e => {
    const b = e.target.closest('button[data-act]'); const li = e.target.closest('.item'); if (!b || !li) return;
    const i = +li.dataset.i, v = site.videos[i];
    if (b.dataset.act === 'poster') {
      const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
      inp.onchange = async () => {
        const f = inp.files[0]; if (!f) return;
        b.disabled = true; b.textContent = '送信中';
        try {
          const { blob } = await shrinkImage(f, 1280);
          const path = `uploads/posters/${v.id}.jpg`;
          await putFile(path, await blobToBase64(blob), 'サムネイル差し替え: ' + v.title);
          v.poster = path + '?v=' + Date.now().toString(36);
          setDirty(true); renderVideos(); toast('サムネイルを差し替えました');
        } catch (err) { toast('失敗: ' + err.message); renderVideos(); }
      };
      inp.click(); return;
    }
    if (b.dataset.act === 'del') {
      if (!confirm(`「${v.title}」を削除しますか？動画ファイルも消えます。`)) return;
      b.disabled = true;
      try { await deleteFile(v.file, '動画を削除: ' + v.title); if (v.poster) await deleteFile(v.poster.split('?')[0], 'サムネイル削除'); }
      catch (err) { toast('削除に失敗: ' + err.message); b.disabled = false; return; }
      site.videos.splice(i, 1);
    } else move(site.videos, i, b.dataset.act === 'up' ? -1 : 1);
    setDirty(true); renderVideos();
  });

  /* ---------- links ---------- */
  function renderLinks() {
    const list = site.links;
    $('linkItems').innerHTML = list.length ? list.map((l, i) => `
      <li class="item l-wide" data-i="${i}">
        <div class="thumb wide">${l.image ? `<img src="${esc(l.image)}" alt="">` : '画像なし'}</div>
        <div class="fields">
          <input data-f="title" value="${esc(l.title)}" placeholder="サイト名">
          <input data-f="url" value="${esc(l.url)}" placeholder="https://">
          <input data-f="description" value="${esc(l.description || '')}" placeholder="説明（任意）">
        </div>
        ${toolsHtml(i, list.length, '<button class="icon" data-act="img" title="カバー画像">画像</button>')}
      </li>`).join('') : '<li class="hint">まだリンクがありません。</li>';
  }
  $('linkForm').addEventListener('submit', e => {
    e.preventDefault();
    site.links.push({ id: uid(), title: $('linkTitle').value.trim(), url: $('linkUrl').value.trim(), description: $('linkDesc').value.trim(), image: '' });
    e.target.reset(); setDirty(true); renderLinks();
  });
  $('linkItems').addEventListener('input', e => {
    const li = e.target.closest('.item'); const f = e.target.dataset.f; if (!li || !f) return;
    site.links[+li.dataset.i][f] = e.target.value; setDirty(true);
  });
  $('linkItems').addEventListener('click', async e => {
    const b = e.target.closest('button[data-act]'); const li = e.target.closest('.item'); if (!b || !li) return;
    const i = +li.dataset.i, l = site.links[i];
    if (b.dataset.act === 'img') {
      const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
      inp.onchange = async () => {
        const f = inp.files[0]; if (!f) return;
        b.disabled = true; b.textContent = '送信中';
        try {
          const { blob, ext } = await shrinkImage(f, 1200);
          const path = `uploads/links/${l.id}.${ext}`;
          await putFile(path, await blobToBase64(blob), 'リンク画像: ' + l.title);
          l.image = path + '?v=' + Date.now().toString(36);
          setDirty(true); renderLinks(); toast('画像を設定しました');
        } catch (err) { toast('失敗: ' + err.message); renderLinks(); }
      };
      inp.click(); return;
    }
    if (b.dataset.act === 'del') {
      if (!confirm(`「${l.title}」を削除しますか？`)) return;
      if (l.image) { try { await deleteFile(l.image.split('?')[0], 'リンク画像削除'); } catch (err) {} }
      site.links.splice(i, 1);
    } else move(site.links, i, b.dataset.act === 'up' ? -1 : 1);
    setDirty(true); renderLinks();
  });

  /* ---------- images ---------- */
  function renderImages() {
    const list = site.images;
    $('imgItems').innerHTML = list.length ? list.map((im, i) => `
      <li class="item" data-i="${i}">
        <div class="thumb"><img src="${esc(im.file)}" alt=""></div>
        <div class="fields"><input data-f="caption" value="${esc(im.caption || '')}" placeholder="説明（任意）"></div>
        ${toolsHtml(i, list.length)}
      </li>`).join('') : '<li class="hint">まだ写真がありません。</li>';
  }
  async function addImages(files) {
    for (const f of files) {
      if (!f.type.startsWith('image/')) { toast(f.name + ' は画像ではありません'); continue; }
      const id = uid();
      try {
        const { blob, ext } = await shrinkImage(f, 1800);
        const path = `uploads/images/${id}.${ext}`;
        toast(f.name + ' をアップロード中…');
        await putFile(path, await blobToBase64(blob), '写真を追加: ' + f.name);
        site.images.unshift({ id, file: path, caption: '' });
        setDirty(true); renderImages(); toast(f.name + ' を追加しました');
      } catch (e) { toast('失敗: ' + e.message); }
    }
  }
  bindDrop($('imgDrop'), $('imgFile'), $('imgPick'), addImages);
  $('imgItems').addEventListener('input', e => {
    const li = e.target.closest('.item'); if (!li || e.target.dataset.f !== 'caption') return;
    site.images[+li.dataset.i].caption = e.target.value; setDirty(true);
  });
  $('imgItems').addEventListener('click', async e => {
    const b = e.target.closest('button[data-act]'); const li = e.target.closest('.item'); if (!b || !li) return;
    const i = +li.dataset.i, im = site.images[i];
    if (b.dataset.act === 'del') {
      if (!confirm('この写真を削除しますか？')) return;
      b.disabled = true;
      try { await deleteFile(im.file, '写真を削除'); } catch (err) { toast('削除に失敗: ' + err.message); b.disabled = false; return; }
      site.images.splice(i, 1);
    } else move(site.images, i, b.dataset.act === 'up' ? -1 : 1);
    setDirty(true); renderImages();
  });

  /* ---------- profile ---------- */
  const PF = { pName: 'name', pReading: 'reading', pTitle: 'title', pTagline: 'tagline', pLead: 'lead', pEmail: 'email', pPhone: 'phone', pWebsite: 'website', pMessage: 'message' };
  function renderProfile() {
    const p = site.profile;
    for (const [id, k] of Object.entries(PF)) $(id).value = p[k] || '';
    $('pTimeline').value = (p.timeline || []).map(t => `${t.year} | ${t.text}`).join('\n');
    $('profPhoto').innerHTML = p.photo ? `<img src="${esc(p.photo)}" alt="">` : '写真なし';
    $('pCutout').checked = !!p.photoCutout;
    $('pIntro').checked = p.intro !== false;
  }
  function readProfileForm() {
    if (!site) return;
    const p = site.profile;
    for (const [id, k] of Object.entries(PF)) p[k] = $(id).value.trim();
    p.photoCutout = $('pCutout').checked;
    p.intro = $('pIntro').checked;
    p.timeline = $('pTimeline').value.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
      const m = l.match(/^(.*?)\s*[|｜]\s*(.*)$/); return m ? { year: m[1].trim(), text: m[2].trim() } : { year: '', text: l };
    });
  }
  document.querySelector('[data-pane="profile"]').addEventListener('input', () => setDirty(true));
  $('profPhotoPick').addEventListener('click', () => $('profPhotoFile').click());
  $('profPhotoFile').addEventListener('change', async () => {
    const f = $('profPhotoFile').files[0]; $('profPhotoFile').value = ''; if (!f) return;
    try {
      const { blob, ext } = await shrinkImage(f, 1200);
      const path = `uploads/profile/${uid()}.${ext}`;
      toast('写真をアップロード中…');
      await putFile(path, await blobToBase64(blob), 'プロフィール写真');
      const old = site.profile.photo;
      site.profile.photo = path;
      if (old) { try { await deleteFile(old.split('?')[0], '旧プロフィール写真を削除'); } catch (e) {} }
      setDirty(true); renderProfile(); toast('写真を変更しました');
    } catch (e) { toast('失敗: ' + e.message); }
  });
  $('profPhotoClear').addEventListener('click', () => { site.profile.photo = ''; setDirty(true); renderProfile(); });

  function renderAll() { renderDocs(); renderVideos(); renderLinks(); renderImages(); renderProfile(); }

  boot();
})();
