/**
 * محرك المنيو التفاعلي والطلبات عبر واتساب (Static / Zero-Backend)
 * يدعم:
 * - مزامنة لحظية للأسعار، التوفر، والأصناف الموسمية من Google Sheets CSV (اختياري عبر googleSheetCsvUrl)
 * - تعدد الفروع بأرقام واتساب منفصلة لكل فرع (branches)
 * - التحكم في طرق الطلب المتاحة (delivery / takeaway / dine_in)
 * - أصناف "السعر حسب الشكل/الطلب" (priceOnRequest) والأصناف غير المتاحة مؤقتاً (soldOut)
 */
(function () {
  "use strict";

  var R = window.RESTAURANT_DATA;
  var C = window.CREDITS_CONFIG || {};
  if (!R) return;

  var CART_KEY = "qayma_cart_" + R.slug;
  var CUST_KEY = "qayma_customer_v1";
  var BRANCH_KEY = "qayma_branch_" + R.slug;

  var allowedModes =
    R.orderModes && R.orderModes.length
      ? R.orderModes
      : ["delivery", "takeaway", "dine_in"];

  var branches = R.branches && R.branches.length ? R.branches : null;

  var state = {
    activeCat: R.categories[0] ? R.categories[0].id : "",
    selectedBranchId: branches ? branches[0].id : "",
    search: "",
    onlyPopular: false,
    cart: [],
    justAddedId: null,
    detectedTable: null,
    sheetSynced: false,
    checkout: {
      mode: allowedModes[0],
      name: "",
      phone: "",
      address: "",
      table: "",
      note: "",
    },
    customizer: null,
    cartOpen: false,
    flyerOpen: false,
    errorMsg: "",
    copiedMsg: false,
  };

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtPrice(n) {
    var num = Number(n);
    var v = Number.isInteger(num) ? String(num) : num.toFixed(1);
    return v + " ج.م";
  }

  function activeBranch() {
    if (!branches) {
      return {
        id: "main",
        name: R.city || "",
        address: R.address || "",
        phone: R.phone || "",
        whatsapp: R.whatsapp || "",
        mapsQuery: R.mapsQuery || R.address || "",
      };
    }
    return (
      branches.find(function (b) {
        return b.id === state.selectedBranchId;
      }) || branches[0]
    );
  }

  function loadStorage() {
    try {
      var savedCart = localStorage.getItem(CART_KEY);
      if (savedCart) state.cart = JSON.parse(savedCart) || [];
      var savedCust = localStorage.getItem(CUST_KEY);
      if (savedCust) {
        var p = JSON.parse(savedCust);
        state.checkout.name = p.name || "";
        state.checkout.phone = p.phone || "";
        state.checkout.address = p.address || "";
      }
      if (branches) {
        var savedBr = localStorage.getItem(BRANCH_KEY);
        if (
          savedBr &&
          branches.some(function (b) {
            return b.id === savedBr;
          })
        ) {
          state.selectedBranchId = savedBr;
        }
      }
    } catch (_) {}

    if (allowedModes.indexOf("dine_in") >= 0) {
      var params = new URLSearchParams(window.location.search);
      var tbl = params.get("table");
      if (tbl && tbl.trim()) {
        state.detectedTable = tbl.trim();
        state.checkout.mode = "dine_in";
        state.checkout.table = tbl.trim();
      }
    }
  }

  function saveCart() {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(state.cart));
    } catch (_) {}
  }

  function saveCustomer() {
    try {
      localStorage.setItem(
        CUST_KEY,
        JSON.stringify({
          name: state.checkout.name,
          phone: state.checkout.phone,
          address: state.checkout.address,
        })
      );
    } catch (_) {}
  }

  // RFC-4180 CSV parser for Google Sheets published CSV
  function parseCsv(text) {
    var rows = [];
    var row = [];
    var cur = "";
    var inQuotes = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      var next = text[i + 1];
      if (inQuotes) {
        if (ch === '"' && next === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          cur += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ",") {
          row.push(cur.trim());
          cur = "";
        } else if (ch === "\n" || ch === "\r") {
          if (ch === "\r" && next === "\n") i++;
          row.push(cur.trim());
          if (row.some(Boolean)) rows.push(row);
          row = [];
          cur = "";
        } else {
          cur += ch;
        }
      }
    }
    row.push(cur.trim());
    if (row.some(Boolean)) rows.push(row);
    return rows;
  }

  function applyGoogleSheetCsv(csvText) {
    var rows = parseCsv(csvText);
    if (rows.length < 2) return;
    var header = rows[0].map(function (h) {
      return h.toLowerCase().trim();
    });
    var idxId = header.indexOf("id");
    var idxCatId = header.indexOf("category_id");
    var idxCatName = header.indexOf("category_name");
    var idxName = header.indexOf("name");
    var idxPrice = header.indexOf("price");
    var idxAvail = header.indexOf("available");
    var idxBadge = header.indexOf("badge");
    var idxDesc = header.indexOf("description");

    var itemMap = {};
    R.categories.forEach(function (cat) {
      cat.items.forEach(function (it) {
        itemMap[it.id] = it;
      });
    });

    for (var r = 1; r < rows.length; r++) {
      var cols = rows[r];
      var id = idxId >= 0 ? cols[idxId] : "";
      var name = idxName >= 0 ? cols[idxName] : "";
      var rawPrice = idxPrice >= 0 ? cols[idxPrice] : "";
      var availStr = idxAvail >= 0 ? (cols[idxAvail] || "").toLowerCase() : "نعم";
      var badge = idxBadge >= 0 ? cols[idxBadge] : undefined;
      var desc = idxDesc >= 0 ? cols[idxDesc] : undefined;

      var isHidden = availStr === "اخفاء" || availStr === "hide";
      var isSoldOut =
        availStr === "لا" ||
        availStr === "no" ||
        availStr === "0" ||
        availStr === "false" ||
        availStr === "خلص" ||
        availStr === "غير متاح";

      var parsedNum = parseFloat(rawPrice);
      var isOnReq =
        rawPrice === "-" ||
        rawPrice === "حسب الشكل" ||
        rawPrice === "حسب الطلب" ||
        isNaN(parsedNum);

      if (id && itemMap[id]) {
        var target = itemMap[id];
        target._hidden = isHidden;
        target.soldOut = isSoldOut;
        if (rawPrice !== "") {
          if (isOnReq) {
            target.priceOnRequest = true;
            target.priceLabel = rawPrice !== "-" ? rawPrice : "حسب الشكل";
          } else {
            target.priceOnRequest = false;
            target.price = parsedNum;
          }
        }
        if (name) target.name = name;
        if (badge !== undefined && badge !== "") target.badge = badge;
        if (desc !== undefined && desc !== "") target.description = desc;
      } else if (name && !isHidden) {
        // صنف جديد أو موسمي أضافه صاحب المطعم مباشرة في الشيت!
        var catId = (idxCatId >= 0 && cols[idxCatId]) || "seasonal-sheet";
        var catName =
          (idxCatName >= 0 && cols[idxCatName]) || "عروض وأصناف الموسم";
        var catObj = R.categories.find(function (c) {
          return c.id === catId || c.name === catName;
        });
        if (!catObj) {
          catObj = {
            id: catId,
            name: catName,
            subtitle: "متاح الآن لفترة محدودة",
            tone: "accent",
            items: [],
          };
          R.categories.unshift(catObj);
        }
        var newItem = {
          id: id || "sheet_item_" + r,
          name: name,
          description: desc || "",
          price: isOnReq ? 0 : parsedNum,
          priceOnRequest: isOnReq,
          priceLabel: isOnReq
            ? rawPrice && rawPrice !== "-"
              ? rawPrice
              : "حسب الطلب"
            : "",
          badge: badge || "",
          soldOut: isSoldOut,
        };
        catObj.items.push(newItem);
        itemMap[newItem.id] = newItem;
      }
    }

    state.sheetSynced = true;
    if (R.categories[0]) state.activeCat = R.categories[0].id;
    renderMenuAndBar();
  }

  function syncSheetIfConfigured() {
    if (!R.googleSheetCsvUrl || !R.googleSheetCsvUrl.trim()) return;
    fetch(R.googleSheetCsvUrl.trim(), { cache: "no-store" })
      .then(function (res) {
        return res.ok ? res.text() : Promise.reject();
      })
      .then(applyGoogleSheetCsv)
      .catch(function () {
        // في حالة عدم توفر إنترنت يستمر العمل بالبيانات المحلية بسلاسة
      });
  }

  function findItem(itemId) {
    for (var i = 0; i < R.categories.length; i++) {
      var items = R.categories[i].items;
      for (var j = 0; j < items.length; j++) {
        if (items[j].id === itemId) return items[j];
      }
    }
    return null;
  }

  function lineIsOnRequest(line) {
    if (line.variant) return !!line.variant.priceOnRequest;
    return !!line.priceOnRequest;
  }

  function lineUnitPrice(line) {
    if (lineIsOnRequest(line)) {
      return (line.addons || []).reduce(function (s, a) {
        return s + a.price;
      }, 0);
    }
    var base = line.variant ? line.variant.price : line.basePrice;
    var add = (line.addons || []).reduce(function (s, a) {
      return s + a.price;
    }, 0);
    return base + add;
  }

  function lineTotal(line) {
    return lineUnitPrice(line) * line.qty;
  }

  function cartCount() {
    return state.cart.reduce(function (s, l) {
      return s + l.qty;
    }, 0);
  }

  function cartSubtotal() {
    return state.cart.reduce(function (s, l) {
      return s + lineTotal(l);
    }, 0);
  }

  function cartHasOnRequest() {
    return state.cart.some(lineIsOnRequest);
  }

  function itemQtyInCart(itemId) {
    return state.cart
      .filter(function (l) {
        return l.itemId === itemId;
      })
      .reduce(function (s, l) {
        return s + l.qty;
      }, 0);
  }

  function addToCartLine(payload) {
    var addonKey = (payload.addons || [])
      .map(function (a) {
        return a.id;
      })
      .sort()
      .join(",");
    var key =
      payload.itemId +
      "__" +
      (payload.variant ? payload.variant.id : "base") +
      "__" +
      JSON.stringify(payload.choices || {}) +
      "__" +
      addonKey +
      "__" +
      (payload.note || "");

    var existing = state.cart.find(function (l) {
      return l.key === key;
    });
    if (existing) {
      existing.qty += payload.qty;
    } else {
      state.cart.push({
        key: key,
        itemId: payload.itemId,
        name: payload.name,
        basePrice: payload.basePrice,
        priceOnRequest: !!payload.priceOnRequest,
        priceLabel: payload.priceLabel || "",
        variant: payload.variant || null,
        choices: payload.choices || {},
        addons: payload.addons || [],
        note: payload.note || "",
        qty: payload.qty,
      });
    }
    saveCart();
    state.justAddedId = payload.itemId;
    renderMenuAndBar();
    setTimeout(function () {
      if (state.justAddedId === payload.itemId) {
        state.justAddedId = null;
        renderMenuAndBar();
      }
    }, 850);
  }

  function buildOrderMessage() {
    var br = activeBranch();
    var modeMap = {
      delivery: "توصيل للمنزل (دليفري)",
      takeaway: "استلام من الفرع",
      dine_in:
        "داخل الصالة" +
        (state.checkout.table
          ? " — ترابيزة رقم (" + state.checkout.table + ")"
          : ""),
    };

    var lines = [];
    lines.push("*طلب جديد — " + R.name + "*");
    lines.push("──────────────");
    if (branches && branches.length > 1) {
      lines.push("*الفرع:* " + br.name + " (" + br.address + ")");
    }
    lines.push("*نوع الطلب:* " + modeMap[state.checkout.mode]);

    if (state.checkout.name.trim()) {
      lines.push("*الاسم:* " + state.checkout.name.trim());
    }
    if (state.checkout.phone.trim()) {
      lines.push("*الموبايل:* " + state.checkout.phone.trim());
    }
    if (state.checkout.mode === "delivery" && state.checkout.address.trim()) {
      lines.push("*العنوان:* " + state.checkout.address.trim());
    }

    lines.push("");
    lines.push("*الأصناف المطلوبة:*");

    state.cart.forEach(function (l, idx) {
      var vPart = l.variant ? " — " + l.variant.label : "";
      var cVals = Object.values(l.choices || {}).filter(Boolean);
      var cPart = cVals.length ? " (" + cVals.join("، ") + ")" : "";
      lines.push(idx + 1 + ". *" + l.qty + "× " + l.name + "*" + vPart + cPart);
      if (l.addons && l.addons.length) {
        lines.push(
          "   + إضافات: " +
            l.addons
              .map(function (a) {
                return a.label + " (+" + a.price + "ج)";
              })
              .join("، ")
        );
      }
      if (l.note) {
        lines.push("   ملاحظة/تفاصيل: " + l.note);
      }
      if (lineIsOnRequest(l)) {
        lines.push(
          "   السعر: يُحدد حسب الشكل/الطلب عند التأكيد" +
            (lineTotal(l) > 0 ? " (إضافات: " + fmtPrice(lineTotal(l)) + ")" : "")
        );
      } else {
        lines.push("   السعر: " + fmtPrice(lineTotal(l)));
      }
    });

    lines.push("──────────────");
    var sub = cartSubtotal();
    if (cartHasOnRequest()) {
      lines.push(
        "*إجمالي الأصناف المسعّرة:* *" +
          fmtPrice(sub) +
          "* _(تُضاف قيمة الأصناف الخاصة حسب الشكل عند التأكيد)_"
      );
    } else {
      lines.push("*إجمالي الأصناف:* *" + fmtPrice(sub) + "*");
    }
    if (state.checkout.mode === "delivery") {
      lines.push("_(يُضاف رسوم التوصيل حسب المكان عند التأكيد)_");
    }
    if (state.checkout.note.trim()) {
      lines.push("*ملاحظات إضافية:* " + state.checkout.note.trim());
    }
    return lines.join("\n");
  }

  function validateCheckout() {
    var ch = state.checkout;
    var br = activeBranch();
    if (!br.whatsapp) {
      return "هذا الفرع للعرض فقط حالياً — اختر فرعاً متاحاً للطلب عبر واتساب";
    }
    if (ch.mode === "delivery") {
      if (!ch.name.trim()) return "من فضلك اكتب اسمك لتأكيد الأوردر";
      if (!ch.phone.trim())
        return "من فضلك اكتب رقم الموبايل عشان الدليفري يتواصل معاك";
      if (!ch.address.trim()) return "من فضلك اكتب العنوان بالتفصيل";
    } else if (ch.mode === "takeaway") {
      if (!ch.name.trim())
        return "من فضلك اكتب اسمك عشان نجهزلك الطلب باسمك";
    } else if (ch.mode === "dine_in") {
      if (!ch.table.trim()) return "من فضلك اكتب رقم الترابيزة";
    }
    return "";
  }

  function renderHeaderAndFooter() {
    var tableBanner = document.getElementById("table-banner");
    if (state.detectedTable) {
      tableBanner.textContent =
        "أهلاً بيك في صالة " +
        R.name +
        " — تم تحديد ترابيزة رقم (" +
        state.detectedTable +
        ") تلقائياً";
      tableBanner.classList.remove("hidden");
    }

    var br = activeBranch();
    var mapsUrl =
      "https://www.google.com/maps/search/?api=1&query=" +
      encodeURIComponent(br.mapsQuery || br.address || R.address);

    var branchSelectorHtml = "";
    if (branches && branches.length > 1) {
      branchSelectorHtml =
        '<div class="branch-switcher">' +
        '  <span class="branch-switcher-label">اختر الفرع الأقرب لك:</span>' +
        '  <div class="branch-pills">' +
        branches
          .map(function (b) {
            var active = b.id === br.id ? " active" : "";
            return (
              '<button type="button" class="branch-pill' +
              active +
              '" data-branch-select="' +
              esc(b.id) +
              '">' +
              esc(b.name) +
              "</button>"
            );
          })
          .join("") +
        "  </div>" +
        "</div>";
    }

    var coverHtml = R.coverImage
      ? '<div class="cover-wrap"><img src="' +
        esc(R.coverImage) +
        '" alt="' +
        esc(R.name) +
        '"></div>'
      : '<div class="cover-ornament"></div>';

    var contactBtns = "";
    if (br.phone) {
      contactBtns +=
        '<a class="btn-call" href="tel:' +
        esc(br.phone) +
        '"><span dir="ltr">' +
        esc(br.phone) +
        "</span></a>";
    }
    if (br.whatsapp) {
      contactBtns +=
        '<a class="btn-wa-top" href="https://wa.me/' +
        esc(br.whatsapp) +
        '" target="_blank" rel="noopener">' +
        (branches && branches.length > 1 ? "واتساب الفرع" : "واتساب مباشر") +
        "</a>";
    }

    document.getElementById("header-root").innerHTML =
      '<div class="container">' +
      '  <div class="header-topbar">' +
      '    <span class="status-pill"><span class="status-dot"></span>مفتوح للطلبات الآن</span>' +
      '    <div style="display:flex;gap:8px;align-items:center">' +
      (R.instagramUrl
        ? '<a href="' +
          esc(R.instagramUrl) +
          '" target="_blank" rel="noopener" class="btn-outline-paper">إنستجرام</a>'
        : "") +
      (R.facebookUrl
        ? '<a href="' +
          esc(R.facebookUrl) +
          '" target="_blank" rel="noopener" class="btn-outline-paper">فيسبوك</a>'
        : "") +
      (R.menuFlyerImages && R.menuFlyerImages.length
        ? '<button type="button" id="btn-open-flyer" class="btn-outline-paper">صور المنيو الأصلي</button>'
        : "") +
      "    </div>" +
      "  </div>" +
      coverHtml +
      '  <div class="identity-card">' +
      '    <div class="identity-top">' +
      '      <img class="identity-logo" src="' +
      esc(R.logoImage) +
      '" alt="' +
      esc(R.name) +
      '">' +
      "      <div>" +
      '        <div class="identity-title-row">' +
      '          <h1 class="identity-name">' +
      esc(R.name) +
      "</h1>" +
      '          <span class="identity-tagline">' +
      esc(R.tagline) +
      "</span>" +
      "        </div>" +
      '        <p class="identity-intro">' +
      esc(R.shortIntro) +
      "</p>" +
      "      </div>" +
      "    </div>" +
      branchSelectorHtml +
      '    <div class="identity-contact">' +
      '      <a class="address-link" href="' +
      esc(mapsUrl) +
      '" target="_blank" rel="noopener">العنوان: ' +
      esc(br.address) +
      "</a>" +
      '      <div class="contact-actions">' +
      contactBtns +
      "      </div>" +
      "    </div>" +
      "  </div>" +
      "</div>";

    var creditHref = C.whatsapp
      ? "https://wa.me/" +
        C.whatsapp +
        "?text=" +
        encodeURIComponent(
          "أهلاً " +
            (C.developerName || "") +
            "، شفت منيو " +
            R.name +
            " وحابب أعمل منيو رقمي لمطعمي"
        )
      : C.fallbackUrl || "#";

    var allBranchesSummary = branches
      ? branches
          .map(function (b) {
            return (
              b.name +
              ": " +
              b.address +
              (b.phone ? " (" + b.phone + ")" : "")
            );
          })
          .join("  •  ")
      : R.address + (R.phone ? " — " + R.phone : "");

    document.getElementById("footer-root").innerHTML =
      '<div class="container">' +
      '  <div class="restaurant-foot-card">' +
      "    <h3>" +
      esc(R.name) +
      " — " +
      esc(R.tagline) +
      "</h3>" +
      "    <p>" +
      esc(allBranchesSummary) +
      "</p>" +
      (R.branchesNotice
        ? '<p style="font-size:12px;margin-top:6px;opacity:0.85">' +
          esc(R.branchesNotice) +
          "</p>"
        : "") +
      "  </div>" +
      '  <div class="credits-bar">' +
      '    <div class="credits-text">' +
      "      <div>صُمم وطُوّر بواسطة <strong>" +
      esc(C.developerName || "م/ محمد عبدالستار") +
      "</strong></div>" +
      "      <p>عندك مطعم أو حلواني أو كافيه؟ احصل على منيو رقمي لمشروعك مجاناً</p>" +
      "    </div>" +
      '    <div class="credits-actions">' +
      '      <a class="btn-qr-link" href="./qr.html">طباعة كود QR</a>' +
      '      <a class="btn-credit-cta" href="' +
      esc(creditHref) +
      '" target="_blank" rel="noopener">اطلب منيو لمشروعك</a>' +
      "    </div>" +
      "  </div>" +
      "</div>";

    var flyerBtn = document.getElementById("btn-open-flyer");
    if (flyerBtn) {
      flyerBtn.addEventListener("click", function () {
        state.flyerOpen = true;
        renderModals();
      });
    }

    document
      .querySelectorAll("[data-branch-select]")
      .forEach(function (btn) {
        btn.addEventListener("click", function () {
          state.selectedBranchId = btn.getAttribute("data-branch-select");
          try {
            localStorage.setItem(BRANCH_KEY, state.selectedBranchId);
          } catch (_) {}
          renderHeaderAndFooter();
        });
      });
  }

  function renderTabs() {
    var strip = document.getElementById("cat-strip");
    strip.innerHTML = R.categories
      .filter(function (cat) {
        return cat.items.some(function (i) {
          return !i._hidden;
        });
      })
      .map(function (cat) {
        var cls = "cat-tab" + (state.activeCat === cat.id ? " active" : "");
        return (
          '<button type="button" class="' +
          cls +
          '" data-cat="' +
          esc(cat.id) +
          '">' +
          esc(cat.name) +
          "</button>"
        );
      })
      .join("");

    var popBtn = document.getElementById("btn-popular");
    popBtn.className = "btn-popular" + (state.onlyPopular ? " active" : "");
  }

  function renderMenuAndBar() {
    renderTabs();
    var q = state.search.trim().toLowerCase();
    var html = [];

    R.categories.forEach(function (cat) {
      var items = cat.items.filter(function (it) {
        if (it._hidden) return false;
        if (state.onlyPopular && !it.popular) return false;
        if (!q) return true;
        return (
          it.name.toLowerCase().includes(q) ||
          (it.description && it.description.toLowerCase().includes(q)) ||
          cat.name.toLowerCase().includes(q)
        );
      });

      if (!items.length) return;

      var toneCls =
        cat.tone === "primary"
          ? " tone-primary"
          : cat.tone === "accent"
          ? " tone-accent"
          : "";

      html.push(
        '<section class="cat-section" id="cat-' +
          esc(cat.id) +
          '">' +
          '  <div class="cat-banner' +
          toneCls +
          '">' +
          "    <div>" +
          '      <div class="cat-title-wrap">' +
          '        <h2 class="cat-title">' +
          esc(cat.name) +
          "</h2>" +
          '        <span class="cat-count">' +
          items.length +
          " أصناف</span>" +
          "      </div>" +
          (cat.subtitle
            ? '<p class="cat-subtitle">' + esc(cat.subtitle) + "</p>"
            : "") +
          "    </div>" +
          (cat.bannerImage
            ? '<img class="cat-banner-img" src="' +
              esc(cat.bannerImage) +
              '" alt="' +
              esc(cat.name) +
              '">'
            : "") +
          "  </div>" +
          '  <div class="items-grid">' +
          items
            .map(function (it) {
              var inQty = itemQtyInCart(it.id);
              var isAdded = state.justAddedId === it.id;
              var isSoldOut = !!it.soldOut;
              var hasOpts =
                (it.variants && it.variants.length) ||
                (it.choiceGroups && it.choiceGroups.length) ||
                (it.addons && it.addons.length) ||
                it.priceOnRequest;

              var variantsHtml = "";
              if (it.variants && it.variants.length && !isSoldOut) {
                variantsHtml =
                  '<div class="variant-chips">' +
                  it.variants
                    .map(function (v) {
                      return (
                        '<button type="button" class="variant-chip" data-variant-item="' +
                        esc(it.id) +
                        '" data-variant-id="' +
                        esc(v.id) +
                        '">' +
                        esc(v.label) +
                        ": " +
                        (v.priceOnRequest ? "حسب الشكل" : v.price + " ج") +
                        "</button>"
                      );
                    })
                    .join("") +
                  "</div>";
              }

              var priceDisplay = it.priceOnRequest
                ? esc(it.priceLabel || "حسب الشكل")
                : fmtPrice(it.price);

              var btnText = isSoldOut
                ? "غير متاح اليوم"
                : isAdded
                ? "تمت الإضافة"
                : it.priceOnRequest
                ? "+ اطلب تسعير"
                : it.variants && it.variants.length
                ? "+ اختر المقاس"
                : "+ أضف" +
                  (inQty > 0
                    ? ' <span class="qty-pill">' + inQty + "</span>"
                    : "");

              return (
                '<article class="item-card' +
                (inQty > 0 ? " in-cart" : "") +
                (isSoldOut ? " sold-out" : "") +
                '" ' +
                (isSoldOut ? "" : 'data-open-item="' + esc(it.id) + '"') +
                ">" +
                '  <div class="item-body">' +
                "    <div>" +
                '      <div class="item-head">' +
                '        <h3 class="item-name">' +
                esc(it.name) +
                "</h3>" +
                '        <span class="price-leader"></span>' +
                '        <span class="item-price">' +
                priceDisplay +
                "</span>" +
                "      </div>" +
                (it.badge
                  ? '<span class="item-badge">' + esc(it.badge) + "</span>"
                  : "") +
                (it.description
                  ? '<p class="item-desc">' + esc(it.description) + "</p>"
                  : "") +
                variantsHtml +
                "    </div>" +
                '    <div class="item-foot">' +
                '      <span class="item-hint">' +
                (isSoldOut
                  ? "نفد مؤقتاً"
                  : it.priceOnRequest
                  ? esc(it.notePlaceholder || "اكتب الشكل أو الطلب في الملاحظة")
                  : it.unitLabel
                  ? "السعر " + esc(it.unitLabel)
                  : hasOpts
                  ? "اضغط للاختيار أو كتابة ملاحظة"
                  : "جاهز للإضافة") +
                "</span>" +
                '      <button type="button" ' +
                (isSoldOut ? "disabled " : "") +
                'class="btn-add' +
                (isAdded ? " added" : "") +
                (isSoldOut ? " disabled" : "") +
                '" data-quick-add="' +
                esc(it.id) +
                '">' +
                btnText +
                "</button>" +
                "    </div>" +
                "  </div>" +
                (it.image
                  ? '<div class="item-thumb"><img src="' +
                    esc(it.image) +
                    '" alt="' +
                    esc(it.name) +
                    '"></div>'
                  : "") +
                "</article>"
              );
            })
            .join("") +
          "  </div>" +
          "</section>"
      );
    });

    var mainEl = document.getElementById("menu-root");
    if (!html.length) {
      mainEl.innerHTML =
        '<div class="restaurant-foot-card">' +
        "  <h3>لا يوجد صنف مطابق للبحث</h3>" +
        '  <button type="button" id="btn-reset-filter" class="btn-add" style="margin-top:8px">عرض المنيو بالكامل</button>' +
        "</div>";
      var resetBtn = document.getElementById("btn-reset-filter");
      if (resetBtn) {
        resetBtn.addEventListener("click", function () {
          state.search = "";
          state.onlyPopular = false;
          document.getElementById("search-input").value = "";
          renderMenuAndBar();
        });
      }
    } else {
      mainEl.innerHTML = html.join("");
    }

    var count = cartCount();
    var barRoot = document.getElementById("floating-cart-root");
    if (count > 0) {
      var subLabel = cartHasOnRequest()
        ? cartSubtotal() > 0
          ? fmtPrice(cartSubtotal()) + " + حسب الشكل"
          : "تسعير عبر واتساب"
        : fmtPrice(cartSubtotal());

      barRoot.classList.remove("hidden");
      barRoot.innerHTML =
        '<div class="floating-cart-inner">' +
        '  <button type="button" id="btn-open-cart" class="btn-floating-cart">' +
        '    <div style="display:flex;align-items:center;gap:10px;text-align:right">' +
        '      <span class="cart-badge-count">' +
        count +
        "</span>" +
        "      <div>" +
        '        <div style="font-size:15px;font-weight:900">مراجعة الطلب وإرساله على واتساب</div>' +
        '        <div style="font-size:11px;opacity:0.9;font-weight:700">اضغط لتحديد الفرع وطريقة الاستلام وإتمام الأوردر</div>' +
        "      </div>" +
        "    </div>" +
        '    <span class="cart-bar-total">' +
        subLabel +
        "</span>" +
        "  </button>" +
        "</div>";
      document
        .getElementById("btn-open-cart")
        .addEventListener("click", function () {
          state.cartOpen = true;
          state.errorMsg = "";
          renderModals();
        });
    } else {
      barRoot.classList.add("hidden");
      barRoot.innerHTML = "";
    }
  }

  function openCustomizer(item, preVariantId) {
    if (item.soldOut) return;
    var variant = null;
    if (item.variants && item.variants.length) {
      variant =
        item.variants.find(function (v) {
          return v.id === preVariantId;
        }) || item.variants[0];
    }
    var choices = {};
    (item.choiceGroups || []).forEach(function (g) {
      choices[g.id] = g.defaultChoice || g.choices[0] || "";
    });
    state.customizer = {
      item: item,
      variant: variant,
      choices: choices,
      addons: [],
      note: "",
      qty: 1,
    };
    renderModals();
  }

  function renderModals() {
    var root = document.getElementById("modals-root");

    if (state.customizer) {
      var cz = state.customizer;
      var it = cz.item;
      var isReq = cz.variant ? !!cz.variant.priceOnRequest : !!it.priceOnRequest;
      var unitP = lineUnitPrice({
        basePrice: it.price,
        priceOnRequest: it.priceOnRequest,
        variant: cz.variant,
        addons: cz.addons,
      });

      var variantsBlock = "";
      if (it.variants && it.variants.length) {
        variantsBlock =
          '<div class="field-group">' +
          '  <label class="field-label">اختر الحجم / النوع المطلوب:</label>' +
          '  <div class="option-grid">' +
          it.variants
            .map(function (v) {
              var sel =
                cz.variant && cz.variant.id === v.id ? " selected" : "";
              return (
                '<button type="button" class="option-btn' +
                sel +
                '" data-cz-variant="' +
                esc(v.id) +
                '">' +
                esc(v.label) +
                " — " +
                (v.priceOnRequest ? "حسب الشكل" : fmtPrice(v.price)) +
                "</button>"
              );
            })
            .join("") +
          "  </div>" +
          "</div>";
      }

      var choicesBlock = (it.choiceGroups || [])
        .map(function (g) {
          return (
            '<div class="field-group">' +
            '  <label class="field-label">' +
            esc(g.label) +
            ":</label>" +
            '  <div class="option-grid">' +
            g.choices
              .map(function (ch) {
                var sel = cz.choices[g.id] === ch ? " selected" : "";
                return (
                  '<button type="button" class="option-btn' +
                  sel +
                  '" data-cz-group="' +
                  esc(g.id) +
                  '" data-cz-choice="' +
                  esc(ch) +
                  '">' +
                  esc(ch) +
                  "</button>"
                );
              })
              .join("") +
            "  </div>" +
            "</div>"
          );
        })
        .join("");

      var addonsBlock = "";
      if (it.addons && it.addons.length) {
        addonsBlock =
          '<div class="field-group">' +
          '  <label class="field-label">إضافات اختيارية:</label>' +
          it.addons
            .map(function (ad) {
              var checked = cz.addons.some(function (a) {
                return a.id === ad.id;
              });
              return (
                '<button type="button" class="addon-row' +
                (checked ? " selected" : "") +
                '" data-cz-addon="' +
                esc(ad.id) +
                '">' +
                "  <span>" +
                (checked ? "✓ " : "+ ") +
                esc(ad.label) +
                "</span>" +
                '  <span style="color:var(--brand-primary)">+' +
                fmtPrice(ad.price) +
                "</span>" +
                "</button>"
              );
            })
            .join("") +
          "</div>";
      }

      var notePlaceholder =
        it.notePlaceholder ||
        "مثال: كتابة اسم معين على التورتة، تفاصيل الشكل، أو ملاحظة خاصة...";

      root.innerHTML =
        '<div class="modal-backdrop" id="modal-bg">' +
        '  <div class="modal-panel" onclick="event.stopPropagation()">' +
        '    <div class="modal-header">' +
        "      <div>" +
        '        <h3 style="margin:0;font-family:var(--font-display);font-size:19px;font-weight:900">' +
        esc(it.name) +
        "</h3>" +
        (it.description
          ? '<p style="margin:4px 0 0 0;font-size:12px;color:var(--ink-muted);font-weight:600">' +
            esc(it.description) +
            "</p>"
          : "") +
        "      </div>" +
        '      <button type="button" class="btn-close" id="btn-close-modal">×</button>' +
        "    </div>" +
        '    <div class="modal-body">' +
        variantsBlock +
        choicesBlock +
        addonsBlock +
        '      <div class="field-group" style="margin-bottom:0">' +
        '        <label class="field-label">' +
        (isReq
          ? "اكتب تفاصيل الطلب / الشكل المطلوب *"
          : "ملاحظة خاصة على الصنف (اختياري):") +
        "</label>" +
        '        <input type="text" id="cz-note-input" class="text-input" value="' +
        esc(cz.note) +
        '" placeholder="' +
        esc(notePlaceholder) +
        '">' +
        "      </div>" +
        "    </div>" +
        '    <div class="modal-footer" style="display:flex;align-items:center;gap:10px">' +
        '      <div class="stepper">' +
        '        <button type="button" id="cz-minus">−</button>' +
        '        <span style="min-width:22px;text-align:center;font-weight:900">' +
        cz.qty +
        "</span>" +
        '        <button type="button" id="cz-plus">+</button>' +
        "      </div>" +
        '      <button type="button" id="cz-confirm" class="btn-primary-full">' +
        "        <span>أضف للطلب</span>" +
        "        <span>" +
        (isReq
          ? unitP > 0
            ? "حسب الشكل +" + fmtPrice(unitP * cz.qty)
            : "يُسعّر حسب الشكل"
          : fmtPrice(unitP * cz.qty)) +
        "</span>" +
        "      </button>" +
        "    </div>" +
        "  </div>" +
        "</div>";

      bindCustomizerEvents();
      return;
    }

    if (state.cartOpen) {
      var ch = state.checkout;
      var br = activeBranch();

      var linesHtml = state.cart
        .map(function (l) {
          var cVals = Object.values(l.choices || {}).filter(Boolean);
          var onReq = lineIsOnRequest(l);
          return (
            '<div class="cart-line">' +
            '  <div style="min-width:0;flex:1">' +
            '    <div style="font-size:14px;font-weight:900">' +
            esc(l.name) +
            (l.variant
              ? ' <span style="color:var(--brand-primary)">(' +
                esc(l.variant.label) +
                ")</span>"
              : "") +
            "</div>" +
            (cVals.length
              ? '<div style="font-size:11px;color:var(--ink-muted);font-weight:700">' +
                esc(cVals.join(" • ")) +
                "</div>"
              : "") +
            (l.addons && l.addons.length
              ? '<div style="font-size:11px;font-weight:800">+ ' +
                esc(
                  l.addons
                    .map(function (a) {
                      return a.label;
                    })
                    .join("، ")
                ) +
                "</div>"
              : "") +
            (l.note
              ? '<div style="font-size:11px;color:var(--ink-muted);font-weight:700">ملاحظة: ' +
                esc(l.note) +
                "</div>"
              : "") +
            '    <div style="font-size:13px;font-weight:900;color:var(--brand-primary);margin-top:3px">' +
            (onReq ? "السعر حسب الشكل عند التأكيد" : fmtPrice(lineTotal(l))) +
            "</div>" +
            "  </div>" +
            '  <div class="stepper">' +
            '    <button type="button" data-cart-dec="' +
            esc(l.key) +
            '">−</button>' +
            '    <span style="min-width:20px;text-align:center;font-weight:900;font-size:13px">' +
            l.qty +
            "</span>" +
            '    <button type="button" data-cart-inc="' +
            esc(l.key) +
            '">+</button>' +
            "  </div>" +
            "</div>"
          );
        })
        .join("");

      var branchCheckoutHtml = "";
      if (branches && branches.length > 1) {
        var orderableBranches = branches.filter(function (b) {
          return !!b.whatsapp;
        });
        branchCheckoutHtml =
          '<div class="field-group">' +
          '  <label class="field-label">فرع الطلب:</label>' +
          '  <div class="option-grid">' +
          orderableBranches
            .map(function (b) {
              var sel = b.id === br.id ? " selected" : "";
              return (
                '<button type="button" class="option-btn' +
                sel +
                '" data-ch-branch="' +
                esc(b.id) +
                '">' +
                esc(b.name) +
                "</button>"
              );
            })
            .join("") +
          "  </div>" +
          "</div>";
      }

      var modeLabels = {
        delivery: "دليفري للمنزل",
        takeaway: "استلام من الفرع",
        dine_in: "داخل الصالة",
      };

      var modeTabsHtml =
        '<div class="field-group" style="margin-top:16px">' +
        '  <label class="field-label">طريقة استلام الطلب:</label>' +
        '  <div class="mode-tabs" style="grid-template-columns:repeat(' +
        allowedModes.length +
        ',1fr)">' +
        allowedModes
          .map(function (m) {
            return (
              '<button type="button" class="option-btn' +
              (ch.mode === m ? " selected" : "") +
              '" data-ch-mode="' +
              m +
              '">' +
              modeLabels[m] +
              "</button>"
            );
          })
          .join("") +
        "  </div>" +
        "</div>";

      var customerFields = "";
      if (ch.mode === "dine_in") {
        customerFields =
          '<div class="field-group">' +
          '  <label class="field-label">رقم الترابيزة *</label>' +
          '  <input type="text" id="ch-table" class="text-input" value="' +
          esc(ch.table) +
          '" placeholder="مثال: 4">' +
          "</div>";
      } else {
        customerFields =
          '<div class="field-group">' +
          '  <label class="field-label">الاسم *</label>' +
          '  <input type="text" id="ch-name" class="text-input" value="' +
          esc(ch.name) +
          '" placeholder="اسمك الكريم">' +
          "</div>" +
          '<div class="field-group">' +
          '  <label class="field-label">رقم الموبايل ' +
          (ch.mode === "delivery" ? "*" : "(اختياري)") +
          "</label>" +
          '  <input type="tel" dir="ltr" style="text-align:right" id="ch-phone" class="text-input" value="' +
          esc(ch.phone) +
          '" placeholder="010XXXXXXXX">' +
          "</div>" +
          (ch.mode === "delivery"
            ? '<div class="field-group">' +
              '  <label class="field-label">العنوان بالتفصيل *</label>' +
              '  <input type="text" id="ch-address" class="text-input" value="' +
              esc(ch.address) +
              '" placeholder="المنطقة، الشارع، علامة مميزة...">' +
              "</div>"
            : "");
      }

      root.innerHTML =
        '<div class="modal-backdrop" id="modal-bg">' +
        '  <div class="modal-panel" onclick="event.stopPropagation()">' +
        '    <div class="modal-header primary">' +
        "      <div>" +
        '        <h3 style="margin:0;font-family:var(--font-display);font-size:18px;font-weight:900">فاتورة طلبك — ' +
        esc(R.name) +
        "</h3>" +
        '        <p style="margin:3px 0 0 0;font-size:11px;opacity:0.9;font-weight:700">تُرسل جاهزة ومنسقة على واتساب الفرع للتأكيد الفوري</p>' +
        "      </div>" +
        '      <button type="button" class="btn-close" id="btn-close-modal">×</button>' +
        "    </div>" +
        '    <div class="modal-body">' +
        (state.cart.length === 0
          ? '<p style="text-align:center;padding:30px 0;font-weight:800;color:var(--ink-muted)">السلة فارغة حالياً</p>'
          : '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
            '  <span style="font-size:12px;font-weight:900">الأصناف المختارة (' +
            cartCount() +
            ")</span>" +
            '  <button type="button" id="btn-clear-cart" style="background:none;border:none;color:var(--brand-primary);font-size:12px;font-weight:900;cursor:pointer">إفراغ السلة</button>' +
            "</div>" +
            linesHtml +
            branchCheckoutHtml +
            modeTabsHtml +
            customerFields +
            '<div class="field-group" style="margin-bottom:0">' +
            '  <label class="field-label">ملاحظات إضافية أو موعد الاستلام (اختياري)</label>' +
            '  <input type="text" id="ch-note" class="text-input" value="' +
            esc(ch.note) +
            '" placeholder="مثال: كتابة تهنئة، أو موعد الاستلام المطلوب...">' +
            "</div>" +
            (state.errorMsg
              ? '<div class="error-box">تنبيه: ' +
                esc(state.errorMsg) +
                "</div>"
              : "")) +
        "    </div>" +
        (state.cart.length > 0
          ? '    <div class="modal-footer">' +
            '      <div style="display:flex;justify-content:space-between;align-items:center;font-size:14px">' +
            '        <span style="font-weight:800">إجمالي الأصناف المسعّرة:</span>' +
            '        <strong style="font-size:18px;font-weight:900">' +
            fmtPrice(cartSubtotal()) +
            (cartHasOnRequest() ? " + حسب الشكل" : "") +
            "</strong>" +
            "      </div>" +
            '      <button type="button" id="btn-wa-send" class="btn-wa-submit">إرسال الطلب عبر واتساب (' +
            esc(br.name || R.name) +
            ")</button>" +
            '      <div class="secondary-checkout-row">' +
            '        <button type="button" id="btn-copy-msg" class="btn-sec">' +
            (state.copiedMsg ? "تم نسخ الرسالة" : "نسخ لماسنجر / فيسبوك") +
            "</button>" +
            (br.phone
              ? '        <a href="tel:' +
                esc(br.phone) +
                '" class="btn-sec" style="background:var(--brand-accent)">اتصال: ' +
                esc(br.phone) +
                "</a>"
              : "") +
            "      </div>" +
            "    </div>"
          : "") +
        "  </div>" +
        "</div>";

      bindCartModalEvents();
      return;
    }

    if (state.flyerOpen && R.menuFlyerImages) {
      root.innerHTML =
        '<div class="modal-backdrop" id="modal-bg">' +
        '  <div class="modal-panel" style="max-width:740px" onclick="event.stopPropagation()">' +
        '    <div class="modal-header">' +
        '      <strong style="font-family:var(--font-display);font-size:16px">صور المنيو الأصلي — ' +
        esc(R.name) +
        "</strong>" +
        '      <button type="button" class="btn-close" id="btn-close-modal">×</button>' +
        "    </div>" +
        '    <div class="modal-body">' +
        R.menuFlyerImages
          .map(function (src) {
            return (
              '<img src="' +
              esc(src) +
              '" alt="' +
              esc(R.name) +
              '" style="width:100%;height:auto;border:1px solid #ddd;margin-bottom:12px">'
            );
          })
          .join("") +
        "    </div>" +
        "  </div>" +
        "</div>";

      document
        .getElementById("modal-bg")
        .addEventListener("click", closeModals);
      document
        .getElementById("btn-close-modal")
        .addEventListener("click", closeModals);
      return;
    }

    root.innerHTML = "";
  }

  function closeModals() {
    state.customizer = null;
    state.cartOpen = false;
    state.flyerOpen = false;
    renderModals();
  }

  function bindCustomizerEvents() {
    var cz = state.customizer;
    document.getElementById("modal-bg").addEventListener("click", closeModals);
    document
      .getElementById("btn-close-modal")
      .addEventListener("click", closeModals);

    var noteEl = document.getElementById("cz-note-input");
    if (noteEl) {
      noteEl.addEventListener("input", function (e) {
        cz.note = e.target.value;
      });
    }

    document.querySelectorAll("[data-cz-variant]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var vid = btn.getAttribute("data-cz-variant");
        cz.variant = cz.item.variants.find(function (v) {
          return v.id === vid;
        });
        renderModals();
      });
    });

    document.querySelectorAll("[data-cz-group]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var gid = btn.getAttribute("data-cz-group");
        var val = btn.getAttribute("data-cz-choice");
        cz.choices[gid] = val;
        renderModals();
      });
    });

    document.querySelectorAll("[data-cz-addon]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var aid = btn.getAttribute("data-cz-addon");
        var exists = cz.addons.some(function (a) {
          return a.id === aid;
        });
        if (exists) {
          cz.addons = cz.addons.filter(function (a) {
            return a.id !== aid;
          });
        } else {
          var found = cz.item.addons.find(function (a) {
            return a.id === aid;
          });
          if (found) cz.addons.push(found);
        }
        renderModals();
      });
    });

    document.getElementById("cz-minus").addEventListener("click", function () {
      cz.qty = Math.max(1, cz.qty - 1);
      renderModals();
    });
    document.getElementById("cz-plus").addEventListener("click", function () {
      cz.qty += 1;
      renderModals();
    });
    document
      .getElementById("cz-confirm")
      .addEventListener("click", function () {
        addToCartLine({
          itemId: cz.item.id,
          name: cz.item.name,
          basePrice: cz.item.price,
          priceOnRequest: cz.item.priceOnRequest,
          priceLabel: cz.item.priceLabel,
          variant: cz.variant,
          choices: Object.assign({}, cz.choices),
          addons: cz.addons.slice(),
          note: cz.note.trim(),
          qty: cz.qty,
        });
        closeModals();
      });
  }

  function syncCheckoutInputs() {
    var n = document.getElementById("ch-name");
    var p = document.getElementById("ch-phone");
    var a = document.getElementById("ch-address");
    var t = document.getElementById("ch-table");
    var g = document.getElementById("ch-note");
    if (n) state.checkout.name = n.value;
    if (p) state.checkout.phone = p.value;
    if (a) state.checkout.address = a.value;
    if (t) state.checkout.table = t.value;
    if (g) state.checkout.note = g.value;
    saveCustomer();
  }

  function bindCartModalEvents() {
    document.getElementById("modal-bg").addEventListener("click", closeModals);
    document
      .getElementById("btn-close-modal")
      .addEventListener("click", closeModals);

    var clearBtn = document.getElementById("btn-clear-cart");
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        state.cart = [];
        saveCart();
        renderMenuAndBar();
        renderModals();
      });
    }

    document.querySelectorAll("[data-cart-dec]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        syncCheckoutInputs();
        var k = btn.getAttribute("data-cart-dec");
        state.cart = state.cart
          .map(function (l) {
            return l.key === k ? Object.assign({}, l, { qty: l.qty - 1 }) : l;
          })
          .filter(function (l) {
            return l.qty > 0;
          });
        saveCart();
        renderMenuAndBar();
        renderModals();
      });
    });

    document.querySelectorAll("[data-cart-inc]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        syncCheckoutInputs();
        var k = btn.getAttribute("data-cart-inc");
        state.cart = state.cart.map(function (l) {
          return l.key === k ? Object.assign({}, l, { qty: l.qty + 1 }) : l;
        });
        saveCart();
        renderMenuAndBar();
        renderModals();
      });
    });

    document.querySelectorAll("[data-ch-branch]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        syncCheckoutInputs();
        state.selectedBranchId = btn.getAttribute("data-ch-branch");
        try {
          localStorage.setItem(BRANCH_KEY, state.selectedBranchId);
        } catch (_) {}
        state.errorMsg = "";
        renderHeaderAndFooter();
        renderModals();
      });
    });

    document.querySelectorAll("[data-ch-mode]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        syncCheckoutInputs();
        state.checkout.mode = btn.getAttribute("data-ch-mode");
        state.errorMsg = "";
        renderModals();
      });
    });

    ["ch-name", "ch-phone", "ch-address", "ch-table", "ch-note"].forEach(
      function (id) {
        var el = document.getElementById(id);
        if (el) {
          el.addEventListener("input", function () {
            syncCheckoutInputs();
          });
        }
      }
    );

    var sendBtn = document.getElementById("btn-wa-send");
    if (sendBtn) {
      sendBtn.addEventListener("click", function () {
        syncCheckoutInputs();
        var err = validateCheckout();
        if (err) {
          state.errorMsg = err;
          renderModals();
          return;
        }
        var br = activeBranch();
        var msg = buildOrderMessage();
        var url =
          "https://wa.me/" + br.whatsapp + "?text=" + encodeURIComponent(msg);
        window.open(url, "_blank", "noopener,noreferrer");
      });
    }

    var copyBtn = document.getElementById("btn-copy-msg");
    if (copyBtn) {
      copyBtn.addEventListener("click", function () {
        syncCheckoutInputs();
        var err = validateCheckout();
        if (err) {
          state.errorMsg = err;
          renderModals();
          return;
        }
        var msg = buildOrderMessage();
        if (navigator.clipboard) {
          navigator.clipboard.writeText(msg).then(function () {
            state.copiedMsg = true;
            renderModals();
            setTimeout(function () {
              state.copiedMsg = false;
              renderModals();
            }, 2200);
          });
        }
      });
    }
  }

  function initEvents() {
    document
      .getElementById("search-input")
      .addEventListener("input", function (e) {
        state.search = e.target.value;
        renderMenuAndBar();
      });

    document
      .getElementById("btn-popular")
      .addEventListener("click", function () {
        state.onlyPopular = !state.onlyPopular;
        renderMenuAndBar();
      });

    document.getElementById("cat-strip").addEventListener("click", function (e) {
      var btn = e.target.closest("[data-cat]");
      if (!btn) return;
      var cid = btn.getAttribute("data-cat");
      state.activeCat = cid;
      renderTabs();
      var sec = document.getElementById("cat-" + cid);
      if (sec) {
        var top = sec.getBoundingClientRect().top + window.scrollY - 130;
        window.scrollTo({ top: top, behavior: "smooth" });
      }
    });

    document.getElementById("menu-root").addEventListener("click", function (e) {
      var vBtn = e.target.closest("[data-variant-item]");
      if (vBtn) {
        e.stopPropagation();
        var it1 = findItem(vBtn.getAttribute("data-variant-item"));
        if (it1 && !it1.soldOut)
          openCustomizer(it1, vBtn.getAttribute("data-variant-id"));
        return;
      }

      var qBtn = e.target.closest("[data-quick-add]");
      if (qBtn) {
        e.stopPropagation();
        var it2 = findItem(qBtn.getAttribute("data-quick-add"));
        if (!it2 || it2.soldOut) return;
        if (
          it2.priceOnRequest ||
          (it2.variants && it2.variants.length)
        ) {
          openCustomizer(it2);
          return;
        }
        var defaults = {};
        (it2.choiceGroups || []).forEach(function (g) {
          defaults[g.id] = g.defaultChoice || g.choices[0] || "";
        });
        addToCartLine({
          itemId: it2.id,
          name: it2.name,
          basePrice: it2.price,
          priceOnRequest: false,
          variant: null,
          choices: defaults,
          addons: [],
          note: "",
          qty: 1,
        });
        return;
      }

      var card = e.target.closest("[data-open-item]");
      if (card) {
        var it3 = findItem(card.getAttribute("data-open-item"));
        if (it3 && !it3.soldOut) openCustomizer(it3);
      }
    });

    window.addEventListener(
      "scroll",
      function () {
        for (var i = 0; i < R.categories.length; i++) {
          var cid = R.categories[i].id;
          var el = document.getElementById("cat-" + cid);
          if (el) {
            var r = el.getBoundingClientRect();
            if (r.top <= 170 && r.bottom > 170) {
              if (state.activeCat !== cid) {
                state.activeCat = cid;
                renderTabs();
              }
              break;
            }
          }
        }
      },
      { passive: true }
    );
  }

  loadStorage();
  renderHeaderAndFooter();
  renderMenuAndBar();
  initEvents();
  syncSheetIfConfigured();
})();
