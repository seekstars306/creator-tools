/* Creator Tools core: pure functions, no DOM, no network, no upload.
   Used by subtitle-encoding-fixer, bilingual-subtitle-merger and
   cjk-subtitle-checker. In the browser it is exposed as window.CTCore;
   in Node it is module.exports, so the same code is unit-testable. */
(function (root) {
  "use strict";

  function parseTimestamp(ts) {
    if (ts === undefined || ts === null) return null;
    var s = String(ts).trim();
    var m = s.match(/^(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/)
      || s.match(/^(\d+):(\d{1,2})[,.](\d{1,3})$/)
      || s.match(/^(\d+):(\d{1,2}):(\d{1,2})$/)
      || s.match(/^(\d+):(\d{1,2})$/);
    if (!m) return null;
    if (m.length === 5) {
      var ms = m[4]; while (ms.length < 3) ms += "0";
      return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+ms) / 1000;
    }
    if (m.length === 4) {
      var ms2 = m[3]; while (ms2.length < 3) ms2 += "0";
      return (+m[1]) * 60 + (+m[2]) + (+ms2) / 1000;
    }
    if (m.length === 3) return (+m[1]) * 60 + (+m[2]);
    return null;
  }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function pad3(n) { return (n < 10 ? "00" : n < 100 ? "0" : "") + n; }

  function formatTimestamp(sec, dot) {
    var t = Math.max(0, sec);
    var h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60);
    var s = Math.floor(t % 60), ms = Math.round((t - Math.floor(t)) * 1000);
    if (ms === 1000) { ms = 0; s += 1; }
    return pad2(h) + ":" + pad2(m) + ":" + pad2(s) + (dot ? "." : ",") + pad3(ms);
  }

  function formatAssTimestamp(sec) {
    var t = Math.max(0, sec);
    var h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60);
    var s = Math.floor(t % 60), cs = Math.floor((t - Math.floor(t)) * 100);
    return h + ":" + pad2(m) + ":" + pad2(s) + "." + pad2(cs);
  }

  function stripBom(text) {
    return String(text).charAt(0) === "\uFEFF" ? String(text).slice(1) : String(text);
  }

  function hasReplacementChar(text) {
    return String(text).indexOf("\uFFFD") >= 0;
  }

  // Parse SRT or WebVTT text into cues. Timestamps are kept as seconds.
  function parseSrt(text) {
    var body = stripBom(String(text)).replace(/\r\n?/g, "\n");
    body = body.replace(/^WEBVTT[^\n]*\n/, "");
    var blocks = body.split(/\n\s*\n/);
    var cues = [];
    blocks.forEach(function (block) {
      var lines = block.split("\n").filter(function (l) { return l.trim() !== ""; });
      if (!lines.length) return;
      if (/^\d+$/.test(lines[0].trim())) lines.shift();
      if (!lines.length || lines[0].indexOf("-->") < 0) return;
      var parts = lines[0].split("-->");
      var start = parseTimestamp(parts[0]), end = parseTimestamp(parts[1]);
      if (start === null || end === null) return;
      cues.push({ start: start, end: end, text: lines.slice(1).join("\n") });
    });
    cues.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    return cues;
  }

  function serializeSrt(cues) {
    return cues.map(function (c, i) {
      return (i + 1) + "\n" + formatTimestamp(c.start, false) + " --> " +
        formatTimestamp(c.end, false) + "\n" + c.text;
    }).join("\n\n");
  }

  function overlap(a, b) {
    return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  }

  // Merge two cue lists. B cues are shifted by offsetSec first. A cue's
  // timeline becomes the union with any B cue merged into it. Unmatched
  // cues are kept as their own cues and reported, never hidden.
  function mergeSubtitles(cuesA, cuesB, offsetSec) {
    var offset = isFinite(offsetSec) ? offsetSec : 0;
    var merged = cuesA.map(function (c) {
      return { start: c.start, end: c.end, text: c.text, fromA: true, merged: false };
    });
    var unmatchedB = [];
    cuesB.forEach(function (b) {
      var shifted = { start: Math.max(0, b.start + offset), end: b.end + offset, text: b.text };
      if (shifted.end <= 0) { unmatchedB.push(shifted); return; }
      shifted.end = Math.max(shifted.start, shifted.end);
      var best = -1, bestOv = 0;
      merged.forEach(function (m, idx) {
        if (!m.fromA) return;
        var ov = overlap(m, shifted);
        if (ov > bestOv) { bestOv = ov; best = idx; }
      });
      if (best >= 0 && bestOv > 0) {
        var target = merged[best];
        target.text = target.text + "\n" + shifted.text;
        target.start = Math.min(target.start, shifted.start);
        target.end = Math.max(target.end, shifted.end);
        target.merged = true;
      } else {
        merged.push({ start: shifted.start, end: shifted.end, text: shifted.text, fromA: false, merged: false });
        unmatchedB.push(shifted);
      }
    });
    merged.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    var mergedCount = merged.filter(function (m) { return m.merged; }).length;
    // An A cue is unmatched if no B cue ever overlapped it.
    return {
      cues: merged.map(function (m) { return { start: m.start, end: m.end, text: m.text }; }),
      mergedCount: mergedCount,
      unmatchedA: merged.filter(function (m) { return m.fromA && !m.merged; })
        .map(function (m) { return { start: m.start, end: m.end, text: m.text }; }),
      unmatchedB: unmatchedB,
      total: merged.length
    };
  }

  // ASS export: a merged cue with two lines becomes two Dialogue lines,
  // one per style; a single-line cue becomes one Dialogue line.
  function buildAss(cues) {
    var head = "[Script Info]\nTitle: Bilingual Subtitles\nScriptType: v4.00+\n\n" +
      "[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n" +
      "Style: Lang1,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1\n" +
      "Style: Lang2,Arial,16,&H0000FFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,8,10,10,10,1\n\n" +
      "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";
    var lines = [];
    cues.forEach(function (c) {
      var parts = c.text.split("\n");
      var start = formatAssTimestamp(c.start), end = formatAssTimestamp(c.end);
      if (parts.length >= 2) {
        lines.push("Dialogue: 0," + start + "," + end + ",Lang1,,0,0,0,,," + parts[0]);
        lines.push("Dialogue: 0," + start + "," + end + ",Lang2,,0,0,0,,," + parts.slice(1).join("\\N"));
      } else {
        lines.push("Dialogue: 0," + start + "," + end + ",Lang1,,0,0,0,,," + c.text.replace(/\n/g, "\\N"));
      }
    });
    return head + lines.join("\n") + "\n";
  }

  // --- Encoding helpers ---
  var ENCODINGS = ["utf-8", "gb18030", "shift-jis", "euc-kr", "big5", "windows-1252"];

  function decodeCandidates(buffer) {
    return ENCODINGS.map(function (label) {
      var text;
      try { text = new TextDecoder(label).decode(buffer); }
      catch (e) { text = ""; }
      return { label: label, text: text };
    });
  }

  function previewLines(text, maxLines) {
    var lines = String(text).split(/\r?\n/).filter(function (l) { return l.trim() !== ""; });
    return lines.slice(0, maxLines || 3).join("\n");
  }

  // Windows-1252 byte for a Unicode char, or null if it has no mapping.
  // 0x80-0x9F are the printable punctuation mapped by windows-1252.
  var WIN1252_REVERSE = {
    "\u20AC": 0x80, "\u201A": 0x82, "\u0192": 0x83, "\u201E": 0x84,
    "\u2026": 0x85, "\u2020": 0x86, "\u2021": 0x87, "\u02C6": 0x88,
    "\u2030": 0x89, "\u0160": 0x8A, "\u2039": 0x8B, "\u0152": 0x8C,
    "\u017D": 0x8E, "\u2018": 0x91, "\u2019": 0x92, "\u201C": 0x93,
    "\u201D": 0x94, "\u2022": 0x95, "\u2013": 0x96, "\u2014": 0x97,
    "\u02DC": 0x98, "\u2122": 0x99, "\u0161": 0x9A, "\u203A": 0x9B,
    "\u0153": 0x9C, "\u017E": 0x9E, "\u0178": 0x9F
  };

  // Reverse a UTF-8-read-as-windows-1252 double encoding, e.g. "Ã©" -> "é".
  // Returns the original text when reversal is impossible or unsafe.
  function fixDoubleEncoding(text) {
    var s = String(text);
    var bytes = [];
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i), code = s.charCodeAt(i);
      // Codes <= 0xFF map to the same byte, including the C1 controls
      // (0x80-0x9F) that windows-1252 decoding produces for its
      // otherwise-undefined bytes, e.g. 0x9D for a closing curly quote.
      if (code <= 0xFF) bytes.push(code);
      else if (WIN1252_REVERSE[ch] !== undefined) bytes.push(WIN1252_REVERSE[ch]);
      else return s;
    }
    var decoded;
    try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes)); }
    catch (e) { return s; }
    if (decoded === s || hasReplacementChar(decoded)) return s;
    return decoded;
  }

  // --- CJK detection / QC / reflow ---
  function countInRanges(text, ranges) {
    var n = 0;
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      for (var r = 0; r < ranges.length; r++) {
        if (code >= ranges[r][0] && code <= ranges[r][1]) { n++; break; }
      }
    }
    return n;
  }

  // kana > hangul > han > latin. Kanji-only Japanese cannot be told
  // apart from Chinese by script alone, so it returns "zh" and the
  // page must offer a manual language override.
  function detectScript(text) {
    var s = String(text);
    var kana = countInRanges(s, [[0x3040, 0x30FF], [0x31F0, 0x31FF], [0xFF66, 0xFF9D]]);
    if (kana > 0) return "ja";
    var hangul = countInRanges(s, [[0xAC00, 0xD7A3], [0x1100, 0x11FF]]);
    var han = countInRanges(s, [[0x4E00, 0x9FFF], [0x3400, 0x4DBF], [0xF900, 0xFAFF]]);
    if (hangul > 0 && hangul >= han) return "ko";
    if (han > 0) return "zh";
    return "en";
  }

  function cueCharCount(text) {
    var clean = String(text).replace(/<[^>]*>/g, "").replace(/\r?\n/g, " ");
    return Array.from(clean).length;
  }

  function cueCps(cue) {
    var dur = cue.end - cue.start;
    if (dur <= 0) return Infinity;
    return cueCharCount(cue.text) / dur;
  }

  function checkCue(cue, preset) {
    var chars = cueCharCount(cue.text), cps = cueCps(cue);
    return {
      chars: chars, cps: cps,
      tooLong: chars > preset.maxChars,
      tooFast: cps > preset.maxCps
    };
  }

  function checkSubtitles(cues, preset) {
    var issues = [];
    cues.forEach(function (cue, idx) {
      var r = checkCue(cue, preset);
      if (r.tooLong) issues.push({ cue: idx + 1, type: "tooLong", chars: r.chars, limit: preset.maxChars, text: cue.text });
      if (r.tooFast) issues.push({ cue: idx + 1, type: "tooFast", cps: Math.round(r.cps * 10) / 10, limit: preset.maxCps, text: cue.text });
    });
    return issues;
  }

  var BREAK_CHARS = "，。！？、；：,.!?;: \u3000　";
  var PARTICLES = "はがをにでともへかやねよ";

  // Greedy reflow: break after the last punctuation/particle/space
  // inside the limit; only hard-break mid-string when no such point
  // exists, and flag that cue so the page can warn about it.
  function reflowText(text, maxChars) {
    var chars = Array.from(String(text));
    var lines = [], hardBreaks = 0, rest = chars;
    while (rest.length > maxChars) {
      var windowChars = rest.slice(0, maxChars);
      var cut = -1;
      for (var i = windowChars.length - 1; i >= 0; i--) {
        var ch = windowChars[i];
        if (BREAK_CHARS.indexOf(ch) >= 0 || PARTICLES.indexOf(ch) >= 0) { cut = i + 1; break; }
      }
      if (cut <= 0) { cut = maxChars; hardBreaks++; }
      var line = rest.slice(0, cut).join("");
      // Do not leave a trailing space on the line.
      lines.push(line.replace(/[ \u3000]+$/, ""));
      rest = rest.slice(cut);
      while (rest.length && (rest[0] === " " || rest[0] === "\u3000")) rest = rest.slice(1);
    }
    if (rest.length) lines.push(rest.join(""));
    return { lines: lines, hardBreaks: hardBreaks };
  }

  function reflowSubtitles(cues, maxChars) {
    return cues.map(function (cue) {
      var r = reflowText(cue.text.replace(/\r?\n/g, " "), maxChars);
      return { start: cue.start, end: cue.end, text: r.lines.join("\n"), hardBreaks: r.hardBreaks };
    });
  }

  var api = {
    parseTimestamp: parseTimestamp, formatTimestamp: formatTimestamp,
    formatAssTimestamp: formatAssTimestamp, stripBom: stripBom,
    hasReplacementChar: hasReplacementChar, parseSrt: parseSrt,
    serializeSrt: serializeSrt, overlap: overlap,
    mergeSubtitles: mergeSubtitles, buildAss: buildAss,
    ENCODINGS: ENCODINGS, decodeCandidates: decodeCandidates,
    previewLines: previewLines, fixDoubleEncoding: fixDoubleEncoding,
    detectScript: detectScript, cueCharCount: cueCharCount,
    cueCps: cueCps, checkCue: checkCue, checkSubtitles: checkSubtitles,
    reflowText: reflowText, reflowSubtitles: reflowSubtitles
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CTCore = api;
})(typeof window !== "undefined" ? window : this);
