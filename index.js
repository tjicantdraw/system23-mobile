(function () {
  "use strict";
  // system24 mobile — a Kettu / Bunny / Revenge (Vendetta-format) plugin.
  // NOTE: this file must start with "(" — the loader wraps it as `vendetta => { return <file> }`.

  var metro = vendetta.metro;
  var patcher = vendetta.patcher;
  var React = metro.common.React;
  var RN = metro.common.ReactNative;
  var Text = RN.Text;
  var StyleSheet = RN.StyleSheet;
  var storage = vendetta.plugin.storage;

  var VERSION = 11;
  // v4: hiding back ON (wrapper protection fixed the crashes). Font now comes from the
  // Kettu font pack; the plugin's own font override is an optional fallback.
  var DEFAULTS = {
    monoFont: false,
    fontFamily: "monospace",
    letterSpacing: "-0.3",
    boxy: true,
    hideQuests: true,
    hideUpsells: true,
    blockQuestRequests: true,
    recolor: true,
    recolorText: false,
    extraPatterns: ""
  };
  if (storage.__version !== VERSION) {
    Object.keys(DEFAULTS).forEach(function (k) { storage[k] = DEFAULTS[k]; });
    storage.__version = VERSION;
  }
  Object.keys(DEFAULTS).forEach(function (k) {
    if (storage[k] === undefined) storage[k] = DEFAULTS[k];
  });

  // ---- scouting: what does Discord actually render? ----
  var seenNames = {};      // component name -> count
  var seenCount = 0;
  var textHosts = {};      // components that receive a Discord text "variant" prop
  var rnTextHits = 0;
  var jsxRuntimeCount = 0;      // times React Native's own Text was created
  var VARIANT_RE = /^(text|heading|eyebrow|display|redesign)[-\/]/;
  function scout(type, props) {
    var n = nameOf(type) || (typeof type === "string" ? "<" + type + ">" : "");
    if (!n) return;
    if (seenNames[n] !== undefined) seenNames[n]++;
    else if (seenCount < 3000) { seenNames[n] = 1; seenCount++; }
    if (props && typeof props.variant === "string" && VARIANT_RE.test(props.variant)) {
      textHosts[n] = (textHosts[n] || 0) + 1;
    }
  }

  // system24 colors
  var BORDER = "#303030"; // --bg-1
  var BOX_RADIUS = 2;     // system24 corners are nearly square

  // Component names. "Quest" is case-sensitive so "Request…" never matches.
  var QUEST_RE = /(^|[^a-z])Quest(?!ion)|^OrbsBalance/;
  var UPSELL_RE = /Upsell|NitroPromo|PremiumPromo|GiftButton|PremiumGift|ShopEntry|ShopUpsell|ShopBanner|CollectiblesShop|CollectiblesUpsell|ShopThisLook|MarketingCoachmark|^ChatInputActionButtonGift$|^ChatInputActionButtonGiftOrThread$/;
  // Things that look related but weren't hidden — shown in the debug list so we can add them.
  var CANDIDATE_RE = /quest|nitro|premium|upsell|shop|gift|collectible|promo|boost|orb|wishlist/i;
  // Buttons/rows recognised by their visible label (e.g. the "Quests" button on the You tab).
  var QUEST_LABEL_RE = /^(quests?|orbs|orbs balance.*)$/i;
  var UPSELL_LABEL_RE = /^(shop|get nitro|nitro|send a gift|gift nitro)$/i;
  var labelHits = {};
  function labelOf(props) {
    if (!props) return "";
    var l = props.accessibilityLabel || props.label || props.title || props.text;
    return typeof l === "string" ? l.trim() : "";
  }

  var patches = [];
  var failures = [];
  var runtimeErrors = {};
  function noteError(where, e) {
    var msg = where + ": " + (e && e.message ? e.message : String(e));
    runtimeErrors[msg] = (runtimeErrors[msg] || 0) + 1;
  }
  var hidden = new Set();
  var candidates = new Set();
  var decided = new WeakMap();
  var extraRe = null;

  function resetCache() { decided = new WeakMap(); }

  function compileExtra() {
    var src = String(storage.extraPatterns || "").trim();
    try { extraRe = src ? new RegExp(src) : null; } catch (e) { extraRe = null; }
  }

  function nameOf(type) {
    if (!type) return "";
    if (typeof type === "function") return type.displayName || type.name || "";
    if (typeof type === "object") {
      if (type.displayName) return type.displayName;
      if (type.render) return type.render.displayName || type.render.name || "";
      if (type.type) return nameOf(type.type);
    }
    return "";
  }

  function shouldHide(type) {
    if (!type || (typeof type !== "function" && typeof type !== "object")) return false;
    var v = decided.get(type);
    if (v !== undefined) return v;
    var n = nameOf(type);
    // Never hide wrappers: providers/containers/screens hold other UI and crash it when removed.
    var isWrapper = /(Provider|Context|Container|Wrapper|Screen|Navigator|Boundary|Store|Manager|Root)(Inner)?$/.test(n);
    v = !!n && !isWrapper && (
      (storage.hideQuests && QUEST_RE.test(n)) ||
      (storage.hideUpsells && UPSELL_RE.test(n)) ||
      (extraRe !== null && extraRe.test(n))
    );
    decided.set(type, v);
    if (v) hidden.add(n);
    else if (n && CANDIDATE_RE.test(n)) candidates.add(n);
    return v;
  }

  function monoProps(props) {
    if (!storage.monoFont || !props) return props;
    try { return monoPropsInner(props); } catch (e) { noteError("font", e); return props; }
  }

  function monoPropsInner(props) {
    var flat = StyleSheet.flatten(props.style) || {};
    var fam = String(flat.fontFamily || "");
    var w = flat.fontWeight;
    // Discord on Android encodes weight in the family name (e.g. "ggsans-Semibold").
    var variant = typeof props.variant === "string" ? props.variant : "";
    var bold = /bold|semibold|black|heavy/i.test(fam) || /bold|semibold|black|heavy/.test(variant) || w === "bold" || Number(w) >= 600;
    var extra = {
      fontFamily: storage.fontFamily || "monospace",
      fontWeight: bold ? "bold" : "normal",
      letterSpacing: Number(storage.letterSpacing) || 0
    };
    var out = {};
    for (var k in props) out[k] = props[k];
    out.style = [props.style, extra];
    return out;
  }


  // ------------------------------------------------------------------ recolor + boxy
  // Discord's new design system ignores Kettu themes, so colors are remapped as styles render:
  // tinted greys -> system24 neutral greys, Discord blurple -> system24 purple. Others untouched.
  var COLOR_KEYS = ["backgroundColor", "color", "borderColor", "borderTopColor", "borderBottomColor",
    "borderLeftColor", "borderRightColor", "tintColor", "textDecorationColor"];
  var colorCache = new Map();
  var styleCache = new WeakMap();
  var colorSeen = {};
  var colorSeenCount = 0;

  function parseColor(c) {
    var m, r, g, b, a = 1;
    c = c.trim().toLowerCase();
    if (c[0] === "#") {
      var h = c.slice(1);
      if (h.length === 3 || h.length === 4) h = h.split("").map(function (x) { return x + x; }).join("");
      if (h.length !== 6 && h.length !== 8) return null;
      r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
      if (h.length === 8) a = parseInt(h.slice(6, 8), 16) / 255;
    } else if ((m = c.match(/^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+%?))?\s*\)$/))) {
      r = +m[1]; g = +m[2]; b = +m[3];
      if (m[4] != null) a = m[4].slice(-1) === "%" ? parseFloat(m[4]) / 100 : +m[4];
    } else return null;
    if ([r, g, b, a].some(isNaN)) return null;
    return { r: r / 255, g: g / 255, b: b / 255, a: a };
  }

  function toHsl(c) {
    var max = Math.max(c.r, c.g, c.b), min = Math.min(c.r, c.g, c.b), l = (max + min) / 2, h = 0, s = 0, d = max - min;
    if (d > 0) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === c.r) h = ((c.g - c.b) / d + (c.g < c.b ? 6 : 0));
      else if (max === c.g) h = (c.b - c.r) / d + 2;
      else h = (c.r - c.g) / d + 4;
      h *= 60;
    }
    return { h: h, s: s, l: l, d: d };
  }

  function hslToHex(h, s, l, a) {
    function f(n) {
      var k = (n + h / 30) % 12, x = s * Math.min(l, 1 - l);
      var v = l - x * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      return ("0" + Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16)).slice(-2);
    }
    var hex = "#" + f(0) + f(8) + f(4);
    if (a < 1) hex += ("0" + Math.round(a * 255).toString(16)).slice(-2);
    return hex;
  }

  // Discord sometimes passes color *names* (design tokens) that its native code resolves.
  var TOKEN_MAP = {
    "text-default": "#aeaeae", "text-normal": "#aeaeae",
    "mobile-text-heading-primary": "#cecece", "text-strong": "#cecece", "header-primary": "#cecece",
    "interactive-text-active": "#eeeeee", "interactive-active": "#eeeeee",
    "text-muted": "#808080", "text-subtle": "#808080", "header-secondary": "#808080",
    "redesign-channel-name-text": "#aeaeae", "redesign-channel-name-muted-text": "#808080",
    "channel-icon": "#808080", "interactive-normal": "#808080", "interactive-muted": "#484848"
  };
  function remapToken(c) {
    // Disabled: Discord's native text only understands its own color names; a hex value renders black.
    return c;
    if (TOKEN_MAP[c]) return TOKEN_MAP[c];
    if (/(^|-)brand(-|$)/.test(c) && /text|icon|link/.test(c)) return "#b589d6";
    return c;
  }

  function remapColor(c) {
    if (typeof c !== "string") return c;
    if (/^[a-z]+(-[a-z0-9]+)+$/.test(c)) {
      var t = remapToken(c);
      if (colorSeenCount < 400 && colorSeen[c] === undefined) { colorSeen[c] = t; colorSeenCount++; }
      return t;
    }
    var hit = colorCache.get(c);
    if (hit !== undefined) return hit;
    var out = c;
    var p = parseColor(c);
    if (p) {
      var hsl = toHsl(p);
      if (hsl.d < 0.004) {
        // already neutral grey (possibly one we produced): leave it, so layers don't stack darkening
      } else if (hsl.d < 0.09 || hsl.s < 0.12) {
        // tinted grey -> neutral grey at the same lightness
        out = hslToHex(0, 0, hsl.l, p.a);
      } else if (hsl.h >= 215 && hsl.h <= 250 && hsl.s > 0.35) {
        // Discord blurple -> system24 purple (oklch 70% .12 310 = #b589d6)
        out = hslToHex(274, Math.min(hsl.s, 0.48), Math.max(0.45, Math.min(hsl.l + 0.04, 0.8)), p.a);
      }
    }
    if (colorSeenCount < 400 && colorSeen[c] === undefined) { colorSeen[c] = out; colorSeenCount++; }
    colorCache.set(c, out);
    return out;
  }

  function isAnimatedValue(v) {
    return v !== null && typeof v === "object" && (
      typeof v.__getValue === "function" || v._isReanimatedSharedValue || v.__reanimatedHostObjectRef ||
      typeof v.addListener === "function" || v._animation !== undefined);
  }

  function isPlainStyle(o) {
    // Only skip real Animated / Reanimated styles (copying those breaks animations).
    // Native color objects and other static objects are fine to copy by reference.
    if (o.viewDescriptors || o.viewsRef || o.initial) return false;
    for (var k in o) {
      var v = o[k];
      if (typeof v === "function" || isAnimatedValue(v)) return false;
      if (k === "transform" && Array.isArray(v)) {
        for (var t = 0; t < v.length; t++) {
          var tv = v[t];
          for (var tk in tv) if (isAnimatedValue(tv[tk])) return false;
        }
      }
    }
    return true;
  }

  function remapObject(o) {
    var cached = styleCache.get(o);
    if (cached) return cached;
    var out = o;
    if (isPlainStyle(o)) {
      var copy = null;
      if (storage.recolor) {
        for (var i = 0; i < COLOR_KEYS.length; i++) {
          var k = COLOR_KEYS[i];
          if (typeof o[k] === "string") {
            var nv = remapColor(o[k]);
            if (nv !== o[k]) { if (!copy) { copy = {}; for (var kk in o) copy[kk] = o[kk]; } copy[k] = nv; }
          }
        }
      }
      if (storage.boxy) {
        var src = copy || o;
        var w = typeof src.width === "number" ? src.width : null;
        var h = typeof src.height === "number" ? src.height : null;
        var half = (w != null && h != null) ? Math.min(w, h) / 2 : null;
        var RADII = ["borderRadius", "borderTopLeftRadius", "borderTopRightRadius", "borderBottomLeftRadius",
          "borderBottomRightRadius", "borderTopStartRadius", "borderTopEndRadius", "borderBottomStartRadius", "borderBottomEndRadius"];
        var squared = false;
        for (var ri = 0; ri < RADII.length; ri++) {
          var rk = RADII[ri], rv = src[rk];
          if (typeof rv !== "number" || rv <= BOX_RADIUS) continue;
          // keep true circles round (avatars, status dots): radius at least half the size, or a "999" style radius
          if (half != null && rv >= half - 1 && w === h) continue;
          if (rv >= 100) continue;
          if (!copy) { copy = {}; for (var k2 in o) copy[k2] = o[k2]; }
          copy[rk] = BOX_RADIUS;
          squared = true;
        }
        if (squared && src.backgroundColor && src.borderWidth == null && src.backgroundColor !== "transparent") {
          copy.borderWidth = 1;
          copy.borderColor = BORDER;
        }
      }
      if (copy) out = copy;
    }
    styleCache.set(o, out);
    return out;
  }

  function remapStyle(st, depth) {
    if (!st || typeof st !== "object" || depth > 6) return st;
    if (Array.isArray(st)) {
      var changed = false, arr = new Array(st.length);
      for (var i = 0; i < st.length; i++) { arr[i] = remapStyle(st[i], depth + 1); if (arr[i] !== st[i]) changed = true; }
      return changed ? arr : st;
    }
    return remapObject(st);
  }

  function styleProps(props) {
    if (!(storage.recolor || storage.boxy) || !props) return props;
    try {
      var out = null;
      if (props.style) {
        var ns = remapStyle(props.style, 0);
        if (ns !== props.style) { out = {}; for (var k in props) out[k] = props[k]; out.style = ns; }
      }
      if (storage.recolor) {
        ["color", "tintColor", "backgroundColor"].forEach(function (key) {
          if (typeof props[key] === "string") {
            var nv = remapColor(props[key]);
            if (nv !== props[key]) { if (!out) { out = {}; for (var k3 in props) out[k3] = props[k3]; } out[key] = nv; }
          }
        });
      }
      return out || props;
    } catch (e) { noteError("recolor", e); return props; }
  }

  // Hidden components are swapped for this empty placeholder instead of being removed,
  // because some Discord code (e.g. the server list) crashes if an element is missing.
  function Hidden() { return null; }
  Hidden.displayName = "System24Hidden";

  // Wraps jsx / jsxs / createElement: blank out hidden components, restyle Text.
  function elementHook(args, orig) {
    try {
      var type = args[0];
      var props0 = args[1];
      scout(type, props0);
      if (type === Text) rnTextHits++;
      var lbl = labelOf(props0);
      if (lbl && CANDIDATE_RE.test(lbl)) {
        var key = (nameOf(type) || String(type)) + "[" + lbl + "]";
        labelHits[key] = (labelHits[key] || 0) + 1;
      }
      var hideByLabel = !!lbl && !/(Provider|Context|Container|Screen|Navigator)(Inner)?$/.test(nameOf(type)) && (
        (storage.hideQuests && QUEST_LABEL_RE.test(lbl)) ||
        (storage.hideUpsells && UPSELL_LABEL_RE.test(lbl))
      );
      if (hideByLabel) hidden.add((nameOf(type) || "?") + "[" + lbl + "]");
      if (hideByLabel || shouldHide(type)) {
        args = Array.prototype.slice.call(args);
        var p = args[1] || {};
        args[0] = Hidden;
        args[1] = p.key != null ? { key: p.key } : {};
      } else if (props0) {
        var np = props0;
        if (type === Text || (typeof props0.variant === "string" && VARIANT_RE.test(props0.variant))) np = monoProps(np);
        np = styleProps(np);
        if (np !== props0) {
          args = Array.prototype.slice.call(args);
          args[1] = np;
        }
      }
    } catch (e) {
      noteError("element", e);
    }
    return orig.apply(this, args);
  }

  // Returns a boxier copy of a style (never mutates Discord's objects).
  function boxify(s) {
    if (!s || typeof s !== "object" || Array.isArray(s)) return s;
    var r = s.borderRadius;
    var isCircle = s.width != null && s.width === s.height;
    if (typeof r === "number" && r >= 4 && r <= 32 && s.backgroundColor && !isCircle) {
      var out = {};
      for (var k in s) out[k] = s[k];
      out.borderRadius = 3;
      if (s.borderWidth == null) {
        out.borderWidth = 1;
        out.borderColor = BORDER;
      }
      return out;
    }
    return s;
  }

  function isQuestUrl(a) {
    var u = typeof a === "string" ? a : (a && a.url) || "";
    return /\/quests(\/|\?|$)|\/users\/@me\/quests/.test(String(u));
  }

  function tryPatch(label, fn) {
    try {
      var un = fn();
      if (typeof un === "function") patches.push(un);
      else if (Array.isArray(un)) un.forEach(function (u) { if (typeof u === "function") patches.push(u); });
    } catch (e) {
      failures.push(label + ": " + (e && e.message ? e.message : String(e)));
    }
  }

  function onLoad() {
    compileExtra();

    tryPatch("jsx-runtime", function () {
      // Discord may ship more than one copy of the JSX runtime; patch every one we can find.
      var runtimes = [];
      if (typeof metro.findByPropsAll === "function") runtimes = metro.findByPropsAll("jsx", "jsxs") || [];
      if (!runtimes.length) { var one = metro.findByProps("jsx", "jsxs"); if (one) runtimes = [one]; }
      if (!runtimes.length) throw new Error("jsx runtime not found");
      jsxRuntimeCount = runtimes.length;
      var uns = [];
      runtimes.forEach(function (rt) {
        if (typeof rt.jsx === "function") uns.push(patcher.instead("jsx", rt, elementHook));
        if (typeof rt.jsxs === "function") uns.push(patcher.instead("jsxs", rt, elementHook));
      });
      return uns;
    });

    tryPatch("Text.render", function () {
      // Catches Text even when it's created outside the patched JSX runtime.
      if (!Text || typeof Text.render !== "function") return null; // not a forwardRef in this RN version; JSX hook covers it
      return patcher.before("render", Text, function (args) {
        if (storage.monoFont && args[0]) args[0] = monoProps(args[0]);
      });
    });

    tryPatch("createElement", function () {
      return patcher.instead("createElement", React, elementHook);
    });

    tryPatch("StyleSheet.create", function () {
      return patcher.before("create", StyleSheet, function (args) {
        return; // boxy is now applied at render time (see remapObject)
        try {
          var src = args[0];
          var copy = {};
          for (var key in src) copy[key] = boxify(src[key]);
          args[0] = copy;
        } catch (e) {
          noteError("boxy", e);
        }
      });
    });

    tryPatch("quest requests", function () {
      var HTTP = metro.findByProps("get", "post", "put", "del");
      if (!HTTP) throw new Error("HTTP module not found");
      return ["get", "post", "put", "patch", "del"].filter(function (m) {
        return typeof HTTP[m] === "function";
      }).map(function (m) {
        return patcher.instead(m, HTTP, function (args, orig) {
          if (storage.blockQuestRequests && isQuestUrl(args[0])) {
            if (m === "get") {
              return Promise.resolve({
                ok: true,
                status: 200,
                headers: {},
                body: { quests: [], excluded_quests: [], quest_enrollment_blocked_until: null }
              });
            }
            return Promise.reject({ ok: false, status: 403, body: { message: "Blocked by system24 mobile" } });
          }
          return orig.apply(this, args);
        });
      });
    });

    try {
      var toasts = vendetta.ui && vendetta.ui.toasts;
      if (toasts) toasts.showToast(failures.length ? "system24: loaded with " + failures.length + " issue(s), see settings" : "system24 mobile v11 loaded");
    } catch (e) {}
  }

  function onUnload() {
    patches.forEach(function (un) { try { un(); } catch (e) {} });
    patches = [];
  }

  // ------------------------------------------------------------------ settings

  function Settings() {
    var e = React.createElement;
    var useProxy = vendetta.storage && vendetta.storage.useProxy;
    if (useProxy) useProxy(storage);
    var forceState = React.useState(0);
    var refresh = function () { forceState[1](function (n) { return n + 1; }); };

    var Forms = (vendetta.ui.components && vendetta.ui.components.Forms) || {};
    var FormSection = Forms.FormSection || RN.View;
    var FormSwitchRow = Forms.FormSwitchRow;
    var FormRow = Forms.FormRow;
    var FormInput = Forms.FormInput;

    function sw(key, label, sub) {
      if (!FormSwitchRow) {
        return e(RN.View, { key: key, style: { flexDirection: "row", padding: 12, alignItems: "center" } },
          e(RN.Text, { style: { flex: 1, color: "#d0d0d0" } }, label),
          e(RN.Switch, { value: !!storage[key], onValueChange: function (v) { storage[key] = v; resetCache(); refresh(); } }));
      }
      return e(FormSwitchRow, {
        key: key, label: label, subLabel: sub, value: !!storage[key],
        onValueChange: function (v) { storage[key] = v; resetCache(); refresh(); }
      });
    }

    function input(key, title, placeholder, after) {
      var props = {
        key: key, title: title, placeholder: placeholder, value: String(storage[key] == null ? "" : storage[key]),
        onChange: function (v) { storage[key] = v; if (after) after(); refresh(); },
        onChangeText: function (v) { storage[key] = v; if (after) after(); refresh(); }
      };
      return FormInput ? e(FormInput, props) :
        e(RN.TextInput, Object.assign({ style: { color: "#d0d0d0", padding: 12 } }, props));
    }

    function row(key, label, sub, onPress) {
      return FormRow ? e(FormRow, { key: key, label: label, subLabel: sub, onPress: onPress }) :
        e(RN.Text, { key: key, style: { color: "#aeaeae", padding: 12 }, onPress: onPress }, label + "\n" + sub);
    }

    function copy(text) {
      try { metro.common.clipboard.setString(text); vendetta.ui.toasts.showToast("Copied"); } catch (err) {}
    }

    var hiddenList = Array.from(hidden).sort();
    var candList = Array.from(candidates).sort();
    var errList = Object.keys(runtimeErrors).map(function (m) { return m + " (x" + runtimeErrors[m] + ")"; });
    var top = Object.keys(seenNames).sort(function (a, b) { return seenNames[b] - seenNames[a]; });
    var related = top.filter(function (n) { return CANDIDATE_RE.test(n); });
    var textList = Object.keys(textHosts).map(function (n) { return n + " x" + textHosts[n]; });
    var labelList = Object.keys(labelHits);
    var colorList = Object.keys(colorSeen).slice(0, 60).map(function (c) { return c + (colorSeen[c] !== c ? "->" + colorSeen[c] : ""); });
    var report = "system24 mobile v11 debug" +
      "\n\nColors seen: " + (colorList.join(", ") || "none") +
      "\n\nLabelled items seen: " + (labelList.join(", ") || "none") +
      "\n\nJSX runtimes patched: " + jsxRuntimeCount +
      "\n\nRN Text created: " + rnTextHits +
      "\nText components (variant prop): " + (textList.join(", ") || "none") +
      "\nComponents seen: " + seenCount +
      "\n\nRelated names seen: " + (related.slice(0, 150).join(", ") || "none") +
      "\n\nMost common: " + top.slice(0, 80).join(", ") +
      "\n\n---" + "\n\nIssues: " + (failures.concat(errList).join(" | ") || "none") +
      "\n\nHidden: " + (hiddenList.join(", ") || "none") +
      "\n\nNot hidden but looks related: " + (candList.join(", ") || "none");

    return e(RN.ScrollView, { style: { flex: 1 } },
      e(FormSection, { title: "Look" },
        sw("monoFont", "Force monospace font (fallback)", "Prefer the DM Mono font pack in Kettu > Fonts. Use this only if that doesn't work."),
        input("fontFamily", "Font family", "monospace"),
        input("letterSpacing", "Letter spacing", "-0.3"),
        sw("recolor", "system24 colors", "Neutral greys and purple accent, applied by the plugin."),
        sw("boxy", "Boxy panels", "Square corners and thin borders on cards and buttons.")
      ),
      e(FormSection, { title: "Hide" },
        sw("hideQuests", "Hide Quests", "Removes quest banners, cards and popups."),
        sw("hideUpsells", "Hide Nitro / Shop / gift upsells", null),
        sw("blockQuestRequests", "Block quest data", "Stops quests from being downloaded at all."),
        input("extraPatterns", "Extra component names to hide (regex)", "e.g. SomePromo|OtherBanner", function () { compileExtra(); resetCache(); })
      ),
      e(FormSection, { title: "Debug" },
        row("issues", "Patch issues (" + (failures.length + errList.length) + ")", failures.concat(errList).join("\n") || "None", null),
        row("hidden", "Hidden so far (" + hiddenList.length + ")", hiddenList.slice(0, 40).join(", ") || "Nothing yet. Browse around Discord, then come back.", null),
        row("cand", "Related but NOT hidden (" + candList.length + ")", candList.slice(0, 60).join(", ") || "None seen yet", null),
        row("scout", "Scout: text components found", (textList.join(", ") || "none yet") + "  |  RN Text: " + rnTextHits, null),
        row("copy", "Copy debug report", "Paste this to whoever is fixing the plugin.", function () { copy(report); })
      )
    );
  }

  return { onLoad: onLoad, onUnload: onUnload, settings: Settings };
})()
