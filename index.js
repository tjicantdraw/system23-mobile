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

  var VERSION = 6;
  // v4: hiding back ON (wrapper protection fixed the crashes). Font now comes from the
  // Kettu font pack; the plugin's own font override is an optional fallback.
  var DEFAULTS = {
    monoFont: false,
    fontFamily: "monospace",
    letterSpacing: "-0.3",
    boxy: false,
    hideQuests: true,
    hideUpsells: true,
    blockQuestRequests: true,
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
      } else if (props0 && (type === Text || (typeof props0.variant === "string" && VARIANT_RE.test(props0.variant)))) {
        // RN's Text, or Discord's own Text component (identified by its "variant" prop).
        args = Array.prototype.slice.call(args);
        args[1] = monoProps(props0);
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
        if (!storage.boxy || !args[0] || typeof args[0] !== "object") return;
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
      if (toasts) toasts.showToast(failures.length ? "system24: loaded with " + failures.length + " issue(s), see settings" : "system24 mobile v6 loaded");
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
    var report = "system24 mobile v6 debug" +
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
        sw("boxy", "Boxy panels (experimental)", "Square corners and thin borders. Fully restart Discord after changing.")
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
