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

  var DEFAULTS = {
    monoFont: true,
    fontFamily: "monospace",
    letterSpacing: "-0.3",
    boxy: true,
    hideQuests: true,
    hideUpsells: true,
    blockQuestRequests: true,
    extraPatterns: ""
  };
  Object.keys(DEFAULTS).forEach(function (k) {
    if (storage[k] === undefined) storage[k] = DEFAULTS[k];
  });

  // system24 colors
  var BORDER = "#303030"; // --bg-1

  // Component names. "Quest" is case-sensitive so "Request…" never matches.
  var QUEST_RE = /(^|[^a-z])Quest(?!ion)/;
  var UPSELL_RE = /Upsell|NitroPromo|PremiumPromo|GiftButton|PremiumGift|ShopEntry|ShopUpsell|ShopBanner|CollectiblesShop|CollectiblesUpsell/;
  // Things that look related but weren't hidden — shown in the debug list so we can add them.
  var CANDIDATE_RE = /quest|nitro|premium|upsell|shop|gift|collectible|promo|boost/i;

  var patches = [];
  var failures = [];
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
    v = !!n && (
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
    var flat = StyleSheet.flatten(props.style) || {};
    var fam = String(flat.fontFamily || "");
    var w = flat.fontWeight;
    // Discord on Android encodes weight in the family name (e.g. "ggsans-Semibold").
    var bold = /bold|semibold|black|heavy/i.test(fam) || w === "bold" || Number(w) >= 600;
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

  // Wraps jsx / jsxs / createElement: drop hidden components, restyle Text.
  function elementHook(args, orig) {
    var type = args[0];
    if (shouldHide(type)) return null;
    if (type === Text && args[1]) {
      args = Array.prototype.slice.call(args);
      args[1] = monoProps(args[1]);
    }
    return orig.apply(this, args);
  }

  function boxify(s) {
    if (!s || typeof s !== "object" || Array.isArray(s)) return;
    var r = s.borderRadius;
    var isCircle = s.width != null && s.width === s.height;
    if (typeof r === "number" && r >= 4 && r <= 32 && s.backgroundColor && !isCircle) {
      s.borderRadius = 3;
      if (s.borderWidth == null) {
        s.borderWidth = 1;
        s.borderColor = BORDER;
      }
    }
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
      var rt = metro.findByProps("jsx", "jsxs");
      if (!rt) throw new Error("jsx runtime not found");
      return [
        patcher.instead("jsx", rt, elementHook),
        patcher.instead("jsxs", rt, elementHook)
      ];
    });

    tryPatch("createElement", function () {
      return patcher.instead("createElement", React, elementHook);
    });

    tryPatch("StyleSheet.create", function () {
      return patcher.before("create", StyleSheet, function (args) {
        if (!storage.boxy || !args[0]) return;
        var obj = args[0];
        for (var key in obj) boxify(obj[key]);
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
      if (toasts) toasts.showToast(failures.length ? "system24: loaded with " + failures.length + " issue(s), see settings" : "system24 mobile loaded");
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
    var report = "system24 mobile debug\n\nIssues: " + (failures.join(" | ") || "none") +
      "\n\nHidden: " + (hiddenList.join(", ") || "none") +
      "\n\nNot hidden but looks related: " + (candList.join(", ") || "none");

    return e(RN.ScrollView, { style: { flex: 1 } },
      e(FormSection, { title: "Look" },
        sw("monoFont", "Monospace font", "Use a monospace font everywhere, like system24."),
        input("fontFamily", "Font family", "monospace"),
        input("letterSpacing", "Letter spacing", "-0.3"),
        sw("boxy", "Boxy panels", "Square corners and thin borders. Fully restart Discord after changing.")
      ),
      e(FormSection, { title: "Hide" },
        sw("hideQuests", "Hide Quests", "Removes quest banners, cards and popups."),
        sw("hideUpsells", "Hide Nitro / Shop / gift upsells", null),
        sw("blockQuestRequests", "Block quest data", "Stops quests from being downloaded at all."),
        input("extraPatterns", "Extra component names to hide (regex)", "e.g. SomePromo|OtherBanner", function () { compileExtra(); resetCache(); })
      ),
      e(FormSection, { title: "Debug" },
        row("issues", "Patch issues (" + failures.length + ")", failures.join("\n") || "None", null),
        row("hidden", "Hidden so far (" + hiddenList.length + ")", hiddenList.slice(0, 40).join(", ") || "Nothing yet. Browse around Discord, then come back.", null),
        row("cand", "Related but NOT hidden (" + candList.length + ")", candList.slice(0, 60).join(", ") || "None seen yet", null),
        row("copy", "Copy debug report", "Paste this to whoever is fixing the plugin.", function () { copy(report); })
      )
    );
  }

  return { onLoad: onLoad, onUnload: onUnload, settings: Settings };
})()
