/**
 * Lightweight, zero-dependency ISO/IEC 18004 QR Code Generator (Byte mode, EC Level M, Versions 1..10)
 * Exposes window.QaymaQR.toDataURL(text, opts) and window.QaymaQR.toSVG(text, opts)
 */
(function (global) {
  "use strict";

  // Version 1..10 specs for Error Correction Level M:
  // [totalCodewords, ecCodewordsPerBlock, numBlocksGroup1, dataCodewordsGroup1, numBlocksGroup2, dataCodewordsGroup2]
  var V_SPECS = [
    null,
    [26, 10, 1, 16, 0, 0],
    [44, 16, 1, 28, 0, 0],
    [70, 26, 1, 44, 0, 0],
    [100, 18, 2, 32, 0, 0],
    [134, 24, 2, 43, 0, 0],
    [172, 16, 4, 27, 0, 0],
    [196, 18, 4, 31, 0, 0],
    [242, 22, 2, 38, 2, 39],
    [292, 22, 3, 36, 2, 37],
    [346, 26, 4, 43, 1, 44],
  ];

  var ALIGN_POS = [
    null,
    [],
    [6, 18],
    [6, 22],
    [6, 26],
    [6, 30],
    [6, 34],
    [6, 22, 38],
    [6, 24, 42],
    [6, 26, 46],
    [6, 28, 50],
  ];

  // GF(256) tables with primitive polynomial 0x11d
  var EXP = new Uint8Array(512);
  var LOG = new Uint8Array(256);
  (function initGF() {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  function gfMul(a, b) {
    return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
  }

  function rsGeneratorPoly(degree) {
    var poly = new Uint8Array([1]);
    for (var i = 0; i < degree; i++) {
      var next = new Uint8Array(poly.length + 1);
      var factor = EXP[i];
      for (var j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], factor);
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(data, ecLen) {
    var gen = rsGeneratorPoly(ecLen);
    var rem = new Uint8Array(ecLen);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ rem[0];
      for (var k = 0; k < ecLen - 1; k++) rem[k] = rem[k + 1];
      rem[ecLen - 1] = 0;
      for (var j = 0; j < ecLen; j++) {
        rem[j] ^= gfMul(gen[j + 1], factor);
      }
    }
    return rem;
  }

  function utf8Bytes(str) {
    if (typeof TextEncoder !== "undefined") {
      return Array.from(new TextEncoder().encode(str));
    }
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return out;
  }

  function pickVersion(byteLen) {
    for (var v = 1; v <= 10; v++) {
      var s = V_SPECS[v];
      var totalData = s[2] * s[3] + s[4] * s[5];
      var headerBits = 4 + (v <= 9 ? 8 : 16);
      var availBytes = Math.floor((totalData * 8 - headerBits) / 8);
      if (byteLen <= availBytes) return v;
    }
    throw new Error("QR payload too long (max ~213 UTF-8 bytes)");
  }

  function buildCodewords(bytes, version) {
    var s = V_SPECS[version];
    var totalData = s[2] * s[3] + s[4] * s[5];
    var bits = [];
    function pushBits(val, len) {
      for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
    }

    // Mode 0100 (Byte)
    pushBits(0x4, 4);
    pushBits(bytes.length, version <= 9 ? 8 : 16);
    for (var i = 0; i < bytes.length; i++) pushBits(bytes[i], 8);

    var maxBits = totalData * 8;
    var term = Math.min(4, maxBits - bits.length);
    pushBits(0, term);
    while (bits.length % 8 !== 0) bits.push(0);

    var dataBytes = [];
    for (var b = 0; b < bits.length; b += 8) {
      var v = 0;
      for (var k = 0; k < 8; k++) v = (v << 1) | bits[b + k];
      dataBytes.push(v);
    }
    var pads = [0xec, 0x11];
    var pi = 0;
    while (dataBytes.length < totalData) {
      dataBytes.push(pads[pi & 1]);
      pi++;
    }

    // Split into blocks & compute EC
    var ecLen = s[1];
    var blocks = [];
    var ecBlocks = [];
    var offset = 0;
    for (var g1 = 0; g1 < s[2]; g1++) {
      var blk1 = dataBytes.slice(offset, offset + s[3]);
      offset += s[3];
      blocks.push(blk1);
      ecBlocks.push(rsEncode(blk1, ecLen));
    }
    for (var g2 = 0; g2 < s[4]; g2++) {
      var blk2 = dataBytes.slice(offset, offset + s[5]);
      offset += s[5];
      blocks.push(blk2);
      ecBlocks.push(rsEncode(blk2, ecLen));
    }

    // Interleave data codewords, then EC codewords
    var out = [];
    var maxBlkLen = Math.max(s[3], s[5]);
    for (var col = 0; col < maxBlkLen; col++) {
      for (var bi = 0; bi < blocks.length; bi++) {
        if (col < blocks[bi].length) out.push(blocks[bi][col]);
      }
    }
    for (var ecol = 0; ecol < ecLen; ecol++) {
      for (var ebi = 0; ebi < ecBlocks.length; ebi++) {
        out.push(ecBlocks[ebi][ecol]);
      }
    }
    return out;
  }

  function createMatrix(text) {
    var bytes = utf8Bytes(text);
    var version = pickVersion(bytes.length);
    var size = version * 4 + 17;
    var modules = Array.from({ length: size }, function () {
      return new Uint8Array(size);
    });
    var isFunc = Array.from({ length: size }, function () {
      return new Uint8Array(size);
    });

    function setFunc(r, c, dark) {
      if (r < 0 || r >= size || c < 0 || c >= size) return;
      modules[r][c] = dark ? 1 : 0;
      isFunc[r][c] = 1;
    }

    function drawFinder(r0, c0) {
      for (var dr = -1; dr <= 7; dr++) {
        for (var dc = -1; dc <= 7; dc++) {
          var rr = r0 + dr;
          var cc = c0 + dc;
          var dark =
            dr >= 0 &&
            dr <= 6 &&
            dc >= 0 &&
            dc <= 6 &&
            (dr === 0 ||
              dr === 6 ||
              dc === 0 ||
              dc === 6 ||
              (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
          setFunc(rr, cc, dark);
        }
      }
    }

    drawFinder(0, 0);
    drawFinder(0, size - 7);
    drawFinder(size - 7, 0);

    // Timing patterns
    for (var i = 8; i < size - 8; i++) {
      setFunc(6, i, i % 2 === 0);
      setFunc(i, 6, i % 2 === 0);
    }

    // Alignment patterns
    var apos = ALIGN_POS[version];
    for (var ai = 0; ai < apos.length; ai++) {
      for (var aj = 0; aj < apos.length; aj++) {
        if (
          (ai === 0 && aj === 0) ||
          (ai === 0 && aj === apos.length - 1) ||
          (ai === apos.length - 1 && aj === 0)
        ) {
          continue;
        }
        var cr = apos[ai];
        var cc = apos[aj];
        for (var dr = -2; dr <= 2; dr++) {
          for (var dc = -2; dc <= 2; dc++) {
            setFunc(
              cr + dr,
              cc + dc,
              Math.max(Math.abs(dr), Math.abs(dc)) !== 1
            );
          }
        }
      }
    }

    // Reserve format info + dark module
    for (var f = 0; f <= 8; f++) {
      if (f !== 6) {
        isFunc[8][f] = 1;
        isFunc[f][8] = 1;
      }
    }
    for (var f2 = 0; f2 < 8; f2++) {
      isFunc[8][size - 1 - f2] = 1;
      isFunc[size - 1 - f2][8] = 1;
    }
    setFunc(size - 8, 8, true);

    // Version >= 7 info bits (not needed unless v >= 7, let's include!)
    if (version >= 7) {
      var rem = version;
      for (var vi = 0; vi < 12; vi++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      var vbits = (version << 12) | rem;
      for (var vb = 0; vb < 18; vb++) {
        var bit = ((vbits >>> vb) & 1) === 1;
        var a = size - 11 + (vb % 3);
        var b = Math.floor(vb / 3);
        setFunc(a, b, bit);
        setFunc(b, a, bit);
      }
    }

    // Place data bits
    var codewords = buildCodewords(bytes, version);
    var bitIdx = 0;
    var totalBits = codewords.length * 8;
    var upward = true;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        var r = upward ? size - 1 - vert : vert;
        for (var j = 0; j < 2; j++) {
          var c = right - j;
          if (!isFunc[r][c]) {
            var darkBit = false;
            if (bitIdx < totalBits) {
              darkBit =
                ((codewords[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1) === 1;
              bitIdx++;
            }
            modules[r][c] = darkBit ? 1 : 0;
          }
        }
      }
      upward = !upward;
    }

    function applyFormatBits(mat, mask) {
      // EC Level M = 00
      var data = (0 << 3) | mask;
      var rem = data;
      for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var bits = ((data << 10) | rem) ^ 0x5412;

      for (var k = 0; k <= 5; k++) mat[k][8] = (bits >>> k) & 1;
      mat[7][8] = (bits >>> 6) & 1;
      mat[8][8] = (bits >>> 7) & 1;
      mat[8][7] = (bits >>> 8) & 1;
      for (var k2 = 9; k2 < 15; k2++) mat[8][14 - k2] = (bits >>> k2) & 1;

      for (var k3 = 0; k3 < 8; k3++) mat[8][size - 1 - k3] = (bits >>> k3) & 1;
      for (var k4 = 8; k4 < 15; k4++)
        mat[size - 15 + k4][8] = (bits >>> k4) & 1;
      mat[size - 8][8] = 1;
    }

    function maskCond(mask, r, c) {
      switch (mask) {
        case 0: return (r + c) % 2 === 0;
        case 1: return r % 2 === 0;
        case 2: return c % 3 === 0;
        case 3: return (r + c) % 3 === 0;
        case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
        case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
        case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
        default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
      }
    }

    function penalty(mat) {
      var p = 0;
      for (var r = 0; r < size; r++) {
        var runColor = mat[r][0], runLen = 1;
        for (var c = 1; c < size; c++) {
          if (mat[r][c] === runColor) {
            runLen++;
            if (runLen === 5) p += 3;
            else if (runLen > 5) p += 1;
          } else {
            runColor = mat[r][c];
            runLen = 1;
          }
        }
      }
      for (var c2 = 0; c2 < size; c2++) {
        var runColor2 = mat[0][c2], runLen2 = 1;
        for (var r2 = 1; r2 < size; r2++) {
          if (mat[r2][c2] === runColor2) {
            runLen2++;
            if (runLen2 === 5) p += 3;
            else if (runLen2 > 5) p += 1;
          } else {
            runColor2 = mat[r2][c2];
            runLen2 = 1;
          }
        }
      }
      for (var r3 = 0; r3 < size - 1; r3++) {
        for (var c3 = 0; c3 < size - 1; c3++) {
          var v = mat[r3][c3];
          if (v === mat[r3][c3 + 1] && v === mat[r3 + 1][c3] && v === mat[r3 + 1][c3 + 1]) {
            p += 3;
          }
        }
      }
      return p;
    }

    var bestMask = 0;
    var bestScore = Infinity;
    var bestMat = null;

    for (var m = 0; m < 8; m++) {
      var copy = modules.map(function (row) {
        return new Uint8Array(row);
      });
      for (var r4 = 0; r4 < size; r4++) {
        for (var c4 = 0; c4 < size; c4++) {
          if (!isFunc[r4][c4] && maskCond(m, r4, c4)) {
            copy[r4][c4] ^= 1;
          }
        }
      }
      applyFormatBits(copy, m);
      var sc = penalty(copy);
      if (sc < bestScore) {
        bestScore = sc;
        bestMask = m;
        bestMat = copy;
      }
    }

    return { size: size, modules: bestMat, mask: bestMask };
  }

  function toSVG(text, opts) {
    opts = opts || {};
    var margin = opts.margin != null ? opts.margin : 2;
    var dark = opts.dark || "#181212";
    var light = opts.light || "#FFFFFF";
    var qr = createMatrix(text);
    var total = qr.size + margin * 2;
    var paths = [];
    for (var r = 0; r < qr.size; r++) {
      for (var c = 0; c < qr.size; c++) {
        if (qr.modules[r][c]) {
          paths.push("M" + (c + margin) + "," + (r + margin) + "h1v1h-1z");
        }
      }
    }
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' +
      total +
      " " +
      total +
      '" shape-rendering="crispEdges">' +
      '<rect width="100%" height="100%" fill="' +
      light +
      '"/>' +
      '<path d="' +
      paths.join("") +
      '" fill="' +
      dark +
      '"/></svg>'
    );
  }

  function toDataURL(text, opts) {
    opts = opts || {};
    var pxSize = opts.width || 520;
    var margin = opts.margin != null ? opts.margin : 2;
    var dark = opts.dark || "#181212";
    var light = opts.light || "#FFFFFF";
    var qr = createMatrix(text);
    var totalModules = qr.size + margin * 2;
    var scale = Math.max(4, Math.floor(pxSize / totalModules));
    var realSize = totalModules * scale;

    var canvas = document.createElement("canvas");
    canvas.width = realSize;
    canvas.height = realSize;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, realSize, realSize);
    ctx.fillStyle = dark;
    for (var r = 0; r < qr.size; r++) {
      for (var c = 0; c < qr.size; c++) {
        if (qr.modules[r][c]) {
          ctx.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale);
        }
      }
    }
    return canvas.toDataURL("image/png");
  }

  var api = { createMatrix: createMatrix, toSVG: toSVG, toDataURL: toDataURL };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.QaymaQR = api;
})(typeof window !== "undefined" ? window : globalThis);
