import { describe, test, expect, afterEach, vi } from "vitest";
import { LANGUAGES, DEFAULT_LANG, TABLES, isSupported, translate, makeT, vocab, translateError, keyedError, readStoredLang } from "./i18n.js";

const CODES = LANGUAGES.map((l) => l.code);

// Every string the app can show has to exist in every language. Without this
// the first missed translation is found by a user, not by the suite.
describe("string tables", () => {
  test("offers exactly English, Italian and Chinese", () => {
    expect(CODES).toEqual(["en", "it", "zh"]);
  });

  test("every language defines every key English defines", () => {
    // translate() falls back to English, so a missing key is invisible at
    // runtime — it has to be caught here instead.
    const englishKeys = Object.keys(enTable());
    for (const code of CODES) {
      const missing = englishKeys.filter((k) => !(k in tableFor(code)));
      expect({ code, missing }).toEqual({ code, missing: [] });
    }
  });

  test("no language carries a key English does not", () => {
    const englishKeys = new Set(Object.keys(enTable()));
    for (const code of CODES) {
      const extra = Object.keys(tableFor(code)).filter((k) => !englishKeys.has(k));
      expect({ code, extra }).toEqual({ code, extra: [] });
    }
  });

  test("no translation is left as the English original in Italian or Chinese", () => {
    // A handful of strings are genuinely identical across languages (numbers,
    // brand names, units). Everything else being identical means it was
    // copied in as a placeholder and never translated.
    const allowed = new Set([
      "ph.englishName", "ph.chineseName", "ph.harvestYear", "ph.brewTemp",
      "ph.caffeine", "ph.steepTime", "ref.cola", "ref.espresso", "ref.energy",
      "ref.note.shot", "caffeine.hint.Medium", "ctx.mg",
      "app.entries_one", "app.entries_other",
    ]);
    const en = enTable();
    for (const code of ["it", "zh"]) {
      const table = tableFor(code);
      const untranslated = Object.keys(en).filter((k) => !allowed.has(k) && table[k] === en[k]);
      expect({ code, untranslated }).toEqual({ code, untranslated: [] });
    }
  });

  test("every placeholder in a string is present in all its translations", () => {
    // "Harvest {year}" losing its {year} in translation drops real data.
    const en = enTable();
    for (const code of ["it", "zh"]) {
      const table = tableFor(code);
      for (const key of Object.keys(en)) {
        expect(typeof table[key]).toBe("string");
        expect({ key, code, vars: placeholders(table[key]) })
          .toEqual({ key, code, vars: placeholders(en[key]) });
      }
    }
  });
});

describe("translate", () => {
  test("returns the string for the chosen language", () => {
    expect(translate("en", "common.remove")).toBe("Remove");
    expect(translate("it", "common.remove")).toBe("Rimuovi");
    expect(translate("zh", "common.remove")).toBe("移除");
  });

  test("interpolates named variables", () => {
    expect(translate("en", "detail.harvest", { year: "2024" })).toBe("Harvest 2024");
    expect(translate("zh", "detail.harvest", { year: "2024" })).toBe("2024 年采摘");
  });

  test("leaves an unknown placeholder alone rather than printing undefined", () => {
    expect(translate("en", "detail.harvest", { nope: 1 })).toBe("Harvest {year}");
  });

  test("picks the singular or plural form from count", () => {
    expect(translate("en", "app.entries", { count: 1 })).toBe("1 entry");
    expect(translate("en", "app.entries", { count: 6 })).toBe("6 entries");
    expect(translate("it", "toast.dupesRemoved", { count: 1 })).toBe("Rimosso 1 tè duplicato");
    expect(translate("it", "toast.dupesRemoved", { count: 3 })).toBe("Rimossi 3 tè duplicati");
  });

  // Chinese has no plural inflection; both forms are deliberately the same
  // string, and asking for either must still work.
  test("handles a language whose singular and plural agree", () => {
    expect(translate("zh", "app.entries", { count: 1 })).toBe("1 款");
    expect(translate("zh", "app.entries", { count: 6 })).toBe("6 款");
  });

  test("falls back to English rather than showing a raw key", () => {
    expect(translate("fr", "common.edit")).toBe("Edit");
  });

  test("returns the key itself when nothing defines it", () => {
    expect(translate("en", "nope.not.a.key")).toBe("nope.not.a.key");
  });

  test("makeT binds a language", () => {
    expect(makeT("it")("common.cancel")).toBe("Annulla");
  });
});

// The stored value stays canonical English so a language switch can never
// rewrite saved data or orphan a filter.
describe("vocab", () => {
  test("translates tea types for display", () => {
    expect(vocab("it", "type", "Green")).toBe("Verde");
    expect(vocab("zh", "type", "Green")).toBe("绿茶");
    expect(vocab("en", "type", "Green")).toBe("Green");
  });

  // English "Black" tea is 红茶 (red tea) and English "Dark" is 黑茶. Getting
  // these backwards mislabels every dark tea in the cabinet.
  test("maps Black to 红茶 and Dark to 黑茶", () => {
    expect(vocab("zh", "type", "Black")).toBe("红茶");
    expect(vocab("zh", "type", "Dark")).toBe("黑茶");
  });

  test("translates grade and rarity", () => {
    expect(vocab("it", "grade", "Competition")).toBe("Da concorso");
    expect(vocab("zh", "grade", "Imperial / Gong Ting")).toBe("宫廷");
    expect(vocab("it", "rarity", "Very rare")).toBe("Molto raro");
    expect(vocab("zh", "rarity", "Very rare")).toBe("极稀有");
  });

  test("passes an unknown value through instead of blanking it", () => {
    expect(vocab("zh", "type", "Genmaicha")).toBe("Genmaicha");
    expect(vocab("zh", "nonsense", "Green")).toBe("Green");
  });

  test("leaves an empty value empty", () => {
    expect(vocab("it", "type", "")).toBe("");
    expect(vocab("it", "type", undefined)).toBe(undefined);
  });

  test("covers every value the app can store", () => {
    const cases = {
      type: ["Green", "White", "Yellow", "Oolong", "Black", "Dark", "Pu-erh", "Scented", "Herbal", "Other"],
      grade: ["Everyday", "Standard", "Premium", "Competition", "Imperial / Gong Ting"],
      rarity: ["Common", "Uncommon", "Rare", "Very rare"],
    };
    // Loanwords that Italian keeps verbatim. Chinese translates all of them,
    // so an empty allowance there is the real assertion.
    const sameInItalian = new Set(["Oolong", "Pu-erh", "Standard"]);
    for (const [kind, values] of Object.entries(cases)) {
      for (const code of ["it", "zh"]) {
        const allowed = code === "it" ? sameInItalian : new Set();
        const untranslated = values.filter((v) => !allowed.has(v) && vocab(code, kind, v) === v);
        expect({ kind, code, untranslated }).toEqual({ kind, code, untranslated: [] });
      }
    }
  });
});

describe("translateError", () => {
  test("translates a coded ApiError", () => {
    expect(translateError("it", { code: "auth" })).toBe("La tua sessione è scaduta. Ricarica la pagina per accedere di nuovo.");
    expect(translateError("zh", { code: "network" })).toBe("无法连接服务器。你的修改未被保存。");
  });

  test("fills the status into a refused request", () => {
    expect(translateError("en", { code: "refused", status: 418 })).toBe("The server refused that request (HTTP 418).");
  });

  // A failure mode that predates the codes must still say something real.
  test("falls back to the error's own message when there is no code", () => {
    expect(translateError("it", { message: "Something specific went wrong" })).toBe("Something specific went wrong");
  });

  // The label scanner and the file reader raise their own failures. Before
  // they carried keys, translateError preferred err.message and every scan
  // failure stayed English no matter which language was selected.
  test("translates an error raised with a message key", () => {
    expect(translateError("it", keyedError("err.scan.busy")))
      .toBe("Il lettore di etichette è occupato in questo momento. Attendi un attimo e rileggi.");
    expect(translateError("zh", keyedError("err.file.corrupt")))
      .toBe("无法读取该文件，可能已损坏 — 请换一张照片。");
  });

  test("a keyed error still carries readable English on .message", () => {
    expect(keyedError("err.file.empty").message).toBe("The photo appears empty. Try a clearer shot.");
  });

  test("prefers the message key over a code when an error has both", () => {
    const err = keyedError("err.scan.garbled");
    err.code = "network";
    expect(translateError("en", err)).toBe("Got a garbled response. Try re-reading the photo.");
  });

  test("falls back to the given key when there is nothing else", () => {
    expect(translateError("it", null)).toBe("Impossibile salvare la tua modifica.");
    expect(translateError("zh", undefined, "err.loadFailed")).toBe("无法加载你的收藏。");
  });
});

describe("isSupported", () => {
  test("accepts the three shipped languages and nothing else", () => {
    expect(CODES.every(isSupported)).toBe(true);
    expect(isSupported("fr")).toBe(false);
    expect(isSupported("")).toBe(false);
    expect(isSupported(undefined)).toBe(false);
  });
});

describe("readStoredLang", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("prefers a previously saved choice", () => {
    stubStorage({ "cha:lang:v1": "zh" });
    stubNavigator("it-IT");
    expect(readStoredLang()).toBe("zh");
  });

  test("falls back to the browser language when nothing is saved", () => {
    stubStorage({});
    stubNavigator("it-IT");
    expect(readStoredLang()).toBe("it");
  });

  test("ignores a saved value the app no longer supports", () => {
    stubStorage({ "cha:lang:v1": "fr" });
    stubNavigator("en-GB");
    expect(readStoredLang()).toBe("en");
  });

  test("falls back to English for an unsupported browser language", () => {
    stubStorage({});
    stubNavigator("de-DE");
    expect(readStoredLang()).toBe(DEFAULT_LANG);
  });

  // Private-browsing modes throw on localStorage access; the app must still
  // open rather than fail on the first render.
  test("survives storage that throws", () => {
    vi.stubGlobal("localStorage", { getItem() { throw new Error("denied"); } });
    stubNavigator("zh-CN");
    expect(readStoredLang()).toBe("zh");
  });
});

// --- helpers -------------------------------------------------------------

function tableFor(code) { return TABLES[code]; }
function enTable() { return TABLES.en; }
function placeholders(str) {
  return (String(str).match(/\{(\w+)\}/g) || []).sort();
}

function stubStorage(map) {
  vi.stubGlobal("localStorage", {
    getItem: (k) => (k in map ? map[k] : null),
    setItem: (k, v) => { map[k] = v; },
  });
}
function stubNavigator(language) {
  vi.stubGlobal("navigator", { language, languages: [language] });
}
