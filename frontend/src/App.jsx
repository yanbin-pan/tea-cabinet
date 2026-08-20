import React, { useState, useEffect, useMemo, useCallback } from "react";
import { Search, Plus, X, Leaf, Pencil, Trash2, Save, MapPin, Calendar, Droplet, Award, Camera, Upload, Loader2, AlertCircle, Check, Download, FileUp, Zap, Layers } from "lucide-react";
import { ApiError, loadCollection, saveCollection, uploadPhoto, photoUrl, isPhotoId, dataUrlToBlob } from "./api.js";
import { LanguageProvider, useI18n, LANGUAGES, vocab, translateError, keyedError } from "./i18n.js";

const TEA_TYPES = ["Green", "White", "Yellow", "Oolong", "Black", "Dark", "Pu-erh", "Scented", "Herbal", "Other"];

const TYPE_COLORS = {
  Green:   { bg: "#E7EFDD", fg: "#3B5220", dot: "#6E9438" },
  White:   { bg: "#EFEDE4", fg: "#5A5647", dot: "#B0A98C" },
  Yellow:  { bg: "#F5EBCE", fg: "#6B571C", dot: "#C9A62E" },
  Oolong:  { bg: "#EDE2CF", fg: "#6A4E23", dot: "#B7833B" },
  Black:   { bg: "#EADAD2", fg: "#5C3A2A", dot: "#9E5A3C" },
  Dark:    { bg: "#DFD6CC", fg: "#463A2E", dot: "#7A6248" },
  "Pu-erh":{ bg: "#DCD0C2", fg: "#403123", dot: "#6E5137" },
  Scented: { bg: "#F1E3EA", fg: "#6A3A50", dot: "#B25E86" },
  Herbal:  { bg: "#E4EDE6", fg: "#33513C", dot: "#5E9068" },
  Other:   { bg: "#E8E6E0", fg: "#4A473F", dot: "#928C7C" },
};

const GRADES = ["Everyday", "Standard", "Premium", "Competition", "Imperial / Gong Ting"];
const RARITY = ["Common", "Uncommon", "Rare", "Very rare"];

// Caffeine is stored as free text ("~30 mg", "caffeine-free"), so filtering has
// to work off the parsed mg number. Buckets are named after how a cup drinks,
// not exact figures, because the underlying numbers are approximate anyway.
// "Unlisted" is its own bucket: a tea with no caffeine noted is not low-caffeine.
// The key doubles as the translation lookup ("caffeine.Low") and as the stored
// filter value, so a language switch never changes which teas are selected.
const CAFFEINE_LEVELS = [
  { key: "None", test: (mg) => mg === 0 },
  { key: "Low", hinted: true, test: (mg) => mg > 0 && mg <= 25 },
  { key: "Medium", hinted: true, test: (mg) => mg > 25 && mg <= 50 },
  { key: "High", hinted: true, test: (mg) => mg > 50 },
  { key: "Unlisted", test: (mg) => mg === null },
];

// Which bucket a record falls in, or null if the level is unrecognised.
export function caffeineLevelOf(tea) {
  const mg = parseCaffeineMg(tea?.caffeine);
  return CAFFEINE_LEVELS.find((l) => l.test(mg))?.key ?? null;
}

// The fields a search query is matched against. Shared by the visible results
// and the caffeine counts so the two can never disagree about what is in scope.
function matchesSearch(tea, q) {
  if (!q) return true;
  return [tea.englishName, tea.chineseName, tea.flavourNotes, tea.origin, tea.type, tea.grade, tea.rarity, tea.harvestYear].join(" ").toLowerCase().includes(q);
}

const BLANK = { id: null, englishName: "", chineseName: "", type: "", flavourNotes: "", brewTemp: "", steepTime: "", origin: "", harvestYear: "", rarity: "", grade: "", caffeine: "", reasoning: "", photo: null, createdAt: null };

// Same-origin in production (nginx proxies /api to the backend); override for
// split deployments with VITE_API_BASE at build time.
const API_BASE = import.meta.env.VITE_API_BASE || "";

// A record's photo is an id after this change and a data URL in older exports,
// so both must render while any un-migrated data exists.
export function srcFor(photo) {
  if (!photo) return null;
  return isPhotoId(photo) ? photoUrl(photo) : photo;
}

// Monotonic unique id — timestamp + counter + randomness, so IDs minted in the
// same millisecond (e.g. a bulk import loop) can never collide.
let _idCounter = 0;
function uniqueId() { return `t-${Date.now()}-${(_idCounter++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`; }

// The provider sits above everything so any component can reach the chosen
// language without threading it through props.
export default function App() {
  return (
    <LanguageProvider>
      <Cabinet />
    </LanguageProvider>
  );
}

function Cabinet() {
  const { t, lang } = useI18n();
  const [collection, setCollection] = useState([]);
  const [ready, setReady] = useState(false);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("All");
  const [caffeineFilter, setCaffeineFilter] = useState("All");
  const [editing, setEditing] = useState(null);
  const [detail, setDetail] = useState(null);
  const [toast, setToast] = useState(null);
  const [saveState, setSaveState] = useState("idle");
  const [loadError, setLoadError] = useState(null);
  const [email, setEmail] = useState(null);

  const showToast = useCallback((msg, kind = "ok") => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 2600);
  }, []);

  // The one place a collection is written. Side effects must not live inside a
  // setState updater: React double-invokes updaters under StrictMode, which was
  // firing two PUTs per save.
  const commit = useCallback(async (next) => {
    setSaveState("saving");
    try {
      await saveCollection(next);
      setSaveState("saved");
      return true;
    } catch (err) {
      setSaveState("error");
      const authExpired = err instanceof ApiError && err.kind === "auth";
      showToast(
        authExpired ? t("err.sessionExpired") : translateError(lang, err, "err.saveFailed"),
        "err"
      );
      return false;
    }
  }, [showToast, t, lang]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { teas, source, email } = await loadCollection();
        if (!alive) return;
        setEmail(email);
        // Backfill any fields added in later versions (e.g. caffeine) so older
        // records don't carry undefined values into the edit form.
        setCollection(teas.map((tea) => ({ ...BLANK, ...tea })));
        // "Unreachable" and "empty" are different facts and must not look alike.
        if (source === "cache") showToast(t("toast.offline"), "err");
        if (source === "unavailable") setLoadError({ key: "err.unreachable" });
      } catch (err) {
        if (!alive) return;
        setLoadError(err instanceof ApiError ? { error: err } : { key: "err.loadFailed" });
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reloading the
    // collection on a language change would be a pointless refetch; the stored
    // failure reason is translated at render time instead.
  }, [showToast]);

  const save = useCallback(async (draft) => {
    const isUpdate = Boolean(draft.id) && collection.some((tea) => tea.id === draft.id);
    const next = isUpdate
      ? collection.map((tea) => (tea.id === draft.id ? draft : tea))
      : [{ ...draft, id: draft.id || uniqueId(), createdAt: draft.createdAt || Date.now() }, ...collection];

    setCollection(next);
    setEditing(null);
    // Success is claimed only once the server has confirmed the write.
    if (await commit(next)) showToast(isUpdate ? t("toast.teaUpdated") : t("toast.teaAdded"));
  }, [collection, commit, showToast, t]);

  const remove = useCallback(async (id) => {
    const next = collection.filter((tea) => tea.id !== id);
    setCollection(next);
    setDetail(null);
    if (await commit(next)) showToast(t("toast.removed"));
  }, [collection, commit, showToast, t]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return collection.filter((tea) => {
      if (typeFilter !== "All" && tea.type !== typeFilter) return false;
      if (caffeineFilter !== "All" && caffeineLevelOf(tea) !== caffeineFilter) return false;
      return matchesSearch(tea, q);
    });
  }, [collection, query, typeFilter, caffeineFilter]);

  const typeCounts = useMemo(() => {
    const m = { All: collection.length };
    for (const tea of collection) m[tea.type] = (m[tea.type] || 0) + 1;
    return m;
  }, [collection]);

  const activeTypes = ["All", ...TEA_TYPES.filter((type) => typeCounts[type])];

  // Counted over the type-and-search result rather than the whole cabinet, so a
  // caffeine chip never promises matches the other filters have already excluded.
  const caffeineCounts = useMemo(() => {
    const q = query.trim().toLowerCase();
    const inScope = collection.filter((tea) => (typeFilter === "All" || tea.type === typeFilter) && matchesSearch(tea, q));
    const m = { All: inScope.length };
    for (const tea of inScope) {
      const level = caffeineLevelOf(tea);
      if (level) m[level] = (m[level] || 0) + 1;
    }
    return m;
  }, [collection, query, typeFilter]);

  // Only offer levels the cabinet actually holds; "All" stays so the filter can
  // always be cleared, including when the current pick has dropped to zero.
  const activeCaffeine = [{ key: "All" }, ...CAFFEINE_LEVELS.filter((l) => caffeineCounts[l.key] || caffeineFilter === l.key)];

  const exportJson = useCallback(() => {
    if (collection.length === 0) { showToast(t("toast.nothingToExport"), "err"); return; }
    try {
      const payload = { app: "The Tea Cabinet", version: 1, exportedAt: new Date().toISOString(), teas: collection };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = url; a.download = `tea-cabinet-${stamp}.json`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast(t("toast.exported", { count: collection.length }));
    } catch (e) { showToast(t("toast.exportFailed"), "err"); }
  }, [collection, showToast, t]);

  const importJson = useCallback(async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;

    let incoming;
    try {
      const data = JSON.parse(await file.text());
      incoming = Array.isArray(data) ? data : data.teas;
      if (!Array.isArray(incoming)) throw new Error("bad shape");
    } catch (err) {
      showToast(t("toast.badImportFile"), "err");
      return;
    }

    setSaveState("saving");
    const byId = new Map(collection.map((tea) => [tea.id, tea]));
    let added = 0, updated = 0, failedPhotos = 0;

    for (const raw of incoming) {
      if (!raw || (!raw.englishName && !raw.chineseName)) continue;
      const rec = { ...BLANK, ...raw };

      // An older export carries the photo inline. Upload it as its own small
      // request, so a large import is many small writes and never one huge one.
      if (rec.photo && !isPhotoId(rec.photo)) {
        try {
          rec.photo = await uploadPhoto(await dataUrlToBlob(rec.photo));
        } catch (err) {
          rec.photo = null;
          failedPhotos++;
        }
      }

      if (rec.id && byId.has(rec.id)) {
        // Same ID as an existing tea: update it in place (merge over old).
        rec.createdAt = rec.createdAt || byId.get(rec.id).createdAt || Date.now();
        byId.set(rec.id, rec);
        updated++;
      } else {
        // New tea (or missing id): give it a guaranteed-unique id.
        if (!rec.id) rec.id = uniqueId();
        if (!rec.createdAt) rec.createdAt = Date.now();
        byId.set(rec.id, rec);
        added++;
      }
    }

    const next = Array.from(byId.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    setCollection(next);

    // Success is claimed only once the server has confirmed the write.
    if (await commit(next)) {
      const parts = [];
      if (added) parts.push(t("import.added", { count: added }));
      if (updated) parts.push(t("import.updated", { count: updated }));
      if (failedPhotos) parts.push(t("import.photosSkipped", { count: failedPhotos }));
      showToast(t("toast.importComplete", { summary: parts.length ? parts.join(", ") : t("import.none") }));
    }
  }, [collection, commit, showToast, t]);

  const dedupe = useCallback(async () => {
    const seen = new Map();
    // Collapse duplicates: same id first, otherwise same english+chinese name.
    for (const t of collection) {
      const key = t.id || `${(t.englishName || "").trim().toLowerCase()}|${(t.chineseName || "").trim().toLowerCase()}`;
      const existing = seen.get(key);
      // Keep the richer record (prefer one that has a caffeine value / more fields).
      if (!existing) { seen.set(key, t); continue; }
      const score = (x) => Object.values(x).filter((v) => v !== "" && v != null).length;
      seen.set(key, score(t) >= score(existing) ? t : existing);
    }
    const next = Array.from(seen.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const removed = collection.length - next.length;

    setCollection(next);
    if (await commit(next)) {
      showToast(removed > 0 ? t("toast.dupesRemoved", { count: removed }) : t("toast.noDupes"));
    }
  }, [collection, commit, showToast, t]);

  return (
    <div style={S.root}>
      <style>{CSS}</style>
      <header style={S.header}>
        <div style={S.brandRow}>
          <div style={S.mark}><span style={S.markHanzi}>茶</span></div>
          <div>
            <h1 style={S.h1}>{t("app.title")}</h1>
            <p style={S.sub}>{t("app.subtitle")} · {t("app.entries", { count: collection.length })}</p>
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          {email && <span style={S.whoami}>{email}</span>}
          {saveState === "saving" && <span style={S.saveHint}><Loader2 size={13} className="spin" /> {t("header.saving")}</span>}
          {saveState === "saved" && <span style={S.saveHint}><Check size={13} /> {t("header.saved")}</span>}
          {saveState === "error" && <span style={{ ...S.saveHint, color: "#B3261E" }}><AlertCircle size={13} /> {t("header.notSaved")}</span>}
          <LanguageToggle />
          <label className="btn" style={{ cursor: "pointer" }}>
            <FileUp size={15} /> {t("header.import")}
            <input type="file" accept="application/json,.json" onChange={importJson} style={{ display: "none" }} />
          </label>
          <button className="btn" onClick={exportJson}><Download size={15} /> {t("header.export")}</button>
          {collection.length > 1 && <button className="btn" onClick={dedupe} title={t("header.dedupeTitle")}><Layers size={15} /> {t("header.dedupe")}</button>}
          <button className="btn btn-primary" onClick={() => setEditing({ ...BLANK })}><Plus size={16} strokeWidth={2.2} /> {t("header.addTea")}</button>
        </div>
      </header>

      <div style={S.controls}>
        <div style={S.searchWrap}>
          <Search size={17} style={{ color: "#9a9482", flexShrink: 0 }} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("search.placeholder")} style={S.search} className="tea-search" />
          {query && <button className="clear-x" onClick={() => setQuery("")} aria-label={t("search.clear")}><X size={15} /></button>}
        </div>
        <div style={S.chips}>
          {activeTypes.map((type) => {
            const active = typeFilter === type; const c = TYPE_COLORS[type];
            return (
              <button key={type} onClick={() => setTypeFilter(type)} className="chip" style={{ ...S.chip, ...(active ? S.chipActive : {}), ...(active && c ? { background: c.bg, color: c.fg, borderColor: c.dot } : {}) }}>
                {c && <span style={{ ...S.chipDot, background: c.dot }} />}{type === "All" ? t("filter.all") : vocab(lang, "type", type)}<span style={S.chipCount}>{typeCounts[type] || 0}</span>
              </button>
            );
          })}
        </div>
        <div style={S.chipGroup}>
          <span style={S.chipGroupLabel}><Zap size={13} strokeWidth={2.2} /> {t("filter.caffeine")}</span>
          <div style={S.chips}>
            {activeCaffeine.map((l) => {
              const active = caffeineFilter === l.key;
              const label = l.key === "All" ? t("filter.allCaffeine") : t(`caffeine.${l.key}`);
              return (
                <button key={l.key} onClick={() => setCaffeineFilter(l.key)} className="chip" style={{ ...S.chip, ...(active ? S.chipActive : {}) }} title={l.hinted ? `${label} — ${t(`caffeine.hint.${l.key}`)}` : label}>
                  {label}<span style={S.chipCount}>{caffeineCounts[l.key] || 0}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {!ready ? (
        <div style={S.empty}><Loader2 className="spin" size={22} /><span style={{ marginTop: 10 }}>{t("state.opening")}</span></div>
      ) : loadError ? (
        // A server we could not reach must never be drawn as an empty cabinet:
        // that is the reading that made a data loss look like a normal state.
        <div style={S.empty}>
          <AlertCircle size={26} color="#B3261E" />
          <p style={{ ...S.emptyTitle, marginTop: 12 }}>{loadError.key ? t(loadError.key) : translateError(lang, loadError.error, "err.loadFailed")}</p>
          <p style={S.emptySub}>{t("state.notLost")}</p>
          <button className="btn" onClick={() => window.location.reload()}>{t("state.tryAgain")}</button>
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState hasAny={collection.length > 0} onAdd={() => setEditing({ ...BLANK })} onClear={() => { setQuery(""); setTypeFilter("All"); setCaffeineFilter("All"); }} />
      ) : (
        <div style={S.grid}>{filtered.map((tea) => <TeaCard key={tea.id} tea={tea} onOpen={() => setDetail(tea)} />)}</div>
      )}

      {editing && <EditModal draft={editing} onClose={() => setEditing(null)} onSave={save} onToast={showToast} />}
      {detail && <DetailModal tea={detail} onClose={() => setDetail(null)} onEdit={() => { setEditing(detail); setDetail(null); }} onDelete={() => remove(detail.id)} />}
      {toast && <div style={{ ...S.toast, ...(toast.kind === "err" ? S.toastErr : {}) }}>{toast.kind === "err" ? <AlertCircle size={16} /> : <Check size={16} />} {toast.msg}</div>}
    </div>
  );
}

// A segmented control rather than a select: three options are few enough to
// show at once, and each one is written in its own language so it is legible to
// someone who cannot yet read the language the app is currently in.
function LanguageToggle() {
  const { lang, setLang, t } = useI18n();
  return (
    <div style={S.langGroup} role="group" aria-label={t("lang.label")}>
      {LANGUAGES.map((l) => (
        <button
          key={l.code}
          onClick={() => setLang(l.code)}
          className="lang-btn"
          style={{ ...S.langBtn, ...(lang === l.code ? S.langBtnActive : {}) }}
          aria-pressed={lang === l.code}
          title={l.label}
          lang={l.code}
        >
          {l.short}
        </button>
      ))}
    </div>
  );
}

function TeaCard({ tea, onOpen }) {
  const { t, lang } = useI18n();
  const c = TYPE_COLORS[tea.type] || TYPE_COLORS.Other;
  return (
    <button className="tea-card" style={S.card} onClick={onOpen}>
      <div style={{ ...S.cardTop, background: c.bg }}>
        {tea.photo ? <img src={srcFor(tea.photo)} alt="" style={S.cardImg} /> : <span style={{ ...S.cardHanzi, color: c.fg }}>{firstHanzi(tea.chineseName) || <Leaf size={30} color={c.dot} />}</span>}
        <span style={{ ...S.typeTag, background: c.dot }}>{vocab(lang, "type", tea.type) || "—"}</span>
        {tea.grade && <span style={S.gradeTag}>{vocab(lang, "grade", tea.grade)}</span>}
      </div>
      <div style={S.cardBody}>
        <div style={S.cardNames}>
          <span style={S.cardEn}>{tea.englishName || t("card.untitled")}</span>
          {tea.chineseName && <span style={S.cardZh}>{tea.chineseName}</span>}
        </div>
        {tea.flavourNotes && <p style={S.cardFlavour}>{tea.flavourNotes}</p>}
        <div style={S.cardMeta}>
          {tea.origin && <span style={S.metaItem}><MapPin size={12} /> {shorten(tea.origin, 22)}</span>}
          {tea.harvestYear && <span style={S.metaItem}><Calendar size={12} /> {tea.harvestYear}</span>}
        </div>
      </div>
    </button>
  );
}

function EmptyState({ hasAny, onAdd, onClear }) {
  const { t } = useI18n();
  return (
    <div style={S.empty}>
      <div style={S.emptyMark}>茶</div>
      {hasAny ? (
        <><p style={S.emptyTitle}>{t("empty.noMatchTitle")}</p><p style={S.emptySub}>{t("empty.noMatchSub")}</p><button className="btn" onClick={onClear} style={{ marginTop: 4 }}>{t("empty.clearFilters")}</button></>
      ) : (
        <><p style={S.emptyTitle}>{t("empty.cabinetTitle")}</p><p style={S.emptySub}>{t("empty.cabinetSub")}</p><button className="btn btn-primary" onClick={onAdd} style={{ marginTop: 4 }}><Plus size={16} /> {t("empty.addFirst")}</button></>
      )}
    </div>
  );
}

function EditModal({ draft, onClose, onSave, onToast }) {
  const { t, lang } = useI18n();
  const [form, setForm] = useState(draft);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState(null);
  const [scanned, setScanned] = useState(false);
  // The bytes of the photo just picked, kept only for this modal's preview and
  // for the scan call. What the record stores is the id the server hands back.
  const [preview, setPreview] = useState(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // Scanning needs the image bytes. A freshly picked photo has them in
  // `preview`; an older un-migrated record still carries an inline data URL.
  // A record that holds only a photo id has nothing local to re-read.
  const scanSrc = preview || (form.photo && !isPhotoId(form.photo) ? form.photo : null);

  const onFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setScanError(null); setScanned(false);
    if (file.type && file.type.indexOf("image/") !== 0 && !/\.(jpe?g|png|gif|webp|heic|heif)$/i.test(file.name || "")) {
      setScanError(t("err.notImage"));
      e.target.value = ""; return;
    }
    try {
      const raw = await fileToDataUrl(file);
      // Re-encode to a clean, size-bounded JPEG before storing or scanning.
      const dataUrl = await normalizeImage(raw);
      setPreview(dataUrl);
      // The photo goes up as its own request and the record keeps only its id,
      // so the collection write stays small no matter how many teas have photos.
      try {
        const blob = await dataUrlToBlob(dataUrl);
        const id = await uploadPhoto(blob);
        set("photo", id);
      } catch (err) {
        // Drop the preview too: showing a photo the record is not going to keep
        // is the same class of lie this whole change exists to remove.
        setPreview(null);
        setScanError(translateError(lang, err, "err.api.photoNetwork"));
        return;
      }
      await runScan(dataUrl);
    } catch (err) { setScanError(translateError(lang, err, "err.readFile")); }
    finally { e.target.value = ""; }
  };

  const runScan = async (dataUrl) => {
    setScanning(true); setScanError(null);
    try {
      const parsed = await readLabelWithClaude(dataUrl, lang);
      setForm((f) => ({ ...f,
        englishName: parsed.englishName || f.englishName,
        chineseName: parsed.chineseName || f.chineseName,
        type: parsed.type || f.type,
        flavourNotes: parsed.flavourNotes || f.flavourNotes,
        brewTemp: parsed.brewTemp || f.brewTemp,
        steepTime: parsed.steepTime || f.steepTime,
        origin: parsed.origin || f.origin,
        harvestYear: parsed.harvestYear || f.harvestYear,
        rarity: parsed.rarity || f.rarity,
        grade: parsed.grade || f.grade,
        reasoning: parsed.reasoning || f.reasoning,
      }));
      setScanned(true);
      onToast(t("err.labelRead"), "ok");
    } catch (err) { setScanError(translateError(lang, err, "err.readLabel")); }
    finally { setScanning(false); }
  };

  const submit = () => {
    if (!form.englishName.trim() && !form.chineseName.trim()) { setScanError(t("err.needName")); return; }
    onSave(form);
  };

  const c = TYPE_COLORS[form.type] || TYPE_COLORS.Other;
  return (
    <Overlay onClose={onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <div style={S.modalHead}>
          <h2 style={S.modalTitle}>{draft.id ? t("edit.titleEdit") : t("edit.titleAdd")}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t("common.close")}><X size={18} /></button>
        </div>
        <div style={S.modalScroll}>
          <div style={{ ...S.intake, background: c.bg }}>
            {preview || form.photo ? <img src={preview || srcFor(form.photo)} alt={t("edit.packetAlt")} style={S.intakeImg} /> : <div style={S.intakeIcon}><Camera size={26} color={c.dot} /></div>}
            <div style={{ flex: 1 }}>
              <p style={S.intakeTitle}>{t("edit.readLabel")}</p>
              <p style={S.intakeSub}>{t("edit.readLabelSub")}</p>
              <div style={S.intakeBtns}>
                <label className="btn btn-small" style={{ cursor: "pointer" }}>
                  <Upload size={14} /> {form.photo ? t("edit.replacePhoto") : t("edit.uploadPhoto")}
                  <input type="file" accept="image/*" onChange={onFile} style={{ display: "none" }} />
                </label>
                {scanSrc && !scanning && <button className="btn btn-small" onClick={() => runScan(scanSrc)}><Camera size={14} /> {t("edit.reread")}</button>}
              </div>
            </div>
          </div>

          {scanning && <div style={S.scanState}><Loader2 className="spin" size={16} /> {t("edit.scanning")}</div>}
          {scanned && !scanning && <div style={{ ...S.scanState, ...S.scanOk }}><Check size={16} /> {t("edit.scanned")}</div>}
          {scanError && <div style={{ ...S.scanState, ...S.scanErr }}><AlertCircle size={16} /> {scanError}</div>}

          <div style={S.fieldGrid}>
            <Field label={t("field.englishName")} full><input value={form.englishName} onChange={(e) => set("englishName", e.target.value)} placeholder={t("ph.englishName")} className="fld" /></Field>
            <Field label={t("field.chineseName")} full><input value={form.chineseName} onChange={(e) => set("chineseName", e.target.value)} placeholder={t("ph.chineseName")} className="fld" /></Field>
            <Field label={t("field.teaType")}><select value={form.type} onChange={(e) => set("type", e.target.value)} className="fld"><option value="">{t("select.choose")}</option>{TEA_TYPES.map((v) => <option key={v} value={v}>{vocab(lang, "type", v)}</option>)}</select></Field>
            <Field label={t("field.harvestYear")}><input value={form.harvestYear} onChange={(e) => set("harvestYear", e.target.value)} placeholder={t("ph.harvestYear")} className="fld" /></Field>
            <Field label={t("field.flavourNotes")} full><textarea value={form.flavourNotes} onChange={(e) => set("flavourNotes", e.target.value)} placeholder={t("ph.flavourNotes")} className="fld" rows={2} /></Field>
            <Field label={t("field.waterTemp")}><input value={form.brewTemp} onChange={(e) => set("brewTemp", e.target.value)} placeholder={t("ph.brewTemp")} className="fld" /></Field>
            <Field label={t("field.steepTime")}><input value={form.steepTime} onChange={(e) => set("steepTime", e.target.value)} placeholder={t("ph.steepTime")} className="fld" /></Field>
            <Field label={t("field.caffeine")}><input value={form.caffeine} onChange={(e) => set("caffeine", e.target.value)} placeholder={t("ph.caffeine")} className="fld" /></Field>
            <Field label={t("field.origin")} full><input value={form.origin} onChange={(e) => set("origin", e.target.value)} placeholder={t("ph.origin")} className="fld" /></Field>
            <Field label={t("field.grade")}><select value={form.grade} onChange={(e) => set("grade", e.target.value)} className="fld"><option value="">{t("select.unknown")}</option>{GRADES.map((g) => <option key={g} value={g}>{vocab(lang, "grade", g)}</option>)}</select></Field>
            <Field label={t("field.rarity")}><select value={form.rarity} onChange={(e) => set("rarity", e.target.value)} className="fld"><option value="">{t("select.choose")}</option>{RARITY.map((r) => <option key={r} value={r}>{vocab(lang, "rarity", r)}</option>)}</select></Field>
            <Field label={t("field.reasoning")} full><textarea value={form.reasoning} onChange={(e) => set("reasoning", e.target.value)} placeholder={t("ph.reasoning")} className="fld" rows={2} /></Field>
          </div>
        </div>
        <div style={S.modalFoot}>
          <button className="btn" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn btn-primary" onClick={submit}><Save size={15} /> {draft.id ? t("edit.saveChanges") : t("edit.saveToCollection")}</button>
        </div>
      </div>
    </Overlay>
  );
}

function DetailModal({ tea, onClose, onEdit, onDelete }) {
  const { t, lang } = useI18n();
  const [confirm, setConfirm] = useState(false);
  const c = TYPE_COLORS[tea.type] || TYPE_COLORS.Other;
  return (
    <Overlay onClose={onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <div style={{ ...S.detailHero, background: c.bg }}>
          <button className="icon-btn" style={S.detailClose} onClick={onClose} aria-label={t("common.close")}><X size={18} /></button>
          {tea.photo ? <img src={srcFor(tea.photo)} alt="" style={S.detailImg} /> : <span style={{ ...S.detailHanzi, color: c.fg }}>{firstHanzi(tea.chineseName) || (tea.englishName && tea.englishName[0]) || "茶"}</span>}
        </div>
        <div style={S.modalScroll}>
          <div style={S.detailNames}>
            <div><h2 style={S.detailEn}>{tea.englishName || t("card.untitled")}</h2>{tea.chineseName && <p style={S.detailZh}>{tea.chineseName}</p>}</div>
            <span style={{ ...S.typeTagLg, background: c.dot }}>{vocab(lang, "type", tea.type) || "—"}</span>
          </div>
          {(tea.grade || tea.rarity) && (
            <div style={S.badges}>
              {tea.grade && <span style={S.gradeBadge}><Award size={13} /> {vocab(lang, "grade", tea.grade)}</span>}
              {tea.rarity && <span style={{ ...S.rarityBadge, ...rarityStyle(tea.rarity) }}>{vocab(lang, "rarity", tea.rarity)}</span>}
            </div>
          )}
          {tea.flavourNotes && <Section title={t("detail.flavour")}><p style={S.sectionText}>{tea.flavourNotes}</p></Section>}
          <Section title={t("detail.brewing")}>
            <div style={S.brewRow}>
              <div style={S.brewCell}><Droplet size={16} color={c.dot} /><span style={S.brewVal}>{tea.brewTemp ? `${tea.brewTemp}°C` : "—"}</span><span style={S.brewLbl}>{t("detail.water")}</span></div>
              <div style={S.brewCell}><Calendar size={16} color={c.dot} /><span style={S.brewVal}>{tea.steepTime || "—"}</span><span style={S.brewLbl}>{t("detail.steep")}</span></div>
              {tea.caffeine && <div style={S.brewCell}><Zap size={16} color={c.dot} /><span style={S.brewVal}>{tea.caffeine}</span><span style={S.brewLbl}>{t("detail.caffeinePerCup")}</span></div>}
            </div>
          </Section>
          <CaffeineContext tea={tea} accent={c.dot} />
          {(tea.origin || tea.harvestYear) && (
            <Section title={t("detail.provenance")}>
              <div style={S.provRow}>
                {tea.origin && <span style={S.provItem}><MapPin size={14} color={c.dot} /> {tea.origin}</span>}
                {tea.harvestYear && <span style={S.provItem}><Calendar size={14} color={c.dot} /> {t("detail.harvest", { year: tea.harvestYear })}</span>}
              </div>
            </Section>
          )}
          {tea.reasoning && <Section title={t("detail.whyGrade")}><p style={{ ...S.sectionText, ...S.reasoning }}>{tea.reasoning}</p></Section>}
        </div>
        <div style={S.modalFoot}>
          {confirm ? (
            <><span style={S.confirmText}>{t("detail.removeConfirm")}</span><button className="btn" onClick={() => setConfirm(false)}>{t("detail.keep")}</button><button className="btn btn-danger" onClick={onDelete}><Trash2 size={15} /> {t("common.remove")}</button></>
          ) : (
            <><button className="btn btn-ghost-danger" onClick={() => setConfirm(true)}><Trash2 size={15} /> {t("common.remove")}</button><button className="btn btn-primary" onClick={onEdit}><Pencil size={15} /> {t("common.edit")}</button></>
          )}
        </div>
      </div>
    </Overlay>
  );
}

function Field({ label, children, full }) {
  return <label style={{ ...S.field, ...(full ? { gridColumn: "1 / -1" } : {}) }}><span style={S.fieldLabel}>{label}</span>{children}</label>;
}
function Section({ title, children }) {
  return <div style={S.section}><p style={S.sectionTitle}>{title}</p>{children}</div>;
}
function Overlay({ children, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return <div style={S.overlay} onClick={onClose}>{children}</div>;
}

const SCAN_SYSTEM = "You read photos of Chinese tea packaging and return a single JSON object describing the tea. Translate any Chinese on the label. Infer tea type, brewing guidance, origin, harvest year, and an approximate rarity and grade using the label plus general knowledge of Chinese tea grading. Respond with ONLY valid JSON, no prose, no markdown fences. Keys: englishName, chineseName, type, flavourNotes, brewTemp, steepTime, origin, harvestYear, rarity, grade, reasoning. Rules: type must be one of Green, White, Yellow, Oolong, Black, Dark, Pu-erh, Scented, Herbal, Other. brewTemp is a number in Celsius as a string (e.g. \"85\"). steepTime is short text (e.g. \"2–3 min\" or \"15 sec\"). rarity is one of Common, Uncommon, Rare, Very rare. grade is one of Everyday, Standard, Premium, Competition, Imperial / Gong Ting, or empty. reasoning is one or two sentences explaining the rarity and grade call. Use empty string for anything you cannot determine.";

// The enum fields must stay in canonical English — they are stored values the
// filters and colours key off. Only the prose the user reads is localised.
const SCAN_LANGUAGE_NOTE = {
  en: "",
  it: " Write flavourNotes, origin and reasoning in Italian. Keep type, rarity and grade exactly as the English values listed above.",
  zh: " Write flavourNotes, origin and reasoning in Simplified Chinese. Keep type, rarity and grade exactly as the English values listed above.",
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function extractJsonObject(text) {
  if (!text) return null;
  let clean = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  try { return JSON.parse(clean); } catch (e) {}
  // Find the first balanced { ... } block, tolerating prose around it.
  const start = clean.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < clean.length; i++) {
    const ch = clean[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { const cand = clean.slice(start, i + 1); try { return JSON.parse(cand); } catch (e) { return null; } } }
    }
  }
  return null;
}

// The Anthropic call lives on the backend (/api/scan) so the API key never
// reaches the browser. This sends only the image bytes and the system prompt.
async function readLabelWithClaude(dataUrl, lang = "en") {
  const { mediaType, b64 } = parseDataUrl(dataUrl);
  const system = SCAN_SYSTEM + (SCAN_LANGUAGE_NOTE[lang] || "");
  const body = JSON.stringify({ mediaType, b64, system });

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(600 * attempt);
    let res;
    try {
      res = await fetch(`${API_BASE}/api/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
    } catch (e) { lastErr = keyedError("err.scan.network"); continue; }

    // 503 is the backend saying scanning is unconfigured — deterministic, so it
    // is checked before the retryable 5xx branch that would otherwise swallow it.
    if (res.status === 503) throw keyedError("err.scan.notConfigured");
    if (res.status === 429 || res.status >= 500) { lastErr = keyedError("err.scan.busy"); continue; }
    if (!res.ok) throw keyedError("err.scan.unavailable");

    let data;
    try { data = await res.json(); }
    catch (e) { lastErr = keyedError("err.scan.garbled"); continue; }

    const text = (data && typeof data.text === "string" ? data.text : "").trim();
    const parsed = extractJsonObject(text);
    if (!parsed || typeof parsed !== "object") { lastErr = keyedError("err.scan.unparsable"); continue; }

    // Normalise fields defensively so a partial/odd response can't crash the form.
    const safe = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
    const out = {
      englishName: safe(parsed.englishName), chineseName: safe(parsed.chineseName),
      type: safe(parsed.type), flavourNotes: safe(parsed.flavourNotes),
      brewTemp: safe(parsed.brewTemp), steepTime: safe(parsed.steepTime),
      origin: safe(parsed.origin), harvestYear: safe(parsed.harvestYear),
      rarity: safe(parsed.rarity), grade: safe(parsed.grade), reasoning: safe(parsed.reasoning),
    };
    if (out.type && TEA_TYPES.indexOf(out.type) === -1) out.type = "Other";
    return out;
  }
  throw lastErr || keyedError("err.readLabel");
}

function fileToDataUrl(file) {
  return new Promise((res, rej) => {
    if (!file) { rej(keyedError("err.file.none")); return; }
    const r = new FileReader();
    r.onload = () => {
      const out = r.result;
      if (typeof out !== "string" || out.indexOf("data:") !== 0 || out.indexOf(",") === -1) {
        rej(keyedError("err.file.notImage"));
        return;
      }
      res(out);
    };
    r.onerror = () => rej(keyedError("err.file.corrupt"));
    r.onabort = () => rej(keyedError("err.file.interrupted"));
    try { r.readAsDataURL(file); }
    catch (e) { rej(keyedError("err.file.open")); }
  });
}

// Re-encode any image to a clean, size-bounded JPEG data URL. This fixes HEIC,
// oversized photos, and odd colour profiles that the API can reject, and
// guarantees a well-formed "data:image/jpeg;base64,..." string downstream.
function normalizeImage(dataUrl, maxDim = 1600, quality = 0.85) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        try {
          let { width, height } = img;
          if (!width || !height) { resolve(dataUrl); return; }
          const scale = Math.min(1, maxDim / Math.max(width, height));
          const w = Math.max(1, Math.round(width * scale));
          const h = Math.max(1, Math.round(height * scale));
          const canvas = document.createElement("canvas");
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext("2d");
          if (!ctx) { resolve(dataUrl); return; }
          ctx.drawImage(img, 0, 0, w, h);
          const out = canvas.toDataURL("image/jpeg", quality);
          resolve(out && out.indexOf("data:image/jpeg") === 0 ? out : dataUrl);
        } catch (e) { resolve(dataUrl); }
      };
      img.onerror = () => resolve(dataUrl); // fall back to original if it won't decode
      img.src = dataUrl;
    } catch (e) { resolve(dataUrl); }
  });
}

// Robustly split a data URL into { mediaType, b64 }, validating structure.
function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") throw keyedError("err.file.noImage");
  const comma = dataUrl.indexOf(",");
  if (dataUrl.indexOf("data:") !== 0 || comma === -1) throw keyedError("err.file.malformed");
  const meta = dataUrl.slice(5, comma);
  const b64 = dataUrl.slice(comma + 1);
  if (!b64 || b64.length < 16) throw keyedError("err.file.empty");
  const mediaType = (meta.split(";")[0] || "").trim() || "image/jpeg";
  const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp"];
  return { mediaType: allowed.indexOf(mediaType) === -1 ? "image/jpeg" : mediaType, b64 };
}
function firstHanzi(s) { if (!s) return ""; const m = s.match(/[\u4e00-\u9fff]/g); return m ? m.slice(0, 2).join("") : ""; }
function shorten(s, n) { return s && s.length > n ? s.slice(0, n - 1) + "…" : s; }
function rarityStyle(r) {
  const map = { Common: { background: "#EDEBE4", color: "#5F5A4C" }, Uncommon: { background: "#E3EDDD", color: "#3F5A28" }, Rare: { background: "#EDE1CF", color: "#7A5320" }, "Very rare": { background: "#F0E0E7", color: "#7C3457" } };
  return map[r] || map.Common;
}

// Typical caffeine per standard serving, for context (approximate, mg).
const CAFFEINE_REFERENCE = [
  { key: "ref.herbal", mg: 0, note: "ref.note.free" },
  { key: "ref.decaf", mg: 3, note: "ref.note.glass" },
  { key: "ref.green", mg: 28, note: "ref.note.cup" },
  { key: "ref.black", mg: 47, note: "ref.note.cup" },
  { key: "ref.cola", mg: 34, note: "ref.note.can" },
  { key: "ref.energy", mg: 80, note: "ref.note.glass" },
  { key: "ref.espresso", mg: 63, note: "ref.note.shot" },
  { key: "ref.coffee", mg: 95, note: "ref.note.cup" },
];

// Pull an approximate mg number from a free-text caffeine field.
// "~30 mg" -> 30, "30–45 mg" -> 37 (midpoint), "Caffeine-free" -> 0, else null.
function parseCaffeineMg(s) {
  if (typeof s !== "string" || !s.trim()) return null;
  if (/free|none|no caffeine/i.test(s)) return 0;
  const nums = (s.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  if (nums.length === 0) return null;
  if (nums.length === 1) return nums[0];
  return Math.round((nums[0] + nums[nums.length - 1]) / 2);
}

function CaffeineContext({ tea, accent }) {
  const { t } = useI18n();
  const teaMg = parseCaffeineMg(tea.caffeine);
  if (teaMg === null) return null; // nothing numeric to compare
  const name = tea.englishName ? shorten(tea.englishName, 18) : t("ctx.selected");
  const teaRow = { key: "ctx.thisTea", label: t("ctx.thisTea", { name }), mg: teaMg, isTea: true };
  const rows = [...CAFFEINE_REFERENCE.map((r) => ({ ...r, label: t(r.key) })), teaRow].sort((a, b) => a.mg - b.mg);
  const max = Math.max(95, teaMg, ...CAFFEINE_REFERENCE.map((r) => r.mg));
  return (
    <Section title={t("ctx.title")}>
      <p style={S.ctxIntro}>{t("ctx.intro")}</p>
      <div style={S.ctxChart}>
        {rows.map((r) => {
          const pct = max > 0 ? Math.max(r.mg > 0 ? 4 : 0, (r.mg / max) * 100) : 0;
          return (
            <div key={r.key} style={S.ctxRow}>
              <span style={{ ...S.ctxLabel, ...(r.isTea ? { fontWeight: 700, color: INK } : {}) }}>{r.label}</span>
              <div style={S.ctxTrack}>
                <div style={{ ...S.ctxBar, width: `${pct}%`, background: r.isTea ? accent : "#DAD3C2" }} />
              </div>
              <span style={{ ...S.ctxVal, ...(r.isTea ? { fontWeight: 700, color: INK } : {}) }}>{t("ctx.mg", { n: r.mg })}</span>
            </div>
          );
        })}
      </div>
      <p style={S.ctxFoot}>{t("ctx.foot")}</p>
    </Section>
  );
}


const INK = "#2E2A22"; const PAPER = "#FBF9F3"; const CLAY = "#8A5A3C";
const S = {
  root: { fontFamily: "'Inter', system-ui, sans-serif", background: PAPER, color: INK, minHeight: "100vh", padding: "28px clamp(16px, 4vw, 44px) 64px", maxWidth: 1180, margin: "0 auto" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16, flexWrap: "wrap", paddingBottom: 22, borderBottom: "1px solid #E7E1D3" },
  brandRow: { display: "flex", alignItems: "center", gap: 16 },
  mark: { width: 54, height: 54, borderRadius: 14, background: INK, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  markHanzi: { fontFamily: "'Noto Serif SC', serif", color: PAPER, fontSize: 30, lineHeight: 1, marginTop: 2 },
  h1: { fontFamily: "'Noto Serif SC', 'Inter', serif", fontSize: "clamp(24px, 4vw, 32px)", fontWeight: 600, margin: 0, letterSpacing: "-0.01em" },
  sub: { margin: "3px 0 0", fontSize: 14, color: "#8C8574" },
  saveHint: { display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: "#6B6152" },
  whoami: { fontSize: 12, color: "#6B6152", marginLeft: "auto" },
  controls: { display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", margin: "22px 0 26px" },
  searchWrap: { display: "flex", alignItems: "center", gap: 9, background: "#fff", border: "1px solid #E4DECF", borderRadius: 11, padding: "0 12px", height: 42, flex: "1 1 260px", minWidth: 220 },
  search: { border: "none", outline: "none", background: "transparent", fontSize: 14.5, flex: 1, color: INK, fontFamily: "inherit" },
  chips: { display: "flex", gap: 7, flexWrap: "wrap" },
  chipGroup: { display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" },
  langGroup: { display: "inline-flex", alignItems: "center", background: "#fff", border: "1px solid #E4DECF", borderRadius: 9, padding: 2, gap: 2 },
  langBtn: { border: "none", background: "transparent", color: "#736C5C", height: 28, minWidth: 32, padding: "0 8px", borderRadius: 7, fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", transition: "all .15s" },
  langBtnActive: { background: INK, color: PAPER },
  chipGroupLabel: { display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 600, letterSpacing: 0.3, textTransform: "uppercase", color: "#9a9482" },
  chip: { display: "inline-flex", alignItems: "center", gap: 6, height: 34, padding: "0 12px", borderRadius: 9, border: "1px solid #E4DECF", background: "#fff", color: "#736C5C", fontSize: 13.5, fontWeight: 500, cursor: "pointer", fontFamily: "inherit", transition: "all .15s" },
  chipActive: { background: INK, color: PAPER, borderColor: INK },
  chipDot: { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 },
  chipCount: { fontSize: 11.5, opacity: 0.6, fontVariantNumeric: "tabular-nums" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(224px, 1fr))", gap: 18 },
  card: { textAlign: "left", padding: 0, border: "1px solid #E7E1D3", borderRadius: 16, background: "#fff", cursor: "pointer", overflow: "hidden", fontFamily: "inherit", color: "inherit", transition: "transform .16s, box-shadow .16s, border-color .16s", display: "flex", flexDirection: "column" },
  cardTop: { position: "relative", height: 128, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" },
  cardImg: { width: "100%", height: "100%", objectFit: "cover" },
  cardHanzi: { fontFamily: "'Noto Serif SC', serif", fontSize: 44, lineHeight: 1, opacity: 0.9 },
  typeTag: { position: "absolute", top: 10, left: 10, color: "#fff", fontSize: 11.5, fontWeight: 600, padding: "3px 9px", borderRadius: 7, letterSpacing: "0.01em" },
  rarityTag: { position: "absolute", top: 10, right: 10, background: "rgba(255,255,255,0.82)", color: "#5b5344", fontSize: 10.5, fontWeight: 600, padding: "3px 8px", borderRadius: 7, textTransform: "uppercase", letterSpacing: "0.04em" },
  gradeTag: { position: "absolute", top: 10, right: 10, maxWidth: "60%", background: "rgba(255,255,255,0.86)", color: "#5b5344", fontSize: 10.5, fontWeight: 600, padding: "3px 8px", borderRadius: 7, textTransform: "uppercase", letterSpacing: "0.04em", textAlign: "right", lineHeight: 1.3 },
  cardBody: { padding: "13px 15px 15px", display: "flex", flexDirection: "column", gap: 8, flex: 1 },
  cardNames: { display: "flex", flexDirection: "column", gap: 2 },
  cardEn: { fontSize: 16, fontWeight: 600, lineHeight: 1.25, letterSpacing: "-0.01em" },
  cardZh: { fontFamily: "'Noto Serif SC', serif", fontSize: 13.5, color: "#9A9282" },
  cardFlavour: { margin: 0, fontSize: 13, lineHeight: 1.5, color: "#7C7565", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" },
  cardMeta: { display: "flex", flexWrap: "wrap", gap: "5px 12px", marginTop: "auto", paddingTop: 4 },
  metaItem: { display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "#9A9282" },
  empty: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "72px 20px", color: "#9A9282" },
  emptyMark: { fontFamily: "'Noto Serif SC', serif", fontSize: 60, color: "#DDD5C4", marginBottom: 8 },
  emptyTitle: { fontSize: 18, fontWeight: 600, color: INK, margin: "0 0 4px" },
  emptySub: { fontSize: 14, margin: "0 0 14px", maxWidth: 320, lineHeight: 1.5 },
  overlay: { position: "fixed", inset: 0, background: "rgba(40,36,28,0.42)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "5vh 16px 16px", zIndex: 50, overflowY: "auto" },
  modal: { background: PAPER, borderRadius: 20, width: "100%", maxWidth: 560, boxShadow: "0 24px 60px rgba(40,30,15,0.28)", display: "flex", flexDirection: "column", maxHeight: "90vh", overflow: "hidden" },
  modalHead: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 20px 14px", borderBottom: "1px solid #EAE4D6" },
  modalTitle: { fontFamily: "'Noto Serif SC', serif", fontSize: 20, fontWeight: 600, margin: 0 },
  modalScroll: { overflowY: "auto", padding: "18px 20px", flex: 1 },
  modalFoot: { display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10, padding: "14px 20px", borderTop: "1px solid #EAE4D6", background: "#fff" },
  intake: { display: "flex", gap: 14, alignItems: "flex-start", padding: 15, borderRadius: 14, marginBottom: 14 },
  intakeIcon: { width: 58, height: 58, borderRadius: 12, background: "rgba(255,255,255,0.6)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  intakeImg: { width: 58, height: 58, borderRadius: 12, objectFit: "cover", flexShrink: 0 },
  intakeTitle: { fontSize: 15, fontWeight: 600, margin: 0, color: INK },
  intakeSub: { fontSize: 12.5, margin: "3px 0 10px", lineHeight: 1.45, color: "#6f6a5b" },
  intakeBtns: { display: "flex", gap: 8, flexWrap: "wrap" },
  scanState: { display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#6f6a5b", padding: "9px 12px", background: "#fff", border: "1px solid #EAE4D6", borderRadius: 10, marginBottom: 14 },
  scanOk: { background: "#EAF2E2", border: "1px solid #CBE0B8", color: "#3F5A28" },
  scanErr: { background: "#FBEBE8", border: "1px solid #F1CDC4", color: "#8A4132" },
  fieldGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 },
  field: { display: "flex", flexDirection: "column", gap: 6 },
  fieldLabel: { fontSize: 12, fontWeight: 600, color: "#847D6C", letterSpacing: "0.01em" },
  section: { marginBottom: 18 },
  sectionTitle: { fontSize: 11.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "#A59D8A", margin: "0 0 7px" },
  sectionText: { margin: 0, fontSize: 14.5, lineHeight: 1.55, color: "#453f33" },
  reasoning: { fontStyle: "italic", color: "#6f6a5b", background: "#fff", border: "1px solid #EAE4D6", borderLeft: `3px solid ${CLAY}`, borderRadius: 8, padding: "11px 13px" },
  detailHero: { position: "relative", height: 168, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" },
  detailImg: { width: "100%", height: "100%", objectFit: "cover" },
  detailHanzi: { fontFamily: "'Noto Serif SC', serif", fontSize: 72, lineHeight: 1, opacity: 0.92 },
  detailClose: { position: "absolute", top: 12, right: 12, background: "rgba(255,255,255,0.85)", zIndex: 2 },
  detailNames: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 14 },
  detailEn: { fontFamily: "'Noto Serif SC', serif", fontSize: 24, fontWeight: 600, margin: 0, letterSpacing: "-0.01em" },
  detailZh: { fontFamily: "'Noto Serif SC', serif", fontSize: 16, color: "#9A9282", margin: "3px 0 0" },
  badges: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 18 },
  gradeBadge: { display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12.5, fontWeight: 600, padding: "5px 11px", borderRadius: 8, background: "#F3ECD9", color: "#7A5A1C" },
  rarityBadge: { display: "inline-flex", alignItems: "center", fontSize: 12.5, fontWeight: 600, padding: "5px 11px", borderRadius: 8 },
  typeTagLg: { color: "#fff", fontSize: 12.5, fontWeight: 600, padding: "4px 11px", borderRadius: 8, whiteSpace: "nowrap", flexShrink: 0 },
  brewRow: { display: "flex", gap: 12 },
  brewCell: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "13px 10px", background: "#fff", border: "1px solid #EAE4D6", borderRadius: 11 },
  brewVal: { fontSize: 17, fontWeight: 600, color: INK },
  brewLbl: { fontSize: 11.5, color: "#A59D8A", textTransform: "uppercase", letterSpacing: "0.05em" },
  ctxIntro: { margin: "0 0 12px", fontSize: 13, lineHeight: 1.5, color: "#7C7565" },
  ctxChart: { display: "flex", flexDirection: "column", gap: 8 },
  ctxRow: { display: "grid", gridTemplateColumns: "minmax(96px, 34%) 1fr auto", alignItems: "center", gap: 10 },
  ctxLabel: { fontSize: 12.5, color: "#6f6a5b", lineHeight: 1.25 },
  ctxTrack: { position: "relative", height: 12, background: "#F0ECE1", borderRadius: 6, overflow: "hidden" },
  ctxBar: { position: "absolute", left: 0, top: 0, height: "100%", borderRadius: 6, transition: "width .4s ease", minWidth: 2 },
  ctxVal: { fontSize: 12, color: "#847D6C", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", textAlign: "right" },
  ctxFoot: { margin: "12px 0 0", fontSize: 11.5, lineHeight: 1.5, color: "#A59D8A", fontStyle: "italic" },
  provRow: { display: "flex", flexDirection: "column", gap: 8 },
  provItem: { display: "inline-flex", alignItems: "center", gap: 7, fontSize: 14, color: "#453f33" },
  confirmText: { fontSize: 13.5, color: "#8A4132", marginRight: "auto", fontWeight: 500 },
  toast: { position: "fixed", bottom: 22, left: "50%", transform: "translateX(-50%)", background: INK, color: PAPER, fontSize: 14, fontWeight: 500, padding: "11px 18px", borderRadius: 11, display: "flex", alignItems: "center", gap: 9, boxShadow: "0 10px 30px rgba(40,30,15,0.3)", zIndex: 60 },
  toastErr: { background: "#8A4132" },
};

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Serif+SC:wght@500;600;700&display=swap');
* { box-sizing: border-box; }
.spin { animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.tea-card:hover { transform: translateY(-3px); box-shadow: 0 12px 28px rgba(60,45,20,0.12); border-color: #D8CFB9 !important; }
.tea-card:focus-visible { outline: 2px solid ${CLAY}; outline-offset: 2px; }
.btn { display: inline-flex; align-items: center; gap: 7px; height: 40px; padding: 0 16px; border-radius: 10px; border: 1px solid #DDD5C2; background: #fff; color: ${INK}; font-size: 14px; font-weight: 500; cursor: pointer; font-family: inherit; transition: all .15s; white-space: nowrap; }
.btn:hover { background: #F5F1E7; border-color: #CFC6B0; }
.btn:active { transform: scale(0.98); }
.btn-small { height: 32px; padding: 0 12px; font-size: 13px; border-radius: 8px; }
.btn-primary { background: ${INK}; color: ${PAPER}; border-color: ${INK}; }
.btn-primary:hover { background: #423C30; border-color: #423C30; }
.btn-danger { background: #A5432E; color: #fff; border-color: #A5432E; }
.btn-danger:hover { background: #8E3725; }
.btn-ghost-danger { color: #A5432E; border-color: #E6CFC7; margin-right: auto; }
.btn-ghost-danger:hover { background: #FBEBE8; }
.icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 9px; border: none; background: transparent; color: #7C7565; cursor: pointer; transition: background .15s; }
.icon-btn:hover { background: rgba(0,0,0,0.06); }
.clear-x { border: none; background: transparent; color: #A59D8A; cursor: pointer; display: flex; padding: 2px; border-radius: 6px; }
.clear-x:hover { background: #F0ECE1; }
.chip:hover { border-color: #CFC6B0; }
.lang-btn:hover { background: #F2EEE3; }
.lang-btn[aria-pressed="true"]:hover { background: #2E2A22; }
.tea-search::placeholder { color: #A59D8A; }
.fld { width: 100%; border: 1px solid #E0D9C8; border-radius: 9px; padding: 9px 11px; font-size: 14px; font-family: inherit; color: ${INK}; background: #fff; outline: none; transition: border-color .15s, box-shadow .15s; }
.fld:focus { border-color: ${CLAY}; box-shadow: 0 0 0 3px rgba(138,90,60,0.12); }
textarea.fld { resize: vertical; line-height: 1.5; }
select.fld { cursor: pointer; }
`;
