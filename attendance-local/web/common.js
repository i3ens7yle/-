/* ใช้ร่วมกันทุกหน้า: เรียก API, กล้อง, ขั้นตอนลงเวลา */
(function (g) {
  'use strict';

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad(n) { return ('0' + n).slice(-2); }

  function api(path, body) {
    var opts = { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store' };
    if (body !== undefined) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function (res) {
      return res.json().catch(function () {
        var e = new Error('คอมของร้านตอบกลับผิดพลาด กรุณาลองใหม่'); e.code = 'NET'; throw e;
      });
    }, function () {
      var e = new Error('เชื่อมต่อคอมของร้านไม่ได้ — ต่อ Wi-Fi ของร้านอยู่ไหม และคอมเปิดโปรแกรมอยู่หรือเปล่า');
      e.code = 'NET';
      throw e;
    }).then(function (d) {
      if (!d || !d.ok) {
        var e = new Error((d && d.error) || 'เกิดข้อผิดพลาด กรุณาลองใหม่');
        e.code = (d && d.code) || '';
        throw e;
      }
      return d;
    });
  }

  var store = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };

  function header(shop) {
    return '<header class="top"><div class="shop">' + esc(shop) + '</div><div class="clock" data-clock></div></header>';
  }
  function tickClock() {
    var d = new Date();
    var t = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    $$('[data-clock]').forEach(function (el) { el.textContent = t; });
  }
  setInterval(tickClock, 1000);

  function notice(icon, title, text, retry) {
    return '<div class="card notice"><div class="icon">' + icon + '</div><h2>' + esc(title) + '</h2>' +
      '<p class="muted">' + esc(text) + '</p>' + (retry ? '<button class="btn primary" data-retry>ลองใหม่</button>' : '') + '</div>';
  }

  // ───── รหัสประจำเครื่อง (สุ่มครั้งแรกแล้วจำไว้ในมือถือ) ─────
  var ALPHA = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  var DEV_RE = /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;
  var devMemo = null;
  function deviceInfo() {
    if (devMemo) return devMemo;
    var id = store.get('att_dev');
    if (!DEV_RE.test(id || '')) {
      var a = new Uint8Array(8);
      (g.crypto || g.msCrypto).getRandomValues(a);
      id = '';
      for (var i = 0; i < 8; i++) id += ALPHA[a[i] % 32] + (i === 3 ? '-' : '');
      store.set('att_dev', id);
    }
    devMemo = { id: id, name: deviceName() };
    return devMemo;
  }
  function deviceName() {
    var ua = navigator.userAgent;
    var os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
      : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'อื่น ๆ';
    var m = /Android [\d.]+; ([^;)]+)\)/.exec(ua);
    if (m && m[1].trim() !== 'K') os += ' ' + m[1].trim();
    var br = / Line\//i.test(ua) ? 'LINE' : /FBAN|FBAV/.test(ua) ? 'Facebook' : /SamsungBrowser/.test(ua) ? 'Samsung'
      : /EdgA?\//.test(ua) ? 'Edge' : /CriOS|Chrome/.test(ua) ? 'Chrome' : /FxiOS|Firefox/.test(ua) ? 'Firefox'
      : /Safari/.test(ua) ? 'Safari' : 'เบราว์เซอร์';
    return os + ' · ' + br;
  }

  // ───── รูปเซลฟี่ ─────
  function toJpeg(src, w, h, max, quality, square) {
    var sx = 0, sy = 0;
    if (square) { var side = Math.min(w, h); sx = (w - side) / 2; sy = (h - side) / 2; w = h = side; }
    var s = Math.min(1, max / Math.max(w, h));
    var c = document.createElement('canvas');
    c.width = Math.round(w * s);
    c.height = Math.round(h * s);
    c.getContext('2d').drawImage(src, sx, sy, w, h, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  }
  function both(src, w, h) { return { full: toJpeg(src, w, h, 640, 0.72), thumb: toJpeg(src, w, h, 240, 0.7, true) }; }

  var fileInput = null;
  function fromFile() {
    return new Promise(function (resolve, reject) {
      if (!fileInput) {
        fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        fileInput.setAttribute('capture', 'user');
        fileInput.className = 'hidden';
        document.body.appendChild(fileInput);
      }
      fileInput.value = '';
      fileInput.onchange = function () {
        var f = fileInput.files && fileInput.files[0];
        if (!f) return reject(new Error(''));
        var url = URL.createObjectURL(f);
        var img = new Image();
        img.onload = function () { URL.revokeObjectURL(url); resolve(both(img, img.width, img.height)); };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('อ่านรูปไม่ได้ กรุณาถ่ายใหม่')); };
        img.src = url;
      };
      fileInput.click();
    });
  }

  // กล้องเว็บแคม (ใช้ได้บนคอมเครื่องแม่ที่เปิดผ่าน localhost)
  function fromWebcam() {
    return navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 960 } }, audio: false }).then(function (stream) {
      return new Promise(function (resolve, reject) {
        var box = document.createElement('div');
        box.className = 'cam';
        box.innerHTML = '<div class="box"><video autoplay playsinline muted></video>' +
          '<div class="row"><button class="btn" data-cancel>ยกเลิก</button><button class="btn green" data-snap>📷 ถ่าย</button></div></div>';
        document.body.appendChild(box);
        var video = $('video', box);
        video.srcObject = stream;
        function close() { stream.getTracks().forEach(function (t) { t.stop(); }); box.remove(); }
        $('[data-cancel]', box).onclick = function () { close(); reject(new Error('')); };
        $('[data-snap]', box).onclick = function () {
          var w = video.videoWidth, h = video.videoHeight;
          if (!w) return;
          var r = both(video, w, h);
          close();
          resolve(r);
        };
      });
    }, function () {
      throw new Error('เปิดกล้องของเครื่องนี้ไม่ได้ (ไม่มีกล้อง หรือไม่ได้อนุญาต) — กดลงเวลาโดยไม่ถ่ายรูปได้');
    });
  }

  function takePhoto(preferWebcam) {
    if (preferWebcam && g.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) return fromWebcam();
    return fromFile();
  }

  // ───── ขั้นตอนลงเวลา (มือถือ และหน้าจอร้าน) ─────
  // opts: { adapter:{employees,login,punch}, remember, photo:'required'|'optional', webcam, onDone }
  function createFlow(root, opts) {
    var st = { employees: null, id: '', pin: '', remember: true, info: null, photo: null, thumb: null };

    function busy(on) { $$('button, input, select', root).forEach(function (b) { b.disabled = on; }); }
    function loading() { root.innerHTML = '<div class="card"><div class="spinner"></div></div>'; }

    function showLogin(msg) {
      if (!st.employees) {
        loading();
        opts.adapter.employees().then(function (r) {
          st.employees = r.employees || [];
          showLogin(msg);
        }).catch(function (e) {
          root.innerHTML = notice('📶', 'โหลดรายชื่อไม่ได้', e.message, true);
          $('[data-retry]', root).onclick = function () { showLogin(); };
        });
        return;
      }
      if (!st.employees.length) {
        root.innerHTML = notice('👥', 'ยังไม่มีรายชื่อพนักงาน', 'เจ้าของร้านต้องเพิ่มพนักงานในหน้าเจ้าของร้านก่อน');
        return;
      }
      var options = st.employees.map(function (e) {
        return '<option value="' + esc(e.id) + '"' + (e.id === st.id ? ' selected' : '') + '>' + esc(e.name) + '</option>';
      }).join('');
      root.innerHTML =
        '<form class="card" data-login>' +
          '<h2>ลงเวลาทำงาน</h2>' +
          '<p class="muted small" style="margin:0">เลือกชื่อของคุณแล้วใส่ PIN</p>' +
          '<label class="field">ชื่อพนักงาน<select name="emp" required><option value="">— เลือกชื่อ —</option>' + options + '</select></label>' +
          '<label class="field">PIN<input class="pin" name="pin" type="password" inputmode="numeric" autocomplete="off" maxlength="8" required></label>' +
          (opts.remember ? '<label class="check"><input type="checkbox" name="remember"' + (st.remember ? ' checked' : '') + '> จำฉันไว้ในมือถือเครื่องนี้ (ครั้งหน้าไม่ต้องใส่ PIN)</label>' : '') +
          '<p class="err">' + esc(msg || '') + '</p>' +
          '<button class="btn primary" type="submit">ถัดไป</button>' +
        '</form>';
      var form = $('[data-login]', root);
      if (st.id) form.pin.focus();
      form.onsubmit = function (ev) {
        ev.preventDefault();
        st.id = form.emp.value;
        st.pin = form.pin.value.trim();
        st.remember = opts.remember ? form.remember.checked : false;
        if (!st.id) return showErr(form, 'กรุณาเลือกชื่อ');
        if (!st.pin) return showErr(form, 'กรุณาใส่ PIN');
        doLogin(form);
      };
    }

    function showErr(scope, msg) { $('.err', scope).textContent = msg; }

    function doLogin(form) {
      if (form) busy(true); else loading();
      opts.adapter.login(st.id, st.pin).then(function (r) {
        st.info = r;
        if (opts.remember) {
          if (st.remember) store.set('att_me', { id: st.id, pin: st.pin });
          else store.del('att_me');
        }
        showAction();
      }).catch(function (e) {
        if (e.code === 'PIN') { store.del('att_me'); st.pin = ''; }
        if (form && form.isConnected) { busy(false); showErr(form, e.message); } else showLogin(e.message);
      });
    }

    function resetUser() {
      if (opts.remember) store.del('att_me');
      st.id = ''; st.pin = ''; st.info = null; st.photo = null; st.thumb = null;
      showLogin();
    }

    function showAction(msg) {
      var info = st.info, sug = info.suggested;
      var last = info.last ? 'ล่าสุด: ' + esc(info.last.label) + ' ' + esc(info.last.when) : 'ยังไม่เคยลงเวลา';
      var has = !!st.photo;
      var need = opts.photo === 'required';
      root.innerHTML =
        '<div class="card">' +
          '<h2>สวัสดี ' + esc(info.employee.name) + '</h2>' +
          '<p class="muted small" style="margin:0">' + last + '</p>' +
          '<div class="photo">' +
            '<div class="thumb' + (has ? ' has' : '') + '"' + (has ? ' style="background-image:url(' + st.thumb + ')"' : '') + '>🙂</div>' +
            '<button class="btn" type="button" data-photo>' + (has ? '📷 ถ่ายใหม่' : (need ? '📷 ถ่ายเซลฟี่' : '📷 ถ่ายรูป (ไม่บังคับ)')) + '</button>' +
          '</div>' +
          '<div class="actions">' + actBtn('IN', 'เข้างาน', sug) + actBtn('OUT', 'ออกงาน', sug) + '</div>' +
          '<p class="err">' + esc(msg || '') + '</p>' +
          '<button class="btn ghost" data-switch>ไม่ใช่ฉัน / เปลี่ยนคน</button>' +
        '</div>';
      $('[data-photo]', root).onclick = function () {
        takePhoto(opts.webcam).then(function (p) { st.photo = p.full; st.thumb = p.thumb; showAction(); })
          .catch(function (e) { showAction(e.message); });
      };
      $$('[data-type]', root).forEach(function (b) { b.onclick = function () { doPunch(b.getAttribute('data-type')); }; });
      $('[data-switch]', root).onclick = resetUser;
    }

    function actBtn(type, label, sug) {
      return '<button class="btn ' + (type === 'IN' ? 'in' : 'out') + (sug === type ? ' suggest' : '') + '" data-type="' + type + '">' +
        label + (sug === type ? '<span class="hint">แนะนำ</span>' : '') + '</button>';
    }

    function doPunch(type) {
      if (opts.photo === 'required' && !st.photo) {
        showAction('กรุณาถ่ายเซลฟี่ก่อนลงเวลา');
        $('.photo', root).classList.add('need');
        return;
      }
      busy(true);
      $('[data-type="' + type + '"]', root).innerHTML = 'กำลังบันทึก…';
      opts.adapter.punch({ id: st.id, pin: st.pin, type: type, photo: st.photo || '', thumb: st.thumb || '' }).then(function (r) {
        st.photo = null; st.thumb = null;
        root.innerHTML =
          '<div class="card done ' + (r.type === 'OUT' ? 'out' : '') + '">' +
            '<div class="tick">✓</div><h2>ลง' + esc(r.label) + 'แล้ว</h2>' +
            '<div class="big">' + esc(r.time) + '</div>' +
            '<p class="muted">' + esc(r.name) + ' · ' + esc(r.date) + '</p>' +
            (opts.remember ? '<p class="small muted">ปิดหน้านี้ได้เลย</p>' : '') +
          '</div>';
        if (opts.onDone) opts.onDone(r);
      }).catch(function (e) {
        if (e.code === 'PIN') { store.del('att_me'); st.pin = ''; return showLogin(e.message); }
        showAction(e.message);
      });
    }

    var saved = opts.remember ? store.get('att_me') : null;
    if (saved && saved.id && saved.pin) { st.id = saved.id; st.pin = saved.pin; doLogin(null); }
    else showLogin();
  }

  function qr(el, text, size) {
    el.innerHTML = '';
    if (!g.QRCode) { el.textContent = text; return null; }
    return new g.QRCode(el, { text: text, width: size || 512, height: size || 512, colorDark: '#000000', colorLight: '#ffffff', correctLevel: g.QRCode.CorrectLevel.M });
  }

  g.App = {
    $: $, $$: $$, esc: esc, pad: pad, api: api, store: store, header: header, tickClock: tickClock,
    notice: notice, deviceInfo: deviceInfo, takePhoto: takePhoto, createFlow: createFlow, qr: qr
  };
})(window);
