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

  var VERSION = 19;
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
    preset: "obsidian",
    accentOverride: "",
    ornFrames: true,
    ornStars: true,
    ornScales: true,
    scaleOpacity: "0.55",
    frameTargets: "^Card$",
    autoFrames: true,
    ornPlates: true,
    frameExclude: "Button|Pill|Badge|Chip|Reaction|Toast|Tooltip|Avatar|Icon|Input|Search|Tab|Emoji|Sticker|Status|Typing",
    sectionIcons: true,
    recolor: true,
    outlines: true,
    outlineColor: "#3a1418",
    outlineWidth: "1.5",
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

  // Looks. Grey handling: dark surfaces (L<0.3) are multiplied by `darken`; light text is
  // compressed toward bone. tintSat null = keep Discord's own tint. accent / accentLight replace
  // Discord's blurple (dark uses / bright uses).
  var PRESETS = {
    obsidian: { label: "Obsidian", tintHue: null, tintSat: null, darken: 0.8, textHue: 40, textSat: 0.14, compress: true,
      accent: "#a1111a", accentLight: "#ff5a36", highlight: "fill", fill: "#4a0d12", bar: "#e0283a",
      roundServers: true, ring: "#a1111a", sectionIcons: false, outline: "#3a1418", radius: 6,
      swatch: ["#080b0c", "#1a1a1e", "#a1111a"] },
    ashen: { label: "Ashen", tintHue: 0, tintSat: 0, darken: 0.95, textHue: 30, textSat: 0.08, compress: true,
      accent: "#b8401f", accentLight: "#ff5a36", highlight: "fill", fill: "#3a2018", bar: "#ff5a36",
      roundServers: true, ring: "#6b6b70", sectionIcons: false, outline: "#3a3a40", radius: 6,
      swatch: ["#151515", "#2a2a2c", "#ff5a36"] },
    bloodmoon: { label: "Bloodmoon", tintHue: 356, tintSat: 0.32, darken: 0.75, textHue: 20, textSat: 0.15, compress: true,
      accent: "#a1111a", accentLight: "#ff4a4a", highlight: "fill", fill: "#5a0d14", bar: "#ff3b4a",
      roundServers: true, ring: "#c0202e", sectionIcons: false, outline: "#5a1820", radius: 6,
      swatch: ["#140607", "#2a0c10", "#e0283a"] },
    grimoire: { label: "Grimoire", tintHue: 34, tintSat: 0.2, darken: 0.7, textHue: 34, textSat: 0.2, compress: true,
      accent: "#9e1f1f", accentLight: "#cf3630", highlight: "tint", tint: "rgba(158,31,31,0.18)",
      roundServers: true, ring: null, sectionIcons: true, outline: "#4a3a28", radius: 2,
      swatch: ["#080706", "#100d0a", "#9e1f1f"] },
    system24: { label: "system24", tintHue: 0, tintSat: 0, darken: 1, textHue: 0, textSat: 0, compress: false,
      accent: "#b589d6", accentLight: "#b589d6", highlight: "outline",
      roundServers: false, ring: null, sectionIcons: false, outline: "#484848", radius: 2,
      swatch: ["#141414", "#262626", "#b589d6"] }
  };
  function P() { return PRESETS[storage.preset] || PRESETS.obsidian; }
  function boxR() { var r = P().radius; return typeof r === "number" ? r : 2; }

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



  // ------------------------------------------------------------------ exemptions
  // Some things should keep Discord's look: profile pictures stay round, server tags get no outline.
  // We find out what's being drawn by asking React which component is rendering right now
  // and walking up its parents.
  var AVATAR_RE = /Avatar/;
  var TAG_RE = /GuildTag|ClanTag|GuildBadge|PrimaryGuild/;
  var GUILD_RE = /GuildIcon|GuildsBarGuild|MiniGuildIcon/;
  var ownerTracking = "off";
  var RI = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
  var CI = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  function currentOwner() {
    try {
      if (RI && RI.ReactCurrentOwner) return RI.ReactCurrentOwner.current;
      if (CI && CI.A && typeof CI.A.getOwner === "function") return CI.A.getOwner();
    } catch (e) {}
    return null;
  }
  function kindOf(name) {
    if (!name) return null;
    if (AVATAR_RE.test(name)) return "avatar";
    if (TAG_RE.test(name)) return "tag";
    if (GUILD_RE.test(name)) return "guild";
    return null;
  }
  var ownerKind = new WeakMap();
  function exemptKind(type) {
    var k = kindOf(nameOf(type));
    if (k) return k;
    var f = currentOwner();
    if (!f) return null;
    ownerTracking = "on";
    var hit = ownerKind.get(f);
    if (hit !== undefined) return hit;
    var start = f, depth = 0;
    k = null;
    while (f && depth < 12) {
      k = kindOf(nameOf(f.type));
      if (k) break;
      f = f.return;
      depth++;
    }
    ownerKind.set(start, k);
    return k;
  }

  // ------------------------------------------------------------------ recolor + boxy
  // Discord's new design system ignores Kettu themes, so colors are remapped as styles render:
  // tinted greys -> system24 neutral greys, Discord blurple -> system24 purple. Others untouched.
  var COLOR_KEYS = ["backgroundColor", "color", "borderColor", "borderTopColor", "borderBottomColor",
    "borderLeftColor", "borderRightColor", "tintColor", "textDecorationColor"];
  var colorCache = new Map();
  function resetLook() {
    colorCache = new Map();
    produced = new Set();
    clearStyleCaches();
    ownerKind = new WeakMap();
  }
  function clearStyleCaches() {
    modeCaches = { full: new WeakMap(), noOutline: new WeakMap(), colorOnly: new WeakMap(), round: new WeakMap() };
  }
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

  var produced = new Set();
  function accentFor(light) {
    var ov = String(storage.accentOverride || "");
    if (/^#[0-9a-f]{6}$/i.test(ov)) {
      if (!light) return ov.toLowerCase();
      var h = toHsl(parseColor(ov));
      return hslToHex(h.h, h.s, Math.max(h.l, 0.6), 1);
    }
    return light ? P().accentLight : P().accent;
  }
  function withAlpha(hex, a) {
    return a < 1 ? hex + ("0" + Math.round(a * 255).toString(16)).slice(-2) : hex;
  }
  function remapColor(c) {
    if (typeof c !== "string") return c;
    if (produced.has(c) || produced.has(c.toLowerCase())) return c; // one of ours: never remap twice
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
      var pr = P();
      if (hsl.d < 0.09 || hsl.s < 0.12) {
        var L = hsl.l;
        if (L < 0.3) L = L * pr.darken;
        else if (L > 0.6 && pr.compress) L = 0.55 + (L - 0.6) * 0.65;
        var dark = L < 0.5;
        var gh = dark ? pr.tintHue : pr.textHue, gs = dark ? pr.tintSat : pr.textSat;
        if (gh === null) { gh = hsl.h; gs = hsl.s; }
        out = hslToHex(gh, gs, L, p.a);
        if (out.slice(0, 7) === c.toLowerCase().slice(0, 7) && p.a === 1) out = c;
      } else if (hsl.h >= 215 && hsl.h <= 250 && hsl.s > 0.35) {
        // Discord blurple -> the theme's accent (bright uses get the lighter accent)
        out = withAlpha(accentFor(hsl.l >= 0.7), p.a);
      }
      if (out !== c) produced.add(out);
    }
    if (colorSeenCount < 400 && colorSeen[c] === undefined) { colorSeen[c] = out; colorSeenCount++; }
    colorCache.set(c, out);
    return out;
  }

  function isAnimatedValue(v) {
    return v !== null && typeof v === "object" && (
      v._isReanimatedSharedValue || v.__reanimatedHostObjectRef || v.__workletHash !== undefined);
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

  // mode: "full" | "noOutline" (server tags) | "colorOnly" (avatars)
  var modeCaches = { full: new WeakMap(), noOutline: new WeakMap(), colorOnly: new WeakMap(), round: new WeakMap() };
  function remapObject(o, mode, ctx) {
    mode = mode || "full";
    // only cache when the result can't depend on sibling styles
    var cacheable = !ctx;
    var cache = modeCaches[mode] || (modeCaches[mode] = new WeakMap());
    if (cacheable) { var cached = cache.get(o); if (cached) return cached; }
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
      if (mode === "round") {
        // seals: every rounded corner goes fully round
        var RR = ["borderRadius", "borderTopLeftRadius", "borderTopRightRadius", "borderBottomLeftRadius", "borderBottomRightRadius"];
        for (var rr = 0; rr < RR.length; rr++) {
          if (typeof (copy || o)[RR[rr]] === "number" && (copy || o)[RR[rr]] > 0) {
            if (!copy) { copy = {}; for (var k9 in o) copy[k9] = o[k9]; }
            copy[RR[rr]] = 999;
          }
        }
        var rsrc = copy || o, rw = typeof rsrc.width === "number" ? rsrc.width : (ctx ? ctx.w : null);
        var rh = typeof rsrc.height === "number" ? rsrc.height : (ctx ? ctx.h : null);
        if (P().ring && rw != null && rw === rh && rw >= 30 && rsrc.borderWidth == null && typeof o.width === "number") {
          if (!copy) { copy = {}; for (var k11 in o) copy[k11] = o[k11]; }
          copy.borderWidth = 1.5;
          copy.borderColor = P().ring;
        }
      } else if (storage.boxy && mode !== "colorOnly") {
        var src = copy || o;
        // width/height often live in a different entry of the same style array
        var w = typeof src.width === "number" ? src.width : (ctx ? ctx.w : null);
        var h = typeof src.height === "number" ? src.height : (ctx ? ctx.h : null);
        var half = (w != null && h != null) ? Math.min(w, h) / 2 : null;
        var RADII = ["borderRadius", "borderTopLeftRadius", "borderTopRightRadius", "borderBottomLeftRadius",
          "borderBottomRightRadius", "borderTopStartRadius", "borderTopEndRadius", "borderBottomStartRadius", "borderBottomEndRadius"];
        var squared = false;
        for (var ri = 0; ri < RADII.length; ri++) {
          var rk = RADII[ri], rv = src[rk];
          if (typeof rv !== "number" || rv <= boxR()) continue;
          // keep true circles round (avatars, status dots): radius at least half the size, or a "999" style radius
          if (half != null && rv >= half - 1 && w === h) continue;
          if (rv >= 100) continue;
          if (!copy) { copy = {}; for (var k2 in o) copy[k2] = o[k2]; }
          copy[rk] = boxR();
          squared = true;
        }
        if (storage.outlines && mode === "full") {
          var oc = String(storage.outlineColor || "#484848");
          var ow = Number(storage.outlineWidth) || 1.5;
          var hasBg = src.backgroundColor && src.backgroundColor !== "transparent";
          var isHighlight = false;
          if (typeof o.backgroundColor === "string") {
            var pc = parseColor(o.backgroundColor);
            if (pc && pc.a > 0.04 && pc.a < 0.45) { var hh = toHsl(pc); isHighlight = hh.s < 0.15; }
          }
          if (isHighlight && src.borderWidth == null && P().highlight === "fill") {
            // selected channel / pressed row: scarlet fill with a bright bar on the left
            if (!copy) { copy = {}; for (var k10 in o) copy[k10] = o[k10]; }
            copy.backgroundColor = P().fill;
            copy.borderLeftWidth = 3;
            copy.borderLeftColor = /^#[0-9a-f]{6}$/i.test(String(storage.accentOverride || "")) ? accentFor(true) : P().bar;
            if (typeof copy.borderRadius !== "number" || copy.borderRadius > boxR()) copy.borderRadius = boxR();
          } else if (isHighlight && src.borderWidth == null && P().highlight === "tint") {
            // selected channel / pressed row: crimson wash, no box
            if (!copy) { copy = {}; for (var k8 in o) copy[k8] = o[k8]; }
            copy.backgroundColor = P().tint;
            if (typeof copy.borderRadius !== "number" || copy.borderRadius > boxR()) copy.borderRadius = boxR();
          } else if (isHighlight && src.borderWidth == null) {
            // selected channel / pressed row highlight
            if (!copy) { copy = {}; for (var k6 in o) copy[k6] = o[k6]; }
            copy.borderWidth = ow;
            copy.borderColor = oc;
            if (typeof copy.borderRadius !== "number" || copy.borderRadius > boxR()) copy.borderRadius = boxR();
          } else if (squared && hasBg && src.borderWidth == null) {
            // system24-style outline on boxed panels, cards, inputs and buttons
            if (!copy) { copy = {}; for (var k4 in o) copy[k4] = o[k4]; }
            copy.borderWidth = ow;
            copy.borderColor = oc;
          } else {
            // recolor Discord's own borders / divider lines so every line matches
            var BW = ["borderWidth", "borderTopWidth", "borderBottomWidth", "borderLeftWidth", "borderRightWidth"];
            var hasBorder = false;
            for (var bi = 0; bi < BW.length; bi++) if (typeof src[BW[bi]] === "number" && src[BW[bi]] > 0) hasBorder = true;
            if (hasBorder) {
              if (!copy) { copy = {}; for (var k5 in o) copy[k5] = o[k5]; }
              ["borderColor", "borderTopColor", "borderBottomColor", "borderLeftColor", "borderRightColor"].forEach(function (ck) {
                if (src[ck] != null || ck === "borderColor") copy[ck] = oc;
              });
            }
          }
        }
      }
      if (mode === "noOutline") {
        // server tags: no border at all
        var src2 = copy || o;
        if (typeof src2.borderWidth === "number" && src2.borderWidth > 0) {
          if (!copy) { copy = {}; for (var k7 in o) copy[k7] = o[k7]; }
          copy.borderWidth = 0;
        }
      }
      if (copy) out = copy;
    }
    if (cacheable) cache.set(o, out);
    return out;
  }

  function sizeOf(st, out, depth) {
    if (!st || typeof st !== "object" || depth > 6) return;
    if (Array.isArray(st)) { for (var i = 0; i < st.length; i++) sizeOf(st[i], out, depth + 1); return; }
    if (typeof st.width === "number") out.w = st.width;
    if (typeof st.height === "number") out.h = st.height;
  }

  function remapStyle(st, depth, mode, ctx) {
    if (!st || typeof st !== "object" || depth > 6) return st;
    if (Array.isArray(st)) {
      if (!ctx) { ctx = { w: null, h: null }; sizeOf(st, ctx, 0); if (ctx.w == null && ctx.h == null) ctx = null; }
      var changed = false, arr = new Array(st.length);
      for (var i = 0; i < st.length; i++) { arr[i] = remapStyle(st[i], depth + 1, mode, ctx); if (arr[i] !== st[i]) changed = true; }
      return changed ? arr : st;
    }
    return remapObject(st, mode, ctx);
  }

  var ICON_RE = /Clip|GuildIcon|GuildsBar|Folder|Squircle|Mask/;
  var iconProps = {};
  function scoutIconProps(name, props) {
    if (iconProps[name] || Object.keys(iconProps).length > 25) return;
    var parts = [];
    for (var k in props) {
      if (k === "children" || k === "style") continue;
      var v = props[k];
      if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") parts.push(k + "=" + String(v).slice(0, 20));
      else parts.push(k);
    }
    iconProps[name] = parts.slice(0, 25).join(" ");
  }

  function styleProps(props, type, mode) {
    mode = mode || "full";
    if (!(storage.recolor || storage.boxy) || !props) return props;
    try {
      var out = null;
      var tname = nameOf(type) || (typeof type === "string" ? type : "");
      if (tname && ICON_RE.test(tname)) {
        scoutIconProps(tname, props);
        if ((storage.boxy || mode === "round") && mode !== "colorOnly") {
          for (var pk in props) {
            var pv = props[pk];
            if (/radius/i.test(pk) && typeof pv === "number" && pv > boxR() && pv < 100) {
              if (!out) { out = {}; for (var c0 in props) out[c0] = props[c0]; }
              out[pk] = mode === "round" ? 999 : boxR();
            }
          }
        }
      }
      if (props.style) {
        var ns = remapStyle(props.style, 0, mode, null);
        if (ns !== props.style) { if (!out) { out = {}; for (var k in props) out[k] = props[k]; } out.style = ns; }
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


  // ------------------------------------------------------------------ ornaments
  // Images live next to the plugin in your repo (corner.png, star.png, scales.png).
  var ASSET = String(vendetta.plugin.id || "");
  if (ASSET && ASSET.slice(-1) !== "/") ASSET += "/";
  var Image = RN.Image, View = RN.View;
  var ornCount = {};
  function countOrn(k) { ornCount[k] = (ornCount[k] || 0) + 1; }

  // Owner chain as one string ("Inner|CategoryChannel|..."), cached per fiber.
  var chainCache = new WeakMap();
  function ownerChain() {
    var f = currentOwner();
    if (!f) return "";
    var hit = chainCache.get(f);
    if (hit !== undefined) return hit;
    var names = [], g = f, d = 0;
    while (g && d < 12) { var n = nameOf(g.type); if (n) names.push(n); g = g.return; d++; }
    hit = names.join("|");
    chainCache.set(f, hit);
    return hit;
  }

  // The wrapped original is created with this flag on, so it is never wrapped again (no loop).
  var creatingInner = false;
  function innerEl(orig, props, ref) {
    creatingInner = true;
    try { return React.createElement(orig, Object.assign({}, props, { ref: ref })); }
    finally { creatingInner = false; }
  }

  // forwardRef wrappers keep Discord's refs (list scrolling etc.) working.
  var wrapCache = { frame: new WeakMap(), star: new WeakMap(), scales: new WeakMap(), plate: new WeakMap() };
  function wrapperFor(kind, orig) {
    var cache = wrapCache[kind], w = cache.get(orig);
    if (w) return w;
    var e = React.createElement;
    if (kind === "plate") {
      // Nameplates fill their row, so the corners go NEXT to them (a fragment) and pin to the row's
      // corners. This leaves the nameplate's own layout untouched.
      w = React.forwardRef(function (props, ref) {
        var sz = 22, o = 0, src = { uri: ASSET + "corner.png" };
        var c = function (k, pos, tf) {
          return e(Image, { key: k, source: src, pointerEvents: "none",
            style: Object.assign({ position: "absolute", width: sz, height: sz, zIndex: 2, transform: tf }, pos) });
        };
        return e(React.Fragment, null, innerEl(orig, props, ref),
          c("tl", { top: o, left: o }, []),
          c("tr", { top: o, right: o }, [{ scaleX: -1 }]),
          c("bl", { bottom: o, left: o }, [{ scaleY: -1 }]),
          c("br", { bottom: o, right: o }, [{ scaleX: -1 }, { scaleY: -1 }]));
      });
    } else if (kind === "frame") {
      w = React.forwardRef(function (props, ref) {
        var sz = 22, o = -4, src = { uri: ASSET + "corner.png" };
        var c = function (k, pos, tf) {
          return e(Image, { key: k, source: src, pointerEvents: "none",
            style: Object.assign({ position: "absolute", width: sz, height: sz, transform: tf }, pos) });
        };
        return e(View, { style: { position: "relative" } }, innerEl(orig, props, ref),
          c("tl", { top: o, left: o }, []),
          c("tr", { top: o, right: o }, [{ scaleX: -1 }]),
          c("bl", { bottom: o, left: o }, [{ scaleY: -1 }]),
          c("br", { bottom: o, right: o }, [{ scaleX: -1 }, { scaleY: -1 }]));
      });
    } else if (kind === "star") {
      w = React.forwardRef(function (props, ref) {
        return e(View, { style: { flexDirection: "row", alignItems: "center" } },
          e(Image, { source: { uri: ASSET + "star.png" }, pointerEvents: "none", style: { width: 12, height: 12, marginLeft: 10, marginRight: -4 } }),
          e(View, { style: { flex: 1 } }, innerEl(orig, props, ref)));
      });
    } else {
      w = React.forwardRef(function (props, ref) {
        var op = Number(storage.scaleOpacity);
        return e(View, { style: { flex: 1 } },
          e(Image, { source: { uri: ASSET + "scales.png" }, resizeMode: "repeat", pointerEvents: "none",
            style: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, width: undefined, height: undefined, opacity: isNaN(op) ? 0.55 : op } }),
          innerEl(orig, props, ref));
      });
    }
    w.displayName = "Orn_" + kind + "_" + (nameOf(orig) || "x");
    cache.set(orig, w);
    return w;
  }

  var frameRe = null, frameSrc = null;
  function frameMatch(name) {
    var src = String(storage.frameTargets || "");
    if (src !== frameSrc) { frameSrc = src; try { frameRe = src ? new RegExp(src) : null; } catch (e) { frameRe = null; } }
    return !!frameRe && frameRe.test(name);
  }

  // Returns a replacement element type, or null to leave it alone.
  function ornamentFor(type) {
    if (!ASSET || creatingInner) return null;
    var n = nameOf(type);
    if (!n || /^Orn_/.test(n)) return null;
    if (storage.ornFrames && storage.ornPlates && n === "Nameplate") { countOrn("plate"); return wrapperFor("plate", type); }
    if (storage.ornStars && n === "CategoryChannel") { countOrn("star"); return wrapperFor("star", type); }
    if (storage.ornScales && n === "FastList") { countOrn("scales"); return wrapperFor("scales", type); }
    if (storage.ornFrames && frameMatch(n)) { countOrn("frame:" + n); return wrapperFor("frame", type); }
    return null;
  }


  // Auto frames: any solid, rounded, padded box (a "panel") gets claw corners added as children.
  var autoFrameOwners = {};
  var exclRe = null, exclSrc = null;
  function excluded(chain) {
    var src = String(storage.frameExclude || "");
    if (src !== exclSrc) { exclSrc = src; try { exclRe = src ? new RegExp(src) : null; } catch (e) { exclRe = null; } }
    return !!exclRe && exclRe.test(chain);
  }
  function isHostView(type) {
    return type === View || type === "RCTView" || nameOf(type) === "View";
  }
  function num(v) { return typeof v === "number" ? v : 0; }
  function looksLikePanel(style) {
    var f = StyleSheet.flatten(style) || {};
    if (f.position === "absolute") return false;
    var r = f.borderRadius;
    if (typeof r !== "number" || r < 8 || r > 28) return false;
    if (typeof f.width === "number" && f.width === f.height) return false;      // circles / squares (icons)
    if ((typeof f.width === "number" && f.width < 80) || (typeof f.height === "number" && f.height < 44)) return false;
    var bg = f.backgroundColor;
    if (typeof bg === "string") {
      var pc = parseColor(bg);
      if (!pc || pc.a < 0.5) return false;
    } else if (!bg) return false;
    var pad = Math.max(num(f.padding), num(f.paddingHorizontal), num(f.paddingVertical), num(f.paddingTop), num(f.paddingLeft));
    return pad >= 10 || num(f.minHeight) >= 56 || num(f.height) >= 56;
  }
  function cornerEls() {
    var e = React.createElement, sz = 20, o = -3, src = { uri: ASSET + "corner.png" };
    var c = function (k, pos, tf) {
      return e(Image, { key: "orn-" + k, source: src, pointerEvents: "none",
        style: Object.assign({ position: "absolute", width: sz, height: sz, transform: tf }, pos) });
    };
    return [c("tl", { top: o, left: o }, []), c("tr", { top: o, right: o }, [{ scaleX: -1 }]),
      c("bl", { bottom: o, left: o }, [{ scaleY: -1 }]), c("br", { bottom: o, right: o }, [{ scaleX: -1 }, { scaleY: -1 }])];
  }

  // Serif small-caps look for text inside category headers.
  var HEADER_STYLE = { fontFamily: "serif", letterSpacing: 1.4, textTransform: "uppercase" };
  function headerText(type, props) {
    if (!storage.ornStars || !props) return props;
    var n = nameOf(type);
    if (n !== "Text" && type !== Text) return props;
    if (ownerChain().indexOf("CategoryChannel") === -1) return props;
    countOrn("headerText");
    var out = Object.assign({}, props);
    out.style = [props.style, HEADER_STYLE];
    return out;
  }

  // Grimoire: the # channel icon becomes an italic section mark.
  var SECTION_RE = /^(TextIcon|TextLockIcon)$/;
  var SECTION_SIZES = { xxs: 12, xs: 14, sm: 16, md: 20, lg: 24, custom: 20 };
  function SectionIcon(props) {
    var px = typeof props.size === "number" ? props.size : (SECTION_SIZES[props.size] || 20);
    return React.createElement(Text, {
      style: [props.style, { fontFamily: "serif", fontStyle: "italic", fontSize: Math.round(px * 1.05),
        lineHeight: Math.round(px * 1.2), width: px, textAlign: "center", color: "#a08a62" }]
    }, "\u00a7");
  }
  SectionIcon.displayName = "GrimoireSectionIcon";

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
      if (storage.sectionIcons && P().sectionIcons && props0 && SECTION_RE.test(nameOf(type))) {
        args = Array.prototype.slice.call(args);
        args[0] = SectionIcon;
        args[1] = { size: props0.size, style: props0.style, key: props0.key };
      } else if (hideByLabel || shouldHide(type)) {
        args = Array.prototype.slice.call(args);
        var p = args[1] || {};
        args[0] = Hidden;
        args[1] = p.key != null ? { key: p.key } : {};
      } else if (props0) {
        var np = props0;
        var ornType = ornamentFor(type);
        if (ornType) {
          args = Array.prototype.slice.call(args);
          args[0] = ornType;
          type = ornType;
        }
        np = headerText(type, np);
        if (type === Text || (typeof props0.variant === "string" && VARIANT_RE.test(props0.variant))) np = monoProps(np);
        var kind = (storage.boxy || storage.outlines) ? exemptKind(type) : null;
        if (kind === "guild" && !P().roundServers) kind = null;
        np = styleProps(np, type, kind === "avatar" ? "colorOnly" : kind === "tag" ? "noOutline" : kind === "guild" ? "round" : "full");
        // auto frames (decided on Discord's ORIGINAL style, before our boxy/recolor changes)
        if (storage.ornFrames && storage.autoFrames && ASSET && !creatingInner && kind == null &&
            isHostView(type) && props0.style && looksLikePanel(props0.style)) {
          var chain = ownerChain();
          if (!excluded(chain)) {
            var who = chain.split("|")[0] || "?";
            autoFrameOwners[who] = (autoFrameOwners[who] || 0) + 1;
            args = Array.prototype.slice.call(args);
            if (args.length > 2) {
              // createElement(type, props, ...children): add corners as extra children
              args = args.concat(cornerEls());
            } else {
              np = Object.assign({}, np);
              var kids = np.children == null ? [] : [].concat(np.children);
              np.children = kids.concat(cornerEls());
            }
          }
        }
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
      if (toasts) toasts.showToast(failures.length ? "system24: loaded with " + failures.length + " issue(s), see settings" : "Obsidian theme loaded (v19)");
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
    var Press = RN.Pressable || RN.TouchableOpacity;
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
        onValueChange: function (v) { storage[key] = v; resetCache(); clearStyleCaches(); refresh(); }
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
    var iconList = Object.keys(iconProps).map(function (n) { return n + " {" + iconProps[n] + "}"; });
    var ornList = Object.keys(ornCount).map(function (k) { return k + " x" + ornCount[k]; });
    var report = "system24 mobile v19 debug" +
      "\n\nAssets: " + (ASSET || "none") +
      "\nOrnaments: " + (ornList.join(", ") || "none yet") +
      "\nAuto-framed (by component): " + (Object.keys(autoFrameOwners).map(function (k) { return k + " x" + autoFrameOwners[k]; }).join(", ") || "none yet") +
      "\n\nStyle: " + (storage.preset || "obsidian") + "\nOwner tracking: " + ownerTracking +
      "\n\nIcon components: " + (iconList.join(" | ") || "none") +
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
      e(FormSection, { title: "Theme" },
        e(RN.View, { style: { flexDirection: "row", flexWrap: "wrap", gap: 10, padding: 12 } },
          Object.keys(PRESETS).map(function (id) {
            var pr = PRESETS[id], on = (storage.preset || "obsidian") === id;
            return e(Press, {
              key: id, accessibilityRole: "button", accessibilityLabel: pr.label + " theme",
              onPress: function () { storage.preset = id; storage.outlineColor = pr.outline; resetLook(); refresh(); },
              style: { width: 100, borderWidth: on ? 2 : 1, borderColor: on ? accentFor(true) : "#2e2f36", borderRadius: 8, overflow: "hidden", backgroundColor: "#0e1011" }
            },
              e(RN.View, { style: { height: 56, flexDirection: "row" } },
                pr.swatch.map(function (c, i) { return e(RN.View, { key: i, style: { flex: i === 2 ? 0.5 : 1, backgroundColor: c } }); })),
              e(RN.Text, { style: { color: on ? "#d9d3c7" : "#9a958c", fontSize: 13, padding: 8, fontWeight: on ? "700" : "400" } }, (on ? "\u2713 " : "") + pr.label));
          }))
      ),
      e(FormSection, { title: "Accent color" },
        e(RN.View, { style: { flexDirection: "row", flexWrap: "wrap", gap: 12, padding: 12 } },
          ["", "#a1111a", "#ff5a36", "#d4af37", "#d9d3c7", "#8e1b1b", "#6b6b70"].map(function (c) {
            var on = String(storage.accentOverride || "") === c;
            var shown = c || P().accent;
            return e(Press, {
              key: c || "theme", accessibilityRole: "button", accessibilityLabel: c ? "Accent " + c : "Theme default accent",
              onPress: function () { storage.accentOverride = c; resetLook(); refresh(); },
              style: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", borderWidth: on ? 2 : 0, borderColor: "#d9d3c7" }
            }, e(RN.View, { style: { width: 34, height: 34, borderRadius: 17, backgroundColor: shown, alignItems: "center", justifyContent: "center" } },
              c ? null : e(RN.Text, { style: { color: "#d9d3c7", fontSize: 10 } }, "auto")));
          }))
      ),
      e(FormSection, { title: "Ornaments" },
        sw("ornFrames", "Claw-corner frames", "Ornate corners on cards and panels."),
        sw("ornPlates", "Frame nameplates", "Claw corners on nameplates (the art behind names in your account bar and member lists)."),
        sw("autoFrames", "Frame all panels (auto)", "Corners on every solid rounded box, like profile cards and embeds."),
        input("frameExclude", "Never frame (regex)", "Button|Pill|Badge|..."),
        input("frameTargets", "Also frame these components (regex)", "^Card$"),
        sw("ornStars", "Category stars", "Compass star and serif capitals on category headers."),
        sw("ornScales", "Dragon-scale texture", "Faint scales behind lists."),
        input("scaleOpacity", "Scale texture strength (0 to 1)", "0.55")
      ),
      e(FormSection, { title: "Extras" },
        sw("sectionIcons", "\u00a7 channel icons", "Grimoire theme only: replaces # with \u00a7.")
      ),
      e(FormSection, { title: "Look" },
        sw("monoFont", "Force monospace font (fallback)", "Prefer the DM Mono font pack in Kettu > Fonts. Use this only if that doesn't work."),
        input("fontFamily", "Font family", "monospace"),
        input("letterSpacing", "Letter spacing", "-0.3"),
        sw("recolor", "Theme colors", "Recolor Discord with the selected theme."),
        sw("boxy", "Boxy panels", "Square corners on cards, inputs, buttons and images."),
        sw("outlines", "Outlines", "system24-style outlines on boxes, and matching divider lines."),
        input("outlineColor", "Outline color", "#484848", function () { clearStyleCaches(); }),
        input("outlineWidth", "Outline thickness", "1.5", function () { clearStyleCaches(); })
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
